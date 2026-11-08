"""HTTP and WebSocket routes."""
from __future__ import annotations

import asyncio
import secrets
import sys
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request, Response, WebSocket, WebSocketDisconnect
from fastapi.responses import PlainTextResponse

from app.schemas import AllowedModels, InstanceCreate, InstanceUpdate, PullRequest, SettingsPatch, StopRequest
from app.services.external import lan_ip
from app.services.monitor import prometheus
from app.services.settings import SettingsError


def _token_ok(expected: str | None, given: str) -> bool:
    return not expected or secrets.compare_digest(given, expected)


def is_guest(scope_owner: Any) -> bool:
    """True for requests that came through the read-only guest listener (see services/external.py)."""
    return bool(scope_owner.scope.get("omm_guest"))


def hide_secrets(inst: dict[str, Any]) -> dict[str, Any]:
    """Guests may see that an API key is set, never the key."""
    opts = dict(inst["options"])
    if opts.get("api_key"):
        opts["api_key"] = "********"
    return {**inst, "options": opts}


def require_token(request: Request) -> None:
    if is_guest(request):  # the guest listener only lets read-only paths through
        return
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
    values = request.app.state.settings.all()
    if is_guest(request):  # paths on this PC are of no use to a guest
        values = {k: v for k, v in values.items() if k not in ("ollama_executable_path", "default_models_path")}
    return values


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
    if {"ollama_executable_path", "default_models_path"} & patch.model_fields_set:
        # the model store server follows these two settings: restart it now rather than at the next use
        task = asyncio.create_task(st.models.store.warm())
        st.background.add(task)
        task.add_done_callback(st.background.discard)
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
            "external_monitoring": request.app.state.external.status(), "guest": is_guest(request)}


# ---- instances

@api.get("/instances")
async def list_instances(request: Request) -> list[dict[str, Any]]:
    items = request.app.state.manager.list()
    return [hide_secrets(i) for i in items] if is_guest(request) else items


@api.get("/instances/next-port")
async def next_port(request: Request) -> dict[str, int]:
    return {"port": request.app.state.manager.next_port()}


@api.post("/instances", status_code=201)
async def create_instance(body: InstanceCreate, request: Request) -> dict[str, Any]:
    created = request.app.state.manager.create(body)
    await request.app.state.manager.sync_standby(created["id"])
    return created


@api.get("/instances/{iid}")
async def get_instance(iid: int, request: Request) -> dict[str, Any]:
    inst = request.app.state.manager.get(iid)
    return hide_secrets(inst) if is_guest(request) else inst


@api.patch("/instances/{iid}")
async def update_instance(iid: int, body: InstanceUpdate, request: Request) -> dict[str, Any]:
    updated = request.app.state.manager.update(iid, body)
    await request.app.state.manager.sync_standby(iid)
    return updated


@api.delete("/instances/{iid}", status_code=204)
async def delete_instance(iid: int, request: Request) -> None:
    request.app.state.manager.delete(iid)
    await request.app.state.manager.sync_standby(iid)


@api.get("/instances/{iid}/models")
async def instance_models(iid: int, request: Request) -> list[dict[str, Any]]:
    """Read-only: what this running instance can serve. Managing models is done on /models."""
    return await request.app.state.manager.models(iid)


@api.put("/instances/{iid}/allowed-models")
async def set_allowed_models(iid: int, body: AllowedModels, request: Request) -> dict[str, Any]:
    """Limits the instance to the given models (empty = every installed model). Works while it runs."""
    return request.app.state.manager.set_allowed_models(iid, body.models)


@api.get("/instances/{iid}/requests")
async def instance_requests(iid: int, request: Request, limit: int = 50) -> dict[str, Any]:
    return request.app.state.manager.requests(iid, max(1, min(limit, 200)))


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


@api.get("/monitor/requests")
async def request_series(request: Request, minutes: int = 60, instance: int | None = None) -> dict[str, Any]:
    """Per-minute request numbers (requests, errors, tokens, speed, response time), empty minutes included."""
    return {"series": request.app.state.manager.request_stats.series(max(1, min(minutes, 1440)), instance)}


@api.get("/monitor/history")
async def history(request: Request) -> list[dict[str, Any]]:
    return list(request.app.state.collector.history)


@api.get("/monitor/instances/{iid}/history")
async def instance_history(iid: int, request: Request) -> dict[str, Any]:
    """The latest readings of one running instance: ts (s), cpu (% of the whole machine), rss and vram (bytes), processing, queued."""
    return {"samples": list(request.app.state.collector.inst_history.get(iid, []))}


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
    if not is_guest(websocket) and not _token_ok(st.token, websocket.query_params.get("token", "")):
        await websocket.close(code=1008)
        return
    await websocket.accept()
    q = st.hub.subscribe()

    async def client_left() -> None:
        try:
            while True:
                await websocket.receive_text()
        except (WebSocketDisconnect, RuntimeError):
            return

    left = asyncio.create_task(client_left())  # notices a closed connection even while no event is being sent
    try:
        if st.collector.latest:
            await websocket.send_json({"type": "metrics", "data": st.collector.latest})
        while True:
            event = asyncio.create_task(q.get())
            await asyncio.wait({event, left}, return_when=asyncio.FIRST_COMPLETED)
            if left.done():
                event.cancel()
                break
            await websocket.send_json(event.result())
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        left.cancel()
        st.hub.unsubscribe(q)
