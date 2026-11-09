"""AMD GPUs on Linux through the amdgpu driver's sysfs files; no special rights and no vendor tool needed.

    /sys/class/drm/card<N>/device/
        vendor                  0x1002 for AMD
        mem_info_vram_total/used, mem_info_gtt_total/used     bytes
        gpu_busy_percent        utilization
        hwmon/hwmon*/temp1_input    millidegrees C (the edge temperature)

An integrated GPU (APU) has only a small dedicated carve-out and uses ordinary system memory (GTT) for the rest:
it is reported as unified memory with VRAM and GTT added together. Telling the two kinds apart is a guess from the
carve-out size (see UNIFIED_BELOW), which is to be checked on real hardware. Per-process GPU memory is not offered
by this interface, so the instances' share is estimated from what Ollama reports.
Windows and the other vendors are not covered here.
"""
from __future__ import annotations

import logging
import sys
from pathlib import Path

from .providers import GpuInfo, ProcessVram

log = logging.getLogger("omm.monitor")

AMD_VENDOR = "0x1002"
UNIFIED_BELOW = 4 * 2**30  # a dedicated carve-out smaller than this means an integrated GPU


def _num(p: Path) -> int | None:
    try:
        return int(p.read_text().strip())
    except (OSError, ValueError):
        return None


def _text(p: Path) -> str | None:
    try:
        return p.read_text().strip()
    except OSError:
        return None


PCI_IDS = ("/usr/share/hwdata/pci.ids", "/usr/share/misc/pci.ids")


def pci_name(vendor: str, device: str, files: tuple[str, ...] = PCI_IDS) -> str | None:
    """The marketing name of a PCI device from the system's pci.ids list, e.g. 'Phoenix1' for 0x1681."""
    v, d = vendor.lower().removeprefix("0x"), device.lower().removeprefix("0x")
    for path in files:
        try:
            lines = Path(path).read_text(errors="replace").splitlines()
        except OSError:
            continue
        inside = False
        for line in lines:
            if not line or line.startswith("#"):
                continue
            if not line.startswith("\t"):
                if inside:
                    return None
                inside = line.startswith(v + " ")
            elif inside and line.startswith("\t") and not line.startswith("\t\t") and line[1:].startswith(d + " "):
                return line[1:].split(None, 1)[1].strip()
    return None


class AmdProvider:
    name = "amd"

    def __init__(self, drm: Path | str = "/sys/class/drm", pci_ids: tuple[str, ...] = PCI_IDS):
        if not sys.platform.startswith("linux") and drm == "/sys/class/drm":
            raise RuntimeError("not Linux")
        self.pci_ids = pci_ids
        self.cards = self._find(Path(drm))
        if not self.cards:
            raise RuntimeError("no AMD GPU")

    @staticmethod
    def _find(drm: Path) -> list[Path]:
        out = []
        for card in sorted(drm.glob("card[0-9]*"), key=lambda p: int(p.name[4:])):
            dev = card / "device"
            if _text(dev / "vendor") == AMD_VENDOR and _num(dev / "mem_info_vram_total") is not None:
                out.append(dev)
        return out

    @staticmethod
    def _temperature(dev: Path) -> int | None:
        for hw in sorted((dev / "hwmon").glob("hwmon*")):
            milli = _num(hw / "temp1_input")
            if milli is not None:
                return round(milli / 1000)
        return None

    def _name(self, dev: Path) -> str:
        product = _text(dev / "product_name")
        if product:
            return product
        found = pci_name(AMD_VENDOR, _text(dev / "device") or "", self.pci_ids)
        return f"AMD {found}" if found else "AMD GPU"

    def devices(self) -> list[GpuInfo]:
        out = []
        for i, dev in enumerate(self.cards):
            vram_total, vram_used = _num(dev / "mem_info_vram_total") or 0, _num(dev / "mem_info_vram_used") or 0
            unified = vram_total < UNIFIED_BELOW
            total, used = vram_total, vram_used
            if unified:  # an integrated GPU also uses system memory (GTT)
                total += _num(dev / "mem_info_gtt_total") or 0
                used += _num(dev / "mem_info_gtt_used") or 0
            busy = _num(dev / "gpu_busy_percent")
            temp = self._temperature(dev)
            out.append(GpuInfo(
                index=i, uuid=f"amd-{dev.parent.name}", name=self._name(dev), mem_total=total, mem_used=used,
                util_percent=min(100, busy) if busy is not None else None, temperature_c=temp,
                vendor="amd", unified=unified, env_index=i,
                supports={"mem": True, "util": busy is not None, "temp": temp is not None, "process": False, "process_util": False},
            ))
        return out

    def process_vram(self) -> ProcessVram | None:
        return None

    def process_util(self):
        return None

    def close(self) -> None:
        pass
