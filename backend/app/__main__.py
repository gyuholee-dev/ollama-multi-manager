"""`python -m app --port 8765` -- how Electron (or a developer) launches the backend."""
import argparse
import sys

import uvicorn

from app.config import default_data_dir
from app.logsetup import setup_logging
from app.main import create_app


def main() -> None:
    if len(sys.argv) > 1 and sys.argv[1] == "mcp-stdio":  # the MCP server over stdio (a bridge to the running app), also from the packaged build
        from app.mcp_stdio import main as stdio

        return stdio(sys.argv[2:])
    parser = argparse.ArgumentParser(prog="ollama-multi-manager-backend")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    setup_logging(default_data_dir() / "logs")
    app = create_app()
    server = uvicorn.Server(uvicorn.Config(app, host=args.host, port=args.port, log_level="info", log_config=None))  # (no log_config: uvicorn's lines go through the app's handlers)
    app.state.request_shutdown = lambda: setattr(server, "should_exit", True)
    server.run()


if __name__ == "__main__":
    main()
