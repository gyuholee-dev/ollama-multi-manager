"""HTTP and WebSocket routes."""
from __future__ import annotations

import secrets
import sys
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request, Response, WebSocket, WebSocketDisconnect
from fastapi.responses import PlainTextResponse

from app.schemas import InstanceCreate, InstanceUpdate, PullRequest, SettingsPatch, StopRequest
from app.services.external import lan_ip
from app.services.monitor import prometheus
from app.services.settings import SettingsError


def _token_ok(expected: str | None, given: str) -> bool:
    return not expected or secrets.compare_digest(given, expected)


def require_token(request: Request) -> None:
    auth = request.headers.get("authorization", "")
    given = auth[7:] if auth.lower().startswith("bearer ") else ""
    if not _token_ok(request.app.state.token, given):
        raise HTTPException(401, "Invalid or missing token")


public = APIRouter()
api = APIRouter(dependencies=[Depends(require_token)])


@public.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


# ---- settings

@api.get("/settings")
async def get_settings(request: Request) -> dict[str, Any]:
    return request.app.state.settings.all()


@api.put("/settings")
async def put_settings(patch: SettingsPatch, request: Request) -> dict[str, Any]:
    st = request.app.state
    port = patch.external_monitoring_port
    if port is not None and st.db.one("SELECT 1 FROM instances WHERE port=?", (port,)):
        raise HTTPException(409, f"Port {port} is used by an instance")
    try:
        result = st.settings.update(patch)
    except SettingsError as e:
        raise HTTPException(422, str(e)) from e
    await st.external.apply()
    return result


@api.post("/shutdown", status_code=202)
async def shutdown(request: Request) -> dict[str, str]:
    """Graceful stop (instances are stopped and their state saved). Works on every OS, unlike signals on Windows."""
    request_shutdown = getattr(request.app.state, "request_shutdown", None)
    if request_shutdown is None:
        raise HTTPException(501, "Shutdown is only available when started with `python -m app`")
    request_shutdown()
    return {"status": "shutting down"}


@api.get("/info")
async def info(request: Request) -> dict[str, Any]:
    return {"version": request.app.state.version, "platform": sys.platform, "lan_ip": lan_ip(),
            "external_monitoring": request.app.state.external.status()}


# ---- instances

@api.get("/instances")
async def list_instances(request: Request) -> list[dict[str, Any]]:
    return request.app.state.manager.list()


@api.get("/instances/next-port")
async def next_port(request: Request) -> dict[str, int]:
    return {"port": request.app.state.manager.next_port()}


@api.post("/instances", status_code=201)
async def create_instance(body: InstanceCreate, request: Request) -> dict[str, Any]:
    return request.app.state.manager.create(body)


@api.get("/instances/{iid}")
async def get_instance(iid: int, request: Request) -> dict[str, Any]:
    return request.app.state.manager.get(iid)


@api.patch("/instances/{iid}")
async def update_instance(iid: int, body: InstanceUpdate, request: Request) -> dict[str, Any]:
    return request.app.state.manager.update(iid, body)


@api.delete("/instances/{iid}", status_code=204)
async def delete_instance(iid: int, request: Request) -> None:
    request.app.state.manager.delete(iid)


@api.get("/instances/{iid}/models")
async def instance_models(iid: int, request: Request) -> list[dict[str, Any]]:
    """Read-only: what this running instance can serve. Managing models is done on /models."""
    return await request.app.state.manager.models(iid)


@api.post("/instances/{iid}/start")
async def start_instance(iid: int, request: Request) -> dict[str, Any]:
    return await request.app.state.manager.start(iid)


@api.post("/instances/{iid}/stop")
async def stop_instance(iid: int, request: Request, body: StopRequest | None = None) -> dict[str, Any]:
    return await request.app.state.manager.stop(iid, drain=body.drain_seconds if body else 0)


@api.post("/instances/{iid}/restart")
async def restart_instance(iid: int, request: Request, body: StopRequest | None = None) -> dict[str, Any]:
    return await request.app.state.manager.restart(iid, drain=body.drain_seconds if body else 0)


# ---- models

@api.get("/models")
async def list_models(request: Request) -> list[dict[str, Any]]:
    return await request.app.state.models.list()


@api.post("/models/pull", status_code=202)
async def pull_model(body: PullRequest, request: Request, response: Response) -> dict[str, Any]:
    task, created = await request.app.state.models.start_pull(body.model)
    if not created:
        response.status_code = 200  # the same pull is already running; return it instead of starting another
    return task.to_dict()


@api.delete("/models/{name:path}", status_code=204)
async def delete_model(name: str, request: Request) -> None:
    await request.app.state.models.delete(name)


@api.get("/pulls")
async def list_pulls(request: Request) -> list[dict[str, Any]]:
    return request.app.state.models.list_tasks()


@api.post("/pulls/{task_id}/pause")
async def pause_pull(task_id: str, request: Request) -> dict[str, Any]:
    return (await request.app.state.models.pause(task_id)).to_dict()


@api.post("/pulls/{task_id}/resume")
async def resume_pull(task_id: str, request: Request) -> dict[str, Any]:
    return (await request.app.state.models.resume(task_id)).to_dict()


@api.delete("/pulls/{task_id}", status_code=204)
async def remove_pull(task_id: str, request: Request) -> None:
    """Stops the download and deletes the partly downloaded files."""
    await request.app.state.models.remove(task_id)


@api.get("/logs")
async def get_logs(request: Request, instance: int | None = None, limit: int = 200) -> list[dict[str, Any]]:
    return request.app.state.manager.recent_logs(instance, max(1, min(limit, 2000)))


# ---- monitoring

@api.get("/monitor/snapshot")
async def snapshot(request: Request) -> dict[str, Any]:
    snap = request.app.state.collector.latest
    if snap is None:
        raise HTTPException(503, "No metrics collected yet")
    return snap


@api.get("/monitor/history")
async def history(request: Request) -> list[dict[str, Any]]:
    return list(request.app.state.collector.history)


@api.get("/metrics", response_class=PlainTextResponse)
async def metrics(request: Request) -> str:
    st = request.app.state
    names = {i["id"]: i["name"] for i in st.manager.list()}
    return prometheus.render(st.collector.latest, names)


# ---- realtime

ws_router = APIRouter()


@ws_router.websocket("/ws")
async def ws(websocket: WebSocket) -> None:
    st = websocket.app.state
    if not _token_ok(st.token, websocket.query_params.get("token", "")):
        await websocket.close(code=1008)
        return
    await websocket.accept()
    q = st.hub.subscribe()
    try:
        if st.collector.latest:
            await websocket.send_json({"type": "metrics", "data": st.collector.latest})
        while True:
            await websocket.send_json(await q.get())
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        st.hub.unsubscribe(q)
