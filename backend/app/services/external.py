"""Web access: the app's own web UI, served read-only to guests on a port that can listen on the LAN.

It is a second HTTP server, apart from the main API. Guests need no login: only GET and the live WebSocket are
accepted, only a fixed list of read endpoints is reachable, and no secrets are included. Anything that changes state
is refused here, whatever the page does. Started/stopped/rebound whenever the external_monitoring_* settings change.
(Exporting Prometheus metrics on this port is deferred; see the backlog doc.)
"""
from __future__ import annotations

import asyncio
import logging
import os
import re
import socket
from pathlib import Path
from typing import Any

import uvicorn
from starlette.applications import Starlette
from starlette.responses import JSONResponse, PlainTextResponse
from starlette.routing import Mount
from starlette.staticfiles import StaticFiles

from app.config import CSP
from app.services.instances import InstanceManager, port_free
from app.services.monitor.collector import Collector
from app.services.settings import SettingsService

log = logging.getLogger("omm.external")


def lan_ip() -> str:
    """Address other machines would use. Connecting a UDP socket sends nothing; it only picks a route."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


# The only API paths a guest may read (GET). /models is left out on purpose: reading it starts the model store server.
GUEST_READ_PATHS = re.compile(r"^/(info|settings|instances|pulls|logs|monitor/(snapshot|history|requests)|monitor/instances/\d+/history|instances/\d+(/(models|requests))?)$")
MAX_GUEST_SOCKETS = 20


class GuestGate:
    """ASGI front door of the web access port."""

    def __init__(self, main_app: Any, static_app: Any):
        self.main_app, self.static_app = main_app, static_app
        self.sockets = 0

    async def __call__(self, scope: dict, receive: Any, send: Any) -> None:
        if scope["type"] not in ("http", "websocket"):
            return
        path = scope["path"]
        if scope["type"] == "websocket":
            if path != "/ws" or self.sockets >= MAX_GUEST_SOCKETS:
                await send({"type": "websocket.close", "code": 1008})
                return
            self.sockets += 1
            try:
                await self.main_app({**scope, "omm_guest": True}, receive, send)
            finally:
                self.sockets -= 1
            return
        if scope["method"] not in ("GET", "HEAD"):
            return await JSONResponse({"error": "Read-only (guest) access"}, status_code=403)(scope, receive, send)
        if GUEST_READ_PATHS.match(path):
            return await self.main_app({**scope, "omm_guest": True}, receive, send)
        if self.static_app is None:
            return await PlainTextResponse("Not found", status_code=404)(scope, receive, send)

        async def with_policy(message: dict) -> None:
            if message["type"] == "http.response.start":
                message.setdefault("headers", []).append((b"content-security-policy", CSP.encode()))
            await send(message)

        await self.static_app(scope, receive, with_policy)  # the UI's own files, with the same content policy as the main server


class ExternalMonitor:
    def __init__(self, settings: SettingsService, manager: InstanceManager, collector: Collector,
                 main_app: Any = None, frontend_dir: Path | None = None):
        self.settings, self.manager, self.collector = settings, manager, collector
        self.main_app, self.frontend_dir = main_app, frontend_dir
        self.host = os.environ.get("OMM_EXTERNAL_HOST", "0.0.0.0")
        self.error: str | None = None
        self._server: uvicorn.Server | None = None
        self._task: asyncio.Task | None = None
        self._port: int | None = None

    def _app(self) -> Any:
        # Wrapped in an app so a missing file becomes a plain 404 instead of an unhandled exception.
        static = Starlette(routes=[Mount("/", app=StaticFiles(directory=self.frontend_dir, html=True))]) if self.frontend_dir else None
        return GuestGate(self.main_app, static)

    @property
    def active(self) -> bool:
        return self._server is not None and self._server.started

    def status(self) -> dict[str, Any]:
        return {
            "enabled": bool(self.settings.get("external_monitoring_enabled")),
            "port": self.settings.get("external_monitoring_port"),
            "active": self.active, "error": self.error,
        }

    async def apply(self) -> None:
        """Make reality match the settings: start, stop, or rebind."""
        want = self.settings.get("external_monitoring_enabled")
        port = self.settings.get("external_monitoring_port")
        if self._server and (not want or port != self._port):
            await self._stop()
        if want and self._server is None:
            await self._start(port)

    async def _start(self, port: int) -> None:
        self.error = None
        if not port_free(port):
            self.error = f"Port {port} is already in use"
            log.warning("Web access not started: %s", self.error)
            return
        server = uvicorn.Server(uvicorn.Config(self._app(), host=self.host, port=port, log_level="warning", lifespan="off", timeout_graceful_shutdown=2))
        server.install_signal_handlers = lambda: None  # the main server owns signal handling
        self._server, self._port = server, port
        self._task = asyncio.create_task(self._serve(server))
        for _ in range(100):
            if server.started or self._task.done():
                break
            await asyncio.sleep(0.05)
        if server.started:
            log.info("Web access listening on %s:%d", self.host, port)
        else:
            self.error = self.error or "Failed to start"
            await self._stop()

    async def _serve(self, server: uvicorn.Server) -> None:
        try:
            await server.serve()
        except SystemExit:  # uvicorn exits instead of raising when it cannot bind
            self.error = "Failed to bind the port"

    async def _stop(self) -> None:
        if self._server:
            self._server.should_exit = True
        if self._task:
            await asyncio.gather(self._task, return_exceptions=True)
        self._server = self._task = self._port = None

    async def close(self) -> None:
        await self._stop()
