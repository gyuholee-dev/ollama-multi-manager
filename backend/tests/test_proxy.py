import asyncio
import json
import time

import httpx
import psutil

from app.services.instances import port_free
from app.services.monitor import prometheus
from tests.conftest import free_port, wait_for


async def start(env, name="p", **opts):
    inst = (await env.client.post("/instances", json={"name": name, "port": free_port(), "options": opts})).json()
    await env.client.post(f"/instances/{inst['id']}/start")
    await wait_for(lambda: env.app.state.manager.status(inst["id"])["state"] == "running")
    return inst


def perf(env, inst):
    return env.app.state.manager.handles[inst["id"]].proxy.stats.snapshot()


async def gen(port, model="m", n=5, stream=True, path="/api/generate"):
    body = {"model": model, "prompt": "hi", "stream": stream, "options": {"num_predict": n}}
    async with httpx.AsyncClient(timeout=30) as c:
        return await c.post(f"http://127.0.0.1:{port}{path}", json=body)


async def test_instance_port_is_served_by_the_proxy_and_ollama_listens_elsewhere(env):
    inst = await start(env)
    h = env.app.state.manager.handles[inst["id"]]
    assert h.port == inst["port"] and h.inner_port not in (0, h.port)
    async with httpx.AsyncClient() as c:
        via = await c.get(f"http://127.0.0.1:{h.port}/api/version")
        direct = await c.get(f"http://127.0.0.1:{h.inner_port}/api/version")
    assert via.status_code == 200 and via.json() == direct.json()


async def test_requests_pass_through_unchanged(env):
    inst = await start(env)
    port = inst["port"]
    async with httpx.AsyncClient() as c:
        tags = await c.get(f"http://127.0.0.1:{port}/api/tags")
        missing = await c.get(f"http://127.0.0.1:{port}/api/nope")
    assert [m["name"] for m in tags.json()["models"]] == ["fake:1b"]
    assert missing.status_code == 404
    r = await gen(port, n=10, stream=False)
    assert r.status_code == 200 and r.json()["eval_count"] == 10
    r = await gen(port, n=3, path="/api/chat")
    lines = [json.loads(x) for x in r.text.splitlines()]
    assert lines[-1]["done"] is True and lines[0]["message"]["content"] == "t0 "
    assert (await gen(port, path="/v1/chat/completions", stream=False)).json()["usage"]["completion_tokens"] == 1  # max_tokens defaults to 1


async def test_streaming_arrives_chunk_by_chunk(env, monkeypatch):
    monkeypatch.setenv("FAKE_GEN_DELAY", "0.15")
    inst = await start(env)
    arrivals = []
    async with httpx.AsyncClient(timeout=30) as c:
        async with c.stream("POST", f"http://127.0.0.1:{inst['port']}/api/generate",
                            json={"model": "m", "prompt": "hi", "options": {"num_predict": 6}}) as r:
            t0 = time.monotonic()
            async for _ in r.aiter_lines():
                arrivals.append(time.monotonic() - t0)
    assert len(arrivals) == 7 and arrivals[0] < 0.5 and arrivals[-1] > 0.8  # not buffered until the end


async def test_perf_numbers(env):
    inst = await start(env)
    await gen(inst["port"], n=10, stream=True)
    await gen(inst["port"], n=10, stream=False, path="/api/chat")
    async with httpx.AsyncClient() as c:
        await c.get(f"http://127.0.0.1:{inst['port']}/api/tags")  # not an inference request
    p = perf(env, inst)
    assert p["requests"] == 2 and p["requests_total"] == 2 and p["inflight"] == 0 and p["queued"] == 0
    assert abs(p["tok_per_s"] - 10.0) < 0.01 and p["tokens"] == 20
    assert 0 < p["ttft_avg"] <= p["latency_avg"]
    whole = await env.app.state.collector.collect()
    assert whole["instances"][str(inst["id"])]["perf"]["requests"] == 2
    text = prometheus.render(whole, {inst["id"]: inst["name"]})
    assert "omm_instance_requests_inflight" in text and "omm_instance_tokens_per_second" in text


async def test_waiting_requests_are_counted_per_model(env, monkeypatch):
    monkeypatch.setenv("FAKE_GEN_DELAY", "0.1")
    inst = await start(env, num_parallel=1)
    same = [asyncio.create_task(gen(inst["port"], model="a", n=15)) for _ in range(3)]
    await wait_for(lambda: perf(env, inst)["inflight"] == 3)
    p = perf(env, inst)
    assert p["queued"] == 2 and p["processing"] == 1
    await asyncio.gather(*same)
    assert perf(env, inst)["inflight"] == 0 and perf(env, inst)["queued"] == 0
    # two different models each have a free slot, so nothing waits
    two = [asyncio.create_task(gen(inst["port"], model=m, n=15)) for m in ("a", "b")]
    await wait_for(lambda: perf(env, inst)["inflight"] == 2)
    assert perf(env, inst)["queued"] == 0
    await asyncio.gather(*two)


async def test_client_hangup_stops_the_upstream_request(env, monkeypatch, tmp_path):
    events = tmp_path / "events"
    monkeypatch.setenv("FAKE_EVENTS", str(events))
    monkeypatch.setenv("FAKE_GEN_DELAY", "0.1")
    inst = await start(env)
    async with httpx.AsyncClient(timeout=30) as c:
        async with c.stream("POST", f"http://127.0.0.1:{inst['port']}/api/generate",
                            json={"model": "m", "prompt": "hi", "options": {"num_predict": 100}}) as r:
            async for _ in r.aiter_lines():
                break
    await wait_for(lambda: events.exists() and "client_gone" in events.read_text())  # Ollama noticed
    await wait_for(lambda: perf(env, inst)["inflight"] == 0)
    assert perf(env, inst)["requests_total"] == 1


async def test_unreachable_ollama_gives_502(env):
    inst = await start(env)
    h = env.app.state.manager.handles[inst["id"]]
    h.proxy.upstream_port = free_port()
    r = await gen(inst["port"])
    assert r.status_code == 502 and "error" in r.json()
    assert perf(env, inst)["inflight"] == 0


async def test_stopping_frees_the_port_and_restart_works(env):
    inst = await start(env)
    port = inst["port"]
    assert not port_free(port)
    await env.client.post(f"/instances/{inst['id']}/stop")
    assert port_free(port)
    assert (await env.client.post(f"/instances/{inst['id']}/restart")).status_code == 200
    await wait_for(lambda: env.app.state.manager.status(inst["id"])["state"] == "running")
    assert (await gen(port)).status_code == 200


async def test_crash_frees_the_port(env):
    inst = await start(env)
    pid = env.app.state.manager.status(inst["id"])["pid"]
    for p in [psutil.Process(pid), *psutil.Process(pid).children(recursive=True)]:
        p.kill()
    await wait_for(lambda: env.app.state.manager.status(inst["id"])["state"] == "crashed")
    await wait_for(lambda: port_free(inst["port"]))


async def test_start_fails_cleanly_when_the_port_is_taken(env):
    import socket
    inst = (await env.client.post("/instances", json={"name": "t", "port": free_port()})).json()
    with socket.socket() as s:
        s.bind(("127.0.0.1", inst["port"]))
        s.listen()
        r = await env.client.post(f"/instances/{inst['id']}/start")
    assert r.status_code == 409 and r.json()["error"]["code"] == "port_in_use"
    assert env.app.state.manager.status(inst["id"])["state"] == "stopped"


async def test_stop_can_wait_for_running_requests(env, monkeypatch):
    monkeypatch.setenv("FAKE_GEN_DELAY", "0.1")
    inst = await start(env)
    job = asyncio.create_task(gen(inst["port"], n=15))  # about 1.5 s
    await wait_for(lambda: perf(env, inst)["inflight"] == 1)
    stopping = asyncio.create_task(env.client.post(f"/instances/{inst['id']}/stop", json={"drain_seconds": 20}))
    await wait_for(lambda: env.app.state.manager.status(inst["id"])["state"] == "stopping")
    refused = await gen(inst["port"], n=2)  # new requests are turned away while it drains
    assert refused.status_code == 503
    done = await job
    assert done.status_code == 200 and done.text.count("\n") == 16  # the running request was not cut off
    assert (await stopping).status_code == 200
    assert env.app.state.manager.status(inst["id"])["state"] == "stopped"


async def test_drain_gives_up_after_the_timeout(env, monkeypatch):
    monkeypatch.setenv("FAKE_GEN_DELAY", "0.5")
    inst = await start(env)
    job = asyncio.create_task(gen(inst["port"], n=40))  # 20 s, longer than the drain
    await wait_for(lambda: perf(env, inst)["inflight"] == 1)
    t0 = time.monotonic()
    r = await env.client.post(f"/instances/{inst['id']}/stop", json={"drain_seconds": 1})
    assert r.status_code == 200 and time.monotonic() - t0 < 8
    await asyncio.gather(job, return_exceptions=True)


async def test_instance_models_are_listed_by_the_instance(env):
    inst = await start(env)
    r = await env.client.get(f"/instances/{inst['id']}/models")
    assert [m["name"] for m in r.json()] == ["fake:1b"]
    other = (await env.client.post("/instances", json={"name": "off", "port": free_port()})).json()
    assert (await env.client.get(f"/instances/{other['id']}/models")).status_code == 409


async def test_errors_models_and_history(env):
    inst = await start(env)
    port = inst["port"]
    await gen(port, model="a", n=10)
    await gen(port, model="a", n=10, path="/api/chat")
    await gen(port, model="b", n=4)
    h = env.app.state.manager.handles[inst["id"]]
    h.proxy.upstream_port = free_port()          # Ollama "disappears"
    assert (await gen(port, model="a")).status_code == 502
    p = perf(env, inst)
    assert p["errors"] == 1 and p["errors_total"] == 1 and p["requests"] == 4
    assert p["models"]["a"]["requests"] == 3 and p["models"]["a"]["errors"] == 1
    assert abs(p["models"]["a"]["tok_per_s"] - 10.0) < 0.01 and p["models"]["b"]["requests"] == 1
    r = (await env.client.get(f"/instances/{inst['id']}/requests?limit=3")).json()
    assert [x["status"] for x in r["requests"]] == [502, 200, 200]  # newest first
    first = r["requests"][1]
    assert first["model"] == "b" and first["path"] == "/api/generate" and first["tokens"] == 4 and first["client"] == "127.0.0.1"
    assert not any(k in ("prompt", "response", "content", "messages") for x in r["requests"] for k in x)  # the list carries no content
    assert "omm_instance_request_errors_total" in prometheus.render(await env.app.state.collector.collect(), {inst["id"]: "p"})


async def test_a_client_that_hangs_up_is_not_an_error(env, monkeypatch):
    monkeypatch.setenv("FAKE_GEN_DELAY", "0.1")
    inst = await start(env)
    async with httpx.AsyncClient(timeout=30) as c:
        async with c.stream("POST", f"http://127.0.0.1:{inst['port']}/api/generate",
                            json={"model": "m", "prompt": "hi", "options": {"num_predict": 100}}) as r:
            async for _ in r.aiter_lines():
                break
    await wait_for(lambda: perf(env, inst)["inflight"] == 0)
    p = perf(env, inst)
    assert p["errors"] == 0 and p["cancelled"] == 1
    assert env.app.state.manager.requests(inst["id"])["requests"][0]["outcome"] == "cancelled"


async def test_per_minute_numbers_are_stored_and_survive_a_restart(tmp_path, fake_exe, provider):
    from app.main import create_app
    data = tmp_path / "data"
    app = create_app(data_dir=data, provider=provider, token=None)
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
            await c.put("/settings", json={"ollama_executable_path": fake_exe})
            inst = (await c.post("/instances", json={"name": "s", "port": free_port()})).json()
            await c.post(f"/instances/{inst['id']}/start")
            await wait_for(lambda: app.state.manager.status(inst["id"])["state"] == "running")
            await gen(inst["port"], n=10)
            await gen(inst["port"], n=10, stream=False)
            await wait_for(lambda: app.state.manager.handles[inst["id"]].proxy.stats.total == 2)
            s = (await c.get(f"/monitor/requests?minutes=5&instance={inst['id']}")).json()["series"]
    assert len(s) == 5 and sum(x["requests"] for x in s) == 2
    last = [x for x in s if x["requests"]][0]
    assert last["tokens"] == 20 and abs(last["tok_per_s"] - 10.0) < 0.01 and last["latency_avg"] > 0
    app2 = create_app(data_dir=data, provider=provider, token=None)
    async with app2.router.lifespan_context(app2):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app2), base_url="http://t") as c:
            again = (await c.get("/monitor/requests?minutes=5")).json()["series"]   # all instances
            assert sum(x["requests"] for x in again) == 2
            await c.delete(f"/instances/{inst['id']}")
            assert sum(x["requests"] for x in (await c.get("/monitor/requests?minutes=5")).json()["series"]) == 0


async def test_input_tokens_and_openai_compatible_speed(env, monkeypatch):
    monkeypatch.setenv("FAKE_GEN_DELAY", "0.05")
    inst = await start(env)
    port = inst["port"]
    await gen(port, n=10)                                                        # native: exact
    p = perf(env, inst)
    assert p["prompt_tokens"] == 3 and p["tokens"] == 10 and abs(p["tok_per_s"] - 10.0) < 0.01
    # OpenAI-compatible, not streamed: the speed is tokens over the whole request (approximate)
    async with httpx.AsyncClient(timeout=30) as c:
        r = await c.post(f"http://127.0.0.1:{port}/v1/chat/completions", json={"model": "m", "messages": [], "max_tokens": 10})
        assert r.json()["usage"]["completion_tokens"] == 10
        # streamed with include_usage: the speed is measured after the first byte
        async with c.stream("POST", f"http://127.0.0.1:{port}/v1/chat/completions", json={
                "model": "m", "messages": [], "max_tokens": 10, "stream": True, "stream_options": {"include_usage": True}}) as r:
            async for _ in r.aiter_lines():
                pass
        # streamed without usage: nothing to count, but it still is a request
        async with c.stream("POST", f"http://127.0.0.1:{port}/v1/chat/completions", json={"model": "m", "messages": [], "max_tokens": 3, "stream": True}) as r:
            async for _ in r.aiter_lines():
                pass
    await wait_for(lambda: perf(env, inst)["requests"] == 4)
    p = perf(env, inst)
    assert p["tokens"] == 30 and p["prompt_tokens"] == 9 and p["tokens_total"] == 30 and p["prompt_tokens_total"] == 9
    v1 = env.app.state.manager.requests(inst["id"], 3)["requests"]
    assert v1[1]["tokens"] == 10 and v1[0]["tokens"] is None                      # newest first: no usage -> no tokens
    assert 6 < p["tok_per_s"] < 40                                                  # mixed exact and approximate speeds
    text = prometheus.render(await env.app.state.collector.collect(), {inst["id"]: "p"})
    assert 'omm_instance_tokens_total{instance="p",kind="prompt"} 9' in text


async def test_api_key_is_required_when_set(env):
    inst = await start(env, api_key="s3cret-key-0123456")
    url = f"http://127.0.0.1:{inst['port']}"
    async with httpx.AsyncClient() as c:
        assert (await c.get(f"{url}/api/version")).status_code == 401
        bad = await c.get(f"{url}/api/version", headers={"Authorization": "Bearer nope"})
        assert bad.status_code == 401 and bad.headers["www-authenticate"] == "Bearer"
        assert (await c.get(f"{url}/api/version", headers={"Authorization": "Basic s3cret-key-0123456"})).status_code == 401
        ok = await c.get(f"{url}/api/version", headers={"Authorization": "Bearer s3cret-key-0123456"})
        assert ok.status_code == 200
        pre = await c.options(f"{url}/api/chat")  # CORS preflights are not asked for credentials
        assert pre.status_code != 401
    r = await gen(inst["port"])
    assert r.status_code == 401 and perf(env, inst)["requests_total"] == 0
    async with httpx.AsyncClient(timeout=30) as c:
        r = await c.post(f"{url}/api/generate", json={"model": "m", "prompt": "hi", "options": {"num_predict": 3}}, headers={"Authorization": "Bearer s3cret-key-0123456"})
    assert r.status_code == 200 and perf(env, inst)["requests"] == 1


async def test_listening_on_the_network_is_opt_in(env):
    from app.services.external import lan_ip
    local = await start(env, "local")
    lan = await start(env, "open", listen="lan")
    assert env.app.state.manager.handles[local["id"]].proxy.host == "127.0.0.1"
    assert env.app.state.manager.handles[lan["id"]].proxy.host == "0.0.0.0"
    assert not port_free(lan["port"], "0.0.0.0") and not port_free(lan["port"])
    ip = lan_ip()
    if ip != "127.0.0.1":  # only meaningful on a machine that has a network address
        async with httpx.AsyncClient(timeout=3) as c:
            assert (await c.get(f"http://{ip}:{lan['port']}/api/version")).status_code == 200
            try:
                await c.get(f"http://{ip}:{local['port']}/api/version")
                raise AssertionError("a local-only instance answered on the network address")
            except httpx.ConnectError:
                pass
    r = await env.client.post("/instances", json={"name": "x", "port": free_port(), "options": {"api_key": "short-key-1234"}})
    assert r.status_code == 422  # keys must be at least 16 characters


# ---------------------------------------------------------------- on-demand start

async def make_on_demand(env, name="od", **opts):
    inst = (await env.client.post("/instances", json={"name": name, "port": free_port(), "options": {"auto_start": True, **opts}})).json()
    return inst


async def test_on_demand_instance_holds_its_port_and_starts_on_the_first_request(env):
    inst = await make_on_demand(env)
    m = env.app.state.manager
    assert m.status(inst["id"])["state"] == "stopped" and not port_free(inst["port"])  # standby proxy holds the port
    r = await gen(inst["port"], n=3)
    assert r.status_code == 200 and m.status(inst["id"])["state"] == "running"
    assert perf(env, inst)["requests_total"] == 1
    # a stopped instance without the option is not started by anything
    plain = await start(env, "plain")
    await env.client.post(f"/instances/{plain['id']}/stop")
    assert port_free(plain["port"])


async def test_requests_wait_while_the_instance_is_starting(env, monkeypatch):
    inst = await make_on_demand(env)
    results = await asyncio.gather(*(gen(inst["port"], n=2) for _ in range(3)))  # all arrive before it is ready
    assert [r.status_code for r in results] == [200, 200, 200]
    assert env.app.state.manager.status(inst["id"])["state"] == "running"


async def test_explicit_stop_keeps_the_port_and_the_next_request_restarts(env):
    inst = await make_on_demand(env)
    await gen(inst["port"], n=2)
    await env.client.post(f"/instances/{inst['id']}/stop")
    assert env.app.state.manager.status(inst["id"])["state"] == "stopped" and not port_free(inst["port"])
    assert (await gen(inst["port"], n=2)).status_code == 200
    assert env.app.state.manager.status(inst["id"])["state"] == "running"
    assert env.app.state.manager.proxies[inst["id"]].stats.total == 2  # statistics carry over the restart


async def test_idle_on_demand_instance_stops_itself(env, monkeypatch):
    monkeypatch.setattr(type(env.app.state.manager), "IDLE_CHECK_SECONDS", 0.2)
    monkeypatch.setattr(type(env.app.state.manager), "IDLE_UNIT_SECONDS", 0.5)  # "1 idle minute" = 0.5 s
    inst = await make_on_demand(env, idle_stop_min=1)
    await gen(inst["port"], n=2)
    m = env.app.state.manager
    assert m.status(inst["id"])["state"] == "running"
    await wait_for(lambda: m.status(inst["id"])["state"] == "stopped", timeout=10)
    assert not port_free(inst["port"])                       # still reserved
    assert (await gen(inst["port"], n=2)).status_code == 200  # and wakes up again


async def test_a_busy_on_demand_instance_is_not_stopped(env, monkeypatch):
    monkeypatch.setattr(type(env.app.state.manager), "IDLE_CHECK_SECONDS", 0.2)
    monkeypatch.setattr(type(env.app.state.manager), "IDLE_UNIT_SECONDS", 0.3)
    monkeypatch.setenv("FAKE_GEN_DELAY", "0.1")
    inst = await make_on_demand(env, idle_stop_min=1)
    r = await gen(inst["port"], n=25)  # 2.5 s of work, longer than the idle time
    assert r.status_code == 200 and r.text.count("\n") == 26


async def test_standby_follows_option_changes_and_deletion(env):
    m = env.app.state.manager
    inst = await make_on_demand(env)
    assert inst["id"] in m.proxies and not port_free(inst["port"])
    r = await env.client.patch(f"/instances/{inst['id']}", json={"options": {"auto_start": False}})
    assert r.status_code == 200 and inst["id"] not in m.proxies and port_free(inst["port"])
    new_port = free_port()
    await env.client.patch(f"/instances/{inst['id']}", json={"port": new_port, "options": {"auto_start": True}})
    assert not port_free(new_port) and m.proxies[inst["id"]].port == new_port
    assert (await env.client.delete(f"/instances/{inst['id']}")).status_code == 204
    assert port_free(new_port) and inst["id"] not in m.proxies


async def test_on_demand_instances_are_not_started_at_app_start_but_stand_by(tmp_path, fake_exe, provider):
    from app.main import create_app
    data = tmp_path / "data"
    app = create_app(data_dir=data, provider=provider, token=None)
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
            await c.put("/settings", json={"ollama_executable_path": fake_exe})
            inst = (await c.post("/instances", json={"name": "od", "port": free_port(), "options": {"auto_start": True}})).json()
            await gen(inst["port"], n=2)
            assert app.state.manager.status(inst["id"])["state"] == "running"
    assert port_free(inst["port"])  # quitting releases everything
    app2 = create_app(data_dir=data, provider=provider, token=None)
    async with app2.router.lifespan_context(app2):
        await wait_for(lambda: not port_free(inst["port"]))            # standing by again ...
        assert app2.state.manager.status(inst["id"])["state"] == "stopped"  # ... but not started
        assert (await gen(inst["port"], n=2)).status_code == 200


async def test_a_request_to_a_stopped_plain_instance_is_refused_not_started(env):
    inst = await start(env, "plain2")
    h = env.app.state.manager.handles[inst["id"]]
    h.proxy.ready = False  # pretend it is not ready and cannot become so
    h.state = "stopping"
    assert (await gen(inst["port"], n=2)).status_code == 503


async def test_a_client_that_leaves_right_after_the_last_byte_still_counts(env, monkeypatch):
    """Connection: close clients drop the socket the moment the answer ends; that must not look like a cancel."""
    monkeypatch.setenv("FAKE_GEN_DELAY", "0.01")
    inst = await start(env)
    for body, path in (({"model": "m", "prompt": "hi", "options": {"num_predict": 6}}, "/api/generate"),               # streamed
                       ({"model": "m", "prompt": "hi", "stream": False, "options": {"num_predict": 6}}, "/api/generate")):  # one JSON object
        payload = json.dumps(body).encode()
        reader, writer = await asyncio.open_connection("127.0.0.1", inst["port"])
        writer.write(f"POST {path} HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: {len(payload)}\r\nConnection: close\r\n\r\n".encode() + payload)
        await writer.drain()
        data = b""
        while b'"done":true' not in data.replace(b'": ', b'":').replace(b'" :', b'":'):
            chunk = await reader.read(4096)
            if not chunk:
                break
            data += chunk
        writer.close()  # gone the instant the end was seen
    await wait_for(lambda: perf(env, inst)["requests"] == 2 and perf(env, inst)["inflight"] == 0)
    p = perf(env, inst)
    assert p["cancelled"] == 0 and p["tokens"] == 12 and p["prompt_tokens"] == 6


# ---- instances limited to chosen models

async def allow(env, inst, models):
    r = await env.client.put(f"/instances/{inst['id']}/allowed-models", json={"models": models})
    assert r.status_code == 200, r.text
    return r.json()


async def test_a_model_limit_refuses_other_models_and_accepts_the_chosen_ones(env):
    inst = await start(env)
    port = inst["port"]
    assert (await gen(port, model="anything", stream=False)).status_code == 200  # no limit: every model goes through
    saved = await allow(env, inst, ["fake:1b"])
    assert saved["options"]["allowed_models"] == ["fake:1b"]
    assert (await gen(port, model="fake:1b", stream=False)).status_code == 200
    assert (await gen(port, model="fake", stream=False)).status_code == 404  # "fake" means "fake:latest", another model than "fake:1b"
    r = await gen(port, model="other:7b", stream=False)
    assert r.status_code == 404 and "other:7b" in r.json()["error"]
    assert (await gen(port, model="other:7b", path="/api/chat")).status_code == 404
    assert (await gen(port, model="other:7b", path="/v1/chat/completions", stream=False)).status_code == 404
    await allow(env, inst, ["other"])  # a name without a tag means ":latest"
    assert (await gen(port, model="other:latest", stream=False)).status_code == 200
    assert (await gen(port, model="other", stream=False)).status_code == 200
    await allow(env, inst, [])  # back to every model
    assert (await gen(port, model="other:7b", stream=False)).status_code == 200


async def test_a_limited_instance_lists_only_its_models_and_leaves_model_changes_to_the_app(env):
    inst = await start(env)
    port = inst["port"]
    async with httpx.AsyncClient() as c:
        await allow(env, inst, ["fake:1b"])
        assert [m["name"] for m in (await c.get(f"http://127.0.0.1:{port}/api/tags")).json()["models"]] == ["fake:1b"]
        await allow(env, inst, ["not-installed:1b"])
        assert (await c.get(f"http://127.0.0.1:{port}/api/tags")).json()["models"] == []
        assert (await c.post(f"http://127.0.0.1:{port}/api/pull", json={"model": "x:1b"})).status_code == 403
        assert (await c.request("DELETE", f"http://127.0.0.1:{port}/api/delete", json={"model": "fake:1b"})).status_code == 403
        assert (await c.post(f"http://127.0.0.1:{port}/api/show", json={"model": "fake:1b"})).status_code == 404
    assert [m["name"] for m in (await env.client.get(f"/instances/{inst['id']}/models")).json()] == []
    await allow(env, inst, ["fake:1b"])
    assert [m["name"] for m in (await env.client.get(f"/instances/{inst['id']}/models")).json()] == ["fake:1b"]


async def test_a_model_limit_can_be_set_when_creating_and_survives_a_restart_of_the_instance(env):
    inst = await start(env, allowed_models=["fake:1b"])
    assert (await gen(inst["port"], model="other:7b", stream=False)).status_code == 404
    await env.client.post(f"/instances/{inst['id']}/stop")
    await wait_for(lambda: env.app.state.manager.status(inst["id"])["state"] == "stopped")
    await env.client.post(f"/instances/{inst['id']}/start")
    await wait_for(lambda: env.app.state.manager.status(inst["id"])["state"] == "running")
    assert (await gen(inst["port"], model="other:7b", stream=False)).status_code == 404
    assert (await gen(inst["port"], model="fake:1b", stream=False)).status_code == 200


async def test_a_refused_model_does_not_wake_an_on_demand_instance(env):
    inst = (await env.client.post("/instances", json={"name": "od", "port": free_port(), "options": {"auto_start": True, "allowed_models": ["fake:1b"]}})).json()
    await env.app.state.manager.sync_standby(inst["id"])
    await wait_for(lambda: inst["id"] in env.app.state.manager.proxies)
    assert (await gen(inst["port"], model="other:7b", stream=False)).status_code == 404
    assert env.app.state.manager.status(inst["id"])["state"] == "stopped"  # still asleep


async def test_instance_history_keeps_readings_of_a_running_instance_and_forgets_it_after_stop(env, monkeypatch):
    inst = await start(env)
    iid = inst["id"]
    collector = env.app.state.collector
    snap = await collector.collect()
    collector._record(snap)
    collector._record(await collector.collect())
    r = await env.client.get(f"/monitor/instances/{iid}/history")
    samples = r.json()["samples"]
    assert r.status_code == 200 and len(samples) >= 2
    assert set(samples[0]) == {"ts", "cpu", "rss", "vram", "processing", "queued"} and samples[0]["rss"] > 0
    assert (await env.client.get("/monitor/instances/999/history")).json() == {"samples": []}
    await env.client.post(f"/instances/{iid}/stop")
    await wait_for(lambda: env.app.state.manager.status(iid)["state"] == "stopped")
    collector._record(await collector.collect())
    assert (await env.client.get(f"/monitor/instances/{iid}/history")).json() == {"samples": []}


async def test_the_request_journal_keeps_content_only_when_asked_to(env):
    off = await start(env, "off")
    on = await start(env, "on", save_requests=True)
    for inst in (off, on):
        assert (await gen(inst["port"], n=3)).status_code == 200
        assert (await gen(inst["port"], n=2, path="/api/chat")).status_code in (200, 404)
    async with httpx.AsyncClient(timeout=30) as c:  # an image-sized string and a long prompt are shortened
        body = {"model": "m", "prompt": "x" * 3000, "stream": True, "options": {"num_predict": 2}}
        assert (await c.post(f"http://127.0.0.1:{on['port']}/api/generate", json=body)).status_code == 200
    await wait_for(lambda: len(env.app.state.manager.requests(on["id"])["requests"]) == 3)

    quiet = (await env.client.get(f"/instances/{off['id']}/requests")).json()["requests"]
    assert quiet and all(x["saved"] is False for x in quiet)
    detail = (await env.client.get(f"/instances/{off['id']}/requests/{quiet[0]['id']}")).json()
    assert "request" not in detail and "response" not in detail

    rows = (await env.client.get(f"/instances/{on['id']}/requests")).json()["requests"]
    assert all(x["saved"] is True and "request" not in x and "response" not in x for x in rows)  # the list stays light
    newest = (await env.client.get(f"/instances/{on['id']}/requests/{rows[0]['id']}")).json()
    assert newest["model"] == "m" and '"prompt"' in newest["request"] and "[3,000 characters]" in newest["request"]
    assert newest["response"]
    assert (await env.client.get(f"/instances/{on['id']}/requests/nope")).status_code == 404

    journal = env.app.state.manager.request_log.path(on["id"])
    assert journal.exists()
    await env.client.post(f"/instances/{on['id']}/stop")
    await wait_for(lambda: env.app.state.manager.status(on["id"])["state"] == "stopped")
    assert len((await env.client.get(f"/instances/{on['id']}/requests")).json()["requests"]) == 3  # a stopped instance keeps its list
    assert (await env.client.delete(f"/instances/{on['id']}")).status_code in (200, 204)
    assert not journal.exists()


def test_answers_are_put_together_from_streamed_lines():
    from app.services.request_log import answer_text
    nd = b'{"response":"Hel","done":false}\n{"response":"lo","done":false}\n{"done":true,"eval_count":2}\n'
    assert answer_text(nd) == "Hello"
    chat = b'{"message":{"role":"assistant","content":"Hi "}}\n{"message":{"role":"assistant","content":"there"},"done":true}\n'
    assert answer_text(chat) == "Hi there"
    sse = b'data: {"choices":[{"delta":{"content":"A"}}]}\n\ndata: {"choices":[{"delta":{"content":"B"}}]}\n\ndata: [DONE]\n'
    assert answer_text(sse) == "AB"
    assert answer_text(nd[:-10]) == "Hello"  # cut inside the last line
    assert '"error"' in answer_text(b'{"error":"boom"}')
    assert answer_text(b"plain text") == "plain text"
