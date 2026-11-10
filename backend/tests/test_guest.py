"""Guest mode: the web UI on the web monitoring port is read-only and needs no login."""
import json

import httpx
import websockets

from app.main import create_app
from tests.conftest import free_port, wait_for


async def open_port(env):
    port = free_port()
    r = await env.client.put("/settings", json={"external_monitoring_enabled": True, "external_monitoring_port": port})
    assert r.status_code == 200, r.text
    return port


async def test_the_web_ui_is_served_only_while_web_access_is_on(env):
    port = await open_port(env)
    async with httpx.AsyncClient() as c:
        page = await c.get(f"http://127.0.0.1:{port}/")
        assert page.status_code == 200 and "Ollama Multi Manager" in page.text
        assert (await c.get(f"http://127.0.0.1:{port}/app.js")).status_code == 200
        await env.client.put("/settings", json={"external_monitoring_enabled": False})   # no restart needed
        try:
            await c.get(f"http://127.0.0.1:{port}/")
            raise AssertionError("the port should be closed")
        except httpx.ConnectError:
            pass


async def test_guests_read_without_a_token_and_see_no_secrets(tmp_path, fake_exe, provider):
    app = create_app(data_dir=tmp_path / "data", provider=provider, token="main-token")
    async with app.router.lifespan_context(app):
        main = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t", headers={"Authorization": "Bearer main-token"})
        async with main:
            port = free_port()
            await main.put("/settings", json={"ollama_executable_path": fake_exe, "external_monitoring_enabled": True,
                                              "external_monitoring_port": port})
            inst = (await main.post("/instances", json={"name": "keyed", "port": free_port(), "options": {"api_key": "super-secret-key"}})).json()
            g = f"http://127.0.0.1:{port}"
            async with httpx.AsyncClient() as guest:                       # no Authorization header at all
                assert (await httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t").get("/instances")).status_code == 401
                items = (await guest.get(f"{g}/instances")).json()
                assert [i["name"] for i in items] == ["keyed"]
                assert items[0]["options"]["api_key"] == "********" and "super-secret-key" not in json.dumps(items)
                one = (await guest.get(f"{g}/instances/{inst['id']}")).json()
                assert one["options"]["api_key"] == "********"
                s = (await guest.get(f"{g}/settings")).json()
                assert "ollama_executable_path" not in s and "default_models_path" not in s
                assert (await guest.get(f"{g}/info")).json()["guest"] is True
                for path in ("/monitor/snapshot", "/monitor/history", f"/monitor/instances/{inst['id']}/history", "/monitor/requests", "/logs", "/pulls", f"/instances/{inst['id']}/requests"):
                    assert (await guest.get(f"{g}{path}")).status_code == 200, path
                assert (await guest.get(f"{g}/instances/{inst['id']}/requests/abc")).status_code != 200  # saved content is not for guests
            assert (await main.get("/info")).json()["guest"] is False       # the main API is untouched
            assert (await main.get("/instances")).json()[0]["options"]["api_key"] == "super-secret-key"


async def test_guests_cannot_change_anything(env):
    port = await open_port(env)
    g = f"http://127.0.0.1:{port}"
    async with httpx.AsyncClient() as c:
        before = (await env.client.get("/instances")).json()
        for method, path, body in (
            ("POST", "/instances", {"name": "x", "port": free_port()}),
            ("PUT", "/settings", {"theme": "dark"}),
            ("PATCH", "/instances/1", {"name": "y"}),
            ("DELETE", "/instances/1", None),
            ("POST", "/instances/1/start", None),
            ("POST", "/instances/1/stop", None),
            ("POST", "/models/pull", {"model": "m:1"}),
            ("DELETE", "/models/m:1", None),
            ("POST", "/shutdown", None),
            ("DELETE", "/pulls/x", None),
        ):
            r = await c.request(method, f"{g}{path}", json=body)
            assert r.status_code == 403, (method, path, r.status_code)
        assert (await env.client.get("/instances")).json() == before
        assert (await env.client.get("/settings")).json()["theme"] != "dark"


async def test_only_listed_read_paths_are_reachable(env):
    store = env.app.state.models.store
    calls = []
    real_base = store.base
    store.base = lambda: (calls.append(1), real_base())[1]
    port = await open_port(env)
    g = f"http://127.0.0.1:{port}"
    async with httpx.AsyncClient() as c:
        for path in ("/models", "/instances/next-port", "/shutdown", "/health", "/instances/1/start", "/../../etc/passwd"):
            r = await c.get(f"{g}{path}")
            assert r.status_code in (404, 405, 403), (path, r.status_code)
    assert not calls                                                           # reading /models would have used the store server


async def test_live_updates_reach_guests_and_other_sockets_are_refused(env):
    await env.client.put("/settings", json={"refresh_interval_seconds": 1})
    port = await open_port(env)
    async with websockets.connect(f"ws://127.0.0.1:{port}/ws") as ws:
        msg = json.loads(await __import__("asyncio").wait_for(ws.recv(), 10))
        assert msg["type"] in ("metrics", "log", "instance")
    try:
        async with websockets.connect(f"ws://127.0.0.1:{port}/other") as ws:
            await ws.recv()
        raise AssertionError("a guest reached a websocket that is not /ws")
    except (websockets.exceptions.ConnectionClosed, websockets.exceptions.InvalidStatus):
        pass
    await env.client.put("/settings", json={"external_monitoring_enabled": False})
    try:
        async with websockets.connect(f"ws://127.0.0.1:{port}/ws") as ws:
            await ws.recv()
        raise AssertionError("nothing should accept a guest socket once web monitoring is off")
    except (OSError, websockets.exceptions.ConnectionClosed, websockets.exceptions.InvalidStatus):
        pass


async def test_the_number_of_guest_sockets_is_limited(env, monkeypatch):
    import asyncio
    from app.services import external
    monkeypatch.setattr(external, "MAX_GUEST_SOCKETS", 2)
    port = await open_port(env)
    socks = [await websockets.connect(f"ws://127.0.0.1:{port}/ws") for _ in range(2)]
    try:
        try:
            third = await websockets.connect(f"ws://127.0.0.1:{port}/ws")
            await asyncio.wait_for(third.recv(), 3)  # only reached if it was let in
            refused = False
        except (websockets.exceptions.InvalidStatus, websockets.exceptions.ConnectionClosed):
            refused = True
        except asyncio.TimeoutError:
            refused = False
        assert refused
        # a place frees up when a guest leaves
        await socks.pop().close()
        await wait_for(lambda: True)
        again = await websockets.connect(f"ws://127.0.0.1:{port}/ws")
        await again.close()
    finally:
        for s in socks:
            await s.close()


async def test_the_guest_ui_files_carry_the_content_security_policy(env):
    port = await open_port(env)
    async with httpx.AsyncClient() as c:
        page = await c.get(f"http://127.0.0.1:{port}/")
        assert "script-src 'self'" in page.headers["content-security-policy"]
