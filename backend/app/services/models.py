"""Model management: proxies Ollama's /api/tags, /api/pull, /api/delete for the default models store.

Independent of instances: it talks to the store's own hidden server (see store.py).

Pulls run as background tasks owned by the backend, so a closed UI does not abort a multi-GB download.
Progress is pushed through the hub; clients can also poll GET /pulls.
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import time
import uuid
from collections import deque
from pathlib import Path
from dataclasses import asdict, dataclass, field
from typing import Any

import httpx

from app.services.hub import Hub
from app.services.instances import InstanceError, InstanceManager
from app.services.store import StoreServer

log = logging.getLogger("omm.models")

MODEL_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,199}$")
FINISHED_KEEP = 50
PROGRESS_INTERVAL = 0.2  # seconds between progress events per task


def parse_parameters(text: str) -> list[dict[str, str]]:
    """`ollama show` prints the settings as lines of "key   value"; a key may repeat (stop). Quotes around a value are dropped."""
    out = []
    for line in text.splitlines():
        parts = line.strip().split(None, 1)
        if len(parts) == 2:
            value = parts[1].strip()
            if len(value) >= 2 and value[0] == value[-1] == '"':
                value = value[1:-1]
            out.append({"key": parts[0], "value": value})
    return out


def manifest_model_name(parts: tuple[str, ...]) -> str | None:
    """The model a manifest file belongs to, from its path under manifests/ (host/namespace/model/tag): the way Ollama names it,
    without the default host and the "library" namespace."""
    if len(parts) < 4:
        return None
    host, namespace, tag = parts[0], parts[1], parts[-1]
    path = list(parts[2:-1])
    if namespace != "library" or host != "registry.ollama.ai":
        path.insert(0, namespace)
        if host != "registry.ollama.ai":
            path.insert(0, host)
    return "/".join(path) + ":" + tag


def check_model_name(name: str) -> str:
    if not MODEL_NAME.match(name):
        raise InstanceError("invalid_model_name", f"Invalid model name: {name!r}", 422)
    return name


@dataclass
class PullTask:
    id: str
    model: str
    status: str = "pulling"  # pulling | paused | error | success
    status_text: str = ""
    completed: int = 0
    total: int = 0
    error: str | None = None
    started_at: float = field(default_factory=time.time)
    finished_at: float | None = None
    digests: list[str] = field(default_factory=list)  # layers seen so far (to find partial files)

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        del d["digests"]
        d["percent"] = round(100 * self.completed / self.total, 1) if self.total else None
        return d


DIGEST = re.compile(r"^(?:sha256:)?([0-9a-f]{64})$")
SAVE_INTERVAL = 3.0  # seconds between progress writes to the database


class ModelService:
    def __init__(self, manager: InstanceManager, hub: Hub, data_dir: Path):
        self.manager, self.hub = manager, hub
        self.store = StoreServer(manager, data_dir, lambda: any(t.status == "pulling" for t in self.tasks.values()))
        self.tasks: dict[str, PullTask] = {}
        self._jobs: dict[str, asyncio.Task] = {}
        self._client = httpx.AsyncClient(timeout=httpx.Timeout(15.0, read=None))
        self._restore()

    def _restore(self) -> None:
        """Downloads that were unfinished when the app last quit come back as paused cards."""
        for r in self.manager.db.query("SELECT model, completed, total, digests FROM downloads"):
            t = PullTask(id=uuid.uuid4().hex[:12], model=r["model"], status="paused", completed=r["completed"],
                         total=r["total"], digests=json.loads(r["digests"]))
            self.tasks[t.id] = t

    def _save(self, task: PullTask) -> None:
        self.manager.db.execute(
            "INSERT OR REPLACE INTO downloads (model, completed, total, digests) VALUES (?,?,?,?)",
            (task.model, task.completed, task.total, json.dumps(task.digests)),
        )

    # ---- helpers

    @staticmethod
    def _unreachable(e: Exception) -> InstanceError:
        return InstanceError("ollama_unreachable", f"Could not reach Ollama: {e}", 502)

    # ---- list / delete

    async def list(self) -> list[dict[str, Any]]:
        base = await self.store.base()
        try:
            r = await self._client.get(f"{base}/api/tags", timeout=15.0)
            r.raise_for_status()
        except httpx.HTTPError as e:
            raise self._unreachable(e) from e
        return [
            {"name": m.get("name"), "size": m.get("size", 0), "digest": m.get("digest"),
             "modified_at": m.get("modified_at"), "details": m.get("details", {})}
            for m in r.json().get("models", [])
        ]

    async def delete(self, name: str) -> None:
        check_model_name(name)
        base = await self.store.base()
        try:
            r = await self._client.request("DELETE", f"{base}/api/delete", json={"model": name}, timeout=30.0)
        except httpx.HTTPError as e:
            raise self._unreachable(e) from e
        if r.status_code == 404:
            raise InstanceError("model_not_found", f"Model not found: {name}", 404)
        if r.status_code >= 400:
            raise InstanceError("delete_failed", r.text[:200], 502)
        self.manager._log(0, "info", f"Deleted model {name}")

    # ---- details / derived models / storage

    async def show(self, name: str) -> dict[str, Any]:
        """What Ollama knows about one model: its settings, template, system prompt, license, abilities."""
        check_model_name(name)
        base = await self.store.base()
        try:
            r = await self._client.post(f"{base}/api/show", json={"model": name}, timeout=30.0)
        except httpx.HTTPError as e:
            raise self._unreachable(e) from e
        if r.status_code == 404:
            raise InstanceError("model_not_found", f"Model not found: {name}", 404)
        if r.status_code >= 400:
            raise InstanceError("show_failed", self._error_text(r.text), 502)
        d = r.json()
        info = d.get("model_info") or {}
        ctx = [v for k, v in info.items() if k.endswith(".context_length") and isinstance(v, int)]
        return {
            "name": name, "details": d.get("details") or {}, "parameters": parse_parameters(d.get("parameters") or ""),
            "system": d.get("system") or None, "template": d.get("template") or "", "license": d.get("license") or "",
            "modelfile": d.get("modelfile") or "", "capabilities": d.get("capabilities") or [], "context_length": ctx[0] if ctx else None,
        }

    async def create(self, name: str, source: str, parameters: dict[str, Any], system: str | None) -> None:
        """Makes `name` from the installed model `source`: the same weight files, other settings. An existing `name` is replaced."""
        check_model_name(name)
        check_model_name(source)
        base = await self.store.base()
        body: dict[str, Any] = {"model": name, "from": source, "stream": False}
        if parameters:
            body["parameters"] = parameters
        if system:
            body["system"] = system
        try:
            r = await self._client.post(f"{base}/api/create", json=body, timeout=httpx.Timeout(15.0, read=300.0))
        except httpx.HTTPError as e:
            raise self._unreachable(e) from e
        if r.status_code >= 400:
            msg = self._error_text(r.text)
            code, status = ("model_not_found", 404) if r.status_code == 404 else ("create_failed", 502)
            raise InstanceError(code, msg or f"Could not create {name}", status)
        self.manager._log(0, "info", f"Created model {name} from {source}")

    def storage(self) -> dict[str, Any]:
        """What the models really take on disk: the files the manifests point to, each counted once however many models share it."""
        root = self.store.models_dir()
        users: dict[str, set[str]] = {}  # digest -> the models that use the file
        sizes: dict[str, int] = {}
        manifests = root / "manifests"
        for f in manifests.rglob("*") if manifests.is_dir() else []:
            name = manifest_model_name(f.relative_to(manifests).parts) if f.is_file() else None
            if not name:
                continue
            try:
                m = json.loads(f.read_text("utf-8"))
            except (OSError, ValueError):
                continue
            for layer in [m.get("config")] + list(m.get("layers") or []):
                digest = (layer or {}).get("digest", "")
                if not digest:
                    continue
                users.setdefault(digest, set()).add(name)
                sizes[digest] = int((layer or {}).get("size", 0))
        blobs = root / "blobs"
        used: set[str] = set()
        for digest in users:
            blob = blobs / digest.replace(":", "-")
            try:
                sizes[digest] = blob.stat().st_size  # the real file; the manifest's number only when it is missing
            except OSError:
                pass
            used.add(blob.name)
        unused = 0
        for f in blobs.iterdir() if blobs.is_dir() else []:
            if f.name not in used:
                try:
                    unused += f.stat().st_size
                except OSError:
                    pass
        own: dict[str, int] = {}
        for digest, names in users.items():
            if len(names) == 1:
                (only,) = names
                own[only] = own.get(only, 0) + sizes[digest]
        names_all = {n for s in users.values() for n in s}
        return {
            "path": str(root), "bytes": sum(sizes[d] for d in users), "unused": unused,
            "models": {n: {"own": own.get(n, 0)} for n in sorted(names_all)},
        }

    # ---- pull

    def by_model(self, model: str) -> PullTask | None:
        return next((t for t in self.tasks.values() if t.model == model and t.status != "success"), None)

    def _get(self, task_id: str) -> PullTask:
        task = self.tasks.get(task_id)
        if task is None:
            raise InstanceError("not_found", "Download not found", 404)
        return task

    async def start_pull(self, model: str) -> tuple[PullTask, bool]:
        """Returns (task, created). A running download of the same model is reused; a paused one is resumed."""
        check_model_name(model)
        existing = self.by_model(model)
        if existing and existing.status == "pulling":
            return existing, False
        if existing:
            await self._launch(existing)
            return existing, True
        task = PullTask(id=uuid.uuid4().hex[:12], model=model)
        self.tasks[task.id] = task
        try:
            await self._launch(task)
        except InstanceError:
            self.tasks.pop(task.id, None)  # never started: no card
            raise
        self.manager._log(0, "info", f"Pull started: {model}")
        return task, True

    async def _launch(self, task: PullTask) -> None:
        task.status, task.error, task.finished_at = "pulling", None, None  # claims the task before the first await
        try:
            base = await self.store.base()
        except InstanceError:
            task.status = "paused"
            raise
        self._jobs[task.id] = asyncio.create_task(self._run(task, base))
        self._save(task)
        self._emit(task)

    async def _stop_job(self, task: PullTask) -> None:
        job = self._jobs.pop(task.id, None)
        if job:
            job.cancel()
            await asyncio.gather(job, return_exceptions=True)

    async def pause(self, task_id: str) -> PullTask:
        task = self._get(task_id)
        if task.status != "pulling":
            raise InstanceError("not_pulling", "The download is not running", 409)
        await self._stop_job(task)
        self._set_paused(task)
        self.manager._log(0, "info", f"Pull paused: {task.model}")
        return task

    def _set_paused(self, task: PullTask) -> None:
        task.status = "paused"
        self._save(task)
        self._emit(task)

    async def resume(self, task_id: str) -> PullTask:
        task = self._get(task_id)
        if task.status not in ("paused", "error"):
            raise InstanceError("not_paused", "The download is not paused", 409)
        await self._launch(task)
        self.manager._log(0, "info", f"Pull resumed: {task.model}")
        return task

    async def remove(self, task_id: str) -> None:
        """Stop the download if it is running, delete what was downloaded so far, and forget it."""
        task = self._get(task_id)
        await self._stop_job(task)
        if task.status != "success":
            self._remove_partials(task)
            self.manager._log(0, "info", f"Pull removed: {task.model}")
        self.manager.db.execute("DELETE FROM downloads WHERE model=?", (task.model,))
        self.tasks.pop(task.id, None)
        self.hub.publish({"type": "pull_removed", "id": task.id})

    def _remove_partials(self, task: PullTask) -> None:
        blobs = self.store.models_dir() / "blobs"
        for d in task.digests:
            m = DIGEST.match(d)
            if not m:
                continue
            for f in blobs.glob(f"sha256-{m.group(1)}-partial*"):
                try:
                    f.unlink()
                except OSError as e:
                    log.warning("Could not delete %s: %s", f, e)

    def list_tasks(self) -> list[dict[str, Any]]:
        return [t.to_dict() for t in sorted(self.tasks.values(), key=lambda t: t.started_at)]

    def _emit(self, task: PullTask) -> None:
        self.hub.publish({"type": "pull", "task": task.to_dict()})

    def _finish(self, task: PullTask, status: str, error: str | None = None) -> None:
        task.status, task.error, task.finished_at = status, error, time.time()
        self._jobs.pop(task.id, None)
        if status == "success":
            self.manager.db.execute("DELETE FROM downloads WHERE model=?", (task.model,))
        else:
            self._save(task)
        self._emit(task)
        done = sorted((t for t in self.tasks.values() if t.status == "success"), key=lambda t: t.finished_at or 0)
        for old in done[:-FINISHED_KEEP]:
            del self.tasks[old.id]

    async def _run(self, task: PullTask, base: str) -> None:
        layers: dict[str, tuple[int, int]] = {}  # digest -> (completed, total)
        last_emit = last_save = 0.0
        succeeded = False
        try:
            async with self._client.stream("POST", f"{base}/api/pull", json={"model": task.model, "stream": True}) as r:
                if r.status_code >= 400:
                    body = (await r.aread()).decode("utf-8", "replace")
                    raise RuntimeError(self._error_text(body) or f"HTTP {r.status_code}")
                async for line in r.aiter_lines():
                    if not line.strip():
                        continue
                    msg = json.loads(line)
                    if msg.get("error"):
                        raise RuntimeError(str(msg["error"]))
                    task.status_text = msg.get("status", task.status_text)
                    succeeded = succeeded or task.status_text == "success"
                    if msg.get("digest") and msg.get("total"):
                        if msg["digest"] not in task.digests:
                            task.digests.append(msg["digest"])
                        layers[msg["digest"]] = (int(msg.get("completed", 0)), int(msg["total"]))
                        task.completed = sum(c for c, _ in layers.values())
                        task.total = sum(t for _, t in layers.values())
                    now = time.monotonic()
                    if now - last_emit >= PROGRESS_INTERVAL:
                        last_emit = now
                        self._emit(task)
                    if now - last_save >= SAVE_INTERVAL:
                        last_save = now
                        self._save(task)
            if not succeeded:  # the stream just ended: the server stopped or crashed mid-download
                raise RuntimeError("Connection closed before the pull finished")
            if task.total:
                task.completed = task.total
            self._finish(task, "success")
            self.manager._log(0, "info", f"Pull finished: {task.model}")
        except asyncio.CancelledError:
            raise  # pause(), remove() and close() set the state themselves
        except (httpx.HTTPError, RuntimeError, ValueError) as e:
            msg = str(e) or e.__class__.__name__
            self._finish(task, "error", msg)
            self.manager._log(0, "warn", f"Pull failed: {task.model}: {msg}")

    @staticmethod
    def _error_text(body: str) -> str:
        try:
            return str(json.loads(body).get("error", ""))
        except ValueError:
            return body[:200]

    async def close(self) -> None:
        running = [t for t in self.tasks.values() if t.status == "pulling"]
        for t in running:
            await self._stop_job(t)
            self._set_paused(t)  # saved: it comes back as a paused card on the next start
        await self._client.aclose()
        await self.store.close()
