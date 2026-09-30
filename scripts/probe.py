#!/usr/bin/env python3
"""本地服务 + 无头 Chrome 诊断：探针把结果 POST 回来，服务端打印。"""

import functools
import http.server
import os
import socketserver
import subprocess
import threading
import time

ROOT = "/Users/gintmr/Downloads/Projects/Podcast-alphaXiv"
PORT = 8768
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
URL = f"http://127.0.0.1:{PORT}/web/?debug=1&mode=both#/1706.03762"


class Handler(http.server.SimpleHTTPRequestHandler):
    def do_POST(self):
        if self.path != "/__probe":
            self.send_response(404)
            self.end_headers()
            return
        n = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(n).decode("utf-8", "replace")
        print("PROBE>>>")
        print(body)
        print("<<<PROBE")
        self.send_response(204)
        self.end_headers()

    def log_message(self, *args):
        pass


def main() -> int:
    handler = functools.partial(Handler, directory=ROOT)
    socketserver.ThreadingTCPServer.allow_reuse_address = True
    srv = socketserver.ThreadingTCPServer(("127.0.0.1", PORT), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    time.sleep(0.6)

    proc = subprocess.Popen(
        [CHROME, "--headless=new", "--disable-gpu", "--no-first-run",
         "--user-data-dir=/tmp/chrome-probe2", "--window-size=430,1500",
         URL],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    time.sleep(18)
    proc.kill()
    srv.shutdown()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
