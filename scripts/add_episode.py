#!/usr/bin/env python3
"""抓取单篇（或多篇）论文播客，产出播放器直接可用的数据。

用法（必须在项目自带的 venv 里跑，因为要用 faster-whisper）：

    HF_HOME="$PWD/_work/hf" _work/venv/bin/python scripts/add_episode.py \
        2609.07303 2609.17523 --model tiny

每篇产出 data/<arxiv_id>/ 下的：
    audio/podcast.mp3     音频
    transcript.json       官方原文（只有 speaker / line，无时间戳）
    segments.json         官方文本 + 本地对齐出的句级时间轴
    cover.png             论文首页缩略图
    meta.json             标题/作者/摘要/许可证/BibTeX 等

并刷新 data/papers.json（列表页数据源）。
"""

from __future__ import annotations

import argparse
import array
import hashlib
import json
import math
import os
import re
import subprocess
import sys

UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126 Safari/537.36"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

JSONLD_RE = re.compile(
    r'<script[^>]*data-alphaxiv-id="json-ld-paper-detail-view"[^>]*>(.*?)</script>', re.S)
AUDIO_RE = re.compile(r"https://paper-podcasts\.alphaxiv\.org/([0-9a-fA-F-]{36})/([^\s\"'<>]+)")
TOPICS_RE = re.compile(r'topics:\$R\[\d+\]=\[([^\]]*)\]')

# 标签收敛：alphaXiv 会给出十几个标签（含 Computer Science、cs.LG 这类过宽的），
# 直接铺到筛选条上会很乱。这里做两级处理：
#   1. 把同义标签映射到一个规范名（agents / agentic-frameworks → Agents）
#   2. 丢掉过宽或纯分类号的标签
#   3. 每篇最多保留 MAX_TAGS 个
MAX_TAGS = 3
TAG_ALIASES = {
    "agents": "Agents",
    "agentic-frameworks": "Agents",
    "multi-agent-learning": "Agents",
    "ai-for-health": "AI for Health",
    "continual-learning": "Continual Learning",
    "reinforcement-learning": "Reinforcement Learning",
    "deep-reinforcement-learning": "Reinforcement Learning",
    "human-ai-interaction": "Human-AI",
    "tool-use": "Tool Use",
    "meta-learning": "Meta-Learning",
    "transformers": "Transformers",
    "efficient-transformers": "Transformers",
    "vision-language-models": "Vision-Language",
    "computer-vision": "Computer Vision",
    "robotics": "Robotics",
    "reasoning": "Reasoning",
    "hep-ph": "Particle Physics",
    "hep-th": "Particle Physics",
    "math-ph": "Particle Physics",
    "quantum-physics": "Quantum Physics",
}
# 过宽的分类，作为标签没有筛选意义
TAG_DROP = {
    "Computer Science", "Physics", "Mathematics", "Statistics", "Biology",
    "Economics", "Electrical Engineering", "Quantitative Biology",
}
CATEGORY_RE = re.compile(r"^[a-z]{2}\.[A-Z]{2}$")


def normalize_topics(raw: list[str]) -> list[str]:
    out: list[str] = []
    for t in raw:
        if t in TAG_DROP or CATEGORY_RE.match(t):
            continue
        label = TAG_ALIASES.get(t, t.replace("-", " ").title())
        if label not in out:
            out.append(label)
    return out[:MAX_TAGS]


def compute_peaks(path: str, buckets: int = 72) -> list[float]:
    """给播放器的波形进度条提供数据。

    用 RMS（能量均值）而不是峰值：语音里瞬态太多，取最大值会得到一条几乎
    等高的方块。TTS 语音又是连续无停顿的，动态范围天生很窄，
    所以要按每篇自身的范围归一化并压一次对比，波形才有起伏。
    数据仍然真实反映相对响度，只是视觉上放大了差异。
    """
    r = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", path, "-ac", "1", "-ar", "4000",
         "-f", "s16le", "-"], capture_output=True)
    data = array.array("h")
    data.frombytes(r.stdout)
    if not data:
        return []
    step = max(1, len(data) // buckets)
    raw = []
    for i in range(buckets):
        chunk = data[i * step:(i + 1) * step]
        raw.append(0.0 if not chunk
                   else math.sqrt(sum(float(x) * x for x in chunk) / len(chunk)) / 32768)
    lo, hi = min(raw), max(raw)
    span = (hi - lo) or 1
    return [round(0.2 + 0.8 * ((p - lo) / span) ** 1.3, 3) for p in raw]


def curl(url: str, out: str | None = None, timeout: int = 90) -> str:
    cmd = ["curl", "-s", "-L", url, "--max-time", str(timeout), "-A", UA,
           "-w", "%{http_code}", "-o", out or "/dev/null"]
    r = subprocess.run(cmd, capture_output=True, text=True)
    return r.stdout.strip()


def js_string(html: str, key: str):
    m = re.search(r'\b%s:\s*"((?:[^"\\]|\\.)*)"' % re.escape(key), html)
    if not m:
        return None
    try:
        return json.loads('"' + m.group(1) + '"')
    except Exception:
        return m.group(1)


def classify_license(url: str | None) -> str:
    if not url:
        return "unknown"
    low = url.lower()
    for needle, label in [
        ("publicdomain/zero", "CC0"), ("publicdomain/mark", "Public Domain"),
        ("licenses/by-nc-nd", "CC BY-NC-ND"), ("licenses/by-nc-sa", "CC BY-NC-SA"),
        ("licenses/by-nc", "CC BY-NC"), ("licenses/by-nd", "CC BY-ND"),
        ("licenses/by-sa", "CC BY-SA"), ("licenses/by", "CC BY"),
        ("nonexclusive-distrib", "arXiv 默认许可"),
    ]:
        if needle in low:
            return label
    return "unknown"


def fetch_meta(arxiv_id: str) -> dict:
    cache = os.path.join(ROOT, "_work", "raw", f"{arxiv_id}.page.html")
    os.makedirs(os.path.dirname(cache), exist_ok=True)
    html = ""
    if not os.path.exists(cache):
        if curl(f"https://www.alphaxiv.org/abs/{arxiv_id}", cache) != "200":
            raise RuntimeError(f"抓取论文页失败: {arxiv_id}")
    with open(cache, encoding="utf-8", errors="replace") as fh:
        html = fh.read()

    ld = {}
    m = JSONLD_RE.search(html)
    if m:
        ld = json.loads(m.group(1))

    audio = AUDIO_RE.search(html)
    topics_m = TOPICS_RE.search(html)
    raw_topics = [t for t in re.findall(r'"([^"]*)"', topics_m.group(1)) if t] if topics_m else []
    return {
        "id": arxiv_id,
        "title": ld.get("headline"),
        "authors": [a.get("name") for a in ld.get("author", []) if a.get("name")],
        "abstract": (ld.get("abstract") or "").strip(),
        "group_id": js_string(html, "groupId"),
        "license": classify_license(js_string(html, "license")),
        "bibtex": js_string(html, "citationBibtex"),
        "audio_url": audio.group(0).replace("&amp;", "&") if audio else None,
        "topics": normalize_topics(raw_topics),
        "raw_topics": raw_topics,
    }


def add_episode(arxiv_id: str, model: str, force: bool,
                keep_audio: bool = False) -> dict | None:
    dest = os.path.join(ROOT, "data", arxiv_id)
    os.makedirs(os.path.join(dest, "audio"), exist_ok=True)

    print(f"\n▶ {arxiv_id}")
    meta = fetch_meta(arxiv_id)
    if not meta["audio_url"]:
        print("   没有播客，跳过")
        return None

    gid = meta["group_id"]
    audio_path = os.path.join(dest, "audio", "podcast.mp3")
    if force or not os.path.exists(audio_path):
        code = curl(meta["audio_url"], audio_path, timeout=300)
        print(f"   音频 {code} {os.path.getsize(audio_path)/1024/1024:.1f}MB")
    else:
        print("   音频已存在")

    tpath = os.path.join(dest, "transcript.json")
    if force or not os.path.exists(tpath):
        code = curl(f"https://paper-podcasts.alphaxiv.org/{gid}/transcript.json", tpath)
        print(f"   官方台词 {code}")

    # 论文首页缩略图
    cover = os.path.join(dest, "cover.png")
    if force or not os.path.exists(cover):
        ver = js_string(open(os.path.join(ROOT, "_work", "raw", f"{arxiv_id}.page.html"),
                             encoding="utf-8", errors="replace").read(), "canonicalId") or f"{arxiv_id}v1"
        code = curl(f"https://thumbnails.assets.alphaxiv.org/{ver}.png", cover)
        if code != "200" or os.path.getsize(cover) < 2000:
            os.path.exists(cover) and os.remove(cover)
            code = curl(f"https://api.alphaxiv.org/open-graph/v1/paper/{arxiv_id}.png", cover)
        print(f"   缩略图 {code} {os.path.getsize(cover)/1024:.0f}KB"
              if os.path.exists(cover) else "   缩略图失败")

    # 时长
    dur = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "csv=p=0", audio_path], capture_output=True, text=True).stdout.strip()
    meta["duration"] = float(dur) if dur else None
    meta["audio_bytes"] = os.path.getsize(audio_path)
    meta["audio_sha256"] = hashlib.sha256(
        open(audio_path, "rb").read()).hexdigest()[:16]
    meta["cover"] = "cover.png" if os.path.exists(cover) else None
    meta["audio"] = None          # 不留本地音频，播放直接走 CDN
    if force or not meta.get("peaks"):
        meta["peaks"] = compute_peaks(audio_path)
        print(f"   波形 {len(meta['peaks'])} 个采样点")

    # 对齐（官方文本 + 本地 ASR 时间轴）
    seg = os.path.join(dest, "segments.json")
    if force or not os.path.exists(seg):
        r = subprocess.run(
            [sys.executable, os.path.join(ROOT, "scripts", "align_transcript.py"),
             "--audio", audio_path, "--transcript", tpath, "--out", seg,
             "--model", model, "--no-words"],
            capture_output=True, text=True)
        sys.stderr.write("".join(l + "\n" for l in r.stderr.splitlines() if l.startswith("[")))

    with open(os.path.join(dest, "meta.json"), "w", encoding="utf-8") as fh:
        json.dump(meta, fh, ensure_ascii=False, indent=2)

    # 音频只是中间产物：ASR 对齐与波形都已算完，没有保留价值。
    # 播放时直接引用 alphaXiv 的 CDN（CORS 是 *，浏览器能直接播）。
    # 这样仓库不会积累音频——200 篇含音频是 896MB，不含只有 27MB。
    if keep_audio:
        print("   保留本地音频（--keep-audio）")
    elif os.path.exists(audio_path):
        os.remove(audio_path)
        try:
            os.rmdir(os.path.dirname(audio_path))
        except OSError:
            pass
        print("   已删除本地音频，播放走 CDN")
    print(f"   完成：{meta['title'][:56]}")
    return meta


def rebuild_index() -> None:
    eps = []
    data_dir = os.path.join(ROOT, "data")
    for name in sorted(os.listdir(data_dir)):
        mp = os.path.join(data_dir, name, "meta.json")
        if not os.path.exists(mp):
            continue
        m = json.load(open(mp, encoding="utf-8"))
        eps.append({
            "id": m["id"], "title": m["title"], "authors": m["authors"],
            "duration": m["duration"], "license": m["license"],
            "topics": m.get("topics", []), "cover": m.get("cover"),
            "path": m["id"],
            # 播放地址给前端用来「保存到本机」；仓库里不留音频
            "audio_url": m.get("audio_url"),
        })
    eps.sort(key=lambda e: e["id"], reverse=True)
    out = os.path.join(data_dir, "papers.json")
    with open(out, "w", encoding="utf-8") as fh:
        json.dump({"generated_at": None, "episodes": eps}, fh, ensure_ascii=False, indent=2)
    print(f"\n已刷新 {out}（{len(eps)} 篇）")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("ids", nargs="*", help="arXiv id 列表")
    ap.add_argument("--model", default="tiny")
    ap.add_argument("--force", action="store_true", help="已存在也重新抓")
    ap.add_argument("--no-index", action="store_true", help="不刷新 papers.json")
    ap.add_argument("--reindex-only", action="store_true", help="只刷新 papers.json")
    ap.add_argument("--keep-audio", action="store_true",
                    help="保留本地音频（默认跑完就删，播放走 CDN）")
    args = ap.parse_args()

    if args.reindex_only:
        rebuild_index()
        return 0
    for aid in args.ids:
        try:
            add_episode(aid, args.model, args.force, args.keep_audio)
        except Exception as exc:
            print(f"   ✗ {aid}: {exc}", file=sys.stderr)
    if not args.no_index:
        rebuild_index()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
