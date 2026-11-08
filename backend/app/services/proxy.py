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
import hmac
import json
import logging
import time
from collections import deque
from dataclasses import dataclass
from collections.abc import Iterable
from typing import Any, AsyncIterator, Awaitable, Callable

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
HISTORY_SIZE = 200


class ProxyError(RuntimeError):
    pass


@dataclass
class Record:
    ts: float
    outcome: str  # ok | error | cancelled (the client went away: not a failure)
    latency: float
    ttft: float | None
    tokens: int | None  # generated tokens, when Ollama reported them
    eval_ns: int | None
    prompt_tokens: int | None = None
    status: int = 0
    path: str = ""
    model: str = ""
    client: str = ""

    @property
    def ok(self) -> bool:
        return self.outcome == "ok"


def _int(v: Any) -> int | None:
    try:
        return int(v) if v else None
    except (TypeError, ValueError):
        return None


def read_stats(tail: bytes, path: str, streamed: bool, latency: float, ttft: float | None) -> tuple[int | None, int | None, int | None]:
    """(generated tokens, generation time in ns, input tokens) taken from the end of an answer.

    Native endpoints end with an object holding eval_count / eval_duration / prompt_eval_count, so the speed is
    exact. The OpenAI-compatible /v1 endpoints only report `usage` (token counts), so their speed is the token
    count over the time spent answering (after the first byte when streaming, the whole request otherwise) --
    an approximation that also includes prompt processing.
    """
    lines = [ln.strip() for ln in tail.split(b"\n") if ln.strip()]
    if path.startswith("/v1/"):
        for ln in reversed(lines):
            if ln.startswith(b"data:"):
                ln = ln[5:].strip()
            if ln == b"[DONE]":
                continue
            try:
                obj = json.loads(ln)
            except ValueError:
                continue
            usage = obj.get("usage") if isinstance(obj, dict) else None
            if isinstance(usage, dict):
                out = _int(usage.get("completion_tokens"))
                secs = latency - ttft if streamed and ttft is not None else latency
                return out, int(secs * 1e9) if out and secs > 0 else None, _int(usage.get("prompt_tokens"))
        return None, None, None
    if not lines:
        return None, None, None
    try:
        obj = json.loads(lines[-1])
    except ValueError:
        return None, None, None
    if not isinstance(obj, dict):
        return None, None, None
    return _int(obj.get("eval_count")), _int(obj.get("eval_duration")), _int(obj.get("prompt_eval_count"))


def reached_end(tail: bytes, sent: int, headers: httpx.Headers) -> bool:
    """Did the whole answer go out? A client that hangs up the instant it has the last byte can cancel the relay
    just before the loop notices the end, so completeness is also judged from the bytes themselves."""
    length = headers.get("content-length", "")
    if length.isdigit() and sent >= int(length):
        return True
    lines = tail.rstrip().split(b"\n")
    last = lines[-1].strip() if lines else b""
    if last in (b"data: [DONE]", b"[DONE]"):
        return True
    try:
        obj = json.loads(last)
    except ValueError:
        return False
    return isinstance(obj, dict) and obj.get("done") is True


def model_of(body: bytes) -> str:
    try:
        m = json.loads(body).get("model")
    except (ValueError, AttributeError):
        return ""
    return m if isinstance(m, str) else ""


def norm_model(name: str) -> str:
    """Ollama treats "llama3" and "llama3:latest" as the same model."""
    name = name.strip()
    return name if ":" in name.rsplit("/", 1)[-1] else f"{name}:latest"


# Requests that change what is installed; an instance limited to chosen models leaves them to the app's model window.
MODEL_CHANGING = frozenset({"/api/pull", "/api/push", "/api/create", "/api/copy", "/api/delete"})
LIST_PATHS = ("/api/tags", "/v1/models")


class PerfStats:
    def __init__(self, parallel: int):
        self.parallel = max(1, parallel)
        self.inflight: dict[str, int] = {}  # model -> requests currently relayed
        self.records: deque[Record] = deque()
        self.history: deque[Record] = deque(maxlen=HISTORY_SIZE)  # newest last; kept past the 5-minute window
        self.total = 0
        self.errors_total = 0
        self.tokens_total = 0
        self.prompt_tokens_total = 0

    def begin(self, model: str) -> None:
        self.inflight[model] = self.inflight.get(model, 0) + 1

    def end(self, model: str, rec: Record) -> None:
        n = self.inflight.get(model, 1) - 1
        if n > 0:
            self.inflight[model] = n
        else:
            self.inflight.pop(model, None)
        self.records.append(rec)
        self.history.append(rec)
        self.total += 1
        if rec.outcome == "error":
            self.errors_total += 1
        self.tokens_total += rec.tokens or 0
        self.prompt_tokens_total += rec.prompt_tokens or 0

    def snapshot(self) -> dict[str, Any]:
        cutoff = time.time() - WINDOW_SECONDS
        while self.records and self.records[0].ts < cutoff:
            self.records.popleft()
        done = [r for r in self.records if r.ok]
        ttfts = [r.ttft for r in done if r.ttft is not None]
        gen = [r for r in done if r.tokens and r.eval_ns]
        tokens = sum(r.tokens for r in gen)
        eval_s = sum(r.eval_ns for r in gen) / 1e9
        errors = sum(1 for r in self.records if r.outcome == "error")
        cancelled = sum(1 for r in self.records if r.outcome == "cancelled")
        running = sum(self.inflight.values())
        # Each loaded model serves `parallel` requests at once (OLLAMA_NUM_PARALLEL); the rest wait.
        queued = sum(max(0, n - self.parallel) for n in self.inflight.values())
        return {
            "inflight": running, "queued": queued, "processing": running - queued,
            "requests": len(self.records), "requests_total": self.total,
            "errors": errors, "errors_total": self.errors_total, "cancelled": cancelled,
            "models": self._by_model(),
            "latency_avg": sum(r.latency for r in done) / len(done) if done else None,
            "ttft_avg": sum(ttfts) / len(ttfts) if ttfts else None,
            "prompt_tokens": sum(r.prompt_tokens or 0 for r in done),
            "tokens_total": self.tokens_total, "prompt_tokens_total": self.prompt_tokens_total,
            "tokens": tokens, "eval_seconds": eval_s, "tok_per_s": tokens / eval_s if eval_s > 0 else None,
            "window_seconds": WINDOW_SECONDS,
        }


    def _by_model(self) -> dict[str, dict[str, Any]]:
        out: dict[str, dict[str, Any]] = {}
        for r in self.records:
            m = out.setdefault(r.model or "-", {"requests": 0, "errors": 0, "tokens": 0, "eval_seconds": 0.0, "_lat": 0.0, "_ok": 0})
            m["requests"] += 1
            if r.outcome == "error":
                m["errors"] += 1
            if r.ok:
                m["_lat"] += r.latency
                m["_ok"] += 1
                if r.tokens and r.eval_ns:
                    m["tokens"] += r.tokens
                    m["eval_seconds"] += r.eval_ns / 1e9
        for m in out.values():
            ok, lat = m.pop("_ok"), m.pop("_lat")
            m["latency_avg"] = lat / ok if ok else None
            m["tok_per_s"] = m["tokens"] / m["eval_seconds"] if m["eval_seconds"] > 0 else None
        return out

    def recent(self, limit: int) -> list[dict[str, Any]]:
        """Newest first. No prompts or answers are kept, only what happened to each request."""
        return [
            {"ts": r.ts, "path": r.path, "model": r.model, "status": r.status, "outcome": r.outcome,
             "duration": round(r.latency, 3), "ttft": round(r.ttft, 3) if r.ttft is not None else None,
             "tokens": r.tokens, "prompt_tokens": r.prompt_tokens, "client": r.client}
            for r in list(self.history)[::-1][:limit]
        ]


class InstanceProxy:
    def __init__(self, name: str, port: int, upstream_port: int | None, parallel: int, recorder: Callable[[Record], None] | None = None,
                 host: str = "127.0.0.1", api_key: str | None = None):
        self.name, self.port, self.upstream_port = name, port, upstream_port  # upstream None = standby (nothing behind the port)
        self.host, self.api_key = host, api_key  # host 0.0.0.0 = reachable from the network
        self.recorder = recorder  # called with every finished request (the manager stores per-minute sums)
        self.stats = PerfStats(parallel)
        self.ready = False  # True once the upstream answers; requests arriving earlier wait (see ensure)
        self.ensure: Callable[[], Awaitable[bool]] | None = None  # set by the manager: make the upstream ready, True if it is
        self.last_activity = time.monotonic()
        self._client = httpx.AsyncClient(timeout=httpx.Timeout(None, connect=5.0), limits=httpx.Limits(max_connections=None, max_keepalive_connections=20))
        self._server: uvicorn.Server | None = None
        self._task: asyncio.Task | None = None
        self._closing: asyncio.Task | None = None
        self.allowed: frozenset[str] = frozenset()  # models this instance serves (normalized); empty = all
        self.draining = False  # stopping: new inference requests are refused while the running ones finish

    def set_allowed(self, models: Iterable[str]) -> None:
        self.allowed = frozenset(norm_model(m) for m in models if m.strip())

    def _not_allowed(self, name: str) -> bool:
        return bool(name) and norm_model(name) not in self.allowed

    async def _deny(self, request: Request, path: str) -> Response | None:
        """With a model limit set: refuse what the instance must not do, before it is even woken up."""
        if path in MODEL_CHANGING and request.method in ("POST", "DELETE"):
            return JSONResponse({"error": "This instance serves selected models only; manage models in the app"}, status_code=403)
        if request.method == "POST" and (path in INFERENCE_PATHS or path == "/api/show"):
            body = await request.body()
            try:
                name = json.loads(body).get("model") or json.loads(body).get("name") or ""
            except (ValueError, AttributeError):
                name = ""
            if isinstance(name, str) and self._not_allowed(name):
                return JSONResponse({"error": f"model '{name}' not found"}, status_code=404)
        if request.method == "GET" and path.startswith("/v1/models/") and self._not_allowed(path[len("/v1/models/"):]):
            return JSONResponse({"error": {"message": "model not found", "type": "invalid_request_error"}}, status_code=404)
        return None

    async def _filtered_list(self, request: Request, path: str, headers: dict[str, str]) -> Response:
        """The model lists show only the models this instance serves."""
        url = f"http://127.0.0.1:{self.upstream_port}{path}" + (f"?{request.url.query}" if request.url.query else "")
        try:
            r = await self._client.get(url, headers=headers)
            data = r.json()
        except (httpx.HTTPError, ValueError) as e:
            return JSONResponse({"error": f"Could not reach Ollama: {e.__class__.__name__}"}, status_code=502)
        if r.status_code < 400 and isinstance(data, dict):
            key, field = ("models", "name") if path == "/api/tags" else ("data", "id")
            data[key] = [m for m in data.get(key, []) if isinstance(m, dict) and norm_model(str(m.get(field, ""))) in self.allowed]
        return JSONResponse(data, status_code=r.status_code)

    # ---- relaying

    def _app(self) -> Starlette:
        methods = ["GET", "POST", "PUT", "DELETE", "HEAD", "PATCH", "OPTIONS"]
        return Starlette(routes=[Route("/{path:path}", self._handle, methods=methods)])

    def _authorized(self, request: Request) -> bool:
        if not self.api_key or request.method == "OPTIONS":  # CORS preflights carry no credentials; Ollama answers them
            return True
        auth = request.headers.get("authorization", "")
        scheme, _, token = auth.partition(" ")
        return scheme.lower() == "bearer" and hmac.compare_digest(token.strip().encode(), self.api_key.encode())

    async def _handle(self, request: Request) -> Response:
        if not self._authorized(request):
            return JSONResponse({"error": "Missing or invalid API key"}, status_code=401, headers={"WWW-Authenticate": "Bearer"})
        path = request.url.path
        if self.allowed:
            denied = await self._deny(request, path)
            if denied is not None:
                return denied
        self.last_activity = time.monotonic()
        if not self.ready:  # stopped (standby) or still starting: start it if allowed and wait until it answers
            if self.ensure is None or not await self.ensure():
                return JSONResponse({"error": "The instance is not running"}, status_code=503, headers={"Retry-After": "5"})
        measured = request.method == "POST" and path in INFERENCE_PATHS
        started = time.monotonic()
        url = f"http://127.0.0.1:{self.upstream_port}" + path + (f"?{request.url.query}" if request.url.query else "")
        headers = {k: v for k, v in request.headers.items() if k.lower() not in HOP_BY_HOP and not (self.api_key and k.lower() == "authorization")}
        if self.allowed and request.method == "GET" and path in LIST_PATHS:
            return await self._filtered_list(request, path, headers)
        model = ""
        if measured and self.draining:
            return JSONResponse({"error": "The instance is stopping"}, status_code=503, headers={"Retry-After": "5"})
        if measured:
            body = await request.body()  # small JSON; read whole to learn the model name
            model = model_of(body)
            content: Any = body
            self.stats.begin(model)
        else:
            has_body = "content-length" in request.headers or "transfer-encoding" in request.headers
            content = request.stream() if has_body else None

        client = request.client.host if request.client else ""

        def finish(outcome: str, status: int, ttft: float | None, tail: bytes, streamed: bool = False) -> None:
            if not measured:
                return
            latency = time.monotonic() - started
            out, eval_ns, prompt = read_stats(tail, path, streamed, latency, ttft) if outcome == "ok" else (None, None, None)
            rec = Record(time.time(), outcome, latency, ttft, out, eval_ns, prompt, status, path, model, client)
            self.stats.end(model, rec)
            self.last_activity = time.monotonic()
            if self.recorder is not None:
                try:
                    self.recorder(rec)
                except Exception:  # statistics must never break a request
                    log.exception("Could not store request statistics")

        try:
            resp = await self._client.send(self._client.build_request(request.method, url, headers=headers, content=content), stream=True)
        except httpx.HTTPError as e:
            finish("error", 502, None, b"")
            return JSONResponse({"error": f"Could not reach Ollama: {e.__class__.__name__}"}, status_code=502)

        async def body() -> AsyncIterator[bytes]:
            ttft: float | None = None
            tail = b""
            outcome = "cancelled"  # stays so when the client goes away before the answer is complete
            sent = 0
            try:
                async for chunk in resp.aiter_raw():
                    if ttft is None:
                        ttft = time.monotonic() - started
                    sent += len(chunk)
                    if measured:
                        tail = (tail + chunk)[-STATS_TAIL:]
                    yield chunk
                outcome = "ok" if resp.status_code < 400 else "error"
            except httpx.HTTPError:
                outcome = "error"  # Ollama died or broke the connection mid-answer
                raise
            finally:
                if outcome == "cancelled" and measured and resp.status_code < 400 and reached_end(tail, sent, resp.headers):
                    outcome = "ok"  # the client left only after receiving everything
                with anyio.CancelScope(shield=True):
                    await resp.aclose()  # closing the upstream request is what makes Ollama stop generating
                finish(outcome, resp.status_code, ttft, tail, resp.headers.get("content-type", "").startswith("text/event-stream"))

        out_headers = {k: v for k, v in resp.headers.items() if k.lower() not in SKIP_RESPONSE}
        return StreamingResponse(body(), status_code=resp.status_code, headers=out_headers)

    # ---- lifecycle

    def attach(self, upstream_port: int, parallel: int) -> None:
        """An instance process now runs behind this proxy (it is ready once the manager sees it answer)."""
        self.upstream_port, self.ready, self.draining = upstream_port, False, False
        self.stats.parallel = max(1, parallel)
        self.last_activity = time.monotonic()

    def detach(self) -> None:
        """The process is gone but the port stays reserved (standby for an on-demand instance)."""
        self.upstream_port, self.ready, self.draining = None, False, False

    async def drain(self, timeout: float) -> int:
        """Refuse new inference requests and wait for the running ones. Returns how many were still running."""
        self.draining = True
        end = time.monotonic() + timeout
        while time.monotonic() < end and sum(self.stats.inflight.values()) > 0:
            await asyncio.sleep(0.2)
        return sum(self.stats.inflight.values())

    async def start(self) -> None:
        server = uvicorn.Server(uvicorn.Config(
            self._app(), host=self.host, port=self.port, log_level="warning", lifespan="off",
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
