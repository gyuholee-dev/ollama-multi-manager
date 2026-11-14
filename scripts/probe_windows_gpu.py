"""Windows GPU probe: what Vulkan says about each GPU, and how it lines up with what Windows has recorded.

Run on the Windows machine (no extra packages, nothing is changed):

    python scripts\\probe_windows_gpu.py

It prints three things:
  1. the Vulkan devices in the order the loader lists them: number, type (integrated / discrete), vendor, name, LUID
  2. the adapters Windows has recorded (registry): name, vendor, memory, LUID, and what the 4 GiB rule says about them
  3. the two joined by LUID

Compare the Vulkan numbers with the `Vulkan0`, `Vulkan1` names in an Ollama log ("inference compute" lines).
"""
from __future__ import annotations

import ctypes
import struct
import sys
from ctypes import POINTER, Structure, byref, c_char_p, c_uint32, c_ubyte, c_void_p

TYPES = {0: "other", 1: "INTEGRATED", 2: "DISCRETE", 3: "virtual", 4: "CPU"}
VENDORS = {0x10DE: "NVIDIA", 0x1002: "AMD", 0x8086: "Intel", 0x1414: "Microsoft"}
UNIFIED_BELOW = 4 * 2**30  # the rule the app uses today


class AppInfo(Structure):
    _fields_ = [("sType", c_uint32), ("pNext", c_void_p), ("pApplicationName", c_char_p), ("applicationVersion", c_uint32),
                ("pEngineName", c_char_p), ("engineVersion", c_uint32), ("apiVersion", c_uint32)]


class InstanceInfo(Structure):
    _fields_ = [("sType", c_uint32), ("pNext", c_void_p), ("flags", c_uint32), ("pApplicationInfo", POINTER(AppInfo)),
                ("enabledLayerCount", c_uint32), ("ppEnabledLayerNames", c_void_p),
                ("enabledExtensionCount", c_uint32), ("ppEnabledExtensionNames", c_void_p)]


class IdProps(Structure):  # VkPhysicalDeviceIDProperties
    _fields_ = [("sType", c_uint32), ("pNext", c_void_p), ("deviceUUID", c_ubyte * 16), ("driverUUID", c_ubyte * 16),
                ("deviceLUID", c_ubyte * 8), ("deviceNodeMask", c_uint32), ("deviceLUIDValid", c_uint32)]


class Props2(Structure):  # VkPhysicalDeviceProperties2: the plain properties are 824 bytes
    _fields_ = [("sType", c_uint32), ("pNext", c_void_p), ("properties", c_ubyte * 824)]


def vulkan_devices() -> list[dict]:
    vk = ctypes.WinDLL("vulkan-1")
    app = AppInfo(0, None, b"omm-probe", 1, b"omm-probe", 1, (1 << 22) | (1 << 12))  # Vulkan 1.1
    info = InstanceInfo(1, None, 0, ctypes.pointer(app), 0, None, 0, None)
    instance = c_void_p()
    rc = vk.vkCreateInstance(byref(info), None, byref(instance))
    if rc != 0:
        raise OSError(f"vkCreateInstance failed: {rc}")
    try:
        count = c_uint32(0)
        vk.vkEnumeratePhysicalDevices(instance, byref(count), None)
        handles = (c_void_p * count.value)()
        vk.vkEnumeratePhysicalDevices(instance, byref(count), handles)
        out = []
        for i, h in enumerate(handles):
            ids = IdProps(1000071004, None)  # VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_ID_PROPERTIES
            p2 = Props2(1000059001, ctypes.cast(byref(ids), c_void_p))  # VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_PROPERTIES_2
            vk.vkGetPhysicalDeviceProperties2(c_void_p(h), byref(p2))
            raw = bytes(p2.properties)
            api, driver, vendor, device, dtype = struct.unpack_from("<5I", raw, 0)
            name = raw[20:276].split(b"\0", 1)[0].decode(errors="replace")
            luid = int.from_bytes(bytes(ids.deviceLUID), "little") if ids.deviceLUIDValid else None
            out.append({"index": i, "type": TYPES.get(dtype, str(dtype)), "vendor": vendor, "device": device, "name": name, "luid": luid})
        return out
    finally:
        vk.vkDestroyInstance(instance, None)


def registry_adapters() -> list[dict]:
    import winreg

    out = []
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
                    out.append({"name": get("Description", ""), "vendor": int(get("VendorId")), "device": int(get("DeviceId")), "luid": int(luid),
                                "dedicated": int(get("DedicatedVideoMemory")), "shared": int(get("SharedSystemMemory"))})
            except OSError:
                continue
    return out


def luid_text(v: int | None) -> str:
    return "-" if v is None else f"0x{(v >> 32) & 0xFFFFFFFF:08x}_0x{v & 0xFFFFFFFF:08x}"


def main() -> None:
    if sys.platform != "win32":
        sys.exit("This probe is for Windows.")
    try:
        vulkan = vulkan_devices()
    except Exception as e:
        print(f"Vulkan: not available ({e})")
        vulkan = []
    print("== Vulkan devices (loader order) ==")
    for d in vulkan:
        print(f"  Vulkan{d['index']}  {d['type']:<10}  {VENDORS.get(d['vendor'], hex(d['vendor'])):<9} {d['name']}   luid={luid_text(d['luid'])}")
    reg = registry_adapters()
    print("\n== Windows adapters (registry) ==")
    for a in reg:
        rule = "unified (iGPU by the 4 GiB rule)" if a["dedicated"] < UNIFIED_BELOW else "discrete by the 4 GiB rule"
        print(f"  {VENDORS.get(a['vendor'], hex(a['vendor'])):<9} {a['name']}   dedicated={a['dedicated'] / 2**20:.0f} MiB shared={a['shared'] / 2**30:.1f} GiB"
              f"   luid={luid_text(a['luid'])}   -> {rule}")
    print("\n== Joined by LUID ==")
    by_luid = {a["luid"]: a for a in reg}
    for d in vulkan:
        a = by_luid.get(d["luid"])
        if a is None:
            print(f"  Vulkan{d['index']} {d['name']}: no registry adapter with this LUID")
            continue
        rule = "unified" if a["dedicated"] < UNIFIED_BELOW else "discrete"
        agree = "same" if (d["type"] == "INTEGRATED") == (rule == "unified") else "DIFFERENT"
        print(f"  Vulkan{d['index']}  Vulkan says {d['type']:<10} rule says {rule:<8} -> {agree}   ({a['name']})")
    print("\nNext: compare Vulkan0, Vulkan1 ... with the names in an Ollama log ('inference compute' lines).")


if __name__ == "__main__":
    main()
