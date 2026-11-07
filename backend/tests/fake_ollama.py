"""Stand-in for `ollama serve`: /api/version, /api/ps, /api/tags, /api/pull, /api/delete,
plus an optional runner-like child process.

Env knobs: FAKE_CHILD=0 (no child), FAKE_PULL_DELAY=<seconds between pull progress lines, default 0.05>,
FAKE_GEN_DELAY=<seconds per generated token, default 0.02>, FAKE_EVENTS=<file that gets a line when a client hangs up mid-answer>.
"""
import json
import os
import signal
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LOCK = threading.Lock()
LAYER1, LAYER2 = "sha256:" + "1" * 64, "sha256:" + "2" * 64
MODELS = [{"name": "fake:1b", "model": "fake:1b", "size": 1_000_000, "digest": "sha256:aaa",
           "modified_at": "2026-01-01T00:00:00Z", "details": {"family": "fake", "parameter_size": "1B"}}]


class Handler(BaseHTTPRequestHandler):
    def _json(self, body, status=200):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n) or b"{}")

    def do_GET(self):
        if self.path == "/api/version":
            self._json({"version": "0.0.0-fake"})
        elif self.path == "/api/ps":
            self._json({"models": [{"name": "fake:1b", "size": 1_000_000, "size_vram": 800_000, "expires_at": "2099-01-01T00:00:00Z"}]})
        elif self.path == "/api/tags":
            with LOCK:
                self._json({"models": list(MODELS)})
        else:
            self.send_error(404)

    def do_DELETE(self):
        name = self._body().get("model")
        with LOCK:
            for m in MODELS:
                if m["name"] == name:
                    MODELS.remove(m)
                    return self._json({})
        self._json({"error": f"model '{name}' not found"}, 404)

    def do_POST(self):
        if self.path in ("/api/generate", "/api/chat"):
            return self._generate()
        if self.path == "/v1/chat/completions":
            return self._openai()
        if self.path != "/api/pull":
            return self.send_error(404)
        name = self._body().get("model", "")
        # Streamed ndjson, closed by the server (HTTP/1.0 style): no Content-Length.
        self.send_response(200)
        self.send_header("Content-Type", "application/x-ndjson")
        self.end_headers()
        send = lambda o: (self.wfile.write(json.dumps(o).encode() + b"\n"), self.wfile.flush())  # noqa: E731
        delay = float(os.environ.get("FAKE_PULL_DELAY", "0.05"))
        try:
            send({"status": "pulling manifest"})
            if name.startswith("bad"):
                return send({"error": "pull model manifest: file does not exist"})
            for step in range(1, 5):
                time.sleep(delay)
                send({"status": "pulling aaa", "digest": LAYER1, "total": 100, "completed": step * 25})
                send({"status": "pulling bbb", "digest": LAYER2, "total": 300, "completed": step * 75})
            with LOCK:
                if not any(m["name"] == name for m in MODELS):
                    MODELS.append({"name": name, "model": name, "size": 400, "digest": "sha256:" + name,
                                   "modified_at": "2026-01-02T00:00:00Z", "details": {}})
            send({"status": "success"})
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _openai(self):
        """OpenAI-style answer: only token counts in `usage` (no timings). Streams SSE when asked to."""
        req = self._body()
        n = int(req.get("max_tokens", 1))
        delay = float(os.environ.get("FAKE_GEN_DELAY", "0.02"))
        usage = {"prompt_tokens": 3, "completion_tokens": n, "total_tokens": 3 + n}
        if not req.get("stream"):
            time.sleep(delay * n)
            return self._json({"choices": [{"message": {"role": "assistant", "content": "hi"}}], "usage": usage})
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        try:
            for i in range(n):
                time.sleep(delay)
                self.wfile.write(b"data: " + json.dumps({"choices": [{"delta": {"content": f"t{i} "}}]}).encode() + b"\n\n")
                self.wfile.flush()
            if (req.get("stream_options") or {}).get("include_usage"):
                self.wfile.write(b"data: " + json.dumps({"choices": [], "usage": usage}).encode() + b"\n\n")
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _generate(self):
        """Streams `num_predict` tokens (default 5), then the final object with Ollama-style stats:
        eval_count = tokens, eval_duration = 1 s per 10 tokens (so the speed is always 10 tok/s)."""
        req = self._body()
        n = int((req.get("options") or {}).get("num_predict", 5))
        stream = req.get("stream", True)
        delay = float(os.environ.get("FAKE_GEN_DELAY", "0.02"))
        stats = {"done": True, "total_duration": 1, "prompt_eval_count": 3, "eval_count": n, "eval_duration": n * 100_000_000}
        chat = self.path == "/api/chat"
        token = lambda i: ({"message": {"role": "assistant", "content": f"t{i} "}} if chat else {"response": f"t{i} "})  # noqa: E731
        try:
            if not stream:
                time.sleep(delay * n)
                return self._json({**token(n), **stats})
            self.send_response(200)
            self.send_header("Content-Type", "application/x-ndjson")
            self.end_headers()
            for i in range(n):
                time.sleep(delay)
                self.wfile.write(json.dumps({**token(i), "done": False}).encode() + b"\n")
                self.wfile.flush()
            self.wfile.write(json.dumps({**token(n), **stats}).encode() + b"\n")
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            if os.environ.get("FAKE_EVENTS"):
                with open(os.environ["FAKE_EVENTS"], "a") as f:
                    f.write("client_gone\n")

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
    server = ThreadingHTTPServer((host, int(port)), Handler)
    server.daemon_threads = True

    def stop(*_):
        if child:
            child.terminate()
        os._exit(0)

    signal.signal(signal.SIGTERM, stop)
    server.serve_forever()


if __name__ == "__main__":
    main()
