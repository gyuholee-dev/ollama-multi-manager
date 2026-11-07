"""In-process pub/sub. Slow subscribers lose their oldest messages instead of blocking publishers."""
from __future__ import annotations

import asyncio
from typing import Any


class Hub:
    def __init__(self) -> None:
        self._subs: set[asyncio.Queue] = set()

    def subscribe(self, maxsize: int = 200) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=maxsize)
        self._subs.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        self._subs.discard(q)

    def publish(self, msg: dict[str, Any]) -> None:
        for q in list(self._subs):
            if q.full():
                try:
                    q.get_nowait()
                except asyncio.QueueEmpty:
                    pass
            q.put_nowait(msg)
