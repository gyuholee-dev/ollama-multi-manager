"""`python -m app --port 8765` -- how Electron (or a developer) launches the backend."""
import argparse
import logging

import uvicorn

from app.main import create_app


def main() -> None:
    parser = argparse.ArgumentParser(prog="ollama-multi-manager-backend")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    uvicorn.run(create_app(), host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
