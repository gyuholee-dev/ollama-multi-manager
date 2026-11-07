"""External monitoring endpoint: a second, tiny HTTP server that only serves /metrics.

Separate from the main API so it can listen on the LAN (0.0.0.0) without exposing anything else.
Started/stopped/rebound whenever the external_monitoring_* settings change.
"""
from __future__ import annotations

import asyncio
import logging
import os
import socket
from typing import Any

import uvicorn
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import PlainTextResponse
from starlette.routing import Route

from app.services.instances import InstanceManager, port_free
from app.services.monitor import prometheus
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


class ExternalMonitor:
    def __init__(self, settings: SettingsService, manager: InstanceManager, collector: Collector):
        self.settings, self.manager, self.collector = settings, manager, collector
        self.host = os.environ.get("OMM_EXTERNAL_HOST", "0.0.0.0")
        self.error: str | None = None
        self._server: uvicorn.Server | None = None
        self._task: asyncio.Task | None = None
        self._port: int | None = None

    def _app(self) -> Starlette:
        async def metrics(_: Request) -> PlainTextResponse:
            names = {i["id"]: i["name"] for i in self.manager.list()}
            return PlainTextResponse(prometheus.render(self.collector.latest, names), media_type="text/plain; version=0.0.4")

        return Starlette(routes=[Route("/metrics", metrics)])

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
            log.warning("External monitoring not started: %s", self.error)
            return
        server = uvicorn.Server(uvicorn.Config(self._app(), host=self.host, port=port, log_level="warning", lifespan="off"))
        server.install_signal_handlers = lambda: None  # the main server owns signal handling
        self._server, self._port = server, port
        self._task = asyncio.create_task(self._serve(server))
        for _ in range(100):
            if server.started or self._task.done():
                break
            await asyncio.sleep(0.05)
        if server.started:
            log.info("External monitoring listening on %s:%d", self.host, port)
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
