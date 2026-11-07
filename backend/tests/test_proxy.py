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
