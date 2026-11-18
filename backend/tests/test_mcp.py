"""The MCP server: its listener, its token, and the read-only tools, tried with the MCP SDK's own client over real HTTP."""
import sys

import httpx
import httpx2
import pytest
from mcp import Client
from mcp.client.stdio import StdioServerParameters
from mcp.client.streamable_http import streamable_http_client

from app.services.mcp import RateLimiter
from app.services.mcp_tools import clamp, instructions, masked
from app.services.shot_bridge import ShotBridge
from tests.conftest import free_port, wait_for

TOKEN = "t" * 32


async def start_mcp(env, token=TOKEN, **extra):
    port = free_port()
    r = await env.client.put("/settings", json={"mcp_enabled": True, "mcp_port": port, "mcp_token": token, **extra})
    assert r.status_code == 200, r.text
    await wait_for(lambda: env.app.state.mcp.active)
    return port


def connect(port, token=TOKEN):
    """The SDK's client, sending the token as every client of this server has to."""
    http = httpx2.AsyncClient(headers={"Authorization": f"Bearer {token}"})
    return Client(streamable_http_client(f"http://127.0.0.1:{port}/mcp", http_client=http))


# ---- the listener follows the settings

async def test_the_server_is_off_by_default_and_needs_a_token_to_start(env):
    status = (await env.client.get("/info")).json()["mcp"]
    assert status["enabled"] is False and status["active"] is False and status["token_set"] is False and status["port"] == 9101
    port = free_port()
    await env.client.put("/settings", json={"mcp_enabled": True, "mcp_port": port})  # on, but there is no token
    assert env.app.state.mcp.active is False
    with pytest.raises(httpx.ConnectError):
        async with httpx.AsyncClient() as c:
            await c.post(f"http://127.0.0.1:{port}/mcp", json={})


async def test_it_starts_when_the_token_is_set_and_stops_when_it_is_switched_off(env):
    port = await start_mcp(env)
    status = (await env.client.get("/info")).json()["mcp"]
    assert status["active"] is True and status["port"] == port and status["lan"] is False and status["token_set"] is True
    await env.client.put("/settings", json={"mcp_enabled": False})
    assert env.app.state.mcp.active is False
    with pytest.raises(httpx.ConnectError):
        async with httpx.AsyncClient() as c:
            await c.post(f"http://127.0.0.1:{port}/mcp", json={})


async def test_removing_the_token_stops_it_and_changing_the_port_moves_it(env):
    port = await start_mcp(env)
    other = free_port()
    await env.client.put("/settings", json={"mcp_port": other})
    await wait_for(lambda: env.app.state.mcp.active)
    async with httpx.AsyncClient() as c:
        with pytest.raises(httpx.ConnectError):
            await c.post(f"http://127.0.0.1:{port}/mcp", json={})
        assert (await c.post(f"http://127.0.0.1:{other}/mcp", json={})).status_code == 401  # there, and asking for the token
    await env.client.put("/settings", json={"mcp_token": ""})
    assert env.app.state.mcp.active is False


async def test_a_port_in_use_is_reported_not_taken(env):
    busy = free_port()
    await env.client.put("/settings", json={"external_monitoring_enabled": True, "external_monitoring_port": busy})
    await wait_for(lambda: env.app.state.external.active)
    r = await env.client.put("/settings", json={"mcp_port": busy})  # the same as the web access port
    assert r.status_code == 409
    inst = (await env.client.post("/instances", json={"name": "a", "port": free_port()})).json()
    r = await env.client.put("/settings", json={"mcp_port": inst["port"]})
    assert r.status_code == 409
    other = free_port()
    await env.client.put("/settings", json={"mcp_enabled": True, "mcp_token": TOKEN, "mcp_port": other})
    r = await env.client.post("/instances", json={"name": "b", "port": other})  # an instance may not take the MCP port either
    assert r.status_code >= 400


# ---- the token and the rate

async def test_a_request_without_the_right_token_is_refused_and_repeated_mistakes_lock_the_sender(env):
    port = await start_mcp(env)
    url = f"http://127.0.0.1:{port}/mcp"
    async with httpx.AsyncClient() as c:
        none = await c.post(url, json={})
        assert none.status_code == 401 and none.headers["www-authenticate"] == "Bearer"
        wrong = await c.post(url, json={}, headers={"Authorization": "Bearer nope"})
        assert wrong.status_code == 401
        for _ in range(10):
            await c.post(url, json={}, headers={"Authorization": "Bearer nope"})
        locked = await c.post(url, json={}, headers={"Authorization": f"Bearer {TOKEN}"})  # even the right one waits
        assert locked.status_code == 429


async def test_only_the_mcp_path_is_served_and_the_token_is_not_a_cookie_or_a_query(env):
    port = await start_mcp(env)
    async with httpx.AsyncClient() as c:
        assert (await c.get(f"http://127.0.0.1:{port}/")).status_code == 404
        assert (await c.get(f"http://127.0.0.1:{port}/metrics")).status_code == 404
        assert (await c.post(f"http://127.0.0.1:{port}/mcp?token={TOKEN}", json={})).status_code == 401
        c.cookies.set("token", TOKEN)
        assert (await c.post(f"http://127.0.0.1:{port}/mcp", json={})).status_code == 401


async def test_a_page_of_another_site_cannot_reach_a_loopback_server_by_dns_rebinding(env):
    port = await start_mcp(env)
    body = {"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}}
    headers = {"Authorization": f"Bearer {TOKEN}", "Accept": "application/json, text/event-stream"}
    async with httpx.AsyncClient() as c:
        evil_host = await c.post(f"http://127.0.0.1:{port}/mcp", json=body, headers={**headers, "Host": f"evil.example:{port}"})
        assert evil_host.status_code == 421
        evil_origin = await c.post(f"http://127.0.0.1:{port}/mcp", json=body, headers={**headers, "Origin": "https://evil.example"})
        assert evil_origin.status_code in (400, 403)


def test_requests_are_counted_per_sender():
    rate = RateLimiter(limit=3, window=10)
    assert [rate.allow("a", now=t) for t in (0, 1, 2, 3)] == [True, True, True, False]
    assert rate.allow("b", now=3) is True  # another sender has its own count
    assert rate.allow("a", now=10.5) is True  # the oldest request left the window


async def test_too_many_requests_are_refused(env, monkeypatch):
    port = await start_mcp(env)
    env.app.state.mcp._server.config.app.rate = RateLimiter(limit=2, window=60)  # the gate of the running listener
    async with httpx.AsyncClient() as c:
        codes = [(await c.post(f"http://127.0.0.1:{port}/mcp", json={}, headers={"Authorization": f"Bearer {TOKEN}"})).status_code for _ in range(4)]
    assert codes[2:] == [429, 429] and 429 not in codes[:2]


# ---- the tools

async def test_the_tools_are_read_only_and_there_are_no_others(env):
    port = await start_mcp(env)
    async with connect(port) as client:
        tools = (await client.list_tools()).tools
        names = {t.name for t in tools}
        assert names == {"list_instances", "get_instance", "get_system_status", "get_system_history", "get_instance_history", "list_models",
                         "get_model", "list_downloads", "get_logs", "get_requests"}
        assert all(t.annotations and t.annotations.read_only_hint and not t.annotations.destructive_hint for t in tools)
        assert not {"start_instance", "stop_instance", "delete_instance", "put_settings", "shutdown"} & names


async def test_instances_are_listed_without_their_api_keys(env):
    inst = (await env.client.post("/instances", json={"name": "keyed", "port": free_port(), "options": {"api_key": "super-secret-key-1234"}})).json()
    port = await start_mcp(env)
    async with connect(port) as client:
        listed = await client.call_tool("list_instances", {})
        one = await client.call_tool("get_instance", {"instance_id": inst["id"]})
    for result in (listed, one):
        assert "super-secret-key-1234" not in str(result.content) and "super-secret-key-1234" not in str(result.structured_content)
    assert one.structured_content["options"]["api_key"] == "********" and one.structured_content["name"] == "keyed"
    assert [i["name"] for i in listed.structured_content["result"]] == ["keyed"]


async def test_an_instance_that_does_not_exist_is_a_tool_error_the_model_can_read(env):
    port = await start_mcp(env)
    async with connect(port) as client:
        result = await client.call_tool("get_instance", {"instance_id": 999})
        assert result.is_error and "not" in result.content[0].text.lower()
        history = await client.call_tool("get_instance_history", {"instance_id": 999})
        assert history.is_error


async def test_the_system_status_and_the_logs(env):
    port = await start_mcp(env)
    await wait_for(lambda: env.app.state.collector.latest)
    inst = (await env.client.post("/instances", json={"name": "logged", "port": free_port()})).json()
    async with connect(port) as client:
        status = await client.call_tool("get_system_status", {})
        assert status.structured_content["gpu"]["devices"][0]["name"] == "Fake GPU" and "cpu_percent" in status.structured_content["system"]
        logs = await client.call_tool("get_logs", {"limit": 5})
        assert any("logged" in line["msg"] for line in logs.structured_content["result"])
        one = await client.call_tool("get_logs", {"instance_id": inst["id"], "limit": 1000})  # more than the most: it is cut, not refused
        assert not one.is_error and len(one.structured_content["result"]) <= 300


async def test_the_request_journal_gives_numbers_and_never_what_was_asked(env):
    inst = (await env.client.post("/instances", json={"name": "journal", "port": free_port(), "options": {"save_requests": True}})).json()
    env.app.state.manager.request_log.add(inst["id"], {
        "id": "r1", "ts": 1.0, "path": "/api/chat", "model": "m", "status": 200, "outcome": "ok", "duration": 1.2, "ttft": 0.3,
        "tokens": 5, "prompt_tokens": 3, "client": "127.0.0.1", "saved": True,
    }, request="THE-SECRET-PROMPT", response="THE-SECRET-ANSWER")
    port = await start_mcp(env)
    async with connect(port) as client:
        result = await client.call_tool("get_requests", {"instance_id": inst["id"], "limit": 10})
    text = str(result.structured_content) + str(result.content)
    assert "THE-SECRET" not in text
    assert result.structured_content["requests"][0]["path"] == "/api/chat" and result.structured_content["requests"][0]["tokens"] == 5


async def test_models_and_downloads(env):
    port = await start_mcp(env)
    async with connect(port) as client:
        models = await client.call_tool("list_models", {})
        assert not models.is_error and isinstance(models.structured_content["result"], list)
        downloads = await client.call_tool("list_downloads", {})
        assert not downloads.is_error and downloads.structured_content["result"] == []


# ---- the control tools (off unless switched on)

CONTROL = {"start_instance", "stop_instance", "restart_instance"}


async def test_the_control_tools_are_not_offered_until_the_control_switch_is_on(env):
    port = await start_mcp(env)
    assert (await env.client.get("/info")).json()["mcp"]["control"] is False
    async with connect(port) as client:
        init = await client.list_tools()
        assert not CONTROL & {t.name for t in init.tools}
    await env.client.put("/settings", json={"mcp_control": True})  # the tools are registered when the server is built: it is rebuilt
    await wait_for(lambda: env.app.state.mcp.active and env.app.state.mcp._bound[2] is True)
    assert (await env.client.get("/info")).json()["mcp"]["control"] is True
    async with connect(port) as client:
        tools = {t.name: t for t in (await client.list_tools()).tools}
        assert CONTROL <= set(tools)
        assert tools["start_instance"].annotations.read_only_hint is False and tools["start_instance"].annotations.destructive_hint is False
        assert tools["stop_instance"].annotations.destructive_hint is True and tools["restart_instance"].annotations.destructive_hint is True
        assert not {"delete_instance", "create_instance", "put_settings", "shutdown"} & set(tools)  # nothing else changes the app
    await env.client.put("/settings", json={"mcp_control": False})
    await wait_for(lambda: env.app.state.mcp.active and env.app.state.mcp._bound[2] is False)
    async with connect(port) as client:
        assert not CONTROL & {t.name for t in (await client.list_tools()).tools}


async def test_an_instance_is_started_stopped_and_restarted_through_the_tools(env):
    inst = (await env.client.post("/instances", json={"name": "ctl", "port": free_port()})).json()
    port = await start_mcp(env, mcp_control=True)
    state = lambda: env.app.state.manager.status(inst["id"])["state"]
    async with connect(port) as client:
        started = await client.call_tool("start_instance", {"instance_id": inst["id"]})
        assert not started.is_error and started.structured_content["name"] == "ctl"
        await wait_for(lambda: state() == "running")
        again = await client.call_tool("start_instance", {"instance_id": inst["id"]})
        assert again.is_error and "already" in again.content[0].text.lower()  # a refusal the model can read
        restarted = await client.call_tool("restart_instance", {"instance_id": inst["id"], "drain_seconds": 1000})  # more than the most: cut, not refused
        assert not restarted.is_error
        await wait_for(lambda: state() == "running")
        stopped = await client.call_tool("stop_instance", {"instance_id": inst["id"]})
        assert not stopped.is_error
        await wait_for(lambda: state() == "stopped")
        assert env.app.state.manager.get(inst["id"])["desired_state"] == "stopped"  # it stays stopped across an app restart
        missing = await client.call_tool("stop_instance", {"instance_id": 999})
        assert missing.is_error and "not" in missing.content[0].text.lower()


async def test_an_instance_returned_by_a_control_tool_has_no_api_key(env):
    inst = (await env.client.post("/instances", json={"name": "keyed2", "port": free_port(), "options": {"api_key": "super-secret-key-5678"}})).json()
    port = await start_mcp(env, mcp_control=True)
    async with connect(port) as client:
        result = await client.call_tool("stop_instance", {"instance_id": inst["id"]})
    assert "super-secret-key-5678" not in str(result.content) + str(result.structured_content)


# ---- the screenshot tool (developer mode, its own switch, this PC only)

PNG = b"\x89PNG\r\n\x1a\n-fake-picture"


def fake_listener(requests, status=200, reply=None):
    """Stands in for Electron's screenshot listener: records what it is asked, answers with a picture (or with `reply`)."""
    def handler(request: httpx.Request) -> httpx.Response:
        import base64
        import json
        requests.append((request.url.path, request.headers.get("authorization"), json.loads(request.content)))
        body = reply or {"ok": True, "mime": "image/png", "file": "/data/screenshots/s.png", "width": 400, "height": 800, "full_width": 800, "full_height": 1600,
                         "data": base64.b64encode(PNG).decode()}
        return httpx.Response(status, json=body)
    return httpx.MockTransport(handler)


def with_listener(env, requests, **kwargs):
    env.app.state.mcp.shots = ShotBridge("http://shots.test", "shot-token", transport=fake_listener(requests, **kwargs))


async def test_the_screenshot_tool_is_not_offered_without_developer_mode_or_the_switch(env):
    port = await start_mcp(env, mcp_screenshot=True)  # the switch is on, but the app has no listener: it is not in developer mode
    status = (await env.client.get("/info")).json()["mcp"]
    assert status["screenshot"] is True and status["screenshot_available"] is False and status["screenshot_active"] is False
    async with connect(port) as client:
        assert "take_screenshot" not in {t.name for t in (await client.list_tools()).tools}
    with_listener(env, [])  # developer mode, but the switch is off
    await env.client.put("/settings", json={"mcp_screenshot": False})
    await wait_for(lambda: env.app.state.mcp.active and env.app.state.mcp._bound[3] is False)
    async with connect(port) as client:
        assert "take_screenshot" not in {t.name for t in (await client.list_tools()).tools}


async def test_the_screenshot_tool_hands_over_the_picture_and_where_it_was_saved(env):
    requests = []
    with_listener(env, requests)
    port = await start_mcp(env, mcp_screenshot=True)
    assert (await env.client.get("/info")).json()["mcp"]["screenshot_active"] is True
    async with connect(port) as client:
        tools = {t.name: t for t in (await client.list_tools()).tools}
        assert tools["take_screenshot"].annotations.read_only_hint is False and tools["take_screenshot"].annotations.destructive_hint is False
        result = await client.call_tool("take_screenshot", {"kind": "element", "selector": "#logs", "instance_id": 2, "depth": 6, "max_side": 900})
    assert not result.is_error
    image = next(c for c in result.content if c.type == "image")
    assert image.mime_type == "image/png"
    import base64
    assert base64.b64decode(image.data) == PNG
    text = next(c for c in result.content if c.type == "text").text
    assert "/data/screenshots/s.png" in text and "400x800" in text and "800x1600" in text  # saved where, how large, and that it was scaled down
    assert requests == [("/capture", "Bearer shot-token", {"kind": "element", "max_side": 900, "selector": "#logs", "instance_id": 2, "depth": 6})]


async def test_the_screenshot_tool_defaults_and_limits(env):
    requests = []
    with_listener(env, requests)
    port = await start_mcp(env, mcp_screenshot=True)
    async with connect(port) as client:
        await client.call_tool("take_screenshot", {})
        await client.call_tool("take_screenshot", {"kind": "full", "max_side": 100000})  # more than the most: cut, not refused
        refused = await client.call_tool("take_screenshot", {"kind": "video"})
    assert requests[0][2] == {"kind": "viewport", "max_side": 1568}
    assert requests[1][2] == {"kind": "full", "max_side": 4096}
    assert refused.is_error and len(requests) == 2  # a kind that does not exist never reaches the app


async def test_a_screenshot_that_fails_is_a_tool_error_the_model_can_read(env):
    requests = []
    with_listener(env, requests, status=404, reply={"ok": False, "code": "NO_WINDOW", "message": "The monitor window of instance 9 is not open"})
    port = await start_mcp(env, mcp_screenshot=True)
    async with connect(port) as client:
        result = await client.call_tool("take_screenshot", {"instance_id": 9})
    assert result.is_error and "not open" in result.content[0].text


async def test_a_listener_that_cannot_be_reached_is_an_error_not_a_crash(env):
    env.app.state.mcp.shots = ShotBridge("http://127.0.0.1:1", "shot-token")  # nothing listens there
    port = await start_mcp(env, mcp_screenshot=True)
    async with connect(port) as client:
        result = await client.call_tool("take_screenshot", {})
    assert result.is_error and "cannot be reached" in result.content[0].text


async def test_with_other_machines_allowed_the_screenshot_tool_is_not_offered(env):
    with_listener(env, [])
    port = await start_mcp(env, mcp_screenshot=True, mcp_lan=True)  # what a screenshot shows is not meant to leave this PC
    status = (await env.client.get("/info")).json()["mcp"]
    assert status["lan"] is True and status["screenshot"] is True and status["screenshot_active"] is False
    async with connect(port) as client:
        assert "take_screenshot" not in {t.name for t in (await client.list_tools()).tools}
    await env.client.put("/settings", json={"mcp_lan": False})  # back to this PC only: the tool comes
    await wait_for(lambda: env.app.state.mcp.active and env.app.state.mcp._bound[3] is True)


def test_the_bridge_is_there_only_with_an_address_and_a_token():
    assert ShotBridge.from_env({}).available is False
    assert ShotBridge.from_env({"OMM_SHOT_URL": "http://127.0.0.1:5"}).available is False
    assert ShotBridge.from_env({"OMM_SHOT_URL": "http://127.0.0.1:5", "OMM_SHOT_TOKEN": "t"}).available is True


# ---- stdio: a bridge to the running server

def stdio_client_for(args, port, token=TOKEN, **extra_env):
    import os
    env = {k: v for k, v in os.environ.items() if k in ("PATH", "HOME", "SYSTEMROOT", "PYTHONPATH")}
    env.update({"OMM_MCP_TOKEN": token, "OMM_MCP_URL": f"http://127.0.0.1:{port}/mcp", **extra_env})
    return Client(StdioServerParameters(command=sys.executable, args=args, env=env))


async def test_a_client_that_starts_the_server_as_a_program_gets_the_same_tools_over_stdio(env):
    inst = (await env.client.post("/instances", json={"name": "stdio-one", "port": free_port()})).json()
    port = await start_mcp(env)
    async with stdio_client_for(["-m", "app.mcp_stdio"], port) as client:
        names = {t.name for t in (await client.list_tools()).tools}
        assert "list_instances" in names and not {"start_instance", "stop_instance", "take_screenshot"} & names  # what the settings allow, no more
        result = await client.call_tool("get_instance", {"instance_id": inst["id"]})
        assert not result.is_error and result.structured_content["name"] == "stdio-one"


async def test_the_bridge_is_also_reached_through_the_backends_own_command_and_follows_the_switches(env):
    port = await start_mcp(env, mcp_control=True)
    async with stdio_client_for(["-m", "app", "mcp-stdio"], port) as client:
        assert {"start_instance", "stop_instance", "restart_instance"} <= {t.name for t in (await client.list_tools()).tools}


async def test_the_bridge_with_a_wrong_token_gets_no_tools_and_without_one_it_says_so(env):
    port = await start_mcp(env)
    with pytest.raises(Exception):  # the server refuses the session: the client does not get as far as the tools
        async with stdio_client_for(["-m", "app.mcp_stdio"], port, token="wrong" * 8) as client:
            await client.list_tools()
    import subprocess
    r = subprocess.run([sys.executable, "-m", "app.mcp_stdio"], capture_output=True, text=True, timeout=30, env={"PATH": "/usr/bin:/bin"}, cwd=str(__import__("pathlib").Path(__file__).parents[1]))
    assert r.returncode == 2 and "OMM_MCP_TOKEN" in r.stderr


# ---- the settings that belong to it

async def test_the_token_has_a_least_length_and_guests_never_see_it(env):
    short = await env.client.put("/settings", json={"mcp_token": "short"})
    assert short.status_code == 422
    ok = await env.client.put("/settings", json={"mcp_token": TOKEN})
    assert ok.json()["mcp_token"] == TOKEN and ok.json()["mcp_token_set"] is True  # the settings window shows it, to be copied


async def test_guests_of_the_web_access_never_see_the_mcp_token(env):
    web = free_port()
    await env.client.put("/settings", json={"mcp_token": TOKEN, "external_monitoring_enabled": True, "external_monitoring_port": web})
    await wait_for(lambda: env.app.state.external.active)
    async with httpx.AsyncClient() as guest:
        settings = (await guest.get(f"http://127.0.0.1:{web}/settings")).json()
    assert "mcp_token" not in settings and TOKEN not in str(settings)
    assert settings["mcp_token_set"] is True  # that there is one is not a secret; what it is, is


async def test_with_other_machines_allowed_the_address_is_not_known_in_advance_and_the_token_stands_guard(env):
    port = await start_mcp(env, mcp_lan=True)
    assert (await env.client.get("/info")).json()["mcp"]["lan"] is True
    body = {"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}}
    headers = {"Accept": "application/json, text/event-stream", "Host": f"192.168.1.20:{port}"}
    async with httpx.AsyncClient() as c:
        refused = await c.post(f"http://127.0.0.1:{port}/mcp", json=body, headers=headers)  # no token
        assert refused.status_code == 401
        passed = await c.post(f"http://127.0.0.1:{port}/mcp", json=body, headers={**headers, "Authorization": f"Bearer {TOKEN}"})
        assert passed.status_code != 421  # the Host of a LAN address is accepted; the token was what counted


def test_what_the_tools_show_of_an_instance_and_how_much_they_return():
    assert masked({"options": {"api_key": "k", "num_ctx": 1}})["options"] == {"api_key": "********", "num_ctx": 1}
    assert masked({"options": {"num_ctx": 1}})["options"] == {"num_ctx": 1}
    assert [clamp(v, 1, 300) for v in (-5, 0, 100, 5000)] == [1, 1, 100, 300]


def test_what_the_server_tells_a_client_about_itself_follows_the_control_switch():
    assert "start_instance" not in instructions(False) and "Nothing here changes the app" in instructions(False)
    assert "start_instance" in instructions(True) and "only when the user asked" in instructions(True)
    assert "take_screenshot" not in instructions(False) and "prompts and answers" in instructions(False, True)
