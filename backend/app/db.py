"""SQLite access. One shared connection guarded by a lock; queries here are tiny."""
from __future__ import annotations

import sqlite3
import threading
from pathlib import Path
from typing import Any, Iterable

SCHEMA_PATH = Path(__file__).resolve().parent.parent / "schema.sql"
SCHEMA_VERSION = 4


class Database:
    def __init__(self, path: Path | str):
        self._lock = threading.RLock()
        self._conn = sqlite3.connect(str(path), check_same_thread=False, isolation_level=None)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")

    def migrate(self) -> None:
        """Apply schema.sql (idempotent), then the data migrations an older database still needs, and record the version."""
        with self._lock:
            old = self._conn.execute("PRAGMA user_version").fetchone()[0]
            self._conn.executescript(SCHEMA_PATH.read_text(encoding="utf-8"))
            if 0 < old < 2:
                # v2: the old "external monitoring" (on by default, only /metrics) became "web access", which serves the web UI. A
                # database that predates this would silently open the UI to the network: switch it off once.
                self._conn.execute("UPDATE settings SET value='false' WHERE key='external_monitoring_enabled'")
                self._conn.execute("DELETE FROM settings WHERE key='external_monitoring_web'")
            if 0 < old < 3:
                # v3: the MCP server has no "this PC only" mode any more (its token is what stands guard); the setting is gone
                self._conn.execute("DELETE FROM settings WHERE key='mcp_lan'")
            if 0 < old < 4:
                # v4: the MCP screenshot tool has no switch of its own any more: it is offered wherever the app can take a picture
                self._conn.execute("DELETE FROM settings WHERE key='mcp_screenshot'")
            self._conn.execute(f"PRAGMA user_version={SCHEMA_VERSION}")

    def query(self, sql: str, params: Iterable[Any] = ()) -> list[sqlite3.Row]:
        with self._lock:
            return self._conn.execute(sql, tuple(params)).fetchall()

    def one(self, sql: str, params: Iterable[Any] = ()) -> sqlite3.Row | None:
        rows = self.query(sql, params)
        return rows[0] if rows else None

    def execute(self, sql: str, params: Iterable[Any] = ()) -> sqlite3.Cursor:
        with self._lock:
            return self._conn.execute(sql, tuple(params))

    def close(self) -> None:
        with self._lock:
            self._conn.close()
