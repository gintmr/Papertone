#!/usr/bin/env python3
"""Forced alignment for alphaXiv podcasts.

Why this exists:
  alphaXiv's official `transcript.json` has perfect text (it is the script the
  TTS actually read) but NO timestamps -- the site's own player has the
  click-to-seek code and it is inert because every entry lacks `start`.

  So we keep the official text as ground truth and use ASR only to obtain a
  time axis, then align the two word sequences with difflib.

Output: segments.json with per-line start/end plus word-level timings.

Usage:
    python3 align_transcript.py --audio podcast.mp3 \
        --transcript transcript.json --out transcript.segments.json \
        --model small
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from difflib import SequenceMatcher

NORM_RE = re.compile(r"[^a-z0-9']+")


def norm(word: str) -> str:
    return NORM_RE.sub("", word.lower())


def build_asr_words(model, audio: str):
    segments, info = model.transcribe(
        audio,
        word_timestamps=True,
        vad_filter=True,
        beam_size=5,
        condition_on_previous_text=False,
    )
    words = []
    for seg in segments:
        for w in seg.words or []:
            token = norm(w.word)
            if token:
                words.append({"w": token, "raw": w.word, "start": w.start, "end": w.end})
    return words, info


def align(official_lines: list[dict], asr_words: list[dict], duration: float):
    off_tokens, off_index = [], []
    for li, entry in enumerate(official_lines):
        for wi, raw in enumerate(entry["line"].split()):
            t = norm(raw)
            if t:
                off_tokens.append(t)
                off_index.append((li, wi))

    asr_tokens = [w["w"] for w in asr_words]
    matcher = SequenceMatcher(None, off_tokens, asr_tokens, autojunk=False)
    times: dict[tuple[int, int], dict] = {}
    for a, b, size in matcher.get_matching_blocks():
        for k in range(size):
            times[off_index[a + k]] = asr_words[b + k]

    matched = len(times)
    total = len(off_tokens)

    out = []
    for li, entry in enumerate(official_lines):
        idxs = [i for i, (l, _) in enumerate(off_index) if l == li]
        hits = [times[off_index[i]] for i in idxs if off_index[i] in times]
        out.append(
            {
                "i": li,
                "speaker": entry.get("speaker"),
                "text": entry["line"],
                "start": round(hits[0]["start"], 3) if hits else None,
                "end": round(hits[-1]["end"], 3) if hits else None,
                "words": [
                    {
                        "w": official_lines[l]["line"].split()[w],
                        "start": round(times[(l, w)]["start"], 3),
                        "end": round(times[(l, w)]["end"], 3),
                    }
                    for (l, w) in [(off_index[i][0], off_index[i][1]) for i in idxs]
                    if (l, w) in times
                ],
            }
        )

    # 用相邻行的边界补齐空洞，最后一行延伸到音频结尾
    filled = [s for s in out if s["start"] is not None]
    for i, seg in enumerate(out):
        if seg["start"] is None:
            prev = next((s["end"] for s in reversed(out[:i]) if s["end"] is not None), 0.0)
            nxt = next((s["start"] for s in out[i + 1 :] if s["start"] is not None), duration)
            seg["start"], seg["end"] = round(prev, 3), round(nxt, 3)
    for i, seg in enumerate(out[:-1]):
        if seg["end"] is None or seg["end"] > out[i + 1]["start"]:
            seg["end"] = out[i + 1]["start"]
    if out:
        out[-1]["end"] = round(duration, 3)

    return out, matched, total, filled


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--audio", required=True)
    ap.add_argument("--transcript", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--model", default="small")
    ap.add_argument("--language", default="en")
    ap.add_argument(
        "--no-words",
        action="store_true",
        help="丢弃词级时间戳，只保留句级（体积约降到 1/6）",
    )
    args = ap.parse_args()

    from faster_whisper import WhisperModel
    import subprocess

    official = json.load(open(args.transcript, encoding="utf-8"))
    duration = float(
        subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "csv=p=0", args.audio],
            capture_output=True, text=True).stdout.strip()
    )

    print(f"[asr] model={args.model} ...", file=sys.stderr)
    model = WhisperModel(args.model, device="cpu", compute_type="int8")
    asr_words, info = build_asr_words(model, args.audio)
    print(f"[asr] {len(asr_words)} words, lang={info.language}", file=sys.stderr)

    segments, matched, total, _ = align(official, asr_words, duration)
    if args.no_words:
        for seg in segments:
            seg.pop("words", None)

    result = {
        "source": "official_text + asr_alignment",
        "word_level": not args.no_words,
        "model": args.model,
        "language": args.language,
        "duration": round(duration, 3),
        "word_match_rate": round(matched / total, 4) if total else None,
        "line_count": len(segments),
        "segments": segments,
    }
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(result, fh, ensure_ascii=False, indent=2)

    print(
        f"[align] lines={len(segments)} word_match={matched}/{total} "
        f"({100*matched/total:.1f}%) -> {args.out}",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
