"""The MCP server: lets an MCP client (Claude Code ...) look at the app, and when switched on also start and stop its instances. Streamable HTTP (see mcp_tools.py).

It has a listener of its own, apart from the main API (whose port and token change at every start) and from the web access port (whose guest
page is not meant to open just because a client wants the tools):
- Off until it is switched on in the settings, and not started without a token.
- On all addresses: the point of an MCP server is that a client on another PC of the network (an editor on the PC you work at, the app on the PC
  that runs the models) can use it, so there is no "this PC only" mode. What stands guard is the token (below). Nothing sent is encrypted, which is
  as it is for the web access: it is for a network you trust. OMM_MCP_HOST binds it to one address instead.
- Every request carries the MCP token as `Authorization: Bearer`; a wrong or missing one is refused (401), and repeated mistakes lock the
  sender's address for a while. The token is the one the settings keep for this (kept as it is, like the metrics token, so the settings
  window can show it again to be copied).
- Requests are counted per sender: more than RATE_LIMIT in RATE_WINDOW seconds are refused (429).
- What a client may do is what the settings allow: the reading tools always; start/stop/restart only with "control" (mcp_control, off by default);
  take_screenshot wherever the app can take a picture (today: in developer mode, when the app hands the backend the way to Electron's screenshot
  listener, see shot_bridge.py); it has no switch of its own, as a developer is meant to be able to take screenshots, and the screenshots meant for
  users that come later are meant to be reachable through this server too.
- A client that starts its servers as programs can use app/mcp_stdio.py, a bridge to this listener (`python -m app mcp-stdio`).
Started, stopped and rebound whenever the mcp_* settings change (the tools are registered when the server is built, so a switch is a rebind).
"""
from __future__ import annotations

import asyncio
import logging
import os
import time
from collections import deque
from typing import Any

import uvicorn
from mcp.server.mcpserver import MCPServer
from mcp.server.transport_security import TransportSecuritySettings
from starlette.responses import JSONResponse

from app.services.instances import InstanceManager, port_free
from app.services.mcp_tools import instructions, register_control_tools, register_screenshot_tool, register_tools
from app.services.models import ModelService
from app.services.monitor.collector import Collector
from app.services.settings import MCP_TOKEN_KEY, SettingsService
from app.services.shot_bridge import ShotBridge
from app.services.webauth import LoginLimiter, verify_token

log = logging.getLogger("omm.mcp")

PATH = "/mcp"
RATE_LIMIT = 300   # requests per sender ...
RATE_WINDOW = 60   # ... in this many seconds (a client makes a few requests per tool call)


class RateLimiter:
    """At most `limit` requests per sender in `window` seconds."""

    def __init__(self, limit: int = RATE_LIMIT, window: float = RATE_WINDOW):
        self.limit, self.window = limit, window
        self._seen: dict[str, deque[float]] = {}

    def allow(self, who: str, now: float | None = None) -> bool:
        now = now if now is not None else time.monotonic()
        times = self._seen.setdefault(who, deque())
        while times and now - times[0] >= self.window:
            times.popleft()
        if len(times) >= self.limit:
            return False
        times.append(now)
        if len(self._seen) > 1000:  # never grow without bound
            self._seen = {k: v for k, v in self._seen.items() if v and now - v[-1] < self.window}
        return True


def _header(scope: dict, name: bytes) -> str:
    for k, v in scope.get("headers", []):
        if k == name:
            return v.decode("latin-1")
    return ""


class McpGate:
    """ASGI front door: the path, the token and the rate, then the MCP app."""

    def __init__(self, app: Any, settings: SettingsService, rate: RateLimiter | None = None):
        self.app, self.settings = app, settings
        self.rate = rate or RateLimiter()
        self.limiter = LoginLimiter()  # wrong tokens, per sender

    async def __call__(self, scope: dict, receive: Any, send: Any) -> None:
        if scope["type"] == "lifespan":
            return await self.app(scope, receive, send)  # the MCP app starts and stops its session manager here
        if scope["type"] != "http":
            return  # no WebSocket on this port
        if scope["path"].rstrip("/") != PATH:
            return await JSONResponse({"error": "Not found"}, status_code=404)(scope, receive, send)
        stored = self.settings.get(MCP_TOKEN_KEY)
        if not stored:  # the token was removed while the listener runs: nothing is served
            return await JSONResponse({"error": "Not found"}, status_code=404)(scope, receive, send)
        who = (scope.get("client") or ("?", 0))[0]
        if self.limiter.locked(who):
            return await JSONResponse({"error": "Too many failures"}, status_code=429, headers={"retry-after": "60"})(scope, receive, send)
        auth = _header(scope, b"authorization")
        given = auth[7:] if auth.lower().startswith("bearer ") else ""
        if not given or not verify_token(given, stored):
            self.limiter.failed(who)
            return await JSONResponse({"error": "Invalid or missing token"}, status_code=401, headers={"www-authenticate": "Bearer"})(scope, receive, send)
        self.limiter.ok(who)
        if not self.rate.allow(who):
            return await JSONResponse({"error": "Too many requests"}, status_code=429, headers={"retry-after": str(RATE_WINDOW)})(scope, receive, send)
        await self.app(scope, receive, send)


def build_app(manager: InstanceManager, collector: Collector, models: ModelService, settings: SettingsService, version: str,
              control: bool = False, shots: ShotBridge | None = None) -> Any:
    """A new MCP server and its ASGI app behind the gate (a session manager runs once, so every start builds its own)."""
    server = MCPServer("ollama-multi-manager", title="Ollama Multi Manager", version=version, instructions=instructions(control, shots is not None))
    register_tools(server, manager, collector, models)
    if control:
        register_control_tools(server, manager)
    if shots is not None:
        register_screenshot_tool(server, shots)
    # Host and Origin checks (against DNS rebinding) cannot name the addresses the server is reached by: they are the PC's names and addresses on every
    # network, so the token is what stands guard (a page that reaches the server by rebinding does not have it).
    security = TransportSecuritySettings(enable_dns_rebinding_protection=False)
    app = server.streamable_http_app(streamable_http_path=PATH, transport_security=security, host="0.0.0.0")
    return McpGate(app, settings)


class McpService:
    def __init__(self, settings: SettingsService, manager: InstanceManager, collector: Collector, models: ModelService, version: str,
                 shots: ShotBridge | None = None):
        self.settings, self.manager, self.collector, self.models, self.version = settings, manager, collector, models, version
        self.shots = shots or ShotBridge()
        self.error: str | None = None
        self._server: uvicorn.Server | None = None
        self._task: asyncio.Task | None = None
        self._bound: tuple[int, bool, bool] | None = None  # (port, control, screenshot) the running listener was started with

    @property
    def active(self) -> bool:
        return self._server is not None and self._server.started

    def _wanted(self) -> tuple[int, bool, bool] | None:
        """(port, control, screenshot) when the server should run, None when it should not. The tools are registered when the server is built, so a
        change of a switch is a rebind like a change of the port. The screenshot tool is offered where there is a way to a screenshot."""
        if not self.settings.get("mcp_enabled") or not self.settings.get(MCP_TOKEN_KEY):
            return None
        shot = bool(self.shots.available)
        return int(self.settings.get("mcp_port")), bool(self.settings.get("mcp_control")), shot

    def status(self) -> dict[str, Any]:
        return {
            "enabled": bool(self.settings.get("mcp_enabled")),
            "port": self.settings.get("mcp_port"),
            "control": bool(self.settings.get("mcp_control")),
            "screenshot": bool(self._bound and self._bound[2]),  # the screenshot tool is offered now (there is a way to a screenshot)
            "token_set": bool(self.settings.get(MCP_TOKEN_KEY)),
            "path": PATH,
            "active": self.active, "error": self.error,
        }

    async def apply(self) -> None:
        """Make reality match the settings: start, stop, or rebind."""
        want = self._wanted()
        if self._server and want != self._bound:
            await self._stop()
        if want and self._server is None:
            await self._start(*want)
        elif not want:
            self.error = None

    async def _start(self, port: int, control: bool, shot: bool) -> None:
        self.error = None
        if not port_free(port):
            self.error = f"Port {port} is already in use"
            log.warning("MCP server not started: %s", self.error)
            return
        host = os.environ.get("OMM_MCP_HOST") or "0.0.0.0"
        app = build_app(self.manager, self.collector, self.models, self.settings, self.version, control, self.shots if shot else None)
        server = uvicorn.Server(uvicorn.Config(app, host=host, port=port, log_level="warning", lifespan="on", timeout_graceful_shutdown=2))
        server.install_signal_handlers = lambda: None  # the main server owns signal handling
        self._server, self._bound = server, (port, control, shot)
        self._task = asyncio.create_task(self._serve(server))
        for _ in range(100):
            if server.started or self._task.done():
                break
            await asyncio.sleep(0.05)
        if server.started:
            log.info("MCP server listening on %s:%d%s", host, port, PATH)
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
        self._server = self._task = self._bound = None

    async def close(self) -> None:
        await self._stop()
