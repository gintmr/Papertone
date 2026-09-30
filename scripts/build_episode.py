#!/usr/bin/env python3
"""Stage 6: 把元数据 + 句级时间轴 + 中文译文合成播放器直接可用的 episode.json。

输入：
  --meta       论文元数据（extract_paper.py 或 feed API 的产物）
  --segments   align_transcript.py 的产物（句级，可含词级）
  --zh         中文译文数组（可选，与 segments 一一对应）
  --audio      音频相对路径（写进结果里的引用）
  --out        输出路径

输出字段刻意保持精简：只留播放器要用的。
"""

from __future__ import annotations

import argparse
import json
import os
import sys


def build(meta: dict, segments: dict, zh: list | None, audio: str) -> dict:
    paper = meta.get("paper", meta)
    segs = []
    for s in segments["segments"]:
        item = {
            "i": s["i"],
            "speaker": s.get("speaker"),
            "start": s["start"],
            "end": s["end"],
            "en": s["text"],
        }
        if zh and s["i"] < len(zh):
            item["zh"] = zh[s["i"]]
        segs.append(item)

    arxiv_id = paper.get("arxiv_id") or paper.get("id")
    out = {
        "id": arxiv_id,
        "title": paper.get("title"),
        "authors": paper.get("authors") or [],
        "abstract": paper.get("abstract"),
        "links": {
            "alphaxiv": f"https://www.alphaxiv.org/abs/{arxiv_id}",
            "arxiv": f"https://arxiv.org/abs/{arxiv_id}",
        },
        # 优先用 alphaXiv CDN 的绝对地址——仓库里不再保留音频。
        # 老数据没有 audio_url 时才退回本地相对路径。
        "audio": paper.get("audio_url") or audio,
        "duration": segments["duration"],
        "segments": segs,
    }
    # 透传站点要用的附带信息
    for key in ("cover", "bibtex", "topics", "peaks"):
        if paper.get(key):
            out[key] = paper[key]
    lic = paper.get("license")
    if isinstance(lic, dict):
        out["license"] = lic.get("class")
    elif lic:
        out["license"] = lic
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--meta", required=True)
    ap.add_argument("--segments", required=True)
    ap.add_argument("--zh")
    ap.add_argument("--audio", default="audio/podcast.mp3")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    meta = json.load(open(args.meta, encoding="utf-8"))
    segments = json.load(open(args.segments, encoding="utf-8"))
    zh = json.load(open(args.zh, encoding="utf-8")) if args.zh else None

    episode = build(meta, segments, zh, args.audio)
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(episode, fh, ensure_ascii=False, indent=2)

    size = os.path.getsize(args.out)
    has_words = any("words" in s for s in segments["segments"])
    print(
        f"[episode] {episode['id']} | {len(episode['segments'])} 句 | "
        f"词级={'有' if has_words else '无'} | 中文={'有' if zh else '无'} | {size/1024:.1f}KB",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
