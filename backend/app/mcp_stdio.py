"""`python -m app.mcp_stdio` (or `python -m app mcp-stdio`): the MCP server over standard input and output, for a client that starts its MCP servers as
programs and talks to them through their stdin and stdout.

It is not a second server. The tools need the running app's own state (instances, readings, logs), so this is a bridge: what arrives on stdin is
passed to the app's MCP server over HTTP (with the MCP token), what that answers is written to stdout. The app has to be running with its MCP server
switched on, and what the client may do is what the settings allow (the control and the screenshot switches work as they do for any client).

  OMM_MCP_TOKEN   the MCP token (required; an environment variable and not an argument, so that it is not in the process list)
  OMM_MCP_URL     the server's address (default http://127.0.0.1:9101/mcp)
"""
from __future__ import annotations

import argparse
import os
import sys
from typing import Any

import anyio
import httpx2
from mcp.client.streamable_http import streamable_http_client
from mcp.server.stdio import stdio_server

DEFAULT_URL = "http://127.0.0.1:9101/mcp"


async def pump(source: Any, sink: Any) -> None:
    """Moves messages from one stream to the other until the source ends. A message that could not be read is not passed on."""
    async for item in source:
        if isinstance(item, Exception):
            print(f"mcp-stdio: skipped a message that could not be read: {item}", file=sys.stderr)
            continue
        await sink.send(item)


async def bridge(url: str, token: str, stdin: Any = None, stdout: Any = None) -> None:
    """Runs until the client closes stdin or the server closes the connection."""
    http = httpx2.AsyncClient(headers={"Authorization": f"Bearer {token}"})
    async with http, streamable_http_client(url, http_client=http) as (from_server, to_server), stdio_server(stdin, stdout) as (from_client, to_client):
        async with anyio.create_task_group() as tasks:
            async def up() -> None:
                await pump(from_client, to_server)
                tasks.cancel_scope.cancel()  # the client is gone: close the session

            async def down() -> None:
                await pump(from_server, to_client)
                tasks.cancel_scope.cancel()

            tasks.start_soon(up)
            tasks.start_soon(down)


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="mcp-stdio", description="MCP over stdio, bridged to the running app's MCP server")
    parser.add_argument("--url", default=os.environ.get("OMM_MCP_URL") or DEFAULT_URL, help=f"the MCP server's address (default {DEFAULT_URL})")
    args = parser.parse_args(argv)
    token = os.environ.get("OMM_MCP_TOKEN", "")
    if not token:
        print("mcp-stdio: set OMM_MCP_TOKEN to the MCP token shown in the app's settings", file=sys.stderr)
        raise SystemExit(2)
    try:
        anyio.run(bridge, args.url, token)
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
