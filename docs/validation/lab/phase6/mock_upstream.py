#!/usr/bin/env python3
"""Deterministic OpenAI-compatible upstream for the phase-6 pricing experiments.

It never contacts a vendor. Token counts come from `lab_prompt_tokens`,
`lab_completion_tokens`, `lab_cached_tokens` and `lab_delay` in the request body,
so a call's cost is known before it is made. See README.md for the exact setup.

    python3 mock_upstream.py 19080
"""

import json
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        sys.stderr.write("mock " + (fmt % args) + "\n")

    def send_json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.endswith("/models"):
            return self.send_json(
                200,
                {
                    "object": "list",
                    "data": [
                        {
                            "id": "lab-model",
                            "object": "model",
                            "created": 0,
                            "owned_by": "lab",
                        }
                    ],
                },
            )
        return self.send_json(404, {"error": {"message": "not found"}})

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        body = json.loads(self.rfile.read(length) or b"{}")
        if not self.path.endswith("/chat/completions"):
            return self.send_json(404, {"error": {"message": "not found"}})

        prompt = int(body.get("lab_prompt_tokens", 1000))
        completion = int(body.get("lab_completion_tokens", 100))
        cached = int(body.get("lab_cached_tokens", 0))
        delay = float(body.get("lab_delay", 0))
        model = body.get("model", "lab-model")
        usage = {
            "prompt_tokens": prompt,
            "completion_tokens": completion,
            "total_tokens": prompt + completion,
        }
        if cached:
            usage["prompt_tokens_details"] = {"cached_tokens": cached}
        if delay:
            time.sleep(delay)

        if body.get("stream"):
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "close")
            self.end_headers()

            def event(obj):
                self.wfile.write(("data: " + json.dumps(obj) + "\n\n").encode())
                self.wfile.flush()

            event(
                {
                    "id": "chatcmpl-lab",
                    "object": "chat.completion.chunk",
                    "created": 0,
                    "model": model,
                    "choices": [
                        {
                            "index": 0,
                            "delta": {"role": "assistant", "content": ""},
                            "finish_reason": None,
                        }
                    ],
                }
            )
            event(
                {
                    "id": "chatcmpl-lab",
                    "object": "chat.completion.chunk",
                    "created": 0,
                    "model": model,
                    "choices": [
                        {
                            "index": 0,
                            "delta": {"content": "lab"},
                            "finish_reason": None,
                        }
                    ],
                }
            )
            event(
                {
                    "id": "chatcmpl-lab",
                    "object": "chat.completion.chunk",
                    "created": 0,
                    "model": model,
                    "choices": [
                        {
                            "index": 0,
                            "delta": {},
                            "finish_reason": "stop",
                        }
                    ],
                    "usage": usage,
                }
            )
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()
            self.close_connection = True
            return

        return self.send_json(
            200,
            {
                "id": "chatcmpl-lab",
                "object": "chat.completion",
                "created": 0,
                "model": model,
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": "lab"},
                        "finish_reason": "stop",
                    }
                ],
                "usage": usage,
            },
        )


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 19080
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
