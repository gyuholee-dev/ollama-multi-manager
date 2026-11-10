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


def test_an_old_database_gets_web_access_switched_off_once(tmp_path):
    """Web monitoring used to be on by default and served only /metrics; now it serves the web UI to the network."""
    from app.db import Database
    db = Database(tmp_path / "app.db")
    db.migrate()
    assert db.one("SELECT value FROM settings WHERE key='external_monitoring_enabled'")["value"] == "false"  # fresh: off
    db.execute("UPDATE settings SET value='true' WHERE key='external_monitoring_enabled'")
    db.execute("INSERT INTO settings(key, value) VALUES('external_monitoring_web', 'true')")
    db.execute("PRAGMA user_version=1")                                                                      # as an old database
    db.migrate()
    assert db.one("SELECT value FROM settings WHERE key='external_monitoring_enabled'")["value"] == "false"
    assert db.one("SELECT 1 FROM settings WHERE key='external_monitoring_web'") is None
    assert db.one("PRAGMA user_version")[0] == 2
    db.execute("UPDATE settings SET value='true' WHERE key='external_monitoring_enabled'")                   # the user's later choice
    db.migrate()
    assert db.one("SELECT value FROM settings WHERE key='external_monitoring_enabled'")["value"] == "true"


async def test_responses_carry_a_content_security_policy(env):
    csp = (await env.client.get("/settings")).headers["content-security-policy"]
    assert "script-src 'self'" in csp and "unsafe-eval" not in csp and "object-src 'none'" in csp
