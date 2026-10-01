#!/usr/bin/env python3
"""扫描 alphaXiv 推荐流，找出「有播客但还没入库」的论文。

抽成独立脚本是为了两边共用：
  - scripts/serve.py        本地服务，网页点按钮时调用
  - .github/workflows/sync.yml  GitHub Actions，纯云端定时/手动触发

用法：
    python3 scripts/discover.py --days 30 --pages 8            # 打印清单
    python3 scripts/discover.py --days 30 --ids-only           # 只打印 id，方便 shell 用
    python3 scripts/discover.py --days 30 --out _work/new.json
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126 Safari/537.36"
FEED = "https://api.alphaxiv.org/papers/v3/feed"
CDN = "https://paper-podcasts.alphaxiv.org"

AI_CATS = {"cs.AI", "cs.LG", "cs.CL", "cs.CV", "cs.NE", "cs.MA", "cs.RO",
           "cs.IR", "cs.SD", "cs.HC", "stat.ML", "eess.AS"}
AI_TAGS = {"agents", "agentic-frameworks", "transformers", "efficient-transformers",
           "reasoning", "llm", "large-language-models", "reinforcement-learning",
           "deep-reinforcement-learning", "tool-use", "meta-learning",
           "continual-learning", "vision-language-models", "multi-agent-learning",
           "human-ai-interaction", "ai-for-health", "alignment", "rag",
           "fine-tuning", "data-curation", "model-interpretation"}

# 浏览量门槛按论文年龄分档。四档是「或」的关系，按天数从小到大命中即止、不累加：
# 3 天以内超过 150 就通过，不会再被要求 300。
#
# 为什么门槛随年龄下降：浏览量是累计值，会随年龄迅速趋于平台期。
# 实测近 30 天推荐流里 394 篇「有播客」论文的「浏览量 ÷ 天数」中位数：
#     0-1 天 352/天 · 1-2 天 80 · 2-3 天 74 · 3-5 天 52
#     5-7 天  34/天 · 7-14 天 14 · 14-30 天 6~12
# 也就是说一篇 3 天 200 浏览（≈67/天）比一篇 25 天 500 浏览（≈20/天）热得多。
# 所以「越新的论文要求越高的速度」才自洽。下面每档折算成速度：
#     3 天 150 ≈ 50/天 · 7 天 250 ≈ 36/天 · 14 天 350 ≈ 25/天 · 30 天 450 ≈ 15/天
# 单调递减，而且各档大约都落在同年龄段的前 10~20%。
VIEW_RULES = [(3, 150), (7, 250), (14, 350), (30, 450)]


def fetch(url: str, timeout: int = 45, headers: dict | None = None) -> tuple[int, bytes]:
    h = {"User-Agent": UA}
    if headers:
        h.update(headers)
    req = urllib.request.Request(url, headers=h)
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
    """返回命中的档位天数（3 / 7 / 14 / 30），都不命中返回 None。"""
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
    out: list[dict] = []
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


def scan(days: int = 30, pages: int = 8, probe_limit: int = 600,
         apply_threshold: bool = True, workers: int = 6) -> dict:
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
                p["_tier"] = tier
                kept.append(p)
                tiers[str(tier)] = tiers.get(str(tier), 0) + 1
        ai = kept

    known = existing_ids()
    todo = [p for p in ai if p.get("universal_paper_id") not in known][:probe_limit]

    found: list[dict] = []
    if todo:
        with ThreadPoolExecutor(max_workers=workers) as pool:
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
                "views": views_of(p),
                "topics": p.get("topics") or [],
                "tier": p.get("_tier"),
                "age_days": round(age_days(p, now) or 0, 1),
            })
    return {
        "scanned_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "days": days, "pages": pages,
        "feed_papers": len(papers),
        "ai_papers": len(ai),
        "ai_before_threshold": ai_before,
        "threshold_applied": apply_threshold,
        "tier_counts": tiers,
        "already_in_library": len(known),
        "probed": len(todo),
        "new": found,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=30)
    ap.add_argument("--pages", type=int, default=8)
    ap.add_argument("--probe-limit", type=int, default=600)
    ap.add_argument("--no-threshold", action="store_true")
    ap.add_argument("--out")
    ap.add_argument("--ids-only", action="store_true",
                    help="只打印 arXiv id（空格分隔），方便 shell 直接拼命令")
    ap.add_argument("--limit", type=int, default=0, help="最多输出多少条")
    args = ap.parse_args()

    res = scan(args.days, args.pages, args.probe_limit, not args.no_threshold)
    items = res["new"]
    if args.limit:
        items = items[:args.limit]
        res["new"] = items

    if args.out:
        os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
        with open(args.out, "w", encoding="utf-8") as fh:
            json.dump(res, fh, ensure_ascii=False, indent=2)

    if args.ids_only:
        print(" ".join(x["id"] for x in items))
        return 0

    print(f"扫描 {res['scanned_at']} · 窗口 {res['days']} 天 · {res['pages']} 页")
    print(f"  feed {res['feed_papers']} → AI {res['ai_papers']}"
          f"（门槛前 {res['ai_before_threshold']}，命中档位 {res['tier_counts']}）"
          f" → 探测 {res['probed']} → 新增 {len(items)}")
    for x in items[:40]:
        print(f"  {str(x['tier']) + 'd':>4}  {x['age_days']:>5.1f}天  {x['views']:>6} 浏览  "
              f"{x['id']:<22} {x['title'][:52]}")
    if len(items) > 40:
        print(f"  … 还有 {len(items) - 40} 条")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
