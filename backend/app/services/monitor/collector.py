"""Periodic metrics collection: system, GPUs, and per-instance CPU/RAM/VRAM/loaded models."""
from __future__ import annotations

import asyncio
import logging
import os
import time
from collections import deque
from typing import Any

import httpx
import psutil

from app.services.hub import Hub
from app.services.instances import Handle, InstanceManager
from app.services.monitor.providers import GpuProvider, ProcessVram
from app.services.settings import SettingsService

log = logging.getLogger("omm.monitor")


class Collector:
    def __init__(self, manager: InstanceManager, provider: GpuProvider, settings: SettingsService, hub: Hub, history: int = 600):
        self.manager, self.provider, self.settings, self.hub = manager, provider, settings, hub
        self.latest: dict[str, Any] | None = None
        self.history: deque = deque(maxlen=history)
        self._procs: dict[int, psutil.Process] = {}
        self._client = httpx.AsyncClient(timeout=2.0)
        psutil.cpu_percent(None)  # prime: the first call always returns 0.0

    async def run(self) -> None:
        """One collection at a time; the next starts only after the previous one finished."""
        while True:
            t0 = time.monotonic()
            try:
                snap = await self.collect()
                self.latest = snap
                self.history.append({"ts": snap["ts"], "cpu": snap["system"]["cpu_percent"], "mem": snap["system"]["mem_used"]})
                self.hub.publish({"type": "metrics", "data": snap})
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("Metrics collection failed")
            interval = self.settings.get("refresh_interval_seconds") or 3
            await asyncio.sleep(max(0.2, interval - (time.monotonic() - t0)))

    async def close(self) -> None:
        await self._client.aclose()
        await asyncio.to_thread(self.provider.close)

    async def collect(self) -> dict[str, Any]:
        system, gpus, pvram = await asyncio.gather(
            asyncio.to_thread(self._system),
            asyncio.to_thread(self._safe_devices),
            asyncio.to_thread(self._safe_process_vram),
        )
        handles = list(self.manager.handles.values())
        results = await asyncio.gather(*(self._instance(h, pvram) for h in handles), return_exceptions=True)
        instances: dict[str, Any] = {}
        seen: set[int] = set()
        for h, res in zip(handles, results):
            if isinstance(res, Exception):
                log.warning("Collecting %s failed: %r", h.name, res)
                continue
            instances[str(h.iid)] = res.pop("_data")
            seen |= res["pids"]
        for pid in set(self._procs) - seen:
            del self._procs[pid]
        return {
            "ts": time.time(),
            "system": system,
            "gpu": {"provider": self.provider.name, "devices": [g.to_dict() for g in gpus]},
            "instances": instances,
        }

    # ---- system

    def _system(self) -> dict[str, Any]:
        vm = psutil.virtual_memory()
        path = os.path.expanduser(self.settings.get("default_models_path") or "~")
        try:
            du = psutil.disk_usage(path if os.path.exists(path) else os.path.expanduser("~"))
            disk = {"disk_total": du.total, "disk_used": du.used}
        except OSError:
            disk = {"disk_total": None, "disk_used": None}
        return {"cpu_percent": psutil.cpu_percent(None), "mem_total": vm.total, "mem_used": vm.total - vm.available, **disk}

    def _safe_devices(self):
        try:
            return self.provider.devices()
        except Exception:
            log.exception("GPU query failed")
            return []

    def _safe_process_vram(self) -> ProcessVram | None:
        try:
            return self.provider.process_vram()
        except Exception:
            log.exception("GPU per-process query failed")
            return None

    # ---- per instance

    async def _instance(self, h: Handle, pvram: ProcessVram | None) -> dict[str, Any]:
        (models, responsive), (pids, cpu, rss) = await asyncio.gather(
            self._api_ps(h.port), asyncio.to_thread(self._proc_stats, h.ps)
        )
        vram, by_gpu, source = self._attribute_vram(pids, pvram, models, responsive)
        data = {
            "state": h.state, "pid": h.ps.pid, "responsive": responsive,
            "cpu_percent": round(cpu, 1), "rss": rss,
            "vram_bytes": vram, "vram_by_gpu": by_gpu, "vram_source": source,
            "models": models,
        }
        return {"_data": data, "pids": set(pids)}

    async def _api_ps(self, port: int) -> tuple[list[dict[str, Any]], bool]:
        try:
            r = await self._client.get(f"http://127.0.0.1:{port}/api/ps")
            r.raise_for_status()
            models = [
                {"name": m.get("name"), "size": m.get("size", 0), "size_vram": m.get("size_vram", 0), "expires_at": m.get("expires_at")}
                for m in r.json().get("models", [])
            ]
            return models, True
        except (httpx.HTTPError, ValueError):
            return [], False

    def _proc_stats(self, ps: psutil.Process) -> tuple[list[int], float, int]:
        """CPU% and RSS summed over the instance's whole process tree (server + runners)."""
        try:
            procs = [ps, *ps.children(recursive=True)]
        except psutil.Error:
            return [], 0.0, 0
        pids, cpu, rss = [], 0.0, 0
        for p in procs:
            cached = self._procs.get(p.pid)
            if cached is None or cached != p:  # psutil equality includes the creation time (PID reuse)
                cached = self._procs[p.pid] = p
            try:
                cpu += cached.cpu_percent(None)
                rss += cached.memory_info().rss
                pids.append(p.pid)
            except psutil.Error:
                continue
        return pids, cpu, rss

    @staticmethod
    def _attribute_vram(pids: list[int], pvram: ProcessVram | None, models: list[dict], responsive: bool):
        """NVML per-process numbers first; fall back to Ollama's own size_vram, marked 'estimated'."""
        estimate = sum(m["size_vram"] for m in models)
        if pvram is not None:
            by_gpu: dict[int, int] = {}
            unavailable = False
            for pid in pids:
                for gpu, used in pvram.get(pid, {}).items():
                    if used is None:
                        unavailable = True
                    else:
                        by_gpu[gpu] = by_gpu.get(gpu, 0) + used
            total = sum(by_gpu.values())
            # NVML saw nothing although Ollama reports GPU memory: PIDs are not visible (container/WDDM).
            if not unavailable and not (total == 0 and estimate > 0):
                return total, {str(g): b for g, b in by_gpu.items()}, "nvml"
        if responsive:
            return estimate, {}, "estimated"
        return None, {}, None
