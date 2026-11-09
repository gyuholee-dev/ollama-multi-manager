"""Paths and process-wide constants."""
from __future__ import annotations

import os
import sys
from pathlib import Path

APP_DIR_NAME = "ollama-multi-manager"
FIRST_INSTANCE_PORT = 11435  # 11434 is left to the user's own Ollama


def default_data_dir() -> Path:
    """Per-user data directory. OMM_DATA_DIR overrides it (tests, portable installs)."""
    override = os.environ.get("OMM_DATA_DIR")
    if override:
        return Path(override).expanduser()
    if sys.platform == "darwin":
        base = Path.home() / "Library" / "Application Support"
    elif sys.platform == "win32":
        base = Path(os.environ.get("APPDATA") or Path.home() / "AppData" / "Roaming")
    else:
        base = Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share")
    return base / APP_DIR_NAME


def cors_origins() -> list[str]:
    raw = os.environ.get("OMM_CORS_ORIGINS", "http://127.0.0.1:5174,http://localhost:5174")
    return [o.strip() for o in raw.split(",") if o.strip()]

# The UI is one bundled script, one stylesheet and a bundled font: nothing is loaded from elsewhere, and nothing is evaluated.
# Inline styles are allowed because the UI sets some style attributes; connect-src covers the API and the live WebSocket.
CSP = ("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; "
       "connect-src 'self' ws: wss:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'")
