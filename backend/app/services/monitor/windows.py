"""Non-NVIDIA GPUs on Windows (AMD, Intel; integrated graphics above all) through the system's own counters; no vendor tool.

NVIDIA cards are left to NVML. Three sources, none of which needs special rights:

    registry  HKLM\\SOFTWARE\\Microsoft\\DirectX\\<guid>   name, vendor, DedicatedVideoMemory, SharedSystemMemory, AdapterLuid
    PDH       \\GPU Adapter Memory(luid_*)\\Dedicated Usage / Shared Usage          memory in use per adapter
              \\GPU Engine(pid_*_luid_*_eng_*_engtype_*)\\Utilization Percentage    time in use per process and engine
              \\GPU Process Memory(pid_*_luid_*)\\Dedicated Usage / Shared Usage    memory in use per process

The counters name an adapter by its LUID, the registry says which LUID belongs to which card. An integrated GPU has only a small
dedicated carve-out and uses ordinary system memory (shared) for the rest: it is reported as unified memory with both added
together, like AmdProvider does for Linux. Temperature is not offered by this interface.
The registry layout and the counter names are as Windows documents them but have not been checked on real hardware yet
(see PdhCounters and read_adapters, the only two places that touch Windows).
"""
from __future__ import annotations

import logging
import re
import sys
import time
from typing import Callable, Protocol

from .providers import GpuInfo, ProcessUtil, ProcessVram

log = logging.getLogger("omm.monitor")

NVIDIA = 0x10DE
MICROSOFT = 0x1414  # the software renderer "Microsoft Basic Render Driver"
VENDORS = {0x1002: "amd", 0x8086: "intel"}
UNIFIED_BELOW = 4 * 2**30  # a dedicated carve-out smaller than this means an integrated GPU
CACHE_SECONDS = 0.5  # the monitor asks devices, process_vram and process_util one after another: one sampling serves all three

LUID = re.compile(r"luid_0x([0-9a-f]{8})_0x([0-9a-f]{8})", re.I)
ENGINE = re.compile(r"pid_(\d+)_luid_(0x[0-9a-f]{8}_0x[0-9a-f]{8})_phys_\d+_eng_\d+_engtype_(.+)$", re.I)
PROCESS = re.compile(r"pid_(\d+)_luid_(0x[0-9a-f]{8}_0x[0-9a-f]{8})_phys_\d+$", re.I)


def luid_key(value: int) -> str:
    """The form the counters use for an adapter number: '0x00000000_0x0000a1b2' (lower case for comparing)."""
    return f"0x{(value >> 32) & 0xFFFFFFFF:08x}_0x{value & 0xFFFFFFFF:08x}"


def luid_of(instance: str) -> str | None:
    m = LUID.search(instance)
    return f"0x{m.group(1)}_0x{m.group(2)}".lower() if m else None


class Counters(Protocol):
    def read(self, path: str) -> dict[str, float]:
        """Every instance of a counter, e.g. r'\\GPU Engine(*)\\Utilization Percentage' -> {instance name: value}."""

    def close(self) -> None: ...


class Adapter:
    def __init__(self, name: str, vendor: int, luid: int, dedicated: int, shared: int):
        self.name, self.vendor, self.luid, self.dedicated, self.shared = name, vendor, luid, dedicated, shared

    @property
    def key(self) -> str:
        return luid_key(self.luid)

    @property
    def unified(self) -> bool:
        return self.dedicated < UNIFIED_BELOW


def read_adapters() -> list[Adapter]:
    """The graphics adapters Windows has recorded (stale entries of removed cards included: the caller filters by the live counters)."""
    import winreg

    out: list[Adapter] = []
    with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\DirectX") as root:
        i = 0
        while True:
            try:
                sub = winreg.EnumKey(root, i)
            except OSError:
                break
            i += 1
            try:
                with winreg.OpenKey(root, sub) as k:
                    def get(name, default=0):
                        try:
                            return winreg.QueryValueEx(k, name)[0]
                        except OSError:
                            return default

                    luid = get("AdapterLuid", None)
                    if luid is None:
                        continue
                    out.append(Adapter(str(get("Description", "") or "GPU"), int(get("VendorId")), int(luid),
                                       int(get("DedicatedVideoMemory")), int(get("SharedSystemMemory"))))
            except OSError:
                continue
    return out


class PdhCounters:
    """Performance counters through pdh.dll. A query is built per reading: processes come and go, and a wildcard is expanded only when added."""

    PDH_MORE_DATA = 0x800007D2
    FMT_DOUBLE = 0x00000200

    def __init__(self, pause: float = 0.1):
        import ctypes
        from ctypes import wintypes

        self.ct, self.wt, self.pause = ctypes, wintypes, pause
        self.pdh = ctypes.WinDLL("pdh")

        class Value(ctypes.Union):
            _fields_ = [("doubleValue", ctypes.c_double), ("largeValue", ctypes.c_longlong)]

        class Fmt(ctypes.Structure):
            _fields_ = [("CStatus", wintypes.DWORD), ("v", Value)]

        class Item(ctypes.Structure):
            _fields_ = [("szName", wintypes.LPWSTR), ("FmtValue", Fmt)]

        self.Item = Item

    def read(self, path: str) -> dict[str, float]:
        ct, pdh = self.ct, self.pdh
        query = ct.c_void_p()
        if pdh.PdhOpenQueryW(None, 0, ct.byref(query)) != 0:
            raise OSError("PdhOpenQuery failed")
        try:
            counter = ct.c_void_p()
            if pdh.PdhAddEnglishCounterW(query, path, 0, ct.byref(counter)) != 0:
                raise OSError(f"counter not available: {path}")
            pdh.PdhCollectQueryData(query)
            time.sleep(self.pause)  # a percentage needs two samples
            pdh.PdhCollectQueryData(query)
            size, count = self.wt.DWORD(0), self.wt.DWORD(0)
            rc = pdh.PdhGetFormattedCounterArrayW(counter, self.FMT_DOUBLE, ct.byref(size), ct.byref(count), None)
            if rc & 0xFFFFFFFF != self.PDH_MORE_DATA:
                return {}
            buf = ct.create_string_buffer(size.value)
            rc = pdh.PdhGetFormattedCounterArrayW(counter, self.FMT_DOUBLE, ct.byref(size), ct.byref(count), buf)
            if rc != 0:
                return {}
            items = ct.cast(buf, ct.POINTER(self.Item))
            out: dict[str, float] = {}
            for n in range(count.value):
                it = items[n]
                if it.FmtValue.CStatus in (0, 1):  # PDH_CSTATUS_VALID_DATA, NEW_DATA
                    out[it.szName] = it.FmtValue.v.doubleValue
            return out
        finally:
            pdh.PdhCloseQuery(query)

    def close(self) -> None:
        pass


class WindowsProvider:
    name = "windows"

    def __init__(self, counters: Counters | None = None, adapters: Callable[[], list[Adapter]] | None = None, clock: Callable[[], float] = time.monotonic):
        if not sys.platform.startswith("win") and counters is None:
            raise RuntimeError("not Windows")
        self.counters = counters or PdhCounters()
        self.clock = clock
        live = {luid_of(inst) for inst in self.counters.read(r"\GPU Adapter Memory(*)\Dedicated Usage")}
        known = (adapters or read_adapters)()
        self.cards = [a for a in known if a.key in live and a.vendor in VENDORS]  # NVIDIA is NVML's, the software renderer is no GPU
        if not self.cards:
            raise RuntimeError("no AMD or Intel GPU")
        self.cards.sort(key=lambda a: (not a.unified, a.name))
        self._cache: tuple[float, dict] | None = None

    def _sample(self) -> dict:
        now = self.clock()
        if self._cache and now - self._cache[0] < CACHE_SECONDS:
            return self._cache[1]
        c = self.counters
        data = {
            "dedicated": c.read(r"\GPU Adapter Memory(*)\Dedicated Usage"),
            "shared": c.read(r"\GPU Adapter Memory(*)\Shared Usage"),
            "engines": c.read(r"\GPU Engine(*)\Utilization Percentage"),
            "pdedicated": self._try(r"\GPU Process Memory(*)\Dedicated Usage"),
            "pshared": self._try(r"\GPU Process Memory(*)\Shared Usage"),
        }
        self._cache = (now, data)
        return data

    def _try(self, path: str) -> dict[str, float] | None:
        try:
            return self.counters.read(path)
        except Exception:
            return None

    def _slot(self, key: str) -> int | None:
        return next((i for i, a in enumerate(self.cards) if a.key == key.lower()), None)

    def devices(self) -> list[GpuInfo]:
        s = self._sample()
        used: dict[str, float] = {}
        for src in ("dedicated", "shared"):
            for inst, v in s[src].items():
                key = luid_of(inst)
                slot = self._slot(key) if key else None
                if slot is not None and (src == "dedicated" or self.cards[slot].unified):
                    used[key] = used.get(key, 0) + v
        busy = self._device_util(s["engines"])
        out = []
        for i, a in enumerate(self.cards):
            total = a.dedicated + (a.shared if a.unified else 0)
            out.append(GpuInfo(
                index=i, uuid=f"win-{a.key}", name=a.name, mem_total=total, mem_used=min(int(used.get(a.key, 0)), total),
                util_percent=busy.get(a.key, 0), temperature_c=None, vendor=VENDORS[a.vendor], unified=a.unified, env_index=i, select_env=self._select_env(a),
                supports={"mem": True, "util": True, "temp": False, "process": True, "process_util": True},
            ))
        return out

    @staticmethod
    def _select_env(a: Adapter) -> dict[str, str]:
        """Ollama leaves integrated graphics out unless told otherwise, and shows the NVIDIA card first: hide it and allow the iGPU.
        (This is what was tried by hand with `ollama serve`: the Vulkan device was used. Which Vulkan number a card has is not
        the number here, so no device list is given.)"""
        env = {"CUDA_VISIBLE_DEVICES": "-1"}
        if a.unified:
            env["OLLAMA_IGPU_ENABLE"] = "1"
        return env

    def _device_util(self, engines: dict[str, float]) -> dict[str, int]:
        """Task Manager's rule: per engine type add the engines up, then show the busiest type."""
        sums: dict[tuple[str, str], float] = {}
        for inst, v in engines.items():
            m = ENGINE.search(inst)
            if m:
                k = (m.group(2).lower(), m.group(3).lower())
                sums[k] = sums.get(k, 0) + v
        out: dict[str, int] = {}
        for (luid, _type), v in sums.items():
            out[luid] = min(100, max(out.get(luid, 0), round(v)))
        return out

    def process_vram(self) -> ProcessVram | None:
        s = self._sample()
        if s["pdedicated"] is None:
            return None
        result: ProcessVram = {}
        for src in ("pdedicated", "pshared"):
            for inst, v in (s[src] or {}).items():
                m = PROCESS.search(inst)
                slot = self._slot(m.group(2)) if m else None
                if m is None or slot is None or (src == "pshared" and not self.cards[slot].unified):
                    continue
                cur = result.setdefault(int(m.group(1)), {})
                cur[slot] = cur.get(slot, 0) + int(v)
        return result

    def process_util(self) -> ProcessUtil | None:
        s = self._sample()
        sums: dict[tuple[int, int, str], float] = {}
        for inst, v in s["engines"].items():
            m = ENGINE.search(inst)
            slot = self._slot(m.group(2)) if m else None
            if m is None or slot is None:
                continue
            k = (int(m.group(1)), slot, m.group(3).lower())
            sums[k] = sums.get(k, 0) + v
        result: ProcessUtil = {}
        for (pid, slot, _type), v in sums.items():
            cur = result.setdefault(pid, {})
            cur[slot] = min(100, max(cur.get(slot, 0), round(v)))
        return {pid: per for pid, per in result.items() if any(per.values())}

    def close(self) -> None:
        self.counters.close()
