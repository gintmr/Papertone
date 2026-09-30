#!/usr/bin/env python3
"""本地服务：静态站点 + 抓取 API。

为什么抓取必须跑在本地而不能放在网页里：
  alphaXiv 的 feed 接口 CORS 只放行 https://www.alphaxiv.org，
  浏览器从我们的站点跨域调用会被拦掉；而 ASR 对齐要跑 ffmpeg 和语音模型，
  浏览器也做不了。所以「扫描 + 抓取」由这个本地服务承担，
  网页只负责点按钮、显示列表、上报进度。

  （播客 CDN 是 access-control-allow-origin: *，音频本身可以跨域取，
   但光有音频没法确定要抓哪些论文——候选名单只能从 feed 拿。）

用法：
    python3 scripts/serve.py            # 默认 8765
    python3 scripts/serve.py --port 9000

接口：
    GET  /api/ping                    服务与库状态
    GET  /api/discover?days=30&pages=8&refresh=1
                                      扫描最近 N 天的 AI 论文，返回增量清单
    POST /api/import                   {ids:[], key:"", model:"", baseUrl:""}
    GET  /api/job                     抓取进度
"""

from __future__ import annotations

import argparse
import functools
import http.server
import json
import os
import re
import socketserver
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126 Safari/537.36"
FEED = "https://api.alphaxiv.org/papers/v3/feed"
CDN = "https://paper-podcasts.alphaxiv.org"
CACHE = os.path.join(ROOT, "_work", "cache")
RANGE_RE = re.compile(r"bytes=(\d*)-(\d*)")

AI_CATS = {"cs.AI", "cs.LG", "cs.CL", "cs.CV", "cs.NE", "cs.MA", "cs.RO",
           "cs.IR", "cs.SD", "cs.HC", "stat.ML", "eess.AS"}
AI_TAGS = {"agents", "agentic-frameworks", "transformers", "efficient-transformers",
           "reasoning", "llm", "large-language-models", "reinforcement-learning",
           "deep-reinforcement-learning", "tool-use", "meta-learning",
           "continual-learning", "vision-language-models", "multi-agent-learning",
           "human-ai-interaction", "ai-for-health", "alignment", "rag",
           "fine-tuning", "data-curation", "model-interpretation"}

# 浏览量门槛随论文年龄放宽：刚上线三天 300 浏览，和上线三周 500 浏览，
# 含金量完全不同。用「浏览量 / 年龄」而不是单一绝对阈值。
VIEW_RULES = [(7, 300), (14, 400), (30, 500)]

STATE = {"job": None}


# ────────────────────────── 抓取逻辑 ──────────────────────────

def fetch(url: str, timeout: int = 45, method: str = "GET", data: bytes | None = None,
          headers: dict | None = None) -> tuple[int, bytes]:
    """注意别把这个函数叫 http —— 会覆盖上面 import 的 http.server 模块。"""
    h = {"User-Agent": UA}
    if headers:
        h.update(headers)
    req = urllib.request.Request(url, data=data, headers=h, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as exc:
        return exc.code, b""
    except Exception:
        return 0, b""


def is_ai(paper: dict) -> bool:
    t = set(paper.get("topics") or [])
    return bool(t & AI_CATS) or bool(t & AI_TAGS)


def has_podcast(group_id: str) -> bool:
    code, _ = fetch(f"{CDN}/{group_id}/podcast.mp3", timeout=15,
                    headers={"Range": "bytes=0-100"})
    return code == 206


def age_days(paper: dict, now: datetime) -> float | None:
    try:
        pub = datetime.fromisoformat(paper["publication_date"].replace("Z", "+00:00"))
    except Exception:
        return None
    return (now - pub).total_seconds() / 86400


def views_of(paper: dict) -> int:
    return ((paper.get("metrics") or {}).get("visits_count") or {}).get("all", 0) or 0


def match_tier(paper: dict, now: datetime) -> int | None:
    """返回命中的档位天数（7 / 14 / 30），都不命中返回 None。

    三档是「或」的关系，先命中哪档就按哪档判，**不累加**：
    一篇 7 天以内的论文只要超过 300 就通过，不会被再要求 500。
    这正是分级的用意——短时间冲到 300 就说明它有价值。
    """
    age = age_days(paper, now)
    if age is None:
        return None
    v = views_of(paper)
    for limit_days, min_views in VIEW_RULES:
        if age <= limit_days:
            return limit_days if v > min_views else None
    return None


def existing_ids() -> set[str]:
    out = set()
    data = os.path.join(ROOT, "data")
    if not os.path.isdir(data):
        return out
    for name in os.listdir(data):
        if os.path.exists(os.path.join(data, name, "episode.json")):
            out.add(name)
    return out


def fetch_feed(days: int, pages: int, sort: str = "Views") -> list[dict]:
    out = []
    for p in range(1, pages + 1):
        url = (f"{FEED}?pageNum={p}&pageSize=100&sort={sort}"
               f"&interval={days}%20Days&linkBlogs=true&topics=%5B%5D")
        code, body = fetch(url, timeout=60)
        if code != 200:
            break
        try:
            papers = json.loads(body).get("papers") or []
        except Exception:
            break
        out += papers
        if len(papers) < 100:
            break
        time.sleep(0.2)
    return out


def scan(days: int, pages: int, refresh: bool, probe_limit: int,
         apply_threshold: bool = True) -> dict:
    os.makedirs(CACHE, exist_ok=True)
    cache_file = os.path.join(CACHE,
                              f"discover-{days}d-{pages}p{'-t' if apply_threshold else ''}.json")
    if not refresh and os.path.exists(cache_file):
        age = time.time() - os.path.getmtime(cache_file)
        if age < 1800:
            with open(cache_file, encoding="utf-8") as fh:
                return json.load(fh)

    papers = fetch_feed(days, pages)
    ai = [p for p in papers if is_ai(p)]
    ai_before = len(ai)
    tiers: dict[str, int] = {}
    now = datetime.now(timezone.utc)
    if apply_threshold:
        kept = []
        for p in ai:
            tier = match_tier(p, now)
            if tier is not None:
                p["_tier"] = tier          # 记录命中档位，面板上直接显示
                kept.append(p)
                tiers[str(tier)] = tiers.get(str(tier), 0) + 1
        ai = kept
    known = existing_ids()
    todo = [p for p in ai if p.get("universal_paper_id") not in known]

    # 热度高的在前，探测到上限就停——播客覆盖率本来就在 1000 篇之后归零
    todo = todo[:probe_limit]
    found: list[dict] = []
    if todo:
        with ThreadPoolExecutor(max_workers=6) as pool:
            flags = list(pool.map(lambda p: has_podcast(p["paper_group_id"]), todo))
        for p, ok in zip(todo, flags):
            if not ok:
                continue
            found.append({
                "id": p.get("universal_paper_id"),
                "title": p.get("title"),
                "authors": (p.get("authors") or [])[:4],
                "group_id": p.get("paper_group_id"),
                "published": (p.get("publication_date") or "")[:10],
                "views": ((p.get("metrics") or {}).get("visits_count") or {}).get("all", 0),
                "topics": p.get("topics") or [],
                "tier": p.get("_tier"),
                "age_days": round(age_days(p, now) or 0, 1),
            })

    result = {
        "scanned_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "days": days,
        "pages": pages,
        "feed_papers": len(papers),
        "ai_papers": len(ai),
        "ai_before_threshold": ai_before,
        "threshold_applied": apply_threshold,
        "tier_counts": tiers,
        "already_in_library": len(known),
        "probed": len(todo),
        "new": found,
    }
    with open(cache_file, "w", encoding="utf-8") as fh:
        json.dump(result, fh, ensure_ascii=False, indent=2)
    return result


def run(cmd: list[str], log: list[str], env: dict | None = None) -> int:
    log.append("$ " + " ".join(os.path.basename(c) if i < 3 else c
                               for i, c in enumerate(cmd)))
    # env 必须显式往下传：子进程要靠它拿到 HF_HOME，否则语音模型会被下到
    # ~/.cache/huggingface，而不是项目里的 _work/hf
    proc = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, env=env)
    for line in (proc.stdout + proc.stderr).splitlines():
        if line.strip():
            log.append("  " + line.strip()[:200])
    return proc.returncode


def import_job(ids: list[str], key: str, model: str, base_url: str, tmodel: str) -> None:
    log: list[str] = []
    job = STATE["job"] = {"state": "running", "done": 0, "total": len(ids),
                          "log": log, "current": None, "failed": []}
    py = sys.executable
    scripts = os.path.join(ROOT, "scripts")
    env = dict(os.environ, HF_HOME=os.path.join(ROOT, "_work", "hf"))
    for i, aid in enumerate(ids, 1):
        job.update(current=aid, done=i - 1)
        log.append(f"\n▶ {aid}  ({i}/{len(ids)})")
        d = os.path.join(ROOT, "data", aid)
        rc = run([py, os.path.join(scripts, "add_episode.py"), aid,
                  "--model", model, "--no-index"], log, env)
        if rc != 0:
            job["failed"].append(aid)
            continue
        run([py, os.path.join(scripts, "translate.py"), "--dir", d, "--key", key,
             "--model", tmodel, "--base-url", base_url], log)
        run([py, os.path.join(scripts, "build_episode.py"),
             "--meta", os.path.join(d, "meta.json"),
             "--segments", os.path.join(d, "segments.json"),
             "--zh", os.path.join(d, "transcript.zh.json"),
             "--out", os.path.join(d, "episode.json")], log)
    job.update(done=len(ids), current=None)
    run([py, os.path.join(scripts, "add_episode.py"), "--reindex-only"], log)
    job["state"] = "done"
    log.append(f"\n完成：成功 {len(ids) - len(job['failed'])} / {len(ids)}")


# ────────────────────────── HTTP 层 ──────────────────────────

class Handler(http.server.SimpleHTTPRequestHandler):
    # —— Range 支持：标准库 http.server 没有，而 GitHub Pages 有，
    #    本地不补上会导致「测出来的拖动行为和线上不一致」 ——
    def send_head(self):
        path = self.translate_path(self.path)
        if os.path.isdir(path):
            return super().send_head()
        try:
            fh = open(path, "rb")
        except OSError:
            self.send_error(404, "File not found")
            return None
        size = os.fstat(fh.fileno()).st_size
        ctype = self.guess_type(path)
        raw = self.headers.get("Range")
        m = RANGE_RE.fullmatch(raw.strip()) if raw else None
        if not m:
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(size))
            self.send_header("Accept-Ranges", "bytes")
            self.end_headers()
            return fh
        start_s, end_s = m.group(1), m.group(2)
        if start_s:
            start = int(start_s)
            end = int(end_s) if end_s else size - 1
        else:
            start = max(0, size - int(end_s or 0))
            end = size - 1
        if start >= size or start > end:
            fh.close()
            self.send_response(416)
            self.send_header("Content-Range", f"bytes */{size}")
            self.end_headers()
            return None
        end = min(end, size - 1)
        self.send_response(206)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Content-Length", str(end - start + 1))
        self.send_header("Accept-Ranges", "bytes")
        self.end_headers()
        fh.seek(start)
        self._range_left = end - start + 1
        return fh

    def copyfile(self, source, outputfile):
        left = getattr(self, "_range_left", None)
        if left is None:
            return super().copyfile(source, outputfile)
        while left > 0:
            chunk = source.read(min(64 * 1024, left))
            if not chunk:
                break
            outputfile.write(chunk)
            left -= len(chunk)
        self._range_left = None

    # —— API ——
    def _json(self, obj, code: int = 200):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(parsed.query)
        if parsed.path == "/api/ping":
            return self._json({"ok": True, "library": len(existing_ids()),
                               "job": (STATE["job"] or {}).get("state")})
        if parsed.path == "/api/job":
            return self._json(STATE["job"] or {"state": "idle", "done": 0, "total": 0, "log": []})
        if parsed.path == "/api/discover":
            try:
                res = scan(int(q.get("days", ["30"])[0]),
                           int(q.get("pages", ["8"])[0]),
                           q.get("refresh", ["0"])[0] == "1",
                           int(q.get("probeLimit", ["500"])[0]),
                           q.get("threshold", ["1"])[0] != "0")
                return self._json(res)
            except Exception as exc:
                return self._json({"error": str(exc)}, 500)
        return super().do_GET()

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path != "/api/import":
            return self.send_error(404)
        n = int(self.headers.get("Content-Length", 0))
        try:
            payload = json.loads(self.rfile.read(n).decode() or "{}")
        except Exception:
            return self._json({"error": "invalid json"}, 400)
        ids = [i for i in (payload.get("ids") or []) if i]
        key = (payload.get("key") or "").strip()
        if not ids:
            return self._json({"error": "没有要抓取的论文"}, 400)
        if STATE["job"] and STATE["job"].get("state") == "running":
            return self._json({"error": "已有任务在跑"}, 409)
        threading.Thread(
            target=import_job,
            args=(ids, key,
                  payload.get("asrModel") or "tiny",
                  payload.get("baseUrl") or "https://api.openai.com/v1",
                  payload.get("model") or "gpt-4o-mini"),
            daemon=True,
        ).start()
        return self._json({"started": True, "total": len(ids)})

    def log_message(self, fmt, *args):
        if self.path.startswith("/api/"):
            sys.stderr.write(f"  API {self.command} {self.path}\n")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--bind", default="0.0.0.0")
    ap.add_argument("--root", default=ROOT)
    args = ap.parse_args()
    socketserver.ThreadingTCPServer.allow_reuse_address = True
    handler = functools.partial(Handler, directory=args.root)
    with socketserver.ThreadingTCPServer((args.bind, args.port), handler) as httpd:
        print("Papertone 本地服务")
        print(f"  站点      http://localhost:{args.port}/")
        print(f"  手机访问  http://<本机局域网IP>:{args.port}/")
        print(f"  库内集数  {len(existing_ids())}")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n已停止")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
