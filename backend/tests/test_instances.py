import os
import signal

import psutil

from app.main import create_app
from tests.conftest import free_port, wait_for


async def make(env, name="a", port=None, **opts):
    port = port or free_port()
    r = await env.client.post("/instances", json={"name": name, "port": port, "options": opts})
    assert r.status_code == 201, r.text
    return r.json()


def state(env, iid):
    return env.app.state.manager.status(iid)["state"]


async def test_crud_and_conflicts(env):
    a = await make(env, "a")
    assert a["status"]["state"] == "stopped" and a["options"]["context_length"] == 4096
    assert (await env.client.post("/instances", json={"name": "a", "port": free_port()})).status_code == 409
    assert (await env.client.post("/instances", json={"name": "b", "port": a["port"]})).status_code == 409
    assert (await env.client.post("/instances", json={"name": "c", "port": 80})).status_code == 422
    r = await env.client.patch(f"/instances/{a['id']}", json={"options": {"context_length": 2048}})
    assert r.json()["options"]["context_length"] == 2048
    assert (await env.client.delete(f"/instances/{a['id']}")).status_code == 204
    assert (await env.client.get(f"/instances/{a['id']}")).status_code == 404


async def test_monitoring_port_is_reserved(env):
    mon = (await env.client.get("/settings")).json()["external_monitoring_port"]
    r = await env.client.post("/instances", json={"name": "x", "port": mon})
    assert r.status_code == 409 and r.json()["error"]["code"] == "port_reserved"


async def test_start_stop_lifecycle(env):
    inst = await make(env, context_length=2048)
    iid = inst["id"]
    r = await env.client.post(f"/instances/{iid}/start")
    assert r.status_code == 200 and r.json()["status"]["state"] in ("starting", "running")
    pid = r.json()["status"]["pid"]
    await wait_for(lambda: state(env, iid) == "running")
    assert state(env, iid) == "running"
    assert (await env.client.post(f"/instances/{iid}/start")).status_code == 409
    assert (await env.client.patch(f"/instances/{iid}", json={"name": "z"})).status_code == 409
    assert (await env.client.delete(f"/instances/{iid}")).status_code == 409

    logs = await wait_for(lambda: [l for l in env.app.state.manager.recent_logs(iid) if "ctx=2048" in l["msg"]])
    assert logs, "instance output should be streamed into the log"

    r = await env.client.post(f"/instances/{iid}/stop")
    assert r.json()["status"]["state"] == "stopped" and r.json()["desired_state"] == "stopped"
    assert not psutil.pid_exists(pid) or psutil.Process(pid).status() == psutil.STATUS_ZOMBIE


async def test_port_in_use_and_missing_executable(env):
    import socket
    s = socket.socket(); s.bind(("127.0.0.1", 0)); busy = s.getsockname()[1]
    inst = await make(env, "busy", port=busy)
    r = await env.client.post(f"/instances/{inst['id']}/start")
    assert r.status_code == 409 and r.json()["error"]["code"] == "port_in_use"
    s.close()
    env.app.state.db.execute("UPDATE settings SET value='\"/does/not/exist\"' WHERE key='ollama_executable_path'")
    r = await env.client.post(f"/instances/{inst['id']}/start")
    assert r.status_code == 400 and r.json()["error"]["code"] == "executable_not_found"


async def test_crash_is_detected_and_restartable(env):
    iid = (await make(env))["id"]
    pid = (await env.client.post(f"/instances/{iid}/start")).json()["status"]["pid"]
    await wait_for(lambda: state(env, iid) == "running")
    os.kill(pid, signal.SIGKILL)
    await wait_for(lambda: env.app.state.manager.status(iid)["state"] == "crashed")
    assert (await env.client.post(f"/instances/{iid}/start")).status_code == 200
    await wait_for(lambda: env.app.state.manager.status(iid)["state"] == "running")


async def test_stop_kills_runner_children(env):
    iid = (await make(env))["id"]
    pid = (await env.client.post(f"/instances/{iid}/start")).json()["status"]["pid"]
    await wait_for(lambda: state(env, iid) == "running")
    kids = psutil.Process(pid).children(recursive=True)
    assert kids, "fake server should have spawned a runner-like child"
    await env.client.post(f"/instances/{iid}/stop")
    await wait_for(lambda: all(not k.is_running() or k.status() == psutil.STATUS_ZOMBIE for k in kids))


async def test_app_quit_saves_state_and_next_start_restores(tmp_path, fake_exe, provider):
    """The lifetime policy: quit stops everything but remembers; start brings the same set back."""
    import httpx
    data = tmp_path / "data"
    app = create_app(data_dir=data, provider=provider, token=None)
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
            await c.put("/settings", json={"ollama_executable_path": fake_exe})
            running = (await c.post("/instances", json={"name": "on", "port": free_port()})).json()
            idle = (await c.post("/instances", json={"name": "off", "port": free_port()})).json()
            pid = (await c.post(f"/instances/{running['id']}/start")).json()["status"]["pid"]
            await wait_for(lambda: app.state.manager.status(running["id"])["state"] == "running")
    # app quit: process is gone, state is remembered
    assert not psutil.pid_exists(pid) or psutil.Process(pid).status() == psutil.STATUS_ZOMBIE

    app2 = create_app(data_dir=data, provider=provider, token=None)
    async with app2.router.lifespan_context(app2):
        m = app2.state.manager
        await wait_for(lambda: m.status(running["id"])["state"] in ("starting", "running"))
        assert m.status(idle["id"])["state"] == "stopped"


async def test_orphans_from_a_crashed_run_are_cleaned_up(tmp_path, fake_exe, provider):
    import httpx
    data = tmp_path / "data"
    app = create_app(data_dir=data, provider=provider, token=None)
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
            await c.put("/settings", json={"ollama_executable_path": fake_exe})
            inst = (await c.post("/instances", json={"name": "o", "port": free_port()})).json()
            pid = (await c.post(f"/instances/{inst['id']}/start")).json()["status"]["pid"]
            await wait_for(lambda: app.state.manager.status(inst["id"])["state"] == "running")
            # simulate "app killed": forget the process without stopping it, keep pid in the DB
            app.state.manager.handles.clear()
            for t in list(app.state.manager.logs):  # nothing else to do; lifespan exit finds no handles
                pass
    assert psutil.pid_exists(pid), "process must survive because the app 'crashed'"

    app2 = create_app(data_dir=data, provider=provider, token=None)
    async with app2.router.lifespan_context(app2):
        await wait_for(lambda: not psutil.pid_exists(pid) or psutil.Process(pid).status() == psutil.STATUS_ZOMBIE)
