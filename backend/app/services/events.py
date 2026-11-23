"""What a server of the app did, in one place: the line in the log and the event the shell (and the page) can listen for on /ws.

The log line is what a person reads (the terminal shows it as `[backend] ...`); the event is the same fact for a program: {"type": "server", "name": "web" | "mcp",
"state": "started" | "stopped" | "failed", "urls": [...], "error": ..., "ts": ...}. They are made together so that they cannot say different things.
(The instances have their own events: "instance", the state of one, and "log", a line of the log screen: see InstanceManager.)
"""
from __future__ import annotations

import logging
import time
from typing import Any


def announce(hub: Any, logger: logging.Logger, name: str, state: str, text: str, *, urls: list[str] | None = None, error: str | None = None) -> None:
    logger.log(logging.WARNING if state == "failed" else logging.INFO, "%s", text)
    if hub is not None:
        hub.publish({"type": "server", "name": name, "state": state, "urls": urls or [], "error": error, "ts": time.time()})
