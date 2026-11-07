"""Stand-in for `ollama serve`: answers /api/version and /api/ps, optionally spawns a runner-like child."""
import json
import os
import signal
import subprocess
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/api/version":
            body = {"version": "0.0.0-fake"}
        elif self.path == "/api/ps":
            body = {"models": [{"name": "fake:1b", "size": 1_000_000, "size_vram": 800_000, "expires_at": "2099-01-01T00:00:00Z"}]}
        else:
            self.send_error(404)
            return
        data = json.dumps(body).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *a):
        pass


def main() -> None:
    if sys.argv[1:2] != ["serve"]:
        sys.exit(2)
    host, _, port = os.environ["OLLAMA_HOST"].rpartition(":")
    child = None
    if os.environ.get("FAKE_CHILD") != "0":
        child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(600)"])
    print(f"fake ollama listening on {host}:{port} models={os.environ.get('OLLAMA_MODELS', '-')} ctx={os.environ.get('OLLAMA_CONTEXT_LENGTH')}", flush=True)
    server = HTTPServer((host, int(port)), Handler)

    def stop(*_):
        if child:
            child.terminate()
        os._exit(0)

    signal.signal(signal.SIGTERM, stop)
    server.serve_forever()


if __name__ == "__main__":
    main()
