"""GPU providers: several vendors seen as one, and the readings of Apple silicon and AMD (from fake system files)."""
import json
import platform
import sys

import pytest

from app.services.instances import build_env
from app.services.monitor import apple, providers
from app.services.monitor.amd import AmdProvider, pci_name
from app.services.monitor.providers import CompositeProvider, GpuInfo
from app.services.proxy import force_cpu
from app.schemas import InstanceOptions


class Fake:
    def __init__(self, name, devices, table=None):
        self.name, self._d, self._t = name, devices, table

    def devices(self):
        return list(self._d)

    def process_vram(self):
        return self._t

    def close(self):
        pass


def test_devices_are_numbered_across_vendors_and_keep_their_own_number():
    nv = Fake("nvml", [GpuInfo(0, "a", "N0", 8, 1, vendor="nvidia"), GpuInfo(1, "b", "N1", 8, 1, vendor="nvidia")], {10: {1: 5}})
    amd = Fake("amd", [GpuInfo(0, "c", "A0", 4, 1, vendor="amd")], None)
    comp = CompositeProvider([nv, amd])
    got = comp.devices()
    assert [(g.index, g.name, g.env_index, g.vendor) for g in got] == [(0, "N0", 0, "nvidia"), (1, "N1", 1, "nvidia"), (2, "A0", 0, "amd")]
    assert comp.name == "nvml+amd" and comp.process_vram() == {10: {1: 5}}  # the vendor that cannot tell adds nothing


def test_one_failing_vendor_does_not_hide_the_others():
    class Broken(Fake):
        def devices(self):
            raise RuntimeError("driver gone")

    comp = CompositeProvider([Broken("x", []), Fake("amd", [GpuInfo(0, "c", "A0", 4, 1, vendor="amd")])])
    assert [g.name for g in comp.devices()] == ["A0"]


def test_no_provider_at_all_is_the_null_provider(monkeypatch):
    monkeypatch.setattr(providers, "_candidates", lambda: iter(()))
    p = providers.detect_provider()
    assert p.name == "none" and p.devices() == []


# ---- Apple silicon

IOREG = '''+-o AGXAcceleratorG16X  <class IOAccelerator>
    "PerformanceStatistics" = {"In use system memory (driver)"=0,"Alloc system memory"=2521006080,"Device Utilization %"=23,"In use system memory"=1106051072}
'''


def test_the_statistics_line_of_ioreg_is_parsed():
    assert apple.parse_ioreg(IOREG) == (23, 1106051072)
    assert apple.parse_ioreg("nothing here") == (None, None)


def test_the_die_temperature_is_the_hottest_valid_sensor():
    readings = [("PMU tdie1", 38.1), ("PMU tdie2", 41.5), ("PMU tdev2", -9202.9), ("PMU tdie3", -9001.0), ("NAND CH0 temp", 60.0)]
    assert apple.die_temperature(readings) == 41.5
    assert apple.die_temperature([("PMU tdie1", -9000.0)]) is None


def test_the_gpu_limit_default_follows_the_macos_rule():
    assert apple.default_gpu_limit(24 * 2**30) == 16 * 2**30
    assert apple.default_gpu_limit(64 * 2**30) == 48 * 2**30


def test_apple_provider_reports_one_unified_memory_device(monkeypatch):
    monkeypatch.setattr(apple.platform, "system", lambda: "Darwin")
    monkeypatch.setattr(apple.platform, "machine", lambda: "arm64")

    def run(cmd):
        return {"sysctl": "Apple M4 Pro\n" if "machdep.cpu.brand_string" in cmd else str(24 * 2**30), "ioreg": IOREG}[cmd[0]]

    p = apple.AppleProvider(run=run, metal_limit=lambda: 17 * 2**30, temperatures=lambda: [("PMU tdie1", 39.6)])
    d = p.devices()[0]
    assert (d.name, d.vendor, d.unified, d.mem_total, d.mem_used, d.util_percent, d.temperature_c) == ("Apple M4 Pro", "apple", True, 17 * 2**30, 1106051072, 23, 40)
    assert d.supports == {"mem": True, "util": True, "temp": True, "process": False, "process_util": False} and p.process_vram() is None
    quiet = apple.AppleProvider(run=run, metal_limit=lambda: None, temperatures=lambda: [])  # no sensors: the reading is flagged missing
    assert quiet.limit == apple.default_gpu_limit(24 * 2**30)
    assert quiet.devices()[0].temperature_c is None and quiet.devices()[0].supports["temp"] is False


def test_apple_provider_refuses_other_machines(monkeypatch):
    monkeypatch.setattr(apple.platform, "machine", lambda: "x86_64")
    with pytest.raises(RuntimeError):
        apple.AppleProvider(run=lambda c: "")


# ---- AMD (Linux sysfs)

def write(p, text):
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text)


def card(root, n, vram_total, vram_used, gtt_total=0, gtt_used=0, busy=None, temp=None, dev_id="0x1681"):
    d = root / f"card{n}" / "device"
    write(d / "vendor", "0x1002\n")
    write(d / "device", dev_id + "\n")
    write(d / "mem_info_vram_total", f"{vram_total}\n")
    write(d / "mem_info_vram_used", f"{vram_used}\n")
    write(d / "mem_info_gtt_total", f"{gtt_total}\n")
    write(d / "mem_info_gtt_used", f"{gtt_used}\n")
    if busy is not None:
        write(d / "gpu_busy_percent", f"{busy}\n")
    if temp is not None:
        write(d / "hwmon" / "hwmon3" / "temp1_input", f"{temp}\n")


PCI_IDS = "# list\n10de  NVIDIA\n\t1234  Something\n1002  Advanced Micro Devices, Inc. [AMD/ATI]\n\t1681  Phoenix1\n\t\t1002 1234  sub\n\t744c  Navi 31\n1003  Other\n\t1681  Wrong\n"


def test_pci_names_come_from_the_systems_id_list(tmp_path):
    f = tmp_path / "pci.ids"
    f.write_text(PCI_IDS)
    assert pci_name("0x1002", "0x1681", (str(f),)) == "Phoenix1" and pci_name("0x1002", "0x9999", (str(f),)) is None


def test_amd_integrated_gpu_is_unified_and_adds_system_memory(tmp_path):
    drm = tmp_path / "drm"
    card(drm, 1, 512 * 2**20, 100 * 2**20, gtt_total=8 * 2**30, gtt_used=2**30, busy=17, temp=47000)
    (tmp_path / "pci.ids").write_text(PCI_IDS)
    p = AmdProvider(drm, (str(tmp_path / "pci.ids"),))
    d = p.devices()[0]
    assert (d.name, d.vendor, d.unified, d.util_percent, d.temperature_c) == ("AMD Phoenix1", "amd", True, 17, 47)
    assert d.mem_total == 512 * 2**20 + 8 * 2**30 and d.mem_used == 100 * 2**20 + 2**30
    assert d.supports == {"mem": True, "util": True, "temp": True, "process": False, "process_util": False} and p.process_vram() is None


def test_amd_discrete_gpu_has_its_own_vram_and_missing_files_are_flagged(tmp_path):
    drm = tmp_path / "drm"
    card(drm, 0, 16 * 2**30, 2**30, gtt_total=32 * 2**30)  # no busy file, no sensor
    d = AmdProvider(drm, ()).devices()[0]
    assert d.unified is False and d.mem_total == 16 * 2**30 and d.util_percent is None and d.temperature_c is None
    assert d.supports["util"] is False and d.supports["temp"] is False and d.name == "AMD GPU"


def test_no_amd_card_means_no_provider(tmp_path):
    (tmp_path / "drm" / "card0" / "device").mkdir(parents=True)
    with pytest.raises(RuntimeError):
        AmdProvider(tmp_path / "drm")


# ---- choosing the compute device

def devs():
    return [GpuInfo(0, "n", "N0", 1, 0, vendor="nvidia", env_index=0), GpuInfo(1, "a", "A0", 1, 0, vendor="amd", env_index=0),
            GpuInfo(2, "a2", "A1", 1, 0, vendor="amd", env_index=1)]


def test_the_apps_gpu_number_becomes_the_vendors_own_number():
    env = build_env(1, InstanceOptions(gpu=2), {}, devices=devs())
    assert env["HIP_VISIBLE_DEVICES"] == "1" and env["ROCR_VISIBLE_DEVICES"] == "1" and "CUDA_VISIBLE_DEVICES" not in env
    env = build_env(1, InstanceOptions(gpu=0), {}, devices=devs())
    assert env["CUDA_VISIBLE_DEVICES"] == "0" and "HIP_VISIBLE_DEVICES" not in env
    assert build_env(1, InstanceOptions(gpu=3), {}, devices=[])["CUDA_VISIBLE_DEVICES"] == "3"  # devices unknown: as before
    assert "CUDA_VISIBLE_DEVICES" not in build_env(1, InstanceOptions(gpu="auto"), {"CUDA_VISIBLE_DEVICES": "5"}, devices=devs())


def test_cpu_hides_every_vendors_devices():
    env = build_env(1, InstanceOptions(gpu="cpu"), {}, devices=devs())
    assert env["CUDA_VISIBLE_DEVICES"] == env["HIP_VISIBLE_DEVICES"] == env["ROCR_VISIBLE_DEVICES"] == "-1"
    assert env["OLLAMA_VULKAN"] == "0" and env["GGML_VK_VISIBLE_DEVICES"] == "-1"  # Vulkan lists the NVIDIA card again once CUDA is hidden


def test_cpu_by_request_on_mac_and_windows(monkeypatch):
    from app.services.instances import cpu_by_request
    for plat, want in (("darwin", True), ("win32", True), ("linux", False)):
        monkeypatch.setattr(sys, "platform", plat)
        assert cpu_by_request(InstanceOptions(gpu="cpu")) is want and not cpu_by_request(InstanceOptions(gpu="auto"))


def test_cpu_only_requests_ask_for_zero_gpu_layers():
    body = json.dumps({"model": "m", "prompt": "hi", "options": {"num_predict": 5, "num_gpu": 99}}).encode()
    assert json.loads(force_cpu(body))["options"] == {"num_predict": 5, "num_gpu": 0}
    assert json.loads(force_cpu(b'{"model":"m"}'))["options"] == {"num_gpu": 0}
    assert force_cpu(b"not json") == b"not json" and force_cpu(b"[1]") == b"[1]"


# ---- per-process GPU use

class FakeNvml:
    """Just enough of pynvml: per-process utilization samples the test controls (per GPU), and its 'not found' error."""

    class NVMLError_NotFound(Exception):
        pass

    def __init__(self, samples):
        self.samples, self.calls = samples, []  # gpu handle -> list of sample objects, or an exception

    @staticmethod
    def nvmlDeviceGetHandleByIndex(i):
        return i

    def nvmlDeviceGetProcessUtilization(self, handle, last_seen):
        self.calls.append((handle, last_seen))
        got = self.samples.get(handle)
        if isinstance(got, Exception):
            raise got
        return [s for s in (got or []) if s.timeStamp > last_seen]


class Sample:
    def __init__(self, pid, ts, sm):
        self.pid, self.timeStamp, self.smUtil = pid, ts, sm


def nvml_with(samples, count=2):
    p = providers.NvmlProvider.__new__(providers.NvmlProvider)
    p._n, p._count, p._last_seen = FakeNvml(samples), count, {}
    return p


def test_nvml_gives_each_process_share_of_each_gpu_and_asks_only_for_new_samples():
    p = nvml_with({0: [Sample(10, 5, 30), Sample(11, 6, 12)], 1: [Sample(10, 5, 4)]})
    assert p.process_util() == {10: {0: 30, 1: 4}, 11: {0: 12}}
    p._n.calls.clear()
    assert p.process_util() == {}  # nothing newer: the processes are idle, which is an answer
    assert p._n.calls == [(0, 6), (1, 5)]


def test_nvml_cannot_tell_when_no_gpu_answers():
    broken = nvml_with({0: RuntimeError("not supported"), 1: RuntimeError("not supported")})
    assert broken.process_util() is None
    mixed = nvml_with({0: RuntimeError("not supported"), 1: [Sample(7, 1, 55)]})
    assert mixed.process_util() == {7: {1: 55}}  # one GPU that answers is enough to say something
    idle = nvml_with({0: FakeNvml.NVMLError_NotFound()}, count=1)
    assert idle.process_util() == {}


def test_per_process_use_is_merged_over_vendors_with_global_gpu_numbers():
    nv = Fake("nvml", [GpuInfo(0, "a", "N0", 8, 1, vendor="nvidia"), GpuInfo(1, "b", "N1", 8, 1, vendor="nvidia")])
    nv.process_util = lambda: {10: {1: 40}}
    amd = Fake("amd", [GpuInfo(0, "c", "A0", 4, 1, vendor="amd")])
    amd.process_util = lambda: None
    comp = CompositeProvider([nv, amd])
    assert comp.process_util() == {10: {1: 40}}
    amd.process_util = lambda: {20: {0: 9}}
    assert comp.process_util() == {10: {1: 40}, 20: {2: 9}}
    nv.process_util = lambda: None
    amd.process_util = lambda: None
    assert comp.process_util() is None


# ---- Windows (fake counters and adapter list: the real ones exist only on Windows)

from app.services.monitor.windows import Adapter, WindowsProvider, luid_key

GiB = 2**30
IGPU, DGPU, NV = 0xA1B2, 0xC3D4, 0xE5F6
L = lambda low: f"luid_0x00000000_0x{low:08X}_phys_0"


class FakeCounters:
    def __init__(self, table):
        self.table = table

    def read(self, path):
        if path not in self.table:
            raise OSError("counter not available")
        return dict(self.table[path])

    def close(self):
        pass


def win_table(**over):
    t = {
        r"\GPU Adapter Memory(*)\Dedicated Usage": {L(IGPU): 0.5 * GiB, L(NV): 9 * GiB},
        r"\GPU Adapter Memory(*)\Shared Usage": {L(IGPU): 1.5 * GiB, L(NV): 0.1 * GiB},
        r"\GPU Engine(*)\Utilization Percentage": {
            f"pid_100_{L(IGPU)}_eng_0_engtype_Compute_0": 30.0,
            f"pid_100_{L(IGPU)}_eng_1_engtype_Compute_0": 20.0,
            f"pid_100_{L(IGPU)}_eng_2_engtype_3D": 10.0,
            f"pid_200_{L(NV)}_eng_0_engtype_3D": 90.0,
        },
        r"\GPU Process Memory(*)\Dedicated Usage": {f"pid_100_{L(IGPU)}": 0.25 * GiB, f"pid_200_{L(NV)}": 5 * GiB},
        r"\GPU Process Memory(*)\Shared Usage": {f"pid_100_{L(IGPU)}": 1 * GiB, f"pid_200_{L(NV)}": 0.05 * GiB},
    }
    t.update(over)
    return t


ADAPTERS = lambda: [
    Adapter("AMD Radeon(TM) Graphics", 0x1002, IGPU, 512 * 2**20, 32 * GiB),
    Adapter("NVIDIA GeForce RTX 5090", 0x10DE, NV, 32 * GiB, 64 * GiB),
    Adapter("Microsoft Basic Render Driver", 0x1414, 0x1, 0, 0),
    Adapter("Radeon RX (removed)", 0x1002, 0x9999, 8 * GiB, 0),  # recorded in the registry, gone from the counters
]


def test_windows_provider_reports_the_integrated_gpu_as_unified_and_leaves_nvidia_to_nvml():
    p = WindowsProvider(FakeCounters(win_table()), ADAPTERS)
    (g,) = p.devices()
    assert (g.name, g.vendor, g.unified, g.index) == ("AMD Radeon(TM) Graphics", "amd", True, 0)
    assert g.mem_total == 512 * 2**20 + 32 * GiB and g.mem_used == 2 * GiB  # carve-out and shared memory, added together
    assert g.util_percent == 50 and g.temperature_c is None and g.supports["temp"] is False  # busiest engine type: Compute 30+20
    assert luid_key(IGPU) == "0x00000000_0x0000a1b2"


def test_windows_provider_attributes_memory_and_time_per_process():
    p = WindowsProvider(FakeCounters(win_table()), ADAPTERS)
    assert p.process_vram() == {100: {0: int(0.25 * GiB) + 1 * GiB}}  # pid 200 sits on the NVIDIA card: not this provider's
    assert p.process_util() == {100: {0: 50}}


def test_windows_provider_without_process_counters_still_reports_devices():
    t = win_table()
    del t[r"\GPU Process Memory(*)\Dedicated Usage"]
    p = WindowsProvider(FakeCounters(t), ADAPTERS)
    assert p.process_vram() is None and len(p.devices()) == 1


def test_windows_provider_unavailable_cases():
    with pytest.raises(RuntimeError):
        WindowsProvider(FakeCounters(win_table()), lambda: [Adapter("NVIDIA", 0x10DE, NV, 32 * GiB, 0)])
    with pytest.raises(RuntimeError):
        WindowsProvider(FakeCounters({r"\GPU Adapter Memory(*)\Dedicated Usage": {}}), ADAPTERS)
    with pytest.raises(OSError):
        WindowsProvider(FakeCounters({}), ADAPTERS)  # Windows without the GPU counters (older than 10 1709)


def test_windows_provider_reads_once_per_tick():
    c = FakeCounters(win_table())
    calls = []
    orig = c.read
    c.read = lambda path: (calls.append(path), orig(path))[1]
    now = [0.0]
    p = WindowsProvider(c, ADAPTERS, clock=lambda: now[0])
    calls.clear()
    p.devices(), p.process_vram(), p.process_util()
    assert len(calls) == 5
    now[0] = 2.0
    p.devices()
    assert len(calls) == 10


def test_selecting_the_integrated_gpu_hides_cuda_and_allows_igpu():
    dev = WindowsProvider(FakeCounters(win_table()), ADAPTERS).devices()[0]
    nv = GpuInfo(0, "n", "RTX", 8, 1, vendor="nvidia")
    comp = CompositeProvider([Fake("windows", [dev]), Fake("nvml", [nv])]).devices()  # even listed first, the iGPU is Vulkan 1
    igpu, rtx = (next(d.index for d in comp if d.vendor == v) for v in ("amd", "nvidia"))
    env = build_env(11434, InstanceOptions(gpu=igpu), {"CUDA_VISIBLE_DEVICES": "0"}, None, comp)
    assert env["CUDA_VISIBLE_DEVICES"] == "-1" and env["OLLAMA_IGPU_ENABLE"] == "1" and "HIP_VISIBLE_DEVICES" not in env
    assert env["GGML_VK_VISIBLE_DEVICES"] == "1"  # discrete cards come first among Vulkan devices: RTX 0, Radeon iGPU 1
    assert "GGML_VK_VISIBLE_DEVICES" not in build_env(11434, InstanceOptions(gpu=1), {"GGML_VK_VISIBLE_DEVICES": "0"}, None, [nv])
    env0 = build_env(11434, InstanceOptions(gpu=rtx), {}, None, comp)
    assert env0["CUDA_VISIBLE_DEVICES"] == "0" and "OLLAMA_IGPU_ENABLE" not in env0
