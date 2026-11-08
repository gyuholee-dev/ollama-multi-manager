import asyncio
import subprocess
import sys
from pathlib import Path

import httpx

from app.main import create_app
from tests.conftest import free_port

FAKE = str(Path(__file__).parent / "fake_ollama.py")


async def test_web_access_follows_settings(env):
    assert (await env.client.get("/settings")).json()["external_monitoring_enabled"] is False   # off until switched on
    port = free_port()
    r = await env.client.put("/settings", json={"external_monitoring_enabled": True, "external_monitoring_port": port})
    assert r.status_code == 200
    ext = env.app.state.external
    assert ext.active and ext.status()["port"] == port
    async with httpx.AsyncClient() as c:
        page = await c.get(f"http://127.0.0.1:{port}/")
        assert page.status_code == 200 and "Ollama Multi Manager" in page.text      # the web UI is what this port serves
        assert (await c.get(f"http://127.0.0.1:{port}/metrics")).status_code == 404  # exporting metrics here is deferred

    new = free_port()                                    # rebind without a restart
    await env.client.put("/settings", json={"external_monitoring_port": new})
    async with httpx.AsyncClient() as c:
        assert (await c.get(f"http://127.0.0.1:{new}/")).status_code == 200
        try:
            await c.get(f"http://127.0.0.1:{port}/")
            raise AssertionError("old port should be closed")
        except httpx.ConnectError:
            pass

    await env.client.put("/settings", json={"external_monitoring_enabled": False})
    assert not ext.active
    async with httpx.AsyncClient() as c:
        try:
            await c.get(f"http://127.0.0.1:{new}/")
            raise AssertionError("nothing should listen once it is switched off")
        except httpx.ConnectError:
            pass


async def test_busy_port_is_reported_not_fatal(env):
    import socket
    s = socket.socket(); s.bind(("127.0.0.1", 0)); s.listen(); busy = s.getsockname()[1]
    await env.client.put("/settings", json={"external_monitoring_enabled": True, "external_monitoring_port": busy})
    info = (await env.client.get("/info")).json()
    assert info["external_monitoring"]["active"] is False and "in use" in info["external_monitoring"]["error"]
    s.close()


async def test_monitoring_port_cannot_take_an_instance_port(env):
    inst = (await env.client.post("/instances", json={"name": "i", "port": free_port()})).json()
    r = await env.client.put("/settings", json={"external_monitoring_port": inst["port"]})
    assert r.status_code == 409


async def test_info(env):
    info = (await env.client.get("/info")).json()
    assert info["version"] and info["lan_ip"] and "platform" in info


async def test_default_ollama_is_shown_read_only(env):
    port = free_port()
    proc = subprocess.Popen([sys.executable, FAKE, "serve"], env={"OLLAMA_HOST": f"127.0.0.1:{port}", "FAKE_CHILD": "0"})
    try:
        c = env.app.state.collector
        c.external_port = port
        ext = None
        for _ in range(50):  # the fake needs a moment to start listening
            ext = (await c.collect())["external"]
            if ext:
                break
            await asyncio.sleep(0.1)
        assert ext and ext["responsive"] and ext["port"] == port and ext["models"][0]["name"] == "fake:1b"
        # a managed instance on that port takes precedence
        await env.client.post("/instances", json={"name": "own", "port": port})
        assert (await c.collect())["external"] is None
    finally:
        proc.terminate(); proc.wait()


async def test_backend_serves_the_ui(tmp_path, provider):
    ui = tmp_path / "ui"; ui.mkdir(); (ui / "index.html").write_text("<h1>ui</h1>")
    app = create_app(data_dir=tmp_path / "d", provider=provider, token="t", frontend_dir=ui)
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
            assert "<h1>ui</h1>" in (await c.get("/")).text            # public shell
            assert (await c.get("/instances")).status_code == 401      # API still protected
            assert (await c.get("/health")).json() == {"status": "ok"}
