#!/usr/bin/env python3
"""Deterministic loopback-only OpenAI fixture; no vendor credentials or chain writes."""
import argparse
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--name", required=True)
    args = parser.parse_args()
    count = 0
    lock = threading.Lock()
    model = f"{args.name}-model"

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass  # Request bodies, headers and credentials never enter logs.

        def send_json(self, body, status=200):
            data = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            if self.path == "/count":
                self.send_json({"requests": count, "name": args.name})
            elif self.path == "/v1/models":
                self.send_json({"object": "list", "data": [{"id": model, "object": "model", "owned_by": args.name}]})
            else:
                self.send_json({"error": "not found"}, 404)

        def do_POST(self):
            nonlocal count
            length = int(self.headers.get("Content-Length", "0"))
            if length > 65536:
                self.send_json({"error": "too large"}, 413)
                return
            try:
                body = json.loads(self.rfile.read(length))
            except (ValueError, UnicodeError):
                self.send_json({"error": "invalid JSON"}, 400)
                return
            if self.path != "/v1/chat/completions":
                self.send_json({"error": "not found"}, 404)
                return
            with lock:
                count += 1
                request_id = f"phase9-{args.name}-{count}"
            text = f"hello from {args.name}"
            if body.get("stream"):
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Connection", "close")
                self.end_headers()
                for chunk in [
                    {"id": request_id, "object": "chat.completion.chunk", "created": 1, "model": body.get("model", model), "choices": [{"index": 0, "delta": {"role": "assistant", "content": text}, "finish_reason": None}]},
                    {"id": request_id, "object": "chat.completion.chunk", "created": 1, "model": body.get("model", model), "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 5, "completion_tokens": 7, "total_tokens": 12}},
                ]:
                    self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode())
                self.wfile.write(b"data: [DONE]\n\n")
                self.wfile.flush()
                self.close_connection = True
            else:
                self.send_json({"id": request_id, "object": "chat.completion", "created": 1, "model": body.get("model", model), "choices": [{"index": 0, "message": {"role": "assistant", "content": text}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 5, "completion_tokens": 7, "total_tokens": 12}})

    ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
