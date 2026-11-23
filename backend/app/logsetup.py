"""The log of the backend, by the usual rule: everything goes to a file, and the terminal shows only info, warnings and errors.

  file      <data folder>/logs/backend.log, a new file at midnight (the old ones are backend.log.YYYY-MM-DD); every level, with the level in each line
  terminal  stdout: "2026-11-23T08:33:20.687Z [backend] MCP server served at ..." (a warning or an error has its level after the name)

Electron starts the backend with its output piped, prints it as it is and prunes the files (30 days, none in developer mode: see electron/logger.js), so
the lines have the same look as the ones of the main process. OMM_LOG_LEVEL (debug, info, warn, error) changes what the terminal shows, never the file.
"""
from __future__ import annotations

import logging
import logging.handlers
import os
import sys
import time
from pathlib import Path

NAME = "backend"
LEVELS = {"debug": logging.DEBUG, "info": logging.INFO, "warn": logging.WARNING, "warning": logging.WARNING, "error": logging.ERROR}
# These say nothing a person needs (the collector asks the instances every few seconds), and they would be most of the file.
QUIET = ("httpx", "httpcore")


def _iso(record: logging.LogRecord) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(record.created)) + f".{int(record.msecs):03d}Z"


class FileFormatter(logging.Formatter):
    """2026-11-23T08:33:20.687Z INFO  [backend] text: the level is always in a line of the file."""

    def format(self, record: logging.LogRecord) -> str:
        text = f"{_iso(record)} {record.levelname.ljust(5)} [{NAME}] {record.getMessage()}"
        if record.exc_info and not record.exc_text:
            record.exc_text = self.formatException(record.exc_info)
        return f"{text}\n{record.exc_text}" if record.exc_text else text


class TerminalFormatter(FileFormatter):
    """2026-11-23T08:33:20.687Z [backend] text; a level after the name only when it is not info."""

    def format(self, record: logging.LogRecord) -> str:
        level = "" if record.levelno == logging.INFO else f" {record.levelname}"
        text = f"{_iso(record)} [{NAME}]{level} {record.getMessage()}"
        if record.exc_info and not record.exc_text:
            record.exc_text = self.formatException(record.exc_info)
        return f"{text}\n{record.exc_text}" if record.exc_text else text


def terminal_level(env: dict[str, str] | None = None) -> int:
    return LEVELS.get(str((env if env is not None else os.environ).get("OMM_LOG_LEVEL", "")).lower(), logging.INFO)


def setup_logging(log_dir: Path | None, stream=None, env: dict[str, str] | None = None) -> None:
    """Replaces the handlers of the root logger: the file (every level) and the terminal (info and above). Safe to call again."""
    root = logging.getLogger()
    for handler in list(root.handlers):
        root.removeHandler(handler)
        handler.close()
    root.setLevel(logging.DEBUG)
    terminal = logging.StreamHandler(stream or sys.stdout)
    terminal.setLevel(terminal_level(env))
    terminal.setFormatter(TerminalFormatter())
    root.addHandler(terminal)
    if log_dir is not None:
        log_dir.mkdir(parents=True, exist_ok=True)
        # backupCount=0 keeps every file: which ones are too old is for the one that prunes (electron/logger.js), as for the other files of the folder
        file = logging.handlers.TimedRotatingFileHandler(log_dir / f"{NAME}.log", when="midnight", backupCount=0, encoding="utf-8", delay=True)
        file.setLevel(logging.DEBUG)
        file.setFormatter(FileFormatter())
        root.addHandler(file)
    for name in QUIET:
        logging.getLogger(name).setLevel(logging.WARNING)
    sys.excepthook = lambda kind, value, tb: logging.getLogger("omm").critical("Uncaught exception", exc_info=(kind, value, tb))


def url_list(host: str, port: int, suffix: str = "/", lan: str | None = None) -> list[str]:
    """Where a server that listens on `host` can be reached: this PC, and the LAN address when it listens on every address."""
    hosts = ["127.0.0.1", *([lan] if lan and lan != "127.0.0.1" else [])] if host in ("", "0.0.0.0", "::") else [host]
    return [f"http://{h}:{port}{suffix}" for h in hosts]


def served_urls(host: str, port: int, suffix: str = "/", lan: str | None = None) -> str:
    return " and ".join(url_list(host, port, suffix, lan))
