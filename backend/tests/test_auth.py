import httpx
import pytest

from app.main import create_app


@pytest.fixture
async def secured(tmp_path, provider):
    app = create_app(data_dir=tmp_path / "d", provider=provider, token="s3cret")
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
            yield c


async def test_health_is_public_everything_else_needs_the_token(secured):
    assert (await secured.get("/health")).status_code == 200
    assert (await secured.get("/settings")).status_code == 401
    assert (await secured.get("/settings", headers={"Authorization": "Bearer nope"})).status_code == 401
    assert (await secured.get("/settings", headers={"Authorization": "Bearer s3cret"})).status_code == 200


async def test_shutdown_endpoint(secured):
    h = {"Authorization": "Bearer s3cret"}
    assert (await secured.post("/shutdown")).status_code == 401
    assert (await secured.post("/shutdown", headers=h)).status_code == 501        # not started via `python -m app`
    called = []
    secured._transport.app.state.request_shutdown = lambda: called.append(1)
    assert (await secured.post("/shutdown", headers=h)).status_code == 202 and called
