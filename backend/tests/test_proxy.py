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
    assert (await gen(port, path="/v1/chat/completions")).json()["usage"]["completion_tokens"] == 1


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
    h.proxy._upstream = f"http://127.0.0.1:{free_port()}"
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
    h.proxy._upstream = f"http://127.0.0.1:{free_port()}"          # Ollama "disappears"
    assert (await gen(port, model="a")).status_code == 502
    p = perf(env, inst)
    assert p["errors"] == 1 and p["errors_total"] == 1 and p["requests"] == 4
    assert p["models"]["a"]["requests"] == 3 and p["models"]["a"]["errors"] == 1
    assert abs(p["models"]["a"]["tok_per_s"] - 10.0) < 0.01 and p["models"]["b"]["requests"] == 1
    r = (await env.client.get(f"/instances/{inst['id']}/requests?limit=3")).json()
    assert [x["status"] for x in r["requests"]] == [502, 200, 200]  # newest first
    first = r["requests"][1]
    assert first["model"] == "b" and first["path"] == "/api/generate" and first["tokens"] == 4 and first["client"] == "127.0.0.1"
    assert "prompt" not in str(r)  # nothing the user typed is kept
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
