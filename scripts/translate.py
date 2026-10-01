#!/usr/bin/env python3
"""把官方英文台词逐句翻成中文，产出 transcript.zh.json。

用 OpenAI 兼容的 /chat/completions 接口，所以 OpenAI、Azure、DeepSeek、
通义、本地 vLLM 等只要兼容都能用，靠 --base-url 切换。

为什么要逐句翻：播放器是按行对照的，逐句粒度天然对齐；
同时把前后各一句一起送进去当上下文，质量接近整篇翻译。

用法：
    python3 scripts/translate.py --dir data/2609.07303 \
        --key sk-xxx --model gpt-4o-mini

    # 一次翻一批，所有待译句子放进同一个并发池（默认 32 并发）
    python3 scripts/translate.py --dir data/*/segments.json \
        --key sk-xxx --model deepseek-chat --concurrency 32

调用远端 API 基本只等网络，本地 CPU 几乎不动，所以并发可以开大；
每句仍有独立的 3 次重试，429/5xx 会退避后再试。
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
from concurrent.futures import ThreadPoolExecutor, as_completed

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


SYSTEM_PROMPT = (
    "你是学术播客的翻译。把用户给出的英文句子翻成自然、口语化的简体中文。"
    "只输出译文本身，不要任何解释、不要加引号、不要重复原文。"
    f"术语按以下对照固定：{GLOSSARY}"
)


def cache_key(model: str, text: str) -> str:
    return hashlib.sha1((model + "\x00" + text).encode()).hexdigest()


def normalize_dir(path: str) -> str:
    """--dir 既接受目录，也接受 data/<id>/segments.json 这种路径。"""
    p = path.rstrip("/")
    return os.path.dirname(p) if p.endswith(".json") else p


def translate_one(en: str, ctx_prev: str, ctx_next: str, base: str, key: str,
                  model: str) -> str:
    """翻一句。整个并发池都是在这里排队，所以这个函数必须自己把重试做完。"""
    user = (
        f"前一句（仅供理解上下文）：{ctx_prev or '（无）'}\n"
        f"后一句（仅供理解上下文）：{ctx_next or '（无）'}\n\n"
        f"要翻译的这一句：\n{en}"
    )
    for attempt in range(3):
        try:
            return call_llm(base, key, model, SYSTEM_PROMPT, user)
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "replace")[:200]
            if exc.code in (429, 500, 502, 503) and attempt < 2:
                time.sleep(2 ** attempt * 2)
                continue
            raise RuntimeError(f"翻译接口返回 {exc.code}: {detail}")
        except Exception:
            if attempt < 2:
                time.sleep(2)
                continue
            raise
    raise RuntimeError("翻译重试三次仍未成功")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True, nargs="+",
                    help="单集目录（可多个），例如 data/2609.07303；"
                         "也接受 data/<id>/segments.json")
    ap.add_argument("--key", default=os.environ.get("OPENAI_API_KEY"))
    ap.add_argument("--base-url", default=os.environ.get("OPENAI_BASE_URL", DEFAULT_BASE))
    ap.add_argument("--model", default=os.environ.get("TRANSLATE_MODEL", "gpt-4o-mini"))
    ap.add_argument("--concurrency", type=int,
                    default=int(os.environ.get("TRANSLATE_CONCURRENCY", "32")),
                    help="同时在飞的请求数。调用远端 API 基本只等网络，"
                         "本地几乎不吃 CPU，所以可以开大")
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()

    if not args.key:
        print("[translate] 缺少 API key", file=sys.stderr)
        return 2

    # ── 收集任务 ──
    # 所有论文的待译句子放进同一个池子，而不是一篇一篇来：
    # 一篇只有 15~20 句，单篇跑根本喂不满 32 个并发。
    jobs = []
    state: dict[str, dict] = {}
    for raw in args.dir:
        directory = normalize_dir(raw)
        seg_path = os.path.join(directory, "segments.json")
        if not os.path.exists(seg_path):
            print(f"[translate] 跳过 {directory}（没有 segments.json）", file=sys.stderr)
            continue
        out_path = os.path.join(directory, "transcript.zh.json")
        if os.path.exists(out_path) and not args.force:
            continue   # 已经有译文，跳过
        seg = json.load(open(seg_path, encoding="utf-8"))
        lines = [s["text"] for s in seg["segments"]]
        cp = cache_path(directory)
        cache = json.load(open(cp, encoding="utf-8")) if os.path.exists(cp) else {}
        zh: list[str | None] = [None] * len(lines)
        for i, en in enumerate(lines):
            ck = cache_key(args.model, en)
            if not args.force and ck in cache:
                zh[i] = cache[ck]
                continue
            jobs.append((directory, i, ck, en))
        state[directory] = {"lines": lines, "zh": zh, "cache": cache, "cp": cp,
                            "out": out_path}

    if not state:
        print("[translate] 没有需要翻译的目录")
        return 0
    reuse = sum(len(s["zh"]) - sum(1 for x in s["zh"] if x is None) for s in state.values())
    print(f"[translate] {len(state)} 篇 / 待译 {len(jobs)} 句 / 命中缓存 {reuse} 句"
          f" / 并发 {args.concurrency}", flush=True)

    # ── 并发翻译 ──
    failed = 0
    if jobs:
        with ThreadPoolExecutor(max_workers=max(1, args.concurrency)) as pool:
            futures = {}
            for directory, i, ck, en in jobs:
                st = state[directory]
                prev = st["lines"][i - 1] if i > 0 else ""
                nxt = st["lines"][i + 1] if i + 1 < len(st["lines"]) else ""
                fut = pool.submit(translate_one, en, prev, nxt,
                                  args.base_url, args.key, args.model)
                futures[fut] = (directory, i, ck)
            for fut in as_completed(futures):
                directory, i, ck = futures[fut]
                try:
                    zh_line = fut.result()
                except Exception as exc:
                    failed += 1
                    print(f"::warning::{directory} 第 {i + 1} 句翻译失败：{exc}",
                          file=sys.stderr, flush=True)
                    continue
                st = state[directory]
                st["zh"][i] = zh_line
                st["cache"][ck] = zh_line

    # ── 落盘 ──
    # 缓存先写：中途失败的话，下次只补没译出来的那几句，不用整篇重来。
    done = 0
    for directory, st in state.items():
        json.dump(st["cache"], open(st["cp"], "w", encoding="utf-8"), ensure_ascii=False)
        missing = sum(1 for x in st["zh"] if x is None)
        if missing:
            print(f"::warning::{directory} 还有 {missing} 句没译出来，本次不写译文",
                  file=sys.stderr, flush=True)
            continue
        json.dump(st["zh"], open(st["out"], "w", encoding="utf-8"),
                  ensure_ascii=False, indent=2)
        print(f"[translate] {len(st['zh'])} 句 -> {st['out']}")
        done += 1

    print(f"[translate] 完成 {done} 篇" + (f"，{len(state) - done} 篇未完成" if done < len(state) else ""))
    return 1 if (failed or done < len(state)) else 0


if __name__ == "__main__":
    raise SystemExit(main())
