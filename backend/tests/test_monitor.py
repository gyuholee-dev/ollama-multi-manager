import psutil

from app.services.monitor.collector import Collector
from app.services.monitor.prometheus import render
from tests.conftest import free_port, wait_for


async def running_instance(env):
    inst = (await env.client.post("/instances", json={"name": "m", "port": free_port()})).json()
    pid = (await env.client.post(f"/instances/{inst['id']}/start")).json()["status"]["pid"]
    await wait_for(lambda: env.app.state.manager.status(inst["id"])["state"] == "running")
    return inst, pid


async def test_system_and_gpu_snapshot(env):
    snap = await env.app.state.collector.collect()
    assert snap["system"]["mem_total"] > 0 and 0 <= snap["system"]["cpu_percent"] <= 100
    assert snap["gpu"]["provider"] == "fake" and snap["gpu"]["devices"][0]["name"] == "Fake GPU"
    assert snap["instances"] == {}


async def test_vram_is_summed_over_the_process_tree(env):
    inst, pid = await running_instance(env)
    child = psutil.Process(pid).children(recursive=True)[0].pid
    env.provider.table = {child: {0: 700_000}, 999999: {0: 5_000_000}}  # unrelated pid must not count
    d = (await env.app.state.collector.collect())["instances"][str(inst["id"])]
    assert d["responsive"] and d["vram_source"] == "nvml" and d["vram_bytes"] == 700_000
    assert d["vram_by_gpu"] == {"0": 700_000}
    assert d["models"][0]["name"] == "fake:1b" and d["rss"] > 0


async def test_falls_back_to_ollama_estimate_when_driver_gives_no_numbers(env):
    inst, pid = await running_instance(env)
    env.provider.supported = False                       # provider cannot report per-process VRAM
    d = (await env.app.state.collector.collect())["instances"][str(inst["id"])]
    assert d["vram_source"] == "estimated" and d["vram_bytes"] == 800_000

    env.provider.supported = True
    env.provider.table = {pid: {0: None}}                # Windows WDDM style: pid listed, usage N/A
    d = (await env.app.state.collector.collect())["instances"][str(inst["id"])]
    assert d["vram_source"] == "estimated"

    env.provider.table = {}                              # NVML sees nothing although Ollama reports VRAM
    d = (await env.app.state.collector.collect())["instances"][str(inst["id"])]
    assert d["vram_source"] == "estimated"


async def test_unresponsive_instance_does_not_break_collection(env):
    inst, pid = await running_instance(env)
    h = env.app.state.manager.handles[inst["id"]]
    h.inner_port = free_port()                           # nothing listens there
    d = (await env.app.state.collector.collect())["instances"][str(inst["id"])]
    assert d["responsive"] is False and d["models"] == []
    assert d["vram_source"] == "nvml" and d["vram_bytes"] == 0   # NVML is authoritative: nothing in the tree uses VRAM
    env.provider.supported = False                       # without NVML there is nothing to report
    d = (await env.app.state.collector.collect())["instances"][str(inst["id"])]
    assert d["vram_bytes"] is None and d["vram_source"] is None


async def test_snapshot_endpoint_and_prometheus(env):
    inst, _ = await running_instance(env)
    c = env.app.state.collector
    c.latest = await c.collect()
    snap = (await env.client.get("/monitor/snapshot")).json()
    assert str(inst["id"]) in snap["instances"]
    text = (await env.client.get("/metrics")).text
    assert 'omm_instance_up{instance="m"} 1' in text
    assert 'omm_instance_vram_bytes{instance="m",source=' in text
    assert "omm_gpu_memory_total_bytes" in text


async def test_snapshot_503_before_first_collection(tmp_path, fake_exe, provider):
    import httpx
    from app.main import create_app
    app = create_app(data_dir=tmp_path / "d", provider=provider, token=None)
    async with app.router.lifespan_context(app):
        app.state.collector.latest = None
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
            assert (await c.get("/monitor/snapshot")).status_code == 503


def test_prometheus_empty_snapshot():
    assert render(None, {}) == ""


async def test_gpu_use_is_summed_over_the_process_tree_and_missing_when_the_provider_cannot_tell(env):
    inst, pid = await running_instance(env)
    child = psutil.Process(pid).children(recursive=True)[0].pid
    env.provider.util = {child: {0: 35}, pid: {0: 5}, 999999: {0: 50}}  # an unrelated pid must not count
    d = (await env.app.state.collector.collect())["instances"][str(inst["id"])]
    assert d["gpu_util_by_gpu"] == {"0": 40}
    env.provider.util = {}  # the provider answers: the instance is idle
    assert (await env.app.state.collector.collect())["instances"][str(inst["id"])]["gpu_util_by_gpu"] == {}
    env.provider.util = None  # it cannot tell (macOS, AMD): the screen shows the GPU's use as a whole
    assert (await env.app.state.collector.collect())["instances"][str(inst["id"])]["gpu_util_by_gpu"] is None
