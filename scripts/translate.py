#!/usr/bin/env python3
"""把官方英文台词逐句翻成中文，产出 transcript.zh.json。

用 OpenAI 兼容的 /chat/completions 接口，所以 OpenAI、Azure、DeepSeek、
通义、本地 vLLM 等只要兼容都能用，靠 --base-url 切换。

为什么要逐句翻：播放器是按行对照的，逐句粒度天然对齐；
同时把前后各一句一起送进去当上下文，质量接近整篇翻译。

用法：
    python3 scripts/translate.py --dir data/2609.07303 \
        --key sk-xxx --model gpt-4o-mini
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.request

DEFAULT_BASE = "https://api.openai.com/v1"

# 固定译法，避免同一篇里术语漂移
GLOSSARY = """
attention=注意力  self-attention=自注意力  multi-head=多头  encoder=编码器
decoder=解码器  token=token   transformer=Transformer  embedding=嵌入
policy=策略  reward=奖励  rollout=轨迹  ablation=消融实验  benchmark=基准
framework=框架  architecture=架构  baseline=基线  推理=reasoning
""".strip()


def call_llm(base: str, key: str, model: str, system: str, user: str,
             timeout: int = 90) -> str:
    body = json.dumps({
        "model": model,
        "temperature": 0,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
    }).encode()
    req = urllib.request.Request(
        base.rstrip("/") + "/chat/completions",
        data=body,
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {key}"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        data = json.loads(resp.read().decode())
    return data["choices"][0]["message"]["content"].strip()


def cache_path(directory: str) -> str:
    return os.path.join(directory, ".translate-cache.json")


def translate_lines(lines: list[str], base: str, key: str, model: str,
                    cache: dict) -> list[str]:
    system = (
        "你是学术播客的翻译。把用户给出的英文句子翻成自然、口语化的简体中文。"
        "只输出译文本身，不要任何解释、不要加引号、不要重复原文。"
        f"术语按以下对照固定：{GLOSSARY}"
    )
    out = []
    for i, en in enumerate(lines):
        ck = hashlib.sha1((model + "\x00" + en).encode()).hexdigest()
        if ck in cache:
            out.append(cache[ck])
            continue
        ctx_prev = lines[i - 1] if i > 0 else ""
        ctx_next = lines[i + 1] if i + 1 < len(lines) else ""
        user = (
            f"前一句（仅供理解上下文）：{ctx_prev or '（无）'}\n"
            f"后一句（仅供理解上下文）：{ctx_next or '（无）'}\n\n"
            f"要翻译的这一句：\n{en}"
        )
        for attempt in range(3):
            try:
                zh = call_llm(base, key, model, system, user)
                break
            except urllib.error.HTTPError as exc:
                detail = exc.read().decode("utf-8", "replace")[:200]
                if exc.code in (429, 500, 502, 503) and attempt < 2:
                    time.sleep(2 ** attempt * 2)
                    continue
                raise RuntimeError(f"翻译接口返回 {exc.code}: {detail}")
            except Exception as exc:
                if attempt < 2:
                    time.sleep(2)
                    continue
                raise
        cache[ck] = zh
        out.append(zh)
        time.sleep(0.05)
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True, help="单集目录，例如 data/2609.07303")
    ap.add_argument("--key", default=os.environ.get("OPENAI_API_KEY"))
    ap.add_argument("--base-url", default=os.environ.get("OPENAI_BASE_URL", DEFAULT_BASE))
    ap.add_argument("--model", default=os.environ.get("TRANSLATE_MODEL", "gpt-4o-mini"))
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()

    seg_path = os.path.join(args.dir, "segments.json")
    out_path = os.path.join(args.dir, "transcript.zh.json")
    if os.path.exists(out_path) and not args.force:
        print("[translate] 已存在，跳过")
        return 0
    if not args.key:
        print("[translate] 缺少 API key", file=sys.stderr)
        return 2

    seg = json.load(open(seg_path, encoding="utf-8"))
    lines = [s["text"] for s in seg["segments"]]
    cp = cache_path(args.dir)
    cache = json.load(open(cp, encoding="utf-8")) if os.path.exists(cp) else {}

    zh = translate_lines(lines, args.base_url, args.key, args.model, cache)
    json.dump(zh, open(out_path, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    json.dump(cache, open(cp, "w", encoding="utf-8"), ensure_ascii=False)
    print(f"[translate] {len(zh)} 句 -> {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
