#!/usr/bin/env python3
"""起本地服务 → 无头 Chrome 截图 → 关服务。用于设计验收。"""

import functools
import http.server
import os
import socketserver
import subprocess
import threading
import time

ROOT = "/Users/gintmr/Downloads/Projects/Podcast-alphaXiv"
PORT = 8771
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
OUT = os.path.join(ROOT, "_work/tmp/shots2")

SHOTS = [
    ("m-controls", f"http://127.0.0.1:{PORT}/web/#/1706.03762", "880,2900", 2),
    ("m-sleep",    f"http://127.0.0.1:{PORT}/web/?sleep=1#/1706.03762", "880,1800", 2),
    ("d-player",   f"http://127.0.0.1:{PORT}/web/?mode=both#/1706.03762", "1440,1450", 1),
]


def serve() -> socketserver.ThreadingTCPServer:
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT)
    socketserver.ThreadingTCPServer.allow_reuse_address = True
    httpd = socketserver.ThreadingTCPServer(("127.0.0.1", PORT), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    time.sleep(0.6)
    return httpd


def shoot(name: str, url: str, size: str, dsf: int = 1) -> None:
    profile = f"/tmp/chrome-shot-{name}"
    args = [
        CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars",
        "--no-first-run", "--no-default-browser-check",
        f"--user-data-dir={profile}",
        f"--window-size={size}",
        f"--force-device-scale-factor={dsf}",
        "--virtual-time-budget=3500",
        f"--screenshot={OUT}/{name}.png",
    ]
    args.append(url)
    try:
        subprocess.run(args, check=False, capture_output=True, timeout=30)
    except subprocess.TimeoutExpired:
        print(f"  {name}: 超时，已放弃")
    print(f"  {name}: {'已生成' if os.path.exists(f'{OUT}/{name}.png') else '无输出'}")


def main() -> int:
    os.makedirs(OUT, exist_ok=True)
    httpd = serve()
    print(f"server on :{PORT}, root={ROOT}")
    # 预热：首次启动 Chrome 要建 profile，容易超时
    try:
        subprocess.run(
            [CHROME, "--headless=new", "--disable-gpu", "--no-first-run",
             "--user-data-dir=/tmp/chrome-shot-warm", "--window-size=800,600",
             "--screenshot=/tmp/warm.png", f"http://127.0.0.1:{PORT}/web/"],
            check=False, capture_output=True, timeout=45)
        print("  warmup: done")
    except subprocess.TimeoutExpired:
        print("  warmup: 超时（继续）")
    for name, url, size, dsf in SHOTS:
        shoot(name, url, size, dsf)
    httpd.shutdown()
    print("done ->", OUT)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
