"""The CPU's model name, for the monitor and the device list (psutil gives only counts)."""
from __future__ import annotations

import functools
import logging
import subprocess
import sys

log = logging.getLogger("omm.monitor")


def _windows() -> str:
    import winreg  # only on Windows
    with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r"HARDWARE\DESCRIPTION\System\CentralProcessor\0") as key:
        return str(winreg.QueryValueEx(key, "ProcessorNameString")[0])


def _darwin() -> str:
    """Also the name of an Apple silicon chip ("Apple M4 Pro")."""
    return subprocess.run(["sysctl", "-n", "machdep.cpu.brand_string"], capture_output=True, text=True, timeout=3, check=True).stdout


def _linux() -> str:
    names: dict[str, str] = {}
    with open("/proc/cpuinfo", encoding="utf-8", errors="replace") as f:
        for line in f:
            key, _, value = line.partition(":")
            names.setdefault(key.strip(), value.strip())
    return names.get("model name") or names.get("Model") or ""


def clean(name: str) -> str:
    """The name on one line with single spaces (the registry and /proc/cpuinfo pad it)."""
    return " ".join(name.split())


@functools.lru_cache(maxsize=1)
def cpu_name() -> str:
    """"" when the system does not say: the screens then show just "CPU"."""
    read = _windows if sys.platform.startswith("win") else _darwin if sys.platform == "darwin" else _linux
    try:
        return clean(read())
    except Exception as e:  # an unreadable name must not stop the monitor
        log.info("CPU name unavailable: %s", e)
        return ""
