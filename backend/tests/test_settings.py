async def test_defaults_do_not_include_removed_options(env):
    s = (await env.client.get("/settings")).json()
    assert s["theme"] == "system" and s["refresh_interval_seconds"] == 3 and s["language"] is None
    assert "restore_instances_on_start" not in s and "stop_instances_on_quit" not in s


async def test_partial_update_persists(env):
    r = await env.client.put("/settings", json={"theme": "dark", "refresh_interval_seconds": 5})
    assert r.status_code == 200 and r.json()["theme"] == "dark"
    assert (await env.client.get("/settings")).json()["refresh_interval_seconds"] == 5


async def test_validation(env):
    assert (await env.client.put("/settings", json={"theme": "pink"})).status_code == 422
    assert (await env.client.put("/settings", json={"refresh_interval_seconds": 0})).status_code == 422
    assert (await env.client.put("/settings", json={"external_monitoring_port": 80})).status_code == 422
    assert (await env.client.put("/settings", json={"restore_instances_on_start": True})).status_code == 422
    assert (await env.client.put("/settings", json={"ollama_executable_path": "/no/such/file"})).status_code == 422


async def test_null_clears_nullable_setting(env):
    r = await env.client.put("/settings", json={"default_models_path": "/tmp/x"})
    assert r.json()["default_models_path"] == "/tmp/x"
    r = await env.client.put("/settings", json={"default_models_path": None})
    assert r.json()["default_models_path"] is None
