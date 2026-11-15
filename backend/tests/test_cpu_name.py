import subprocess

import pytest

from app.services.monitor import cpu
from app.services.monitor.cpu import clean, cpu_name


@pytest.fixture(autouse=True)
def fresh():
    cpu_name.cache_clear()
    yield
    cpu_name.cache_clear()


def test_the_name_is_put_on_one_line_with_single_spaces():
    assert clean("  AMD Ryzen 9 9950X3D 16-Core Processor        \n") == "AMD Ryzen 9 9950X3D 16-Core Processor"


def test_linux_reads_the_model_name_of_the_first_cpu(tmp_path, monkeypatch):
    info = tmp_path / "cpuinfo"
    info.write_text("processor\t: 0\nmodel name\t: Intel(R) Xeon(R) Gold 6338\nprocessor\t: 1\nmodel name\t: Other\n", encoding="utf-8")
    real_open = open
    monkeypatch.setattr("builtins.open", lambda path, *a, **k: real_open(info if path == "/proc/cpuinfo" else path, *a, **k))
    assert cpu._linux() == "Intel(R) Xeon(R) Gold 6338"


def test_an_unreadable_name_is_empty_and_does_not_raise(monkeypatch):
    def broken():
        raise OSError("no such file")

    monkeypatch.setattr(cpu, "_linux", broken)
    monkeypatch.setattr(cpu, "_darwin", broken)
    monkeypatch.setattr(cpu, "_windows", broken)
    assert cpu_name() == ""


def test_the_name_is_read_once(monkeypatch):
    calls = []

    def read():
        calls.append(1)
        return "Apple M4 Pro"

    for name in ("_linux", "_darwin", "_windows"):
        monkeypatch.setattr(cpu, name, read)
    assert cpu_name() == "Apple M4 Pro" and cpu_name() == "Apple M4 Pro" and len(calls) == 1


def test_this_machine_gives_a_name_or_nothing():
    assert isinstance(cpu_name(), str)
    if cpu.sys.platform == "darwin":
        r = subprocess.run(["sysctl", "-n", "machdep.cpu.brand_string"], capture_output=True, text=True)
        assert cpu_name() == clean(r.stdout)
