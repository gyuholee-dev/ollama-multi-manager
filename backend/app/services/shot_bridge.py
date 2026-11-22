"""The way to the screenshots: the MCP server (here, in the backend) cannot take a picture of the app's windows, Electron can. In developer mode Electron
opens a listener on the loopback address (electron/mcp-shot.js) and hands the backend its address and a token through the environment
(OMM_SHOT_URL, OMM_SHOT_TOKEN). Without them (the backend run on its own, or the app not in developer mode) there is no way to a screenshot, and the
screenshot tool is never offered."""
from __future__ import annotations

import base64
import os
from dataclasses import dataclass
from typing import Any

import httpx

TIMEOUT = 90.0  # a long page takes a while to unfold and photograph


class ShotError(Exception):
    """A screenshot that could not be taken; the message is for the MCP client's model to read."""

    def __init__(self, message: str, code: str = "FAILED"):
        super().__init__(message)
        self.code = code


@dataclass
class Shot:
    png: bytes
    file: str
    width: int
    height: int
    full_width: int
    full_height: int


class ShotBridge:
    def __init__(self, url: str | None = None, token: str | None = None, transport: httpx.AsyncBaseTransport | None = None):
        self.url, self.token, self._transport = (url or "").rstrip("/"), token or "", transport

    @classmethod
    def from_env(cls, env: dict[str, str] | None = None) -> "ShotBridge":
        env = env if env is not None else os.environ
        return cls(env.get("OMM_SHOT_URL"), env.get("OMM_SHOT_TOKEN"))

    @property
    def available(self) -> bool:
        return bool(self.url and self.token)

    async def state(self) -> dict[str, Any]:
        """What the app looks like now (developer mode, which windows are shown), as Electron tells it."""
        if not self.available:
            raise ShotError("The app's state is not available: the app is not running in developer mode", "UNAVAILABLE")
        try:
            async with httpx.AsyncClient(transport=self._transport, timeout=10.0) as client:
                r = await client.get(f"{self.url}/state", headers={"Authorization": f"Bearer {self.token}"})
        except httpx.HTTPError as e:
            raise ShotError(f"The app's screenshot listener cannot be reached ({type(e).__name__})", "UNAVAILABLE") from e
        try:
            data = r.json()
        except ValueError:
            data = {}
        if r.status_code != 200 or not data.get("ok"):
            raise ShotError(str(data.get("message") or f"The app's state could not be read (HTTP {r.status_code})"), str(data.get("code") or "FAILED"))
        return {k: v for k, v in data.items() if k != "ok"}

    async def capture(self, kind: str, selector: str | None = None, instance_id: int | None = None, depth: int | None = None, max_side: int = 1568,
                      open_monitor: bool = False) -> Shot:
        if not self.available:
            raise ShotError("Screenshots are not available: the app is not running in developer mode", "UNAVAILABLE")
        body: dict[str, Any] = {"kind": kind, "max_side": max_side}
        for key, value in (("selector", selector), ("instance_id", instance_id), ("depth", depth)):
            if value is not None:
                body[key] = value
        if open_monitor:
            body["open_monitor"] = True
        try:
            async with httpx.AsyncClient(transport=self._transport, timeout=TIMEOUT) as client:
                r = await client.post(f"{self.url}/capture", json=body, headers={"Authorization": f"Bearer {self.token}"})
        except httpx.HTTPError as e:
            raise ShotError(f"The app's screenshot listener cannot be reached ({type(e).__name__})", "UNAVAILABLE") from e
        try:
            data = r.json()
        except ValueError:
            data = {}
        if r.status_code != 200 or not data.get("ok"):
            raise ShotError(str(data.get("message") or f"The screenshot failed (HTTP {r.status_code})"), str(data.get("code") or "FAILED"))
        try:
            return Shot(base64.b64decode(data["data"]), str(data["file"]), int(data["width"]), int(data["height"]),
                        int(data.get("full_width") or data["width"]), int(data.get("full_height") or data["height"]))
        except (KeyError, ValueError, TypeError) as e:
            raise ShotError("The app's screenshot listener answered in a form that cannot be read", "FAILED") from e
