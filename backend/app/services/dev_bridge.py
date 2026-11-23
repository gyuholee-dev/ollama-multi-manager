"""The way to the app's screen, for the tools a developer's agent uses (mcp_dev.py): the MCP server (here, in the backend) can neither take a picture of the
app's windows nor operate them, Electron can. In developer mode Electron opens a listener on the loopback address (electron/dev/listener.js) and hands the
backend its address and a token through the environment (OMM_DEV_URL, OMM_DEV_TOKEN). Without them (the backend run on its own, or the app not in
developer mode) there is no way to the screen, and none of the developer tools is offered."""
from __future__ import annotations

import base64
import os
from dataclasses import dataclass
from typing import Any

import httpx

TIMEOUT = 90.0  # a long page takes a while to unfold and photograph


class DevError(Exception):
    """Something the app's screen could not do (a screenshot, a click ...); the message is for the MCP client's model to read."""

    def __init__(self, message: str, code: str = "FAILED"):
        super().__init__(message)
        self.code = code


@dataclass
class Shot:
    """A picture: the bytes as they come (JPEG or PNG: `mime`), its size, and the size of the whole picture before it was scaled down. Nothing of it is kept on disk."""
    data: bytes
    mime: str
    width: int
    height: int
    full_width: int
    full_height: int


class DevBridge:
    def __init__(self, url: str | None = None, token: str | None = None, transport: httpx.AsyncBaseTransport | None = None):
        self.url, self.token, self._transport = (url or "").rstrip("/"), token or "", transport

    @classmethod
    def from_env(cls, env: dict[str, str] | None = None) -> "DevBridge":
        env = env if env is not None else os.environ
        return cls(env.get("OMM_DEV_URL"), env.get("OMM_DEV_TOKEN"))

    @property
    def available(self) -> bool:
        return bool(self.url and self.token)

    async def state(self) -> dict[str, Any]:
        """What the app looks like now (developer mode, which windows are shown), as Electron tells it."""
        if not self.available:
            raise DevError("The app's state is not available: the app is not running in developer mode", "UNAVAILABLE")
        try:
            async with httpx.AsyncClient(transport=self._transport, timeout=10.0) as client:
                r = await client.get(f"{self.url}/state", headers={"Authorization": f"Bearer {self.token}"})
        except httpx.HTTPError as e:
            raise DevError(f"The app's screenshot listener cannot be reached ({type(e).__name__})", "UNAVAILABLE") from e
        try:
            data = r.json()
        except ValueError:
            data = {}
        if r.status_code != 200 or not data.get("ok"):
            raise DevError(str(data.get("message") or f"The app's state could not be read (HTTP {r.status_code})"), str(data.get("code") or "FAILED"))
        return {k: v for k, v in data.items() if k != "ok"}

    async def ui(self, request: dict[str, Any]) -> dict[str, Any]:
        """Does one thing on the app's screen (find, click, type ...) as Electron's listener does it; what it answers, without the `ok`."""
        if not self.available:
            raise DevError("The screen cannot be operated: the app is not running in developer mode", "UNAVAILABLE")
        try:
            async with httpx.AsyncClient(transport=self._transport, timeout=30.0) as client:
                r = await client.post(f"{self.url}/ui", json=request, headers={"Authorization": f"Bearer {self.token}"})
        except httpx.HTTPError as e:
            raise DevError(f"The app's listener cannot be reached ({type(e).__name__})", "UNAVAILABLE") from e
        try:
            data = r.json()
        except ValueError:
            data = {}
        if r.status_code != 200 or not data.get("ok"):
            raise DevError(str(data.get("message") or f"The action failed (HTTP {r.status_code})"), str(data.get("code") or "FAILED"))
        return {k: v for k, v in data.items() if k != "ok"}

    async def capture(self, kind: str, selector: str | None = None, instance_id: int | None = None, depth: int | None = None, max_side: int = 1568,
                      open_monitor: bool = False, quality: str = "reduced") -> Shot:
        if not self.available:
            raise DevError("Screenshots are not available: the app is not running in developer mode", "UNAVAILABLE")
        body: dict[str, Any] = {"kind": kind, "max_side": max_side, "quality": quality}
        for key, value in (("selector", selector), ("instance_id", instance_id), ("depth", depth)):
            if value is not None:
                body[key] = value
        if open_monitor:
            body["open_monitor"] = True
        try:
            async with httpx.AsyncClient(transport=self._transport, timeout=TIMEOUT) as client:
                r = await client.post(f"{self.url}/capture", json=body, headers={"Authorization": f"Bearer {self.token}"})
        except httpx.HTTPError as e:
            raise DevError(f"The app's screenshot listener cannot be reached ({type(e).__name__})", "UNAVAILABLE") from e
        try:
            data = r.json()
        except ValueError:
            data = {}
        if r.status_code != 200 or not data.get("ok"):
            raise DevError(str(data.get("message") or f"The screenshot failed (HTTP {r.status_code})"), str(data.get("code") or "FAILED"))
        try:
            return Shot(base64.b64decode(data["data"]), str(data.get("mime") or "image/png"), int(data["width"]), int(data["height"]),
                        int(data.get("full_width") or data["width"]), int(data.get("full_height") or data["height"]))
        except (KeyError, ValueError, TypeError) as e:
            raise DevError("The app's screenshot listener answered in a form that cannot be read", "FAILED") from e
