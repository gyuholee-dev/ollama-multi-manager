import threading

from app.services.monitor import ram
from app.services.monitor.ram import from_modules, from_profiler


def test_macos_profiler_gives_the_type_and_the_maker():
    text = "Memory:\n\n      Memory: 24 GB\n      Type: LPDDR5\n      Manufacturer: Hynix\n"
    assert from_profiler(text) == "LPDDR5 · Hynix"
    assert from_profiler("Memory:\n      Memory: 16 GB\n      Type: LPDDR4X\n") == "LPDDR4X"
    assert from_profiler("") == ""


def test_windows_modules_give_the_kind_and_the_speed():
    assert from_modules("34,6000,6400\n34,6000,6400\n") == "DDR5-6000"
    assert from_modules("26,0,3200\n") == "DDR4-3200"  # no configured speed: the rated one
    assert from_modules("35,0,0\n") == "LPDDR5"  # no speed at all
    assert from_modules("0,2400,2400\n") == ""  # a type this list does not know is not guessed
    assert from_modules("\nnot,a,row\n,,\n") == ""


def test_the_kind_is_asked_once_in_the_background_and_empty_until_answered(monkeypatch):
    release = threading.Event()
    calls = []

    def slow_read():
        calls.append(1)
        release.wait(5)
        return "DDR5-6000"

    monkeypatch.setattr(ram, "_read", slow_read)
    monkeypatch.setattr(ram, "_state", {"value": "", "started": False})
    assert ram.ram_name() == ""  # asking does not wait for the system
    assert ram.ram_name() == "" and len(calls) <= 1
    release.set()
    for t in threading.enumerate():
        if t.name == "ram-name":
            t.join(5)
    assert ram.ram_name() == "DDR5-6000" and len(calls) == 1


def test_an_unreadable_kind_stays_empty(monkeypatch):
    def broken():
        raise OSError("no powershell")

    monkeypatch.setattr(ram, "_read", broken)
    monkeypatch.setattr(ram, "_state", {"value": "", "started": False})
    ram.ram_name()
    for t in threading.enumerate():
        if t.name == "ram-name":
            t.join(5)
    assert ram.ram_name() == ""
