import pytest

from tests.conftest import free_port, wait_for


async def running(env):
    inst = (await env.client.post("/instances", json={"name": "m", "port": free_port()})).json()
    await env.client.post(f"/instances/{inst['id']}/start")
    await wait_for(lambda: env.app.state.manager.status(inst["id"])["state"] == "running")
    return inst["id"]


async def task_state(env, tid):
    return next(t for t in (await env.client.get("/pulls")).json() if t["id"] == tid)


async def test_list_requires_a_running_instance(env):
    inst = (await env.client.post("/instances", json={"name": "s", "port": free_port()})).json()
    r = await env.client.get(f"/instances/{inst['id']}/models")
    assert r.status_code == 409 and r.json()["error"]["code"] == "not_running"
    assert (await env.client.get("/instances/999/models")).status_code == 404


async def test_list_models(env):
    iid = await running(env)
    models = (await env.client.get(f"/instances/{iid}/models")).json()
    assert [m["name"] for m in models] == ["fake:1b"] and models[0]["size"] == 1_000_000


async def test_pull_reports_progress_and_installs_the_model(env):
    iid = await running(env)
    events = env.app.state.hub.subscribe(maxsize=1000)
    r = await env.client.post(f"/instances/{iid}/models/pull", json={"model": "tiny:latest"})
    assert r.status_code == 202 and r.json()["status"] == "pulling"
    tid = r.json()["id"]
    await wait_for(lambda: env.app.state.models.tasks[tid].status != "pulling")
    t = await task_state(env, tid)
    assert t["status"] == "success" and t["percent"] == 100.0 and t["total"] == 400
    names = [m["name"] for m in (await env.client.get(f"/instances/{iid}/models")).json()]
    assert "tiny:latest" in names
    seen = []
    while not events.empty():
        e = events.get_nowait()
        if e["type"] == "pull":
            seen.append(e["task"]["status"])
    assert seen[0] == "pulling" and seen[-1] == "success"


async def test_same_pull_twice_reuses_the_running_task(env, monkeypatch):
    monkeypatch.setenv("FAKE_PULL_DELAY", "0.5")
    iid = await running(env)
    a = await env.client.post(f"/instances/{iid}/models/pull", json={"model": "big:1"})
    b = await env.client.post(f"/instances/{iid}/models/pull", json={"model": "big:1"})
    assert a.status_code == 202 and b.status_code == 200 and a.json()["id"] == b.json()["id"]
    await env.client.delete(f"/pulls/{a.json()['id']}")


async def test_pull_error_is_reported(env):
    iid = await running(env)
    tid = (await env.client.post(f"/instances/{iid}/models/pull", json={"model": "bad-model"})).json()["id"]
    await wait_for(lambda: env.app.state.models.tasks[tid].status != "pulling")
    t = await task_state(env, tid)
    assert t["status"] == "error" and "does not exist" in t["error"]


async def test_cancel_pull(env, monkeypatch):
    monkeypatch.setenv("FAKE_PULL_DELAY", "1")
    iid = await running(env)
    tid = (await env.client.post(f"/instances/{iid}/models/pull", json={"model": "slow:1"})).json()["id"]
    await wait_for(lambda: env.app.state.models.tasks[tid].status_text)
    assert (await env.client.delete(f"/pulls/{tid}")).status_code == 204
    assert (await task_state(env, tid))["status"] == "cancelled"
    assert (await env.client.delete("/pulls/nope")).status_code == 404
    names = [m["name"] for m in (await env.client.get(f"/instances/{iid}/models")).json()]
    assert "slow:1" not in names


async def test_instance_stop_fails_the_pull(env, monkeypatch):
    monkeypatch.setenv("FAKE_PULL_DELAY", "1")
    iid = await running(env)
    tid = (await env.client.post(f"/instances/{iid}/models/pull", json={"model": "x:1"})).json()["id"]
    await wait_for(lambda: env.app.state.models.tasks[tid].status_text)
    await env.client.post(f"/instances/{iid}/stop")
    await wait_for(lambda: env.app.state.models.tasks[tid].status != "pulling")
    t = await task_state(env, tid)
    assert t["status"] == "error" and "closed" in t["error"]


async def test_delete_model(env):
    iid = await running(env)
    assert (await env.client.delete(f"/instances/{iid}/models/fake:1b")).status_code == 204
    assert (await env.client.get(f"/instances/{iid}/models")).json() == []
    r = await env.client.delete(f"/instances/{iid}/models/fake:1b")
    assert r.status_code == 404 and r.json()["error"]["code"] == "model_not_found"


@pytest.mark.parametrize("name", ["", "-bad", "a b", "x;rm", "a" * 201])
async def test_invalid_model_names(env, name):
    iid = await running(env)
    r = await env.client.post(f"/instances/{iid}/models/pull", json={"model": name})
    assert r.status_code == 422
