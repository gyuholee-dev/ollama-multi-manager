"""Apple silicon: the GPU shares the CPU's memory, and none of this needs administrator rights.

- chip name, memory size:   sysctl
- GPU memory limit:         Metal's recommendedMaxWorkingSetSize (how much of the shared memory the GPU may use)
- GPU use and memory:       the IOAccelerator entry's PerformanceStatistics (`ioreg`), the same numbers Activity Monitor shows
- temperature:              the on-die sensors ("PMU tdie*") read through IOKit's HID event system

The last two are not documented by Apple and may change with macOS; whatever cannot be read is reported as missing
(None) and flagged in `supports`, never faked. Per-process GPU memory does not exist on this platform, so the
instances' share is estimated from what Ollama reports (see Collector._attribute_vram).
"""
from __future__ import annotations

import ctypes
import ctypes.util
import logging
import platform
import re
import subprocess
from typing import Callable

from .providers import GpuInfo, ProcessVram

log = logging.getLogger("omm.monitor")

GIB = 2**30
_UTIL = re.compile(r'"Device Utilization %"=(\d+)')
_USED = re.compile(r'"In use system memory"=(\d+)')


def parse_ioreg(text: str) -> tuple[int | None, int | None]:
    """(GPU utilization %, GPU memory in use in bytes) from `ioreg -r -d 1 -w0 -c IOAccelerator`; None for what is missing."""
    util, used = _UTIL.search(text), _USED.search(text)
    return (min(100, int(util.group(1))) if util else None), (int(used.group(1)) if used else None)


def default_gpu_limit(total: int) -> int:
    """macOS lets the GPU wire about two thirds of the memory (three quarters above 36 GiB) unless the user changed it."""
    return int(total * (0.75 if total > 36 * GIB else 2 / 3))


def die_temperature(readings: list[tuple[str, float]]) -> float | None:
    """The hottest valid die sensor. Some sensors report absurd values (-9000) while idle: those are dropped."""
    hot = [v for name, v in readings if name.startswith("PMU tdie") and 0 < v < 150]
    return max(hot) if hot else None


def _run(cmd: list[str]) -> str:
    return subprocess.run(cmd, capture_output=True, text=True, timeout=5, check=False).stdout


def _metal_limit() -> int | None:
    """recommendedMaxWorkingSetSize of the default Metal device, called through the Objective-C runtime."""
    try:
        metal = ctypes.CDLL("/System/Library/Frameworks/Metal.framework/Metal")
        objc = ctypes.CDLL(ctypes.util.find_library("objc"))
        metal.MTLCreateSystemDefaultDevice.restype = ctypes.c_void_p
        dev = metal.MTLCreateSystemDefaultDevice()
        if not dev:
            return None
        objc.sel_registerName.restype = ctypes.c_void_p
        objc.sel_registerName.argtypes = [ctypes.c_char_p]
        send = ctypes.CFUNCTYPE(ctypes.c_uint64, ctypes.c_void_p, ctypes.c_void_p)(("objc_msgSend", objc))
        return int(send(dev, objc.sel_registerName(b"recommendedMaxWorkingSetSize"))) or None
    except Exception:
        log.info("Metal could not be queried", exc_info=True)
        return None


class HidTemperatures:
    """Temperature sensors through IOKit's HID event system (private but exported; no special rights needed)."""

    def __init__(self) -> None:
        cf = ctypes.CDLL(ctypes.util.find_library("CoreFoundation"))
        io = ctypes.CDLL(ctypes.util.find_library("IOKit"))
        vp = ctypes.c_void_p
        cf.CFStringCreateWithCString.restype = vp
        cf.CFStringCreateWithCString.argtypes = [vp, ctypes.c_char_p, ctypes.c_uint32]
        cf.CFNumberCreate.restype = vp
        cf.CFNumberCreate.argtypes = [vp, ctypes.c_int, ctypes.c_void_p]
        cf.CFDictionaryCreate.restype = vp
        cf.CFDictionaryCreate.argtypes = [vp, ctypes.POINTER(vp), ctypes.POINTER(vp), ctypes.c_long, vp, vp]
        cf.CFArrayGetCount.restype = ctypes.c_long
        cf.CFArrayGetCount.argtypes = [vp]
        cf.CFArrayGetValueAtIndex.restype = vp
        cf.CFArrayGetValueAtIndex.argtypes = [vp, ctypes.c_long]
        cf.CFStringGetCString.argtypes = [vp, ctypes.c_char_p, ctypes.c_long, ctypes.c_uint32]
        cf.CFRelease.argtypes = [vp]
        io.IOHIDEventSystemClientCreate.restype = vp
        io.IOHIDEventSystemClientCreate.argtypes = [vp]
        io.IOHIDEventSystemClientSetMatching.argtypes = [vp, vp]
        io.IOHIDEventSystemClientCopyServices.restype = vp
        io.IOHIDEventSystemClientCopyServices.argtypes = [vp]
        io.IOHIDServiceClientCopyProperty.restype = vp
        io.IOHIDServiceClientCopyProperty.argtypes = [vp, vp]
        io.IOHIDServiceClientCopyEvent.restype = vp
        io.IOHIDServiceClientCopyEvent.argtypes = [vp, ctypes.c_int64, ctypes.c_int32, ctypes.c_int64]
        io.IOHIDEventGetFloatValue.restype = ctypes.c_double
        io.IOHIDEventGetFloatValue.argtypes = [vp, ctypes.c_int32]
        self._cf, self._io = cf, io

        def s(text: str):
            return cf.CFStringCreateWithCString(None, text.encode(), 0x08000100)

        def n(v: int):
            x = ctypes.c_int32(v)
            return cf.CFNumberCreate(None, 9, ctypes.byref(x))

        keys, vals = (vp * 2)(s("PrimaryUsagePage"), s("PrimaryUsage")), (vp * 2)(n(0xFF00), n(5))
        match = cf.CFDictionaryCreate(None, keys, vals, 2, None, None)
        self._client = io.IOHIDEventSystemClientCreate(None)
        io.IOHIDEventSystemClientSetMatching(self._client, match)
        self._services = io.IOHIDEventSystemClientCopyServices(self._client)
        product = s("Product")
        self._sensors: list[tuple[str, int]] = []
        for i in range(cf.CFArrayGetCount(self._services)):
            svc = cf.CFArrayGetValueAtIndex(self._services, i)
            raw = io.IOHIDServiceClientCopyProperty(svc, product)
            buf = ctypes.create_string_buffer(128)
            name = buf.value.decode(errors="replace") if raw and cf.CFStringGetCString(raw, buf, 128, 0x08000100) else ""
            if raw:
                cf.CFRelease(raw)
            self._sensors.append((name, svc))

    def read(self) -> list[tuple[str, float]]:
        out: list[tuple[str, float]] = []
        for name, svc in self._sensors:
            ev = self._io.IOHIDServiceClientCopyEvent(svc, 15, 0, 0)  # 15 = temperature event
            if ev:
                out.append((name, float(self._io.IOHIDEventGetFloatValue(ev, 15 << 16))))
                self._cf.CFRelease(ev)
        return out


class AppleProvider:
    name = "apple"

    def __init__(self, run: Callable[[list[str]], str] = _run, metal_limit: Callable[[], int | None] = _metal_limit,
                 temperatures: Callable[[], list[tuple[str, float]]] | None = None):
        if platform.system() != "Darwin" or platform.machine() != "arm64":
            raise RuntimeError("not Apple silicon")  # an Intel Mac's GPU is not used by Ollama
        self._run = run
        self.chip = (run(["sysctl", "-n", "machdep.cpu.brand_string"]).strip() or "Apple GPU")
        total = int(run(["sysctl", "-n", "hw.memsize"]).strip() or 0)
        self.limit = metal_limit() or default_gpu_limit(total)
        if temperatures is None:
            try:
                temperatures = HidTemperatures().read
            except Exception:
                log.info("Temperature sensors are not available", exc_info=True)
        self._temps = temperatures
        util, used = parse_ioreg(run(["ioreg", "-r", "-d", "1", "-w0", "-c", "IOAccelerator"]))
        if util is None and used is None:
            raise RuntimeError("no GPU statistics")
        self.supports = {"mem": used is not None, "util": util is not None, "temp": self._read_temp() is not None, "process": False}

    def _read_temp(self) -> int | None:
        if self._temps is None:
            return None
        try:
            t = die_temperature(self._temps())
        except Exception:
            return None
        return round(t) if t is not None else None

    def devices(self) -> list[GpuInfo]:
        util, used = parse_ioreg(self._run(["ioreg", "-r", "-d", "1", "-w0", "-c", "IOAccelerator"]))
        return [GpuInfo(
            index=0, uuid="apple-gpu-0", name=self.chip, mem_total=self.limit, mem_used=used or 0,
            util_percent=util, temperature_c=self._read_temp(),
            vendor="apple", unified=True, env_index=0, supports=dict(self.supports),
        )]

    def process_vram(self) -> ProcessVram | None:
        return None

    def close(self) -> None:
        pass
