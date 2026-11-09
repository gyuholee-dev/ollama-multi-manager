"""Per-instance request journal: `logs/requests-<id>.jsonl`, one JSON object per finished request.

Every measured request leaves its metadata (time, path, model, status, duration, tokens). When the instance's
"save request content" option is on, the request body and the answer are kept as well, cut to CONTENT_LIMIT
characters each. The list in the monitor reads the newest entries of this file, so it also survives a stop
or a restart of the app; the content of one entry is read only when its row is opened.

The file is trimmed to the newest KEEP entries once it grows past MAX_BYTES. Nothing here is sent to guests:
see GUEST_READ_PATHS in services/external.py.
"""
from __future__ import annotations

import json
import logging
import os
import threading
import uuid
from pathlib import Path
from typing import Any

log = logging.getLogger("omm.requests")

KEEP = 200  # entries shown in the monitor and kept after a trim
MAX_BYTES = 16 * 1024 * 1024
CONTENT_LIMIT = 64 * 1024  # characters kept of a request body / an answer
LONG_FIELD = 2048  # a string longer than this inside a request body (an image in base64, ...) is replaced by its size
READ_TAIL = MAX_BYTES + 1024 * 1024
META = ("id", "ts", "path", "model", "status", "outcome", "duration", "ttft", "tokens", "prompt_tokens", "client", "saved")


def shorten_request(body: bytes) -> str:
    """The request body as readable text: long strings (images) shrink to their size, the rest is cut to the limit."""
    text = body.decode("utf-8", "replace")
    try:
        obj = json.loads(text)
    except ValueError:
        return _cut(text)

    def walk(v: Any) -> Any:
        if isinstance(v, str):
            return f"[{len(v):,} characters]" if len(v) > LONG_FIELD else v
        if isinstance(v, list):
            return [walk(x) for x in v]
        if isinstance(v, dict):
            return {k: walk(x) for k, x in v.items()}
        return v

    return _cut(json.dumps(walk(obj), ensure_ascii=False, indent=2))


def answer_text(raw: bytes) -> str:
    """What the model said, put together from a streamed answer (lines of JSON, or server-sent events)."""
    text = raw.decode("utf-8", "replace")
    parts: list[str] = []
    seen = 0
    lines = [ln.strip() for ln in text.split("\n") if ln.strip()]
    for k, line in enumerate(lines):
        if line.startswith("data:"):
            line = line[5:].strip()
        if not line or line == "[DONE]":
            continue
        try:
            obj = json.loads(line)
        except ValueError:
            if k == len(lines) - 1 and parts:
                break  # the answer was cut inside its last line
            return _cut(text)  # not JSON lines: keep it as it came
        seen += 1
        if not isinstance(obj, dict):
            return _cut(text)
        piece = _piece(obj)
        if piece is not None:
            parts.append(piece)
    if parts:
        return _cut("".join(parts))
    if seen == 1:  # one object without text (embeddings, an error, ...)
        try:
            return _cut(json.dumps(json.loads(text), ensure_ascii=False, indent=2))
        except ValueError:
            pass
    return _cut(text)


def _piece(obj: dict[str, Any]) -> str | None:
    msg = obj.get("message")
    if isinstance(msg, dict) and isinstance(msg.get("content"), str):
        return msg["content"]
    if isinstance(obj.get("response"), str):
        return obj["response"]
    choices = obj.get("choices")
    if isinstance(choices, list) and choices and isinstance(choices[0], dict):
        c = choices[0]
        for key in ("delta", "message"):
            inner = c.get(key)
            if isinstance(inner, dict) and isinstance(inner.get("content"), str):
                return inner["content"]
        if isinstance(c.get("text"), str):
            return c["text"]
    return None


def _cut(text: str) -> str:
    if len(text) <= CONTENT_LIMIT:
        return text
    return text[:CONTENT_LIMIT] + f"\n[... {len(text) - CONTENT_LIMIT:,} more characters not kept]"


class RequestLog:
    def __init__(self, directory: Path):
        self.dir = directory
        self.dir.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()

    def path(self, iid: int) -> Path:
        return self.dir / f"requests-{iid}.jsonl"

    def add(self, iid: int, entry: dict[str, Any], request: str | None, response: str | None) -> None:
        entry = {"id": uuid.uuid4().hex[:12], **entry, "saved": request is not None}
        if request is not None:
            entry["request"], entry["response"] = request, response or ""
        line = json.dumps(entry, ensure_ascii=False, separators=(",", ":")) + "\n"
        p = self.path(iid)
        with self._lock:
            try:
                with open(p, "ab") as f:
                    f.write(line.encode("utf-8"))
                if p.stat().st_size > MAX_BYTES:
                    self._trim(p)
            except OSError:
                log.exception("Could not write the request journal")

    def _trim(self, p: Path) -> None:
        rows = self._tail(p, KEEP)
        tmp = p.with_suffix(".tmp")
        tmp.write_bytes(b"".join(json.dumps(r, ensure_ascii=False, separators=(",", ":")).encode("utf-8") + b"\n" for r in rows))
        os.replace(tmp, p)

    @staticmethod
    def _tail(p: Path, limit: int) -> list[dict[str, Any]]:
        """The newest `limit` entries, oldest first."""
        try:
            size = p.stat().st_size
            with open(p, "rb") as f:
                f.seek(max(0, size - READ_TAIL))
                data = f.read()
        except OSError:
            return []
        rows: list[dict[str, Any]] = []
        for ln in data.split(b"\n")[-(limit + 2):]:
            try:
                obj = json.loads(ln)
            except ValueError:
                continue  # a half line at the cut, or damage
            if isinstance(obj, dict):
                rows.append(obj)
        return rows[-limit:]

    def recent(self, iid: int, limit: int) -> list[dict[str, Any]]:
        """Newest first, without the saved content."""
        with self._lock:
            rows = self._tail(self.path(iid), min(limit, KEEP))
        return [{k: r.get(k) for k in META if k in r} for r in rows[::-1]]

    def entry(self, iid: int, rid: str) -> dict[str, Any] | None:
        with self._lock:
            rows = self._tail(self.path(iid), KEEP)
        for r in rows:
            if r.get("id") == rid:
                return r
        return None

    def delete(self, iid: int) -> None:
        with self._lock:
            self.path(iid).unlink(missing_ok=True)
