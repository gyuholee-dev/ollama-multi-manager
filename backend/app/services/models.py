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
        self.store.touch()
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
        self.store.touch()
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
