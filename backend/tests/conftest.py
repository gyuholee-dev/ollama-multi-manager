import asyncio
import os
import socket
import stat
import sys
from pathlib import Path

import httpx
import pytest

from app.main import create_app
from app.services.monitor.providers import GpuInfo


class FakeProvider:
    """GPU provider whose per-process VRAM table the test controls."""

    name = "fake"

    def __init__(self):
        self.table = {}      # pid -> {gpu: bytes|None}
        self.supported = True

    def devices(self):
        return [GpuInfo(0, "GPU-fake", "Fake GPU", 24 * 2**30, 2**30, 10, 40)]

    def process_vram(self):
        return self.table if self.supported else None

    def close(self):
        pass


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture(autouse=True)
def loopback_only(monkeypatch):
    """Never open the external monitoring listener on the LAN while testing."""
    monkeypatch.setenv("OMM_EXTERNAL_HOST", "127.0.0.1")


@pytest.fixture
def fake_exe(tmp_path) -> str:
    script = tmp_path / "ollama"
    script.write_text(f'#!/bin/sh\nexec "{sys.executable}" "{Path(__file__).parent / "fake_ollama.py"}" "$@"\n')
    script.chmod(script.stat().st_mode | stat.S_IXUSR)
    return str(script)


@pytest.fixture
def provider() -> FakeProvider:
    return FakeProvider()


@pytest.fixture
async def env(tmp_path, fake_exe, provider):
    """Running app (lifespan included) + HTTP client + handles to its internals."""
    os.environ.pop("OMM_TOKEN", None)
    app = create_app(data_dir=tmp_path / "data", provider=provider, token=None)
    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            r = await client.put("/settings", json={"ollama_executable_path": fake_exe})
            assert r.status_code == 200, r.text
            yield type("Env", (), {"app": app, "client": client, "provider": provider, "dir": tmp_path / "data"})


async def wait_for(predicate, timeout=10.0, step=0.1):
    loop = asyncio.get_event_loop()
    end = loop.time() + timeout
    while loop.time() < end:
        value = predicate()
        if asyncio.iscoroutine(value):
            value = await value
        if value:
            return value
        await asyncio.sleep(step)
    raise AssertionError("condition not met in time")
