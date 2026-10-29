#!/usr/bin/env python3
"""Tiny HTTP server that prints the observed client address for every request."""
import http.server, socketserver, sys, json, datetime

BIND = sys.argv[1] if len(sys.argv) > 1 else "127.0.0.1"
PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 19000

class H(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    def _handle(self):
        rec = {"client": self.client_address[0], "client_port": self.client_address[1],
               "host_header": self.headers.get("Host"), "path": self.path}
        print(json.dumps(rec), flush=True)
        body = json.dumps(rec).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    do_GET = _handle
    do_POST = _handle
    def log_message(self, *a): pass

class S(socketserver.ThreadingTCPServer):
    allow_reuse_address = True

with S((BIND, PORT), H) as httpd:
    print(f"listening on {BIND}:{PORT}", flush=True)
    httpd.serve_forever()
