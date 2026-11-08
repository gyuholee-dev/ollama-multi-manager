"""Instance lifecycle: one `ollama serve` process per instance, each with its own environment.

Lifetime policy: the app's running state *is* the instances' running state.
  * app start -> start every instance whose saved desired_state is 'running'
  * app quit  -> save each instance's running state, then stop all instances
Anything left over after a crash or kill is cleaned up on the next start (see cleanup_orphans).

Ports: the instance's configured port is served by an in-process proxy (proxy.py) that measures requests;
the real `ollama serve` listens on a private loopback port (Handle.inner_port).
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import shutil
import signal
import socket
import sqlite3
import subprocess
import time
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import httpx
import psutil

from app.config import FIRST_INSTANCE_PORT
from app.db import Database
from app.schemas import InstanceCreate, InstanceOptions, InstanceUpdate
from app.services.hub import Hub
from app.services.proxy import InstanceProxy, ProxyError, norm_model
from app.services.request_stats import RequestStats
from app.services.settings import SettingsService

log = logging.getLogger("omm.instances")

LOG_LINES = 2000
START_WAIT_SECONDS = 120.0  # how long a request waits for an instance that is starting
LOG_FILE_MAX_BYTES = 5 * 1024 * 1024


class InstanceError(Exception):
    def __init__(self, code: str, message: str, status: int = 400):
        super().__init__(message)
        self.code, self.message, self.status = code, message, status


# ---------------------------------------------------------------- pure helpers

def find_ollama(configured: str | None) -> str | None:
    """Settings path -> PATH -> OS default install locations."""
    if configured:
        return configured if os.path.isfile(configured) and os.access(configured, os.X_OK) else None
    found = shutil.which("ollama")
    if found:
        return found
    candidates: list[str] = []
    if os.name == "nt":
        local = os.environ.get("LOCALAPPDATA", "")
        candidates.append(os.path.join(local, "Programs", "Ollama", "ollama.exe"))
    else:
        candidates += ["/usr/local/bin/ollama", "/opt/homebrew/bin/ollama", "/usr/bin/ollama"]
    for c in candidates:
        if os.path.isfile(c) and os.access(c, os.X_OK):
            return c
    return None


def build_env(port: int, o: InstanceOptions, base: dict[str, str], default_models: str | None = None) -> dict[str, str]:
    env = dict(base)
    env["OLLAMA_HOST"] = f"127.0.0.1:{port}"
    env["OLLAMA_CONTEXT_LENGTH"] = str(o.context_length)
    env["OLLAMA_KEEP_ALIVE"] = "-1" if o.keep_alive_min < 0 else f"{o.keep_alive_min}m"
    env["OLLAMA_MAX_LOADED_MODELS"] = str(o.max_loaded_models)
    env["OLLAMA_NUM_PARALLEL"] = str(o.num_parallel)
    env["OLLAMA_FLASH_ATTENTION"] = "1" if o.flash_attention else "0"
    env["OLLAMA_KV_CACHE_TYPE"] = o.kv_cache_type
    for k in ("CUDA_VISIBLE_DEVICES", "HIP_VISIBLE_DEVICES"):
        env.pop(k, None)
    if o.gpu == "cpu":
        env["CUDA_VISIBLE_DEVICES"] = "-1"
        env["HIP_VISIBLE_DEVICES"] = "-1"
    elif isinstance(o.gpu, int):
        env["CUDA_VISIBLE_DEVICES"] = str(o.gpu)
    models = o.models_path or default_models
    if models:
        env["OLLAMA_MODELS"] = os.path.expanduser(models)
    return env


def free_loopback_port() -> int:
    """A port nothing listens on right now, for the private `ollama serve` behind an instance's proxy."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def port_free(port: int, host: str = "127.0.0.1") -> bool:
    """True if nothing is listening.

    Two checks: nobody may accept connections on the loopback address (this also catches a listener bound to all
    addresses, which a plain bind() test misses on macOS/BSD), and `host` must be bindable. SO_REUSEADDR (POSIX)
    makes the bind ignore TIME_WAIT leftovers from a just-stopped instance.
    """
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as c:
        c.settimeout(0.5)
        if c.connect_ex(("127.0.0.1", port)) == 0:
            return False
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        if os.name != "nt":  # on Windows SO_REUSEADDR would let bind() succeed over a live listener
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind((host, port))
        except OSError:
            return False
    return True


def _signal(p: psutil.Process, kill: bool = False) -> None:
    try:
        p.kill() if kill else p.terminate()
    except psutil.Error:
        pass


# ---------------------------------------------------------------- runtime state

@dataclass
class Handle:
    iid: int
    name: str
    port: int
    ps: psutil.Process
    proc: asyncio.subprocess.Process
    log_path: Path
    state: str = "starting"  # starting | running | stopping
    stopping: bool = False
    started_at: float = field(default_factory=time.time)
    tasks: list[asyncio.Task] = field(default_factory=list)
    inner_port: int = 0  # where ollama really listens (0 = same as port, no proxy)
    proxy: InstanceProxy | None = None


POLL_NOISE = re.compile(r'\[GIN\].*\|\s*GET\s+"/api/(?:ps|version)"\s*$')


def is_poll_noise(line: str) -> bool:
    """Ollama's access-log line for a status poll (GET /api/ps, /api/version), which the app sends every few seconds."""
    return bool(POLL_NOISE.search(line))


class InstanceManager:
    IDLE_CHECK_SECONDS = 10.0
    IDLE_UNIT_SECONDS = 60.0  # one "idle minute"; tests shrink it

    def __init__(self, db: Database, hub: Hub, settings: SettingsService, data_dir: Path):
        self.db, self.hub, self.settings = db, hub, settings
        self.log_dir = data_dir / "logs"
        self.log_dir.mkdir(parents=True, exist_ok=True)
        self.handles: dict[int, Handle] = {}
        self.last_exit: dict[int, dict[str, Any]] = {}
        self.logs: dict[int, deque] = {}
        self._locks: dict[int, asyncio.Lock] = {}
        self._proxy_closers: set[asyncio.Task] = set()
        self.proxies: dict[int, InstanceProxy] = {}  # every live proxy: attached to a process, or standing by for an on-demand instance
        self.request_stats = RequestStats(db)
        self._client = httpx.AsyncClient(timeout=1.5)

    # ------------------------------------------------------------- records

    def _lock(self, iid: int) -> asyncio.Lock:
        return self._locks.setdefault(iid, asyncio.Lock())

    def _row(self, iid: int) -> sqlite3.Row:
        row = self.db.one("SELECT * FROM instances WHERE id=?", (iid,))
        if row is None:
            raise InstanceError("not_found", f"Instance {iid} not found", 404)
        return row

    def to_dict(self, row: sqlite3.Row) -> dict[str, Any]:
        return {
            "id": row["id"], "name": row["name"], "port": row["port"],
            "options": json.loads(row["options"]), "desired_state": row["desired_state"],
            "status": self.status(row["id"]),
        }

    def list(self) -> list[dict[str, Any]]:
        return [self.to_dict(r) for r in self.db.query("SELECT * FROM instances ORDER BY id")]

    def get(self, iid: int) -> dict[str, Any]:
        return self.to_dict(self._row(iid))

    def next_port(self) -> int:
        used = {r["port"] for r in self.db.query("SELECT port FROM instances")}
        mon = self.settings.get("external_monitoring_port")
        port = FIRST_INSTANCE_PORT
        while port in used or port == mon or not port_free(port):
            port += 1
        return port

    def create(self, body: InstanceCreate) -> dict[str, Any]:
        self._check_port(body.port)
        try:
            cur = self.db.execute(
                "INSERT INTO instances(name, port, options) VALUES(?,?,?)",
                (body.name, body.port, body.options.model_dump_json()),
            )
        except sqlite3.IntegrityError as e:
            raise self._conflict(e) from e
        self._log(0, "info", f"Created {body.name} (port {body.port})")
        return self.get(cur.lastrowid)

    def update(self, iid: int, body: InstanceUpdate) -> dict[str, Any]:
        row = self._row(iid)
        if iid in self.handles:
            raise InstanceError("running", "Stop the instance before editing it", 409)
        name = body.name or row["name"]
        port = body.port or row["port"]
        options = body.options.model_dump_json() if body.options else row["options"]
        self._check_port(port)
        try:
            self.db.execute("UPDATE instances SET name=?, port=?, options=? WHERE id=?", (name, port, options, iid))
        except sqlite3.IntegrityError as e:
            raise self._conflict(e) from e
        return self.get(iid)

    def delete(self, iid: int) -> None:
        row = self._row(iid)
        if iid in self.handles:
            raise InstanceError("running", "Stop the instance before deleting it", 409)
        self.db.execute("DELETE FROM instances WHERE id=?", (iid,))
        self.request_stats.delete_instance(iid)
        self.logs.pop(iid, None)
        self.last_exit.pop(iid, None)
        self._log(0, "info", f"Deleted {row['name']}")

    def _check_port(self, port: int) -> None:
        if port == self.settings.get("external_monitoring_port"):
            raise InstanceError("port_reserved", f"Port {port} is used by web access", 409)

    @staticmethod
    def _conflict(e: sqlite3.IntegrityError) -> InstanceError:
        msg = str(e)
        if "port" in msg:
            return InstanceError("port_taken", "Another instance already uses this port", 409)
        return InstanceError("name_taken", "Another instance already uses this name", 409)

    # ------------------------------------------------------------- status & logs

    def status(self, iid: int) -> dict[str, Any]:
        h = self.handles.get(iid)
        if h:
            return {"state": h.state, "pid": h.ps.pid, "started_at": h.started_at}
        le = self.last_exit.get(iid)
        if le and le["crashed"]:
            return {"state": "crashed", "pid": None, "exit_code": le["code"]}
        return {"state": "stopped", "pid": None}

    def _publish_status(self, iid: int) -> None:
        self.hub.publish({"type": "instance", "id": iid, "status": self.status(iid)})

    def _log(self, iid: int, level: str, msg: str) -> None:
        """iid 0 = the app itself."""
        entry = {"type": "log", "instance": iid, "level": level, "ts": time.time(), "msg": msg}
        self.logs.setdefault(iid, deque(maxlen=LOG_LINES)).append(entry)
        log.log(logging.WARNING if level == "warn" else logging.INFO, "[%s] %s", iid or "app", msg)
        self.hub.publish(entry)

    def recent_logs(self, iid: int | None, limit: int = 200) -> list[dict[str, Any]]:
        if iid is None:
            merged = sorted((e for d in self.logs.values() for e in d), key=lambda e: e["ts"])
            return merged[-limit:]
        return list(self.logs.get(iid, []))[-limit:]

    # ------------------------------------------------------------- start

    async def start(self, iid: int) -> dict[str, Any]:
        async with self._lock(iid):
            await self._start(iid)
        return self.get(iid)

    async def _start(self, iid: int) -> None:
        row = self._row(iid)
        if iid in self.handles:
            raise InstanceError("already_running", "Instance is already running", 409)
        exe = find_ollama(self.settings.get("ollama_executable_path"))
        if exe is None:
            raise InstanceError("executable_not_found", "Ollama executable not found", 400)
        port = row["port"]
        opts = InstanceOptions(**json.loads(row["options"]))
        inner = free_loopback_port()
        env = build_env(inner, opts, dict(os.environ), self.settings.get("default_models_path"))
        proxy = self.proxies.get(iid)  # an on-demand instance's proxy already holds the port
        if proxy is None:
            proxy = await self._open_proxy(iid, row, opts)
        proxy.attach(inner, opts.num_parallel)
        proxy.set_allowed(opts.allowed_models)

        log_path = self.log_dir / f"instance-{iid}.log"
        if log_path.exists() and log_path.stat().st_size > LOG_FILE_MAX_BYTES:
            log_path.write_bytes(b"")
        start_pos = log_path.stat().st_size if log_path.exists() else 0

        # Output goes to a file, not a pipe: a pipe would break when this process exits.
        kwargs: dict[str, Any] = {}
        if os.name == "nt":
            kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW
        else:
            kwargs["start_new_session"] = True
        try:
            with open(log_path, "ab") as out:
                proc = await asyncio.create_subprocess_exec(
                    exe, "serve", env=env, stdin=subprocess.DEVNULL, stdout=out, stderr=out, **kwargs
                )
        except OSError:
            await self._release_proxy(iid, opts)
            raise
        ps = psutil.Process(proc.pid)
        h = Handle(iid, row["name"], port, ps, proc, log_path, inner_port=inner, proxy=proxy)
        self.handles[iid] = h
        self.last_exit.pop(iid, None)
        self.db.execute(
            "UPDATE instances SET pid=?, pid_started=?, desired_state='running' WHERE id=?",
            (ps.pid, ps.create_time(), iid),
        )
        self._log(iid, "info", f"Started {h.name} (pid {ps.pid}, port {port})")
        h.tasks = [
            asyncio.create_task(self._tail(h, start_pos)),
            asyncio.create_task(self._watch(h)),
            asyncio.create_task(self._probe(h)),
        ]
        self._publish_status(iid)

    async def _probe(self, h: Handle) -> None:
        """starting -> running once the API answers."""
        n = 0
        while self.handles.get(h.iid) is h and not h.stopping:
            try:
                r = await self._client.get(f"http://127.0.0.1:{h.inner_port or h.port}/api/version")
                if r.status_code == 200:
                    h.state = "running"
                    if h.proxy is not None:
                        h.proxy.ready = True
                    self._log(h.iid, "info", f"{h.name} is ready")
                    self._publish_status(h.iid)
                    return
            except httpx.HTTPError:
                pass
            n += 1
            await asyncio.sleep(0.3 if n < 60 else 2.0)

    async def _tail(self, h: Handle, pos: int) -> None:
        # Lines about the app's own status polling are left out of the shown log (the log file keeps everything).
        buf = b""
        while True:
            alive = self.handles.get(h.iid) is h
            try:
                with open(h.log_path, "rb") as f:
                    f.seek(pos)
                    data = f.read(65536)
                    pos = f.tell()
            except OSError:
                data = b""
            if data:
                buf += data
                *lines, buf = buf.split(b"\n")
                for ln in lines:
                    text = ln.decode("utf-8", "replace").rstrip("\r")
                    if not is_poll_noise(text):
                        self._log(h.iid, "info", text)
                continue
            if not alive:
                break
            await asyncio.sleep(0.3)
        if buf and not is_poll_noise(buf.decode("utf-8", "replace")):
            self._log(h.iid, "info", buf.decode("utf-8", "replace"))

    async def _watch(self, h: Handle) -> None:
        code = await h.proc.wait()
        self._finish(h, code)

    def _finish(self, h: Handle, code: int | None) -> None:
        if self.handles.get(h.iid) is not h:
            return
        del self.handles[h.iid]
        if h.proxy is not None:
            self._release_proxy_soon(h.iid, h.proxy)
        crashed = not h.stopping
        self.last_exit[h.iid] = {"crashed": crashed, "code": code}
        self.db.execute("UPDATE instances SET pid=NULL, pid_started=NULL WHERE id=?", (h.iid,))
        if crashed:
            self._log(h.iid, "warn", f"{h.name} exited unexpectedly (code {code})")
        else:
            self._log(h.iid, "info", f"Stopped {h.name}")
        self._publish_status(h.iid)

    # ------------------------------------------------------------- stop

    async def stop(self, iid: int, persist: bool = True, drain: int = 0) -> dict[str, Any]:
        async with self._lock(iid):
            self._row(iid)
            if persist:
                self.db.execute("UPDATE instances SET desired_state='stopped' WHERE id=?", (iid,))
            h = self.handles.get(iid)
            if h is not None:
                h.stopping = True
                h.state = "stopping"
                self._publish_status(iid)
                if drain and h.proxy is not None:
                    left = await h.proxy.drain(drain)
                    self._log(iid, "warn" if left else "info",
                              f"Stopping {h.name}: {left} request(s) were still running after {drain}s" if left else f"Stopping {h.name}: running requests finished")
                await self._terminate(h)
                for _ in range(100):
                    if self.handles.get(iid) is not h:
                        break
                    await asyncio.sleep(0.05)
                else:
                    self._finish(h, None)
                if h.proxy is not None:
                    await self._release_proxy(iid, None, h.proxy)  # a restart reuses the port right away
        return self.get(iid)

    async def restart(self, iid: int, drain: int = 0) -> dict[str, Any]:
        await self.stop(iid, drain=drain)
        return await self.start(iid)

    async def _terminate(self, h: Handle, timeout: float = 10.0) -> None:
        """SIGTERM the server, wait; SIGKILL whatever remains (runner children included)."""
        try:
            children = await asyncio.to_thread(lambda: h.ps.children(recursive=True))
        except psutil.Error:
            children = []
        _signal(h.ps)
        try:
            await asyncio.wait_for(h.proc.wait(), timeout)
        except asyncio.TimeoutError:
            for p in [h.ps, *children]:
                _signal(p, kill=True)
            try:
                await asyncio.wait_for(h.proc.wait(), 5)
            except asyncio.TimeoutError:
                log.error("Process %s did not exit after SIGKILL", h.ps.pid)
        _, alive = await asyncio.to_thread(psutil.wait_procs, children, 3)
        for p in alive:
            _signal(p, kill=True)

    def requests(self, iid: int, limit: int = 50) -> dict[str, Any]:
        """Recent requests relayed for this instance, plus the per-model numbers (last 5 minutes)."""
        self._row(iid)
        h = self.handles.get(iid)
        if h is None or h.proxy is None:
            return {"requests": [], "models": {}}
        return {"requests": h.proxy.stats.recent(limit), "models": h.proxy.stats.snapshot()["models"]}

    async def models(self, iid: int) -> list[dict[str, Any]]:
        """Models this running instance can serve (asks the instance itself, so a custom models path is respected)."""
        self._row(iid)
        h = self.handles.get(iid)
        if h is None or h.state != "running":
            raise InstanceError("not_running", "The instance must be running", 409)
        try:
            r = await self._client.get(f"http://127.0.0.1:{h.inner_port or h.port}/api/tags", timeout=10.0)
            r.raise_for_status()
        except httpx.HTTPError as e:
            raise InstanceError("ollama_unreachable", f"Could not reach Ollama: {e}", 502) from e
        models = [{"name": m.get("name"), "size": m.get("size", 0)} for m in r.json().get("models", [])]
        allowed = {norm_model(m) for m in (self._opts(iid) or InstanceOptions()).allowed_models}
        return [m for m in models if not allowed or norm_model(str(m["name"])) in allowed]

    def set_allowed_models(self, iid: int, models: list[str]) -> dict[str, Any]:
        """Which models the instance serves. Applies at once, also while it runs (the proxy enforces it)."""
        row = self._row(iid)
        opts = json.loads(row["options"])
        opts["allowed_models"] = list(dict.fromkeys(m.strip() for m in models if m.strip()))
        opts = InstanceOptions(**opts)  # validates
        self.db.execute("UPDATE instances SET options=? WHERE id=?", (opts.model_dump_json(), iid))
        proxy = self.proxies.get(iid)
        if proxy is not None:
            proxy.set_allowed(opts.allowed_models)
        self._log(iid, "info", f"{row['name']}: " + (f"serves {len(opts.allowed_models)} selected model(s)" if opts.allowed_models else "serves every installed model"))
        return self.get(iid)

    # ------------------------------------------------------------- proxies, on-demand start

    def _opts(self, iid: int) -> InstanceOptions | None:
        row = self.db.one("SELECT options FROM instances WHERE id=?", (iid,))
        return InstanceOptions(**json.loads(row["options"])) if row else None

    async def _open_proxy(self, iid: int, row: sqlite3.Row, opts: InstanceOptions) -> InstanceProxy:
        port = row["port"]
        host = "0.0.0.0" if opts.listen == "lan" else "127.0.0.1"
        if not port_free(port, host):
            raise InstanceError("port_in_use", f"Port {port} is already in use", 409)
        proxy = InstanceProxy(row["name"], port, None, opts.num_parallel, recorder=lambda rec: self.request_stats.record(iid, rec),
                              host=host, api_key=opts.api_key)
        proxy.ensure = lambda: self.ensure_running(iid)
        proxy.set_allowed(opts.allowed_models)
        if opts.listen == "lan" and not opts.api_key:
            self._log(iid, "warn", f"{row['name']} is open to the whole network without an API key")
        try:
            await proxy.start()
        except ProxyError as e:
            raise InstanceError("port_in_use", f"Port {port} is already in use", 409) from e
        self.proxies[iid] = proxy
        return proxy

    async def _release_proxy(self, iid: int, opts: InstanceOptions | None, proxy: InstanceProxy | None = None) -> None:
        """The process behind a proxy is gone: keep the port (standby) for an on-demand instance, free it otherwise."""
        proxy = proxy or self.proxies.get(iid)
        if proxy is None:
            return
        opts = opts or self._opts(iid)
        if opts is not None and opts.auto_start and self.proxies.get(iid) is proxy:
            proxy.detach()
            return
        if self.proxies.get(iid) is proxy:
            del self.proxies[iid]
        await proxy.close()

    def _release_proxy_soon(self, iid: int, proxy: InstanceProxy) -> None:
        opts = self._opts(iid)
        if opts is not None and opts.auto_start:
            proxy.detach()
            return
        if self.proxies.get(iid) is proxy:
            del self.proxies[iid]
        closer = asyncio.create_task(proxy.close())
        self._proxy_closers.add(closer)
        closer.add_done_callback(self._proxy_closers.discard)

    async def sync_standby(self, iid: int) -> None:
        """Make the standing-by proxy match the instance: present for a stopped on-demand instance, gone otherwise."""
        row = self.db.one("SELECT * FROM instances WHERE id=?", (iid,))
        opts = InstanceOptions(**json.loads(row["options"])) if row else None
        proxy = self.proxies.get(iid)
        if iid in self.handles:
            return  # a running instance's proxy is managed by its process
        host = "0.0.0.0" if opts and opts.listen == "lan" else "127.0.0.1"
        stale = proxy is not None and (opts is None or not opts.auto_start or (proxy.port, proxy.host, proxy.api_key) != (row["port"], host, opts.api_key))
        if stale:
            del self.proxies[iid]
            await proxy.close()
            proxy = None
        if proxy is None and opts is not None and opts.auto_start:
            try:
                await self._open_proxy(iid, row, opts)
                self._log(iid, "info", f"{row['name']} starts on demand (port {row['port']})")
            except InstanceError as e:
                self._log(iid, "warn", f"Could not reserve port {row['port']} for {row['name']}: {e.message}")

    async def ensure_running(self, iid: int) -> bool:
        """A request arrived: start the instance if it is on-demand and stopped, then wait until it answers."""
        h = self.handles.get(iid)
        if h is None:
            opts = self._opts(iid)
            if opts is None or not opts.auto_start:
                return False
            self._log(iid, "info", "A request arrived: starting on demand")
            try:
                await self.start(iid)
            except InstanceError as e:
                if e.code != "already_running":
                    self._log(iid, "warn", f"Could not start on demand: {e.message}")
                    return False
            h = self.handles.get(iid)
        end = time.monotonic() + START_WAIT_SECONDS
        while h is not None and time.monotonic() < end:
            if h.state == "running":
                return True
            if h.state == "stopping" or self.handles.get(iid) is not h:
                return False
            await asyncio.sleep(0.1)
        return False

    async def idle_loop(self) -> None:
        """Stop on-demand instances that have had no requests for their idle time."""
        while True:
            await asyncio.sleep(self.IDLE_CHECK_SECONDS)
            for iid, h in list(self.handles.items()):
                opts = self._opts(iid)
                if h.state != "running" or h.proxy is None or opts is None or not (opts.auto_start and opts.idle_stop_min):
                    continue
                busy = sum(h.proxy.stats.inflight.values())
                if not busy and time.monotonic() - h.proxy.last_activity > opts.idle_stop_min * self.IDLE_UNIT_SECONDS:
                    self._log(iid, "info", f"Stopping {h.name}: no requests for {opts.idle_stop_min} min")
                    try:
                        await self.stop(iid, persist=False)
                    except Exception:
                        log.exception("Idle stop of %s failed", h.name)

    # ------------------------------------------------------------- app lifetime

    async def cleanup_orphans(self) -> None:
        """Kill processes left behind by a crashed/killed previous run (PID + creation time must match)."""
        for row in self.db.query("SELECT id, name, pid, pid_started FROM instances WHERE pid IS NOT NULL"):
            try:
                p = psutil.Process(row["pid"])
                if abs(p.create_time() - (row["pid_started"] or 0)) < 1.0:
                    children = p.children(recursive=True)
                    for q in [p, *children]:
                        _signal(q)
                    _, alive = await asyncio.to_thread(psutil.wait_procs, [p, *children], 5)
                    for q in alive:
                        _signal(q, kill=True)
                    self._log(0, "warn", f"Cleaned up leftover process of {row['name']} (pid {row['pid']})")
            except psutil.Error:
                pass
            self.db.execute("UPDATE instances SET pid=NULL, pid_started=NULL WHERE id=?", (row["id"],))

    async def restore(self) -> None:
        """App start: bring back the instances that were running when the app last quit."""
        await self.cleanup_orphans()
        for row in self.db.query("SELECT id, name, options, desired_state FROM instances ORDER BY id"):
            if json.loads(row["options"]).get("auto_start"):
                await self.sync_standby(row["id"])  # starts when the first request arrives, not now
            elif row["desired_state"] == "running":
                try:
                    await self.start(row["id"])
                except InstanceError as e:
                    self._log(row["id"], "warn", f"Could not restore {row['name']}: {e.message}")

    async def shutdown(self) -> None:
        """App quit: save each instance's running state, then stop everything."""
        for row in self.db.query("SELECT id FROM instances"):
            state = "running" if row["id"] in self.handles else "stopped"
            self.db.execute("UPDATE instances SET desired_state=? WHERE id=?", (state, row["id"]))
        await asyncio.gather(*(self.stop(i, persist=False) for i in list(self.handles)), return_exceptions=True)
        await asyncio.gather(*(p.close() for p in list(self.proxies.values())), return_exceptions=True)  # standing-by proxies
        self.proxies.clear()
        await asyncio.gather(*self._proxy_closers, return_exceptions=True)
        await self._client.aclose()
