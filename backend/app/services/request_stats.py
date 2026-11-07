"""Per-minute request numbers, kept in SQLite so charts survive a restart.

Only counts and sums are stored (requests, errors, tokens, time) -- never prompts, answers or client details.
"""
from __future__ import annotations

import time
from typing import Any

from app.db import Database
from app.services.proxy import Record

KEEP_DAYS = 7


class RequestStats:
    def __init__(self, db: Database):
        self.db = db
        self.prune()

    def record(self, iid: int, rec: Record) -> None:
        ok = rec.ok
        self.db.execute(
            """INSERT INTO request_stats (instance_id, minute, requests, errors, cancelled, ok_requests, tokens, prompt_tokens, eval_ns, latency_sum)
               VALUES (?,?,1,?,?,?,?,?,?,?)
               ON CONFLICT(instance_id, minute) DO UPDATE SET
                 requests=requests+1, errors=errors+excluded.errors, cancelled=cancelled+excluded.cancelled,
                 ok_requests=ok_requests+excluded.ok_requests, tokens=tokens+excluded.tokens,
                 prompt_tokens=prompt_tokens+excluded.prompt_tokens, eval_ns=eval_ns+excluded.eval_ns,
                 latency_sum=latency_sum+excluded.latency_sum""",
            (iid, int(rec.ts // 60), int(rec.outcome == "error"), int(rec.outcome == "cancelled"), int(ok),
             rec.tokens or 0 if ok else 0, rec.prompt_tokens or 0 if ok else 0, rec.eval_ns or 0 if ok else 0,
             rec.latency if ok else 0.0),
        )

    def series(self, minutes: int, iid: int | None = None) -> list[dict[str, Any]]:
        """One entry per minute for the last `minutes` minutes (empty minutes included), oldest first."""
        now = int(time.time() // 60)
        first = now - minutes + 1
        sql = ("SELECT minute, SUM(requests) r, SUM(errors) e, SUM(cancelled) c, SUM(ok_requests) o, SUM(tokens) t, "
               "SUM(prompt_tokens) pt, SUM(eval_ns) ev, SUM(latency_sum) l FROM request_stats WHERE minute>=?")
        params: list[Any] = [first]
        if iid is not None:
            sql += " AND instance_id=?"
            params.append(iid)
        rows = {r["minute"]: r for r in self.db.query(sql + " GROUP BY minute", params)}
        out = []
        for m in range(first, now + 1):
            r = rows.get(m)
            out.append({
                "minute": m, "requests": r["r"] if r else 0, "errors": r["e"] if r else 0, "cancelled": r["c"] if r else 0,
                "tokens": r["t"] if r else 0, "prompt_tokens": r["pt"] if r else 0,
                "tok_per_s": r["t"] / (r["ev"] / 1e9) if r and r["ev"] else None,
                "latency_avg": r["l"] / r["o"] if r and r["o"] else None,
            })
        return out

    def delete_instance(self, iid: int) -> None:
        self.db.execute("DELETE FROM request_stats WHERE instance_id=?", (iid,))

    def prune(self) -> None:
        self.db.execute("DELETE FROM request_stats WHERE minute<?", (int(time.time() // 60) - KEEP_DAYS * 1440,))
