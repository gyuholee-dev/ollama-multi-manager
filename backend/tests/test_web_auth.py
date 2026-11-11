"""Web access: the web UI and API on its port need the password; a signed-in visitor holds a cookie."""
import json

import httpx
import websockets

from app.services import external, webauth
from app.main import create_app
from tests.conftest import free_port

PASSWORD = "correct horse"


async def open_port(env, password=PASSWORD):
    port = free_port()
    body = {"external_monitoring_enabled": True, "external_monitoring_port": port}
    if password is not None:
        body["external_monitoring_password"] = password
    r = await env.client.put("/settings", json=body)
    assert r.status_code == 200, r.text
    return port


async def sign_in(c, port, password=PASSWORD):
    return await c.post(f"http://127.0.0.1:{port}/login", data={"password": password}, follow_redirects=False)


async def test_the_password_is_stored_as_a_hash_and_never_returned(env):
    r = await env.client.put("/settings", json={"external_monitoring_password": PASSWORD})
    body = r.json()
    assert body["external_monitoring_password_set"] is True and "external_monitoring_password" not in body
    assert PASSWORD not in json.dumps((await env.client.get("/settings")).json())
    stored = env.app.state.settings.get("external_monitoring_password_hash")
    assert stored.startswith("pbkdf2_sha256$") and PASSWORD not in stored
    assert (await env.client.get("/info")).json()["external_monitoring"]["password_set"] is True
    assert (await env.client.put("/settings", json={"external_monitoring_password": ""})).json()["external_monitoring_password_set"] is False
    assert (await env.client.put("/settings", json={"external_monitoring_password": "abc"})).status_code == 422  # too short


async def test_without_a_password_the_port_is_guest_mode(env):
    port = await open_port(env, password=None)
    g = f"http://127.0.0.1:{port}"
    async with httpx.AsyncClient() as c:
        assert (await c.get(f"{g}/info")).json()["guest"] is True                 # read-only, no login
        assert (await c.get(f"{g}/")).status_code == 200
        assert (await c.put(f"{g}/settings", json={"theme": "dark"})).status_code == 403
        assert (await c.get(f"{g}/login")).status_code != 200                      # there is nothing to sign in to
    await env.client.put("/settings", json={"external_monitoring_password": PASSWORD})
    async with httpx.AsyncClient() as c:                                           # setting a password ends guest mode at once
        assert (await c.get(f"{g}/info")).status_code == 401
        await sign_in(c, port)
        assert (await c.get(f"{g}/info")).json()["guest"] is False
    await env.client.put("/settings", json={"external_monitoring_password": ""})
    async with httpx.AsyncClient() as c:                                           # and removing it brings guest mode back
        assert (await c.get(f"{g}/info")).json()["guest"] is True


async def test_sign_in_gives_a_cookie_that_lasts_twelve_hours_by_default(env):
    port = await open_port(env)
    g = f"http://127.0.0.1:{port}"
    async with httpx.AsyncClient() as c:
        page = await c.get(f"{g}/", headers={"accept": "text/html"})
        assert page.status_code == 401 and "password" in page.text and "script-src 'self'" in page.headers["content-security-policy"]
        assert (await c.get(f"{g}/instances")).status_code == 401                         # the API says so as JSON
        bad = await sign_in(c, port, "wrong")
        assert bad.status_code == 401 and webauth.COOKIE_NAME not in bad.headers.get("set-cookie", "")
        ok = await sign_in(c, port)
        assert ok.status_code == 303 and ok.headers["location"] == "/"
        cookie = ok.headers["set-cookie"]
        assert f"{webauth.COOKIE_NAME}=" in cookie and "HttpOnly" in cookie and "Max-Age=43200" in cookie and "SameSite=lax" in cookie
        # the cookie is kept by the client: no more sign-in, and the UI is served
        page = await c.get(f"{g}/")
        assert page.status_code == 200 and "Ollama Multi Manager" in page.text
        assert (await c.get(f"{g}/info")).status_code == 200


async def test_the_session_length_can_be_changed(env):
    await env.client.put("/settings", json={"external_monitoring_session_hours": 2})
    port = await open_port(env)
    async with httpx.AsyncClient() as c:
        assert "Max-Age=7200" in (await sign_in(c, port)).headers["set-cookie"]


async def test_an_expired_or_forged_cookie_is_not_accepted(env):
    port = await open_port(env)
    stored = env.app.state.settings.get("external_monitoring_password_hash")
    expired, _ = webauth.make_session(stored, 1, now=0)
    forged = "9999999999." + "0" * 64
    async with httpx.AsyncClient() as c:
        for value in (expired, forged, "garbage", ""):
            r = await c.get(f"http://127.0.0.1:{port}/info", headers={"cookie": f"{webauth.COOKIE_NAME}={value}"})
            assert r.status_code == 401, value


async def test_changing_the_password_ends_every_session(env):
    port = await open_port(env)
    g = f"http://127.0.0.1:{port}"
    async with httpx.AsyncClient() as c:
        await sign_in(c, port)
        assert (await c.get(f"{g}/info")).status_code == 200
        await env.client.put("/settings", json={"external_monitoring_password": "another one"})
        assert (await c.get(f"{g}/info")).status_code == 401
        assert (await sign_in(c, port)).status_code == 401
        assert (await sign_in(c, port, "another one")).status_code == 303


async def test_a_signed_in_visitor_can_do_what_the_app_does(tmp_path, fake_exe, provider):
    app = create_app(data_dir=tmp_path / "data", provider=provider, token="main-token")
    async with app.router.lifespan_context(app):
        main = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t", headers={"Authorization": "Bearer main-token"})
        async with main:
            port = free_port()
            await main.put("/settings", json={"ollama_executable_path": fake_exe, "external_monitoring_enabled": True,
                                              "external_monitoring_port": port, "external_monitoring_password": PASSWORD})
            g = f"http://127.0.0.1:{port}"
            async with httpx.AsyncClient() as web:                       # no Authorization header at all
                assert (await httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t").get("/instances")).status_code == 401
                await sign_in(web, port)
                made = await web.post(f"{g}/instances", json={"name": "from-web", "port": free_port(), "options": {"api_key": "key-1234567890123456"}})
                assert made.status_code == 201, made.text
                items = (await web.get(f"{g}/instances")).json()
                assert items[0]["name"] == "from-web" and items[0]["options"]["api_key"] == "key-1234567890123456"
                assert (await web.put(f"{g}/settings", json={"theme": "dark"})).status_code == 200
                assert "external_monitoring_password_hash" not in (await web.get(f"{g}/settings")).json()
            assert (await main.get("/settings")).json()["theme"] == "dark"


async def test_a_request_from_another_site_is_refused_even_with_the_cookie(env):
    port = await open_port(env)
    g = f"http://127.0.0.1:{port}"
    async with httpx.AsyncClient() as c:
        await sign_in(c, port)
        r = await c.put(f"{g}/settings", json={"theme": "dark"}, headers={"origin": "http://evil.example"})
        assert r.status_code == 403
        assert (await c.put(f"{g}/settings", json={"theme": "dark"}, headers={"origin": g})).status_code == 200
        r = await c.post(f"{g}/login", data={"password": PASSWORD}, headers={"origin": "http://evil.example"}, follow_redirects=False)
        assert r.status_code == 403


async def test_wrong_passwords_lock_an_address_out_for_a_while(env):
    port = await open_port(env)
    async with httpx.AsyncClient() as c:
        for _ in range(webauth.MAX_FAILURES):
            assert (await sign_in(c, port, "nope")).status_code == 401
        assert (await sign_in(c, port, "nope")).status_code == 429
        assert (await sign_in(c, port)).status_code == 429                      # even the right one has to wait


def test_the_limiter_counts_and_forgets():
    lim = webauth.LoginLimiter()
    for _ in range(webauth.MAX_FAILURES):
        assert not lim.locked("a", now=100)
        lim.failed("a", now=100)
    assert lim.locked("a", now=101) and not lim.locked("b", now=101)
    assert not lim.locked("a", now=100 + webauth.LOCK_SECONDS + 1)              # the lock runs out
    lim.failed("b", now=100)
    lim.ok("b")
    assert not lim.locked("b", now=100)


async def test_live_updates_need_the_cookie(env):
    await env.client.put("/settings", json={"refresh_interval_seconds": 1})
    port = await open_port(env)
    try:
        async with websockets.connect(f"ws://127.0.0.1:{port}/ws") as ws:
            await ws.recv()
        raise AssertionError("a socket without the cookie was accepted")
    except (websockets.exceptions.ConnectionClosed, websockets.exceptions.InvalidStatus):
        pass
    async with httpx.AsyncClient() as c:
        cookie = (await sign_in(c, port)).headers["set-cookie"].split(";")[0]
    async with websockets.connect(f"ws://127.0.0.1:{port}/ws", additional_headers={"Cookie": cookie}) as ws:
        msg = json.loads(await __import__("asyncio").wait_for(ws.recv(), 10))
        assert msg["type"] in ("metrics", "log", "instance")
    try:
        async with websockets.connect(f"ws://127.0.0.1:{port}/other", additional_headers={"Cookie": cookie}) as ws:
            await ws.recv()
        raise AssertionError("a socket reached a path that is not /ws")
    except (websockets.exceptions.ConnectionClosed, websockets.exceptions.InvalidStatus):
        pass


async def test_the_number_of_web_sockets_is_limited(env, monkeypatch):
    import asyncio
    monkeypatch.setattr(external, "MAX_WEB_SOCKETS", 2)
    port = await open_port(env)
    async with httpx.AsyncClient() as c:
        cookie = (await sign_in(c, port)).headers["set-cookie"].split(";")[0]
    url = f"ws://127.0.0.1:{port}/ws"
    socks = [await websockets.connect(url, additional_headers={"Cookie": cookie}) for _ in range(2)]
    try:
        try:
            third = await websockets.connect(url, additional_headers={"Cookie": cookie})
            await asyncio.wait_for(third.recv(), 3)  # only reached if it was let in
            refused = False
        except (websockets.exceptions.InvalidStatus, websockets.exceptions.ConnectionClosed):
            refused = True
        except asyncio.TimeoutError:
            refused = False
        assert refused
    finally:
        for s in socks:
            await s.close()


async def test_the_web_port_closes_when_web_monitoring_is_switched_off(env):
    port = await open_port(env)
    async with httpx.AsyncClient() as c:
        assert (await c.get(f"http://127.0.0.1:{port}/login")).status_code == 200
        await env.client.put("/settings", json={"external_monitoring_enabled": False})   # no restart needed
        try:
            await c.get(f"http://127.0.0.1:{port}/login")
            raise AssertionError("the port should be closed")
        except httpx.ConnectError:
            pass


# ---- the metrics token: /metrics on the web access port

TOKEN = "scrape-token-0123456789"


async def snapshot_ready(env):
    c = env.app.state.collector
    c.latest = await c.collect()


async def test_the_token_is_returned_to_the_owner_and_hidden_from_guests(env):
    r = await env.client.put("/settings", json={"external_monitoring_metrics_token": TOKEN})
    body = r.json()
    assert body["external_monitoring_metrics_token_set"] is True and body["external_monitoring_metrics_token"] == TOKEN
    assert (await env.client.get("/settings")).json()["external_monitoring_metrics_token"] == TOKEN
    assert (await env.client.get("/info")).json()["external_monitoring"]["metrics_token_set"] is True
    assert (await env.client.put("/settings", json={"external_monitoring_metrics_token": "short"})).status_code == 422
    assert (await env.client.put("/settings", json={"external_monitoring_metrics_token": ""})).json()["external_monitoring_metrics_token_set"] is False


async def test_without_a_token_metrics_are_not_exported_in_any_mode(env):
    await snapshot_ready(env)
    port = await open_port(env, password=None)
    g = f"http://127.0.0.1:{port}"
    async with httpx.AsyncClient() as c:
        assert (await c.get(f"{g}/metrics")).status_code == 404                           # guest mode
        assert (await c.get(f"{g}/metrics", headers={"authorization": "Bearer anything-at-all-123"})).status_code == 404
    await env.client.put("/settings", json={"external_monitoring_password": PASSWORD})
    async with httpx.AsyncClient() as c:
        await sign_in(c, port)
        assert (await c.get(f"{g}/metrics")).status_code == 404                           # not even signed in


async def test_the_token_opens_metrics_and_nothing_else(env):
    await snapshot_ready(env)
    await env.client.put("/settings", json={"external_monitoring_metrics_token": TOKEN})
    port = await open_port(env)                                                           # a password is set too
    g = f"http://127.0.0.1:{port}"
    bearer = {"authorization": f"Bearer {TOKEN}"}
    async with httpx.AsyncClient() as c:
        ok = await c.get(f"{g}/metrics", headers=bearer)
        assert ok.status_code == 200 and "omm_gpu_memory_total_bytes" in ok.text
        assert (await c.get(f"{g}/metrics")).status_code == 401                           # no header
        assert (await c.get(f"{g}/metrics", headers={"authorization": "Bearer wrong-token-0123456"})).status_code == 401
        assert (await c.get(f"{g}/metrics", headers={"authorization": f"Basic {TOKEN}"})).status_code == 401
        assert (await c.post(f"{g}/metrics", headers=bearer)).status_code == 404
        for path in ("/instances", "/info", "/settings"):                                 # the token is no key to the rest
            assert (await c.get(f"{g}{path}", headers=bearer)).status_code == 401, path
        await sign_in(c, port)                                                            # nor is the password's cookie a key to /metrics
        assert (await c.get(f"{g}/metrics")).status_code == 401
        assert (await c.get(f"{g}/metrics", headers=bearer)).status_code == 200


async def test_the_token_also_works_in_guest_mode_and_changing_it_ends_the_old_one(env):
    await snapshot_ready(env)
    await env.client.put("/settings", json={"external_monitoring_metrics_token": TOKEN})
    port = await open_port(env, password=None)
    g = f"http://127.0.0.1:{port}"
    async with httpx.AsyncClient() as c:
        assert (await c.get(f"{g}/metrics", headers={"authorization": f"Bearer {TOKEN}"})).status_code == 200
        assert "external_monitoring_metrics_token" not in (await c.get(f"{g}/settings")).json()  # a guest cannot read it back
        await env.client.put("/settings", json={"external_monitoring_metrics_token": "another-token-0123456"})
        assert (await c.get(f"{g}/metrics", headers={"authorization": f"Bearer {TOKEN}"})).status_code == 401
        assert (await c.get(f"{g}/metrics", headers={"authorization": "Bearer another-token-0123456"})).status_code == 200
        await env.client.put("/settings", json={"external_monitoring_metrics_token": ""})
        assert (await c.get(f"{g}/metrics", headers={"authorization": "Bearer another-token-0123456"})).status_code == 404


async def test_wrong_tokens_lock_an_address_out_for_a_while(env):
    await snapshot_ready(env)
    await env.client.put("/settings", json={"external_monitoring_metrics_token": TOKEN})
    port = await open_port(env, password=None)
    g = f"http://127.0.0.1:{port}"
    async with httpx.AsyncClient() as c:
        for _ in range(webauth.MAX_FAILURES):
            assert (await c.get(f"{g}/metrics", headers={"authorization": "Bearer wrong-token-0123456"})).status_code == 401
        assert (await c.get(f"{g}/metrics", headers={"authorization": f"Bearer {TOKEN}"})).status_code == 429   # even the right one waits
