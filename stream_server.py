#!/usr/bin/env python3
"""Minimal range-capable HTTP server for streaming one video file to VLC/TV.
Usage: python3 stream_server.py <file> [port]
Serves the file at /movie.mkv with HTTP Range support (seeking works)."""
import os
import sys
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

FILE = sys.argv[1]
PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 8000
SIZE = os.path.getsize(FILE)
CTYPE = "video/x-matroska"
RANGE_RE = re.compile(r"bytes=(\d*)-(\d*)")


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _common(self, start, length):
        self.send_header("Content-Type", CTYPE)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(length))

    def do_HEAD(self):
        self.send_response(200)
        self._common(0, SIZE)
        self.end_headers()

    def do_GET(self):
        rng = self.headers.get("Range")
        start, end = 0, SIZE - 1
        status = 200
        if rng:
            m = RANGE_RE.search(rng)
            if m:
                g1, g2 = m.group(1), m.group(2)
                if g1:
                    start = int(g1)
                    end = int(g2) if g2 else SIZE - 1
                else:  # suffix range: bytes=-N
                    start = max(0, SIZE - int(g2))
                    end = SIZE - 1
                status = 206
        start = max(0, start)
        end = min(end, SIZE - 1)
        length = end - start + 1

        self.send_response(status)
        if status == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{SIZE}")
        self._common(start, length)
        self.end_headers()

        try:
            with open(FILE, "rb") as f:
                f.seek(start)
                remaining = length
                chunk = 1024 * 1024
                while remaining > 0:
                    data = f.read(min(chunk, remaining))
                    if not data:
                        break
                    self.wfile.write(data)
                    remaining -= len(data)
        except (BrokenPipeError, ConnectionResetError):
            pass  # client seeked/closed; normal

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))


if __name__ == "__main__":
    srv = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    srv.daemon_threads = True
    print(f"Serving {FILE} ({SIZE} bytes) on 0.0.0.0:{PORT} as /movie.mkv", flush=True)
    srv.serve_forever()
