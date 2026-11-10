"""Web access: the app's own web UI, served on a port that can listen on the LAN. Two modes, by the password setting.

It is a second HTTP server, apart from the main API.
- No password set: guest mode. Guests need no login: only GET and the live WebSocket are accepted, only a fixed list of
  read endpoints is reachable, and no secrets are included. Anything that changes state is refused here, whatever the
  page does.
- Password set: a visitor signs in once with it (POST /login); the answer is a cookie (HttpOnly, 12 hours by default)
  and, while the cookie is valid, the visitor reaches everything the app itself does, without the API token. Wrong
  passwords are rate-limited per address.
Started/stopped/rebound whenever the external_monitoring_* settings change.
(Exporting Prometheus metrics on this port is deferred; see the backlog doc.)
"""
from __future__ import annotations

import asyncio
import logging
import os
import re
import socket
from http.cookies import SimpleCookie
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlsplit

import uvicorn
from starlette.applications import Starlette
from starlette.responses import HTMLResponse, JSONResponse, PlainTextResponse, RedirectResponse
from starlette.routing import Mount
from starlette.staticfiles import StaticFiles

from app.config import CSP
from app.services.instances import InstanceManager, port_free
from app.services.monitor.collector import Collector
from app.services.settings import PASSWORD_KEY, SettingsService
from app.services.webauth import (COOKIE_NAME, DEFAULT_SESSION_HOURS, LoginLimiter, login_page, make_session, session_valid,
                                  verify_password)

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
MAX_WEB_SOCKETS = 20  # open live connections, guests and signed-in visitors alike
SAFE_METHODS = ("GET", "HEAD")


def _header(scope: dict, name: bytes) -> str:
    for k, v in scope.get("headers", []):
        if k == name:
            return v.decode("latin-1")
    return ""


class WebGate:
    """ASGI front door of the web access port."""

    def __init__(self, main_app: Any, settings: SettingsService, static_app: Any = None):
        self.main_app, self.settings, self.static_app = main_app, settings, static_app
        self.sockets = 0
        self.limiter = LoginLimiter()

    def _lang(self) -> str | None:
        return self.settings.get("language")

    def _signed_in(self, scope: dict, stored: str) -> bool:
        jar: SimpleCookie = SimpleCookie()
        try:
            jar.load(_header(scope, b"cookie"))
        except Exception:  # a broken cookie header is just "not signed in"
            return False
        morsel = jar.get(COOKIE_NAME)
        return bool(morsel) and session_valid(morsel.value, stored)

    async def __call__(self, scope: dict, receive: Any, send: Any) -> None:
        if scope["type"] not in ("http", "websocket"):
            return
        stored = self.settings.get(PASSWORD_KEY)
        if not stored:  # no password: guest mode
            return await self._guest(scope, receive, send)
        if scope["type"] == "websocket":
            if not self._signed_in(scope, stored) or scope["path"] != "/ws":
                await send({"type": "websocket.close", "code": 1008})
                return
            return await self._socket(scope, receive, send, {"omm_web": True})
        if scope["path"] == "/login":
            return await self._login(scope, receive, send, stored)
        if self._signed_in(scope, stored):
            if scope["method"] not in SAFE_METHODS and not self._same_origin(scope):
                return await JSONResponse({"error": "Cross-site request refused"}, status_code=403)(scope, receive, send)
            return await self.main_app({**scope, "omm_web": True}, receive, send)
        if scope["method"] in SAFE_METHODS and "text/html" in _header(scope, b"accept"):
            return await HTMLResponse(login_page(self._lang()), status_code=401, headers={"content-security-policy": CSP})(scope, receive, send)
        await JSONResponse({"error": "Sign in required"}, status_code=401)(scope, receive, send)

    async def _socket(self, scope: dict, receive: Any, send: Any, flags: dict) -> None:
        if scope["path"] != "/ws" or self.sockets >= MAX_WEB_SOCKETS:
            await send({"type": "websocket.close", "code": 1008})
            return
        self.sockets += 1
        try:
            await self.main_app({**scope, **flags}, receive, send)
        finally:
            self.sockets -= 1

    async def _guest(self, scope: dict, receive: Any, send: Any) -> None:
        """No password set: read-only, nothing secret."""
        path = scope["path"]
        if scope["type"] == "websocket":
            return await self._socket(scope, receive, send, {"omm_guest": True})
        if scope["method"] not in SAFE_METHODS:
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

    @staticmethod
    def _same_origin(scope: dict) -> bool:
        """A page of another site must not act with the visitor's cookie: when the browser says where the request
        came from, it has to be this address."""
        origin = _header(scope, b"origin")
        return not origin or urlsplit(origin).netloc == _header(scope, b"host")

    async def _login(self, scope: dict, receive: Any, send: Any, stored: str) -> None:
        lang = self._lang()
        page = lambda error, status: HTMLResponse(login_page(lang, error), status_code=status, headers={"content-security-policy": CSP})  # noqa: E731
        if scope["method"] in SAFE_METHODS:
            return await page(None, 200)(scope, receive, send)
        if scope["method"] != "POST":
            return await PlainTextResponse("Method not allowed", status_code=405)(scope, receive, send)
        if not self._same_origin(scope):
            return await PlainTextResponse("Cross-site request refused", status_code=403)(scope, receive, send)
        who = (scope.get("client") or ("?", 0))[0]
        if self.limiter.locked(who):
            return await page("locked", 429)(scope, receive, send)
        body = b""
        while True:  # a password is short: read at most 4 KB
            message = await receive()
            body += message.get("body", b"")
            if not message.get("more_body") or len(body) > 4096:
                break
        password = parse_qs(body[:4096].decode("utf-8", "replace")).get("password", [""])[0]
        if not verify_password(password, stored):
            self.limiter.failed(who)
            return await page("bad", 401)(scope, receive, send)
        self.limiter.ok(who)
        hours = self.settings.get("external_monitoring_session_hours") or DEFAULT_SESSION_HOURS
        value, seconds = make_session(stored, hours)
        response = RedirectResponse("/", status_code=303)
        response.set_cookie(COOKIE_NAME, value, max_age=seconds, path="/", httponly=True, samesite="lax")
        await response(scope, receive, send)


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
        return WebGate(self.main_app, self.settings, static)

    @property
    def active(self) -> bool:
        return self._server is not None and self._server.started

    def status(self) -> dict[str, Any]:
        return {
            "enabled": bool(self.settings.get("external_monitoring_enabled")),
            "port": self.settings.get("external_monitoring_port"),
            "password_set": bool(self.settings.get(PASSWORD_KEY)),
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
