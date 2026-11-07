"""The model store's own Ollama server.

Managing models (list / pull / delete) needs an Ollama API, but it must not depend on any instance:
on first launch there are no instances and no models. So the backend runs one hidden `ollama serve`
bound to the default models directory, on demand, and stops it again after a quiet period.
It never loads models, so it is kept off the GPUs.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import socket
import subprocess
import time
from pathlib import Path
from typing import Any, Callable

import httpx
import psutil

from app.services.instances import Handle, InstanceError, InstanceManager, find_ollama

log = logging.getLogger("omm.store")

IDLE_STOP_SECONDS = 120.0
READY_TIMEOUT = 30.0


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class StoreServer:
    def __init__(self, manager: InstanceManager, data_dir: Path, busy: Callable[[], bool]):
        self.manager, self.busy = manager, busy
        self.log_path = data_dir / "logs" / "model-store.log"
        self.pid_file = data_dir / "model-store.json"
        self._h: Handle | None = None
        self._key: tuple[str | None, str | None] | None = None
        self._lock = asyncio.Lock()
        self._idle: asyncio.Task | None = None
        self.last_use = time.monotonic()

    def models_dir(self) -> Path:
        """Where this server keeps models (the default models path setting, else OLLAMA_MODELS, else Ollama's default)."""
        configured = self.manager.settings.get("default_models_path") or os.environ.get("OLLAMA_MODELS") or "~/.ollama/models"
        return Path(os.path.expanduser(configured))

    def touch(self) -> None:
        self.last_use = time.monotonic()

    @property
    def running(self) -> bool:
        return self._h is not None and self._h.proc.returncode is None

    async def base(self) -> str:
        """URL of the store's server, starting it when needed."""
        async with self._lock:
            settings = self.manager.settings
            key = (settings.get("ollama_executable_path"), settings.get("default_models_path"))
            if self._h is not None and (not self.running or (key != self._key and not self.busy())):
                await self._stop()  # exited, or the executable / models path setting changed
            if self._h is None:
                await self._start(key)
            self.touch()
            if self._idle is None or self._idle.done():
                self._idle = asyncio.create_task(self._idle_loop())
            return f"http://127.0.0.1:{self._h.port}"

    async def _start(self, key: tuple[str | None, str | None]) -> None:
        exe = find_ollama(key[0])
        if exe is None:
            raise InstanceError("executable_not_found", "Ollama executable not found", 400)
        port = free_port()
        env = dict(os.environ)
        env["OLLAMA_HOST"] = f"127.0.0.1:{port}"
        env["CUDA_VISIBLE_DEVICES"] = env["HIP_VISIBLE_DEVICES"] = "-1"
        if key[1]:
            env["OLLAMA_MODELS"] = os.path.expanduser(key[1])
        self.log_path.parent.mkdir(parents=True, exist_ok=True)
        if self.log_path.exists() and self.log_path.stat().st_size > 1024 * 1024:
            self.log_path.write_bytes(b"")
        kwargs: dict[str, Any] = {}
        if os.name == "nt":
            kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW
        else:
            kwargs["start_new_session"] = True
        with open(self.log_path, "ab") as out:
            proc = await asyncio.create_subprocess_exec(
                exe, "serve", env=env, stdin=subprocess.DEVNULL, stdout=out, stderr=out, **kwargs
            )
        ps = psutil.Process(proc.pid)
        self._h = Handle(0, "model store", port, ps, proc, self.log_path, state="running")
        self._key = key
        try:
            self.pid_file.write_text(json.dumps({"pid": ps.pid, "created": ps.create_time()}))
        except OSError:
            pass
        self.manager._log(0, "info", f"Model store server started (pid {ps.pid}, port {port})")
        deadline = time.monotonic() + READY_TIMEOUT
        async with httpx.AsyncClient(timeout=1.5) as c:
            while time.monotonic() < deadline and proc.returncode is None:
                try:
                    if (await c.get(f"http://127.0.0.1:{port}/api/version")).status_code == 200:
                        return
                except httpx.HTTPError:
                    pass
                await asyncio.sleep(0.2)
        await self._stop()
        raise InstanceError("store_unavailable", "The model store server did not become ready", 502)

    async def _stop(self) -> None:
        h, self._h, self._key = self._h, None, None
        if h is None:
            return
        await self.manager._terminate(h)
        try:
            self.pid_file.unlink()
        except OSError:
            pass
        self.manager._log(0, "info", "Model store server stopped")

    async def _idle_loop(self) -> None:
        while True:
            await asyncio.sleep(5)
            if self._h is None:
                return
            if not self.busy() and time.monotonic() - self.last_use > IDLE_STOP_SECONDS:
                async with self._lock:
                    if self._h is not None and not self.busy() and time.monotonic() - self.last_use > IDLE_STOP_SECONDS:
                        await self._stop()
                        return

    async def cleanup_orphan(self) -> None:
        """A previous run that was killed may have left its store server behind."""
        try:
            d = json.loads(self.pid_file.read_text())
            p = psutil.Process(d["pid"])
            if abs(p.create_time() - d["created"]) < 1.0:
                for q in [p, *p.children(recursive=True)]:
                    q.kill()
                self.manager._log(0, "warn", f"Cleaned up leftover model store server (pid {d['pid']})")
        except (OSError, ValueError, KeyError, psutil.Error):
            pass
        try:
            self.pid_file.unlink()
        except OSError:
            pass

    async def close(self) -> None:
        if self._idle:
            self._idle.cancel()
            await asyncio.gather(self._idle, return_exceptions=True)
        async with self._lock:
            await self._stop()
