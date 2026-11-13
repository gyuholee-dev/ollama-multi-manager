"""A route that answers 204 declares `response_model=None`.

Without it, FastAPI 0.115 (the oldest version requirements.txt allows) reads the `-> None` annotation, which `from __future__ import
annotations` turns into a string, as a response model, and refuses to start: "Status code 204 must not have a response body".
Newer versions accept both, so a machine with a newer FastAPI never shows the failure; this keeps the rule in place.
"""
from fastapi.routing import APIRoute

from app.api.routes import api


def test_204_routes_have_no_response_model() -> None:
    routes = [r for r in api.routes if isinstance(r, APIRoute) and r.status_code == 204]
    assert routes, "no 204 route found: the check does not look at anything"
    assert all(r.response_model is None for r in routes), [r.path for r in routes if r.response_model is not None]
