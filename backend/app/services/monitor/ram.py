"""The memory's kind for the monitor ("LPDDR5 · Hynix", "DDR5-6000"): what the system gives without administrator rights.

macOS and Windows tell it; Linux does not (the type is in the SMBIOS tables that only root reads), so there it stays empty and the monitor shows
the capacity instead."""
from __future__ import annotations

import logging
import subprocess
import sys
import threading

log = logging.getLogger("omm.monitor")

# SMBIOS "memory device type" numbers that tell the kind of module (the DMTF SMBIOS reference)
SMBIOS_TYPES = {20: "DDR", 21: "DDR2", 24: "DDR3", 26: "DDR4", 27: "LPDDR", 28: "LPDDR2", 29: "LPDDR3", 30: "LPDDR4", 34: "DDR5", 35: "LPDDR5"}

WINDOWS_QUERY = "Get-CimInstance Win32_PhysicalMemory | ForEach-Object { \"$($_.SMBIOSMemoryType),$($_.ConfiguredClockSpeed),$($_.Speed)\" }"


def from_profiler(text: str) -> str:
    """The type and maker from `system_profiler SPMemoryDataType` ("Type: LPDDR5", "Manufacturer: Hynix")."""
    found: dict[str, str] = {}
    for line in text.splitlines():
        key, _, value = line.partition(":")
        if key.strip() in ("Type", "Manufacturer") and value.strip():
            found.setdefault(key.strip(), value.strip())
    return " · ".join(found[k] for k in ("Type", "Manufacturer") if k in found)


def from_modules(text: str) -> str:
    """"DDR5-6000" from lines of "<SMBIOS type>,<configured MT/s>,<rated MT/s>" (one per module; the first that names a known type)."""
    for line in text.splitlines():
        parts = [p.strip() for p in line.split(",")]
        if len(parts) < 3 or not parts[0].isdigit() or int(parts[0]) not in SMBIOS_TYPES:
            continue
        kind = SMBIOS_TYPES[int(parts[0])]
        speed = next((int(p) for p in parts[1:3] if p.isdigit() and int(p) > 0), 0)
        return f"{kind}-{speed}" if speed else kind
    return ""


def _read() -> str:
    if sys.platform == "darwin":
        out = subprocess.run(["system_profiler", "SPMemoryDataType"], capture_output=True, text=True, timeout=10, check=True).stdout
        return from_profiler(out)
    if sys.platform.startswith("win"):
        out = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_QUERY],
            capture_output=True, text=True, timeout=15, check=True, creationflags=0x08000000,  # CREATE_NO_WINDOW: no console flashes up
        ).stdout
        return from_modules(out)
    return ""


_state = {"value": "", "started": False}
_lock = threading.Lock()


def _load() -> None:
    try:
        _state["value"] = _read()
    except Exception as e:  # an unreadable kind must not stop the monitor
        log.info("Memory kind unavailable: %s", e)


def ram_name() -> str:
    """"" until the system has answered (it is asked once, in the background: PowerShell takes a second or two) and where it never does."""
    with _lock:
        if not _state["started"]:
            _state["started"] = True
            threading.Thread(target=_load, daemon=True, name="ram-name").start()
    return _state["value"]
