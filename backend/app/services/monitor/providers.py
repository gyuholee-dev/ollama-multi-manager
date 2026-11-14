"""GPU data sources. Everything platform-specific about GPUs lives behind GpuProvider."""
from __future__ import annotations

import logging
import sys
from dataclasses import asdict, dataclass, field, replace
from typing import Protocol

log = logging.getLogger("omm.monitor")

# pid -> {gpu_index: bytes used, or None when the driver does not report it}
ProcessVram = dict[int, dict[int, int | None]]
# pid -> {gpu_index: percent of the GPU's time the process used}
ProcessUtil = dict[int, dict[int, int]]


def full_support() -> dict[str, bool]:
    return {"mem": True, "util": True, "temp": True, "process": True, "process_util": True}


@dataclass
class GpuInfo:
    """One compute device as a provider reports it.

    `index` is the number the app shows (GPU-0, GPU-1, ...) and is assigned by the CompositeProvider across all
    vendors; `env_index` is the device's own number for its vendor's driver (CUDA_VISIBLE_DEVICES and the like).
    `select_env`, when a provider gives it, replaces the per-vendor variable in GPU_ENV (see build_env).
    `supports` says which readings this device can give at all, so the UI can tell "not supported" from "no value yet".
    `unified` marks memory shared with the CPU (Apple silicon, integrated graphics): there is no separate VRAM then.
    """

    index: int
    uuid: str
    name: str
    mem_total: int
    mem_used: int
    util_percent: int | None = None
    temperature_c: int | None = None
    vendor: str = ""
    kind: str = "gpu"  # gpu | npu
    unified: bool = False
    env_index: int | None = None
    select_env: dict[str, str] = field(default_factory=dict)  # the environment that makes Ollama use this device alone, when the vendor's variable cannot say it
    by_vulkan: bool = False  # Ollama reaches this device through Vulkan: build_env adds GGML_VK_VISIBLE_DEVICES with the device's Vulkan number
    supports: dict[str, bool] = field(default_factory=full_support)

    def to_dict(self) -> dict:
        return asdict(self)


class GpuProvider(Protocol):
    name: str

    def devices(self) -> list[GpuInfo]: ...

    def process_vram(self) -> ProcessVram | None:
        """Per-process VRAM, or None if this provider cannot tell."""

    def process_util(self) -> ProcessUtil | None:
        """Per-process GPU utilization, or None if this provider cannot tell."""

    def close(self) -> None: ...


class NullProvider:
    """No GPU support on this machine (e.g. Apple Silicon, no driver)."""

    name = "none"

    def devices(self) -> list[GpuInfo]:
        return []

    def process_vram(self) -> ProcessVram | None:
        return None

    def process_util(self) -> ProcessUtil | None:
        return None

    def close(self) -> None:
        pass


class NvmlProvider:
    name = "nvml"

    def __init__(self) -> None:
        import pynvml  # imported lazily: the module may be absent or fail to find the driver

        self._n = pynvml
        pynvml.nvmlInit()
        self._count = pynvml.nvmlDeviceGetCount()
        self._last_seen: dict[int, int] = {}  # per GPU: time stamp of the newest utilization sample taken

    def devices(self) -> list[GpuInfo]:
        n, out = self._n, []
        for i in range(self._count):
            h = n.nvmlDeviceGetHandleByIndex(i)
            mem = n.nvmlDeviceGetMemoryInfo(h)
            out.append(GpuInfo(
                vendor="nvidia", env_index=i,
                index=i,
                uuid=_s(n.nvmlDeviceGetUUID(h)),
                name=_s(n.nvmlDeviceGetName(h)),
                mem_total=int(mem.total),
                mem_used=int(mem.used),
                util_percent=self._try(lambda: int(n.nvmlDeviceGetUtilizationRates(h).gpu)),
                temperature_c=self._try(lambda: int(n.nvmlDeviceGetTemperature(h, n.NVML_TEMPERATURE_GPU))),
            ))
        return out

    def process_vram(self) -> ProcessVram | None:
        n, result = self._n, {}
        for i in range(self._count):
            h = n.nvmlDeviceGetHandleByIndex(i)
            for getter in (n.nvmlDeviceGetComputeRunningProcesses, n.nvmlDeviceGetGraphicsRunningProcesses):
                procs = self._try(lambda: getter(h)) or []
                for p in procs:
                    used = p.usedGpuMemory
                    # NVML_VALUE_NOT_AVAILABLE (Windows WDDM etc.) comes back as None or a huge sentinel.
                    value = int(used) if used is not None and used < 2**62 else None
                    cur = result.setdefault(int(p.pid), {})
                    if cur.get(i) is None:
                        cur[i] = value
        return result

    def process_util(self) -> ProcessUtil | None:
        """Per-process GPU use since the last call. None when no GPU can tell (older drivers, some Windows setups)."""
        n, result, answered = self._n, {}, False
        for i in range(self._count):
            h = n.nvmlDeviceGetHandleByIndex(i)
            try:
                samples = n.nvmlDeviceGetProcessUtilization(h, self._last_seen.get(i, 0))
            except getattr(n, "NVMLError_NotFound", ()):
                samples, answered = [], True  # nothing ran on this GPU since the last look
            except Exception:
                continue  # this GPU cannot tell
            else:
                answered = True
            for s in samples:
                self._last_seen[i] = max(self._last_seen.get(i, 0), int(s.timeStamp))
                result.setdefault(int(s.pid), {})[i] = max(0, min(100, int(s.smUtil)))
        return result if answered else None

    def close(self) -> None:
        self._try(self._n.nvmlShutdown)

    @staticmethod
    def _try(fn):
        try:
            return fn()
        except Exception:  # NVMLError subclasses vary by driver; any failure just means "not available"
            return None


def _s(v) -> str:
    return v.decode() if isinstance(v, bytes) else str(v)


class CompositeProvider:
    """Every provider that works on this machine, seen as one: devices are numbered across vendors, one after another."""

    def __init__(self, providers: list[GpuProvider]):
        self.providers = providers
        self.name = "+".join(p.name for p in providers) or "none"
        self._offsets: list[int] = []

    def devices(self) -> list[GpuInfo]:
        out: list[GpuInfo] = []
        self._offsets = []
        for p in self.providers:
            self._offsets.append(len(out))
            try:
                found = p.devices()
            except Exception:  # one vendor failing must not hide the others
                log.exception("GPU query failed (%s)", p.name)
                found = []
            for g in found:
                out.append(replace(g, index=len(out), env_index=g.index if g.env_index is None else g.env_index))
        return out

    def process_vram(self) -> ProcessVram | None:
        """Per-process VRAM merged over the providers that can tell; None when none can."""
        if not self._offsets:
            self.devices()
        merged: ProcessVram | None = None
        for p, off in zip(self.providers, self._offsets):
            try:
                table = p.process_vram()
            except Exception:
                log.exception("GPU per-process query failed (%s)", p.name)
                table = None
            if table is None:
                continue
            merged = merged if merged is not None else {}
            for pid, per_gpu in table.items():
                cur = merged.setdefault(pid, {})
                for gpu, used in per_gpu.items():
                    cur[gpu + off] = used
        return merged

    def process_util(self) -> ProcessUtil | None:
        if not self._offsets:
            self.devices()
        merged: ProcessUtil | None = None
        for p, off in zip(self.providers, self._offsets):
            try:
                table = p.process_util()
            except Exception:
                log.exception("GPU per-process utilization query failed (%s)", p.name)
                table = None
            if table is None:
                continue
            merged = merged if merged is not None else {}
            for pid, per_gpu in table.items():
                cur = merged.setdefault(pid, {})
                for gpu, pct in per_gpu.items():
                    cur[gpu + off] = pct
        return merged

    def close(self) -> None:
        for p in self.providers:
            try:
                p.close()
            except Exception:
                log.exception("Closing a GPU provider failed (%s)", p.name)


def detect_provider() -> GpuProvider:
    """Tries every vendor this machine could have; a vendor that is absent or fails is simply left out."""
    found: list[GpuProvider] = []
    for make in _candidates():
        try:
            p = make()
        except Exception as e:
            log.info("GPU provider unavailable: %s", e)
            continue
        log.info("GPU provider: %s", p.name)
        found.append(p)
    return CompositeProvider(found) if found else NullProvider()


def _candidates():
    yield NvmlProvider
    if sys.platform == "darwin":
        from .apple import AppleProvider
        yield AppleProvider
    if sys.platform.startswith("linux"):
        from .amd import AmdProvider
        yield AmdProvider
    if sys.platform.startswith("win"):
        from .windows import WindowsProvider
        yield WindowsProvider
