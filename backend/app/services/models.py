"""Model management: proxies Ollama's /api/tags, /api/pull, /api/delete per instance.

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
from dataclasses import asdict, dataclass, field
from typing import Any

import httpx

from app.services.hub import Hub
from app.services.instances import InstanceError, InstanceManager

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
    instance: int
    model: str
    status: str = "pulling"  # pulling | success | error | cancelled
    status_text: str = ""
    completed: int = 0
    total: int = 0
    error: str | None = None
    started_at: float = field(default_factory=time.time)
    finished_at: float | None = None

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["percent"] = round(100 * self.completed / self.total, 1) if self.total else None
        return d


class ModelService:
    def __init__(self, manager: InstanceManager, hub: Hub):
        self.manager, self.hub = manager, hub
        self.tasks: dict[str, PullTask] = {}
        self._jobs: dict[str, asyncio.Task] = {}
        self._client = httpx.AsyncClient(timeout=httpx.Timeout(15.0, read=None))

    # ---- helpers

    def _base(self, iid: int) -> str:
        self.manager._row(iid)  # 404 if the instance does not exist
        h = self.manager.handles.get(iid)
        if h is None or h.state != "running":
            raise InstanceError("not_running", "The instance must be running to manage its models", 409)
        return f"http://127.0.0.1:{h.port}"

    @staticmethod
    def _unreachable(e: Exception) -> InstanceError:
        return InstanceError("ollama_unreachable", f"Could not reach Ollama: {e}", 502)

    # ---- list / delete

    async def list(self, iid: int) -> list[dict[str, Any]]:
        base = self._base(iid)
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

    async def delete(self, iid: int, name: str) -> None:
        check_model_name(name)
        base = self._base(iid)
        try:
            r = await self._client.request("DELETE", f"{base}/api/delete", json={"model": name}, timeout=30.0)
        except httpx.HTTPError as e:
            raise self._unreachable(e) from e
        if r.status_code == 404:
            raise InstanceError("model_not_found", f"Model not found: {name}", 404)
        if r.status_code >= 400:
            raise InstanceError("delete_failed", r.text[:200], 502)
        self.manager._log(iid, "info", f"Deleted model {name}")

    # ---- pull

    def active(self, iid: int, model: str) -> PullTask | None:
        for t in self.tasks.values():
            if t.status == "pulling" and t.instance == iid and t.model == model:
                return t
        return None

    def start_pull(self, iid: int, model: str) -> tuple[PullTask, bool]:
        """Returns (task, created). Pulling the same model twice on one instance reuses the running task."""
        check_model_name(model)
        base = self._base(iid)
        existing = self.active(iid, model)
        if existing:
            return existing, False
        task = PullTask(id=uuid.uuid4().hex[:12], instance=iid, model=model)
        self.tasks[task.id] = task
        self._jobs[task.id] = asyncio.create_task(self._run(task, base))
        self.manager._log(iid, "info", f"Pull started: {model}")
        self._emit(task)
        return task, True

    async def cancel(self, task_id: str) -> None:
        task = self.tasks.get(task_id)
        if task is None:
            raise InstanceError("not_found", "Pull task not found", 404)
        job = self._jobs.get(task_id)
        if task.status == "pulling" and job:
            job.cancel()
            await asyncio.gather(job, return_exceptions=True)

    def list_tasks(self) -> list[dict[str, Any]]:
        return [t.to_dict() for t in sorted(self.tasks.values(), key=lambda t: t.started_at)]

    def _emit(self, task: PullTask) -> None:
        self.hub.publish({"type": "pull", "task": task.to_dict()})

    def _finish(self, task: PullTask, status: str, error: str | None = None) -> None:
        task.status, task.error, task.finished_at = status, error, time.time()
        self._jobs.pop(task.id, None)
        self._emit(task)
        finished = sorted((t for t in self.tasks.values() if t.status != "pulling"), key=lambda t: t.finished_at or 0)
        for old in finished[:-FINISHED_KEEP]:
            del self.tasks[old.id]

    async def _run(self, task: PullTask, base: str) -> None:
        layers: dict[str, tuple[int, int]] = {}  # digest -> (completed, total)
        last_emit = 0.0
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
                        layers[msg["digest"]] = (int(msg.get("completed", 0)), int(msg["total"]))
                        task.completed = sum(c for c, _ in layers.values())
                        task.total = sum(t for _, t in layers.values())
                    now = time.monotonic()
                    if now - last_emit >= PROGRESS_INTERVAL:
                        last_emit = now
                        self._emit(task)
            if not succeeded:  # the stream just ended: the instance stopped or crashed mid-download
                raise RuntimeError("Connection closed before the pull finished")
            if task.total:
                task.completed = task.total
            self._finish(task, "success")
            self.manager._log(task.instance, "info", f"Pull finished: {task.model}")
        except asyncio.CancelledError:
            self._finish(task, "cancelled")
            self.manager._log(task.instance, "info", f"Pull cancelled: {task.model}")
            raise
        except (httpx.HTTPError, RuntimeError, ValueError) as e:
            msg = str(e) or e.__class__.__name__
            self._finish(task, "error", msg)
            self.manager._log(task.instance, "warn", f"Pull failed: {task.model}: {msg}")

    @staticmethod
    def _error_text(body: str) -> str:
        try:
            return str(json.loads(body).get("error", ""))
        except ValueError:
            return body[:200]

    async def close(self) -> None:
        for job in list(self._jobs.values()):
            job.cancel()
        await asyncio.gather(*self._jobs.values(), return_exceptions=True)
        await self._client.aclose()
