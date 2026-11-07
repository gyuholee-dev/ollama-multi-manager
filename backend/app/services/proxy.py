"""Per-instance request proxy.

Each instance is reachable on the port the user configured; that port is served here, inside the backend,
and every request is relayed to the real `ollama serve`, which listens on a private loopback port.
Relaying lets the app measure what Ollama itself does not report: how many requests are running or waiting,
how long they take, the time to the first byte, and the generation speed (read from the final stats object
Ollama puts at the end of each answer).

The relay is transparent: methods, paths, headers and bodies pass through unchanged, responses are streamed
chunk by chunk, and a client that goes away makes the upstream request go away too (Ollama stops generating).
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from collections import deque
from dataclasses import dataclass
from typing import Any, AsyncIterator

import anyio
import httpx
import uvicorn
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse, Response, StreamingResponse
from starlette.routing import Route

log = logging.getLogger("omm.proxy")

# Only these are counted; everything else (tags, ps, pull, ...) is relayed without being measured.
INFERENCE_PATHS = frozenset({
    "/api/chat", "/api/generate", "/api/embed", "/api/embeddings",
    "/v1/chat/completions", "/v1/completions", "/v1/embeddings", "/v1/responses",
})
HOP_BY_HOP = frozenset({"connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailers", "transfer-encoding", "upgrade", "host"})
SKIP_RESPONSE = HOP_BY_HOP | {"date", "server"}  # the proxy's own server adds these
STATS_TAIL = 64 * 1024  # the stats object is at the end of the answer; keep only that much
WINDOW_SECONDS = 300.0


class ProxyError(RuntimeError):
    pass


@dataclass
class Record:
    ts: float
    ok: bool
    latency: float
    ttft: float | None
    tokens: int | None  # generated tokens, when Ollama reported them
    eval_ns: int | None


def read_stats(tail: bytes) -> tuple[int, int] | None:
    """(eval_count, eval_duration in ns) from the last JSON line of an Ollama answer."""
    lines = [ln for ln in tail.split(b"\n") if ln.strip()]
    if not lines:
        return None
    try:
        obj = json.loads(lines[-1])
    except ValueError:
        return None
    if isinstance(obj, dict) and obj.get("eval_count") and obj.get("eval_duration"):
        try:
            return int(obj["eval_count"]), int(obj["eval_duration"])
        except (TypeError, ValueError):
            return None
    return None


def model_of(body: bytes) -> str:
    try:
        m = json.loads(body).get("model")
    except (ValueError, AttributeError):
        return ""
    return m if isinstance(m, str) else ""


class PerfStats:
    def __init__(self, parallel: int):
        self.parallel = max(1, parallel)
        self.inflight: dict[str, int] = {}  # model -> requests currently relayed
        self.records: deque[Record] = deque()
        self.total = 0

    def begin(self, model: str) -> None:
        self.inflight[model] = self.inflight.get(model, 0) + 1

    def end(self, model: str, rec: Record) -> None:
        n = self.inflight.get(model, 1) - 1
        if n > 0:
            self.inflight[model] = n
        else:
            self.inflight.pop(model, None)
        self.records.append(rec)
        self.total += 1

    def snapshot(self) -> dict[str, Any]:
        cutoff = time.time() - WINDOW_SECONDS
        while self.records and self.records[0].ts < cutoff:
            self.records.popleft()
        done = [r for r in self.records if r.ok]
        ttfts = [r.ttft for r in done if r.ttft is not None]
        gen = [r for r in done if r.tokens and r.eval_ns]
        tokens = sum(r.tokens for r in gen)
        eval_s = sum(r.eval_ns for r in gen) / 1e9
        running = sum(self.inflight.values())
        # Each loaded model serves `parallel` requests at once (OLLAMA_NUM_PARALLEL); the rest wait.
        queued = sum(max(0, n - self.parallel) for n in self.inflight.values())
        return {
            "inflight": running, "queued": queued, "processing": running - queued,
            "requests": len(self.records), "requests_total": self.total,
            "latency_avg": sum(r.latency for r in done) / len(done) if done else None,
            "ttft_avg": sum(ttfts) / len(ttfts) if ttfts else None,
            "tokens": tokens, "eval_seconds": eval_s, "tok_per_s": tokens / eval_s if eval_s > 0 else None,
            "window_seconds": WINDOW_SECONDS,
        }


class InstanceProxy:
    def __init__(self, name: str, port: int, upstream_port: int, parallel: int):
        self.name, self.port, self.upstream_port = name, port, upstream_port
        self.stats = PerfStats(parallel)
        self._upstream = f"http://127.0.0.1:{upstream_port}"
        self._client = httpx.AsyncClient(timeout=httpx.Timeout(None, connect=5.0), limits=httpx.Limits(max_connections=None, max_keepalive_connections=20))
        self._server: uvicorn.Server | None = None
        self._task: asyncio.Task | None = None
        self._closing: asyncio.Task | None = None

    # ---- relaying

    def _app(self) -> Starlette:
        methods = ["GET", "POST", "PUT", "DELETE", "HEAD", "PATCH", "OPTIONS"]
        return Starlette(routes=[Route("/{path:path}", self._handle, methods=methods)])

    async def _handle(self, request: Request) -> Response:
        path = request.url.path
        measured = request.method == "POST" and path in INFERENCE_PATHS
        started = time.monotonic()
        url = self._upstream + path + (f"?{request.url.query}" if request.url.query else "")
        headers = {k: v for k, v in request.headers.items() if k.lower() not in HOP_BY_HOP}
        model = ""
        if measured:
            body = await request.body()  # small JSON; read whole to learn the model name
            model = model_of(body)
            content: Any = body
            self.stats.begin(model)
        else:
            has_body = "content-length" in request.headers or "transfer-encoding" in request.headers
            content = request.stream() if has_body else None

        def finish(ok: bool, ttft: float | None, tail: bytes) -> None:
            if not measured:
                return
            st = read_stats(tail) if ok else None
            self.stats.end(model, Record(time.time(), ok, time.monotonic() - started, ttft, st[0] if st else None, st[1] if st else None))

        try:
            resp = await self._client.send(self._client.build_request(request.method, url, headers=headers, content=content), stream=True)
        except httpx.HTTPError as e:
            finish(False, None, b"")
            return JSONResponse({"error": f"Could not reach Ollama: {e.__class__.__name__}"}, status_code=502)

        async def body() -> AsyncIterator[bytes]:
            ttft: float | None = None
            tail = b""
            done = False
            try:
                async for chunk in resp.aiter_raw():
                    if ttft is None:
                        ttft = time.monotonic() - started
                    if measured:
                        tail = (tail + chunk)[-STATS_TAIL:]
                    yield chunk
                done = True
            finally:
                with anyio.CancelScope(shield=True):
                    await resp.aclose()  # closing the upstream request is what makes Ollama stop generating
                finish(done and resp.status_code < 400, ttft, tail)

        out_headers = {k: v for k, v in resp.headers.items() if k.lower() not in SKIP_RESPONSE}
        return StreamingResponse(body(), status_code=resp.status_code, headers=out_headers)

    # ---- lifecycle

    async def start(self) -> None:
        server = uvicorn.Server(uvicorn.Config(
            self._app(), host="127.0.0.1", port=self.port, log_level="warning", lifespan="off",
            access_log=False, timeout_graceful_shutdown=2,
        ))
        server.install_signal_handlers = lambda: None  # the main server owns signal handling
        self._server = server
        self._task = asyncio.create_task(self._serve(server))
        for _ in range(100):
            if server.started or self._task.done():
                break
            await asyncio.sleep(0.05)
        if not server.started:
            await self.close()
            raise ProxyError(f"Could not listen on port {self.port}")

    async def _serve(self, server: uvicorn.Server) -> None:
        try:
            await server.serve()
        except SystemExit:  # uvicorn exits instead of raising when it cannot bind
            pass

    async def close(self) -> None:
        """Safe to call from several places at once: every caller waits until the port is really free."""
        if self._closing is None:
            self._closing = asyncio.create_task(self._close())
        await asyncio.shield(self._closing)

    async def _close(self) -> None:
        server, task, self._server, self._task = self._server, self._task, None, None
        if server is not None:
            server.should_exit = True
        if task is not None:
            try:
                await asyncio.wait_for(asyncio.shield(task), 5)
            except asyncio.TimeoutError:
                server.force_exit = True
                await asyncio.gather(task, return_exceptions=True)
        await self._client.aclose()
