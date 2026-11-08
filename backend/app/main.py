"""FastAPI application factory."""
from __future__ import annotations

import asyncio
import contextlib
import logging
import os
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from app.api import routes
from app.config import cors_origins, default_data_dir
from app.db import Database
from app.services.external import ExternalMonitor
from app.services.hub import Hub
from app.services.instances import InstanceError, InstanceManager
from app.services.models import ModelService
from app.services.monitor.collector import Collector
from app.services.monitor.providers import GpuProvider, detect_provider
from app.services.settings import SettingsService

log = logging.getLogger("omm")
VERSION = "0.1.0"


def default_frontend_dir() -> Path:
    return Path(os.environ.get("OMM_FRONTEND_DIR") or Path(__file__).resolve().parents[2] / "frontend" / "dist")


def create_app(data_dir: Path | None = None, provider: GpuProvider | None = None, token: str | None = None,
               frontend_dir: Path | None = None) -> FastAPI:
    data_dir = data_dir or default_data_dir()
    token = token if token is not None else os.environ.get("OMM_TOKEN") or None
    ui = frontend_dir or default_frontend_dir()

    @contextlib.asynccontextmanager
    async def lifespan(app: FastAPI):
        data_dir.mkdir(parents=True, exist_ok=True)
        db = Database(data_dir / "app.db")
        db.migrate()
        hub = Hub()
        settings = SettingsService(db)
        manager = InstanceManager(db, hub, settings, data_dir)
        models = ModelService(manager, hub, data_dir)
        collector = Collector(manager, provider or detect_provider(), settings, hub)
        app.state.db, app.state.hub, app.state.settings = db, hub, settings
        app.state.manager, app.state.collector, app.state.token = manager, collector, token
        app.state.models = models
        app.state.version = VERSION
        external = app.state.external = ExternalMonitor(settings, manager, collector, app, ui if ui.is_dir() else None)
        log.info("Backend started (data dir: %s)", data_dir)

        await models.store.cleanup_orphan()
        app.state.background = set()
        warm = asyncio.create_task(models.store.warm()) if not os.environ.get("OMM_NO_STORE_WARM") else None  # tests: no real Ollama at startup
        tasks = [asyncio.create_task(collector.run()), asyncio.create_task(manager.restore()), asyncio.create_task(external.apply()), asyncio.create_task(manager.idle_loop())]
        try:
            yield
        finally:
            tasks[0].cancel()
            tasks[3].cancel()
            await asyncio.gather(tasks[0], tasks[3], return_exceptions=True)
            await asyncio.gather(*tasks[1:3], return_exceptions=True)  # let restore finish so shutdown sees a consistent state
            for t in [*([warm] if warm else []), *app.state.background]:
                t.cancel()
            await asyncio.gather(*([warm] if warm else []), *app.state.background, return_exceptions=True)
            await external.close()
            await models.close()
            await manager.shutdown()
            await collector.close()
            db.close()
            log.info("Backend stopped")

    app = FastAPI(title="ollama-multi-manager", lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware, allow_origins=cors_origins(), allow_methods=["*"], allow_headers=["*"],
    )

    @app.exception_handler(InstanceError)
    async def _instance_error(_: Request, e: InstanceError) -> JSONResponse:
        return JSONResponse({"error": {"code": e.code, "message": e.message}}, status_code=e.status)

    app.include_router(routes.public)
    app.include_router(routes.api)
    app.include_router(routes.ws_router)
    if ui.is_dir():  # same-origin UI: no CORS, and Electron can load it straight from the backend
        app.mount("/", StaticFiles(directory=ui, html=True), name="ui")
    return app
