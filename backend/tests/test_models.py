import pytest

from tests.conftest import wait_for


async def task_state(env, tid):
    return next(t for t in (await env.client.get("/pulls")).json() if t["id"] == tid)


async def test_models_work_without_any_instance(env):
    assert (await env.client.get("/instances")).json() == []
    models = (await env.client.get("/models")).json()
    assert [m["name"] for m in models] == ["fake:1b"]


async def test_store_server_stops_when_idle_and_restarts(env, monkeypatch):
    monkeypatch.setattr("app.services.store.IDLE_STOP_SECONDS", 0.1)
    store = env.app.state.models.store
    await env.client.get("/models")
    assert store.running
    store.last_use -= 10
    await wait_for(lambda: not store.running, timeout=15)
    assert (await env.client.get("/models")).status_code == 200 and store.running


async def test_list_models(env):
    models = (await env.client.get("/models")).json()
    assert [m["name"] for m in models] == ["fake:1b"] and models[0]["size"] == 1_000_000


async def test_pull_reports_progress_and_installs_the_model(env):
    events = env.app.state.hub.subscribe(maxsize=1000)
    r = await env.client.post("/models/pull", json={"model": "tiny:latest"})
    assert r.status_code == 202 and r.json()["status"] == "pulling"
    tid = r.json()["id"]
    await wait_for(lambda: env.app.state.models.tasks[tid].status != "pulling")
    t = await task_state(env, tid)
    assert t["status"] == "success" and t["percent"] == 100.0 and t["total"] == 400
    names = [m["name"] for m in (await env.client.get("/models")).json()]
    assert "tiny:latest" in names
    seen = []
    while not events.empty():
        e = events.get_nowait()
        if e["type"] == "pull":
            seen.append(e["task"]["status"])
    assert seen[0] == "pulling" and seen[-1] == "success"


async def test_same_pull_twice_reuses_the_running_task(env, monkeypatch):
    monkeypatch.setenv("FAKE_PULL_DELAY", "0.5")
    a = await env.client.post("/models/pull", json={"model": "big:1"})
    b = await env.client.post("/models/pull", json={"model": "big:1"})
    assert a.status_code == 202 and b.status_code == 200 and a.json()["id"] == b.json()["id"]
    await env.client.delete(f"/pulls/{a.json()['id']}")


async def test_pull_error_is_reported(env):
    tid = (await env.client.post("/models/pull", json={"model": "bad-model"})).json()["id"]
    await wait_for(lambda: env.app.state.models.tasks[tid].status != "pulling")
    t = await task_state(env, tid)
    assert t["status"] == "error" and "does not exist" in t["error"]


async def test_pause_keeps_progress_and_resume_finishes(env, monkeypatch):
    monkeypatch.setenv("FAKE_PULL_DELAY", "0.3")
    tid = (await env.client.post("/models/pull", json={"model": "slow:1"})).json()["id"]
    await wait_for(lambda: env.app.state.models.tasks[tid].completed > 0)
    r = await env.client.post(f"/pulls/{tid}/pause")
    assert r.status_code == 200 and r.json()["status"] == "paused" and r.json()["completed"] > 0
    assert env.app.state.db.one("SELECT completed FROM downloads WHERE model='slow:1'")["completed"] > 0
    assert (await env.client.post(f"/pulls/{tid}/pause")).status_code == 409  # not running any more
    monkeypatch.setenv("FAKE_PULL_DELAY", "0.01")
    # starting the same model again resumes the same card
    r = await env.client.post("/models/pull", json={"model": "slow:1"})
    assert r.json()["id"] == tid and r.json()["status"] == "pulling"
    await wait_for(lambda: env.app.state.models.tasks[tid].status != "pulling")
    assert (await task_state(env, tid))["status"] == "success"
    assert env.app.state.db.query("SELECT * FROM downloads") == []
    assert "slow:1" in [m["name"] for m in (await env.client.get("/models")).json()]
    assert (await env.client.post(f"/pulls/{tid}/resume")).status_code == 409  # already finished
    assert (await env.client.post("/pulls/nope/pause")).status_code == 404


async def test_resume_endpoint(env, monkeypatch):
    monkeypatch.setenv("FAKE_PULL_DELAY", "0.3")
    tid = (await env.client.post("/models/pull", json={"model": "r:1"})).json()["id"]
    await wait_for(lambda: env.app.state.models.tasks[tid].completed > 0)
    await env.client.post(f"/pulls/{tid}/pause")
    monkeypatch.setenv("FAKE_PULL_DELAY", "0.01")
    assert (await env.client.post(f"/pulls/{tid}/resume")).json()["status"] == "pulling"
    await wait_for(lambda: env.app.state.models.tasks[tid].status == "success")


async def test_delete_removes_partial_files_and_the_card(env, monkeypatch, tmp_path):
    monkeypatch.setenv("FAKE_PULL_DELAY", "0.5")
    store = tmp_path / "store"
    (store / "blobs").mkdir(parents=True)
    await env.client.put("/settings", json={"default_models_path": str(store)})
    l1, l2 = "1" * 64, "2" * 64
    partials = [store / "blobs" / f"sha256-{l1}-partial", store / "blobs" / f"sha256-{l2}-partial-0"]
    complete = store / "blobs" / f"sha256-{l1}"
    for f in [*partials, complete]:
        f.write_bytes(b"x")
    tid = (await env.client.post("/models/pull", json={"model": "gone:1"})).json()["id"]
    await wait_for(lambda: len(env.app.state.models.tasks[tid].digests) == 2)
    assert (await env.client.delete(f"/pulls/{tid}")).status_code == 204
    assert not any(f.exists() for f in partials) and complete.exists()  # only partial files go
    assert all(t["id"] != tid for t in (await env.client.get("/pulls")).json())
    assert env.app.state.db.query("SELECT * FROM downloads") == []
    assert (await env.client.delete(f"/pulls/{tid}")).status_code == 404
    assert "gone:1" not in [m["name"] for m in (await env.client.get("/models")).json()]


async def test_unfinished_downloads_come_back_paused_after_a_restart(tmp_path, fake_exe, provider, monkeypatch):
    import httpx
    from app.main import create_app
    monkeypatch.setenv("FAKE_PULL_DELAY", "0.3")
    data = tmp_path / "data"
    app = create_app(data_dir=data, provider=provider, token=None)
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
            await c.put("/settings", json={"ollama_executable_path": fake_exe})
            tid = (await c.post("/models/pull", json={"model": "keep:1"})).json()["id"]
            await wait_for(lambda: app.state.models.tasks[tid].completed > 0)
    # quitting while the download runs leaves it paused, not lost
    app2 = create_app(data_dir=data, provider=provider, token=None)
    async with app2.router.lifespan_context(app2):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app2), base_url="http://t") as c:
            tasks = (await c.get("/pulls")).json()
            assert [(t["model"], t["status"]) for t in tasks] == [("keep:1", "paused")] and tasks[0]["completed"] > 0
            await c.put("/settings", json={"ollama_executable_path": fake_exe})
            monkeypatch.setenv("FAKE_PULL_DELAY", "0.01")
            assert (await c.post(f"/pulls/{tasks[0]['id']}/resume")).json()["status"] == "pulling"
            await wait_for(lambda: app2.state.models.tasks[tasks[0]["id"]].status == "success")


async def test_store_server_dying_fails_the_pull(env, monkeypatch):
    monkeypatch.setenv("FAKE_PULL_DELAY", "1")
    tid = (await env.client.post("/models/pull", json={"model": "x:1"})).json()["id"]
    await wait_for(lambda: env.app.state.models.tasks[tid].status_text)
    env.app.state.models.store._h.ps.kill()
    await wait_for(lambda: env.app.state.models.tasks[tid].status != "pulling")
    t = await task_state(env, tid)
    assert t["status"] == "error"


async def test_delete_model(env):
    assert (await env.client.delete(f"/models/fake:1b")).status_code == 204
    assert (await env.client.get("/models")).json() == []
    r = await env.client.delete(f"/models/fake:1b")
    assert r.status_code == 404 and r.json()["error"]["code"] == "model_not_found"


@pytest.mark.parametrize("name", ["", "-bad", "a b", "x;rm", "a" * 201])
async def test_invalid_model_names(env, name):
    r = await env.client.post("/models/pull", json={"model": name})
    assert r.status_code == 422
