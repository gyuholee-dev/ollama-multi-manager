"""Key-value settings stored as JSON text in the `settings` table."""
from __future__ import annotations

import json
import os
from typing import Any

from app.db import Database
from app.schemas import SettingsPatch


class SettingsError(ValueError):
    pass


class SettingsService:
    def __init__(self, db: Database):
        self.db = db

    def all(self) -> dict[str, Any]:
        return {r["key"]: json.loads(r["value"]) for r in self.db.query("SELECT key, value FROM settings")}

    def get(self, key: str) -> Any:
        row = self.db.one("SELECT value FROM settings WHERE key=?", (key,))
        return json.loads(row["value"]) if row else None

    def update(self, patch: SettingsPatch) -> dict[str, Any]:
        values = {k: getattr(patch, k) for k in patch.model_fields_set}
        exe = values.get("ollama_executable_path")
        if exe is not None and not (os.path.isfile(exe) and os.access(exe, os.X_OK)):
            raise SettingsError(f"ollama_executable_path is not an executable file: {exe}")
        for k, v in values.items():
            self.db.execute(
                "INSERT INTO settings(key, value) VALUES(?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value, "
                "updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')",
                (k, json.dumps(v)),
            )
        return self.all()
