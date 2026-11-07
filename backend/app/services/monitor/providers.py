"""GPU data sources. Everything platform-specific about GPUs lives behind GpuProvider."""
from __future__ import annotations

import logging
from dataclasses import asdict, dataclass
from typing import Protocol

log = logging.getLogger("omm.monitor")

# pid -> {gpu_index: bytes used, or None when the driver does not report it}
ProcessVram = dict[int, dict[int, int | None]]


@dataclass
class GpuInfo:
    index: int
    uuid: str
    name: str
    mem_total: int
    mem_used: int
    util_percent: int | None = None
    temperature_c: int | None = None

    def to_dict(self) -> dict:
        return asdict(self)


class GpuProvider(Protocol):
    name: str

    def devices(self) -> list[GpuInfo]: ...

    def process_vram(self) -> ProcessVram | None:
        """Per-process VRAM, or None if this provider cannot tell."""

    def close(self) -> None: ...


class NullProvider:
    """No GPU support on this machine (e.g. Apple Silicon, no driver)."""

    name = "none"

    def devices(self) -> list[GpuInfo]:
        return []

    def process_vram(self) -> ProcessVram | None:
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

    def devices(self) -> list[GpuInfo]:
        n, out = self._n, []
        for i in range(self._count):
            h = n.nvmlDeviceGetHandleByIndex(i)
            mem = n.nvmlDeviceGetMemoryInfo(h)
            out.append(GpuInfo(
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


def detect_provider() -> GpuProvider:
    try:
        p = NvmlProvider()
        log.info("GPU provider: NVML (%d device(s))", p._count)
        return p
    except Exception as e:
        log.info("GPU provider: none (%s)", e)
        return NullProvider()
