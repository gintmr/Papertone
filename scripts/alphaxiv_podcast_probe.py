#!/usr/bin/env python3
"""alphaXiv paper-podcast probe (starter script).

Given an arXiv id / alphaXiv paper URL, find the paper-podcast audio URL that
alphaXiv server-renders into the paper page, optionally download the mp3 and
probe for a sibling transcript file.

Usage:
    python3 alphaxiv_podcast_probe.py 1706.03762
    python3 alphaxiv_podcast_probe.py https://www.alphaxiv.org/abs/2502.12345
    python3 alphaxiv_podcast_probe.py 1706.03762 --download ./audio
    python3 alphaxiv_podcast_probe.py 1706.03762 --probe-transcript
    python3 alphaxiv_podcast_probe.py --html samples/1706.03762.html --json

Only stdlib. Personal study use: keep concurrency at 1-2 and >=1s between hits.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

UA = "alphaxiv-podcast-probe/0.1 (personal listening practice; contact: CHANGE_ME)"

AUDIO_RE = re.compile(
    r"https://paper-podcasts\.alphaxiv\.org/([0-9a-fA-F-]{36})/([^\s\"'>]+)"
)
PODCAST_PATH_RE = re.compile(r'podcastPath:"([^"]+)"')
TITLE_RE = re.compile(r"<title>(.*?)</title>", re.S)
GROUP_RE = re.compile(r'\["paper-group","([0-9a-fA-F-]{36})"')
ARXIV_RE = re.compile(r"(\d{4}\.\d{4,5})(v\d+)?")
STATE_RE = re.compile(r'state:"(\w+)",podcastPath:"([^"]+)"')


def request(url: str, timeout: int = 45, headers: dict | None = None):
    hdrs = {"User-Agent": UA, "Accept-Language": "en-US,en;q=0.9"}
    if headers:
        hdrs.update(headers)
    req = urllib.request.Request(url, headers=hdrs)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, dict(resp.headers), resp.read()
    except urllib.error.HTTPError as exc:
        return exc.code, dict(exc.headers or {}), b""
    except Exception as exc:  # DNS / TLS / timeout
        return 0, {"error": str(exc)}, b""


def parse_page(html_text: str) -> dict:
    """Extract podcast info from a server-rendered alphaXiv paper page."""
    info: dict = {"has_podcast": False}

    title = TITLE_RE.search(html_text)
    if title:
        info["page_title"] = title.group(1).strip()

    state = STATE_RE.search(html_text)
    if state:
        info["podcast_state"] = state.group(1)
        info["podcast_path"] = state.group(2)

    group = GROUP_RE.search(html_text)
    if group:
        info["paper_group_id"] = group.group(1)

    audio = AUDIO_RE.search(html_text)
    if audio:
        info["has_podcast"] = True
        info["podcast_id"] = audio.group(1)
        info["podcast_file"] = audio.group(2)
        info["audio_url"] = audio.group(0).replace("&amp;", "&")
    elif info.get("podcast_path"):
        path = info["podcast_path"]
        parts = path.split("/")
        info["has_podcast"] = True
        info["podcast_id"] = parts[0]
        info["podcast_file"] = parts[-1]
        info["audio_url"] = f"https://paper-podcasts.alphaxiv.org/{path}"

    return info


def transcript_candidates(podcast_id: str) -> list[str]:
    """Guesses only. Replace with the real endpoint captured from DevTools."""
    base = f"https://paper-podcasts.alphaxiv.org/{podcast_id}"
    return [
        f"{base}/transcript.json",
        f"{base}/transcript.txt",
        f"{base}/transcript.vtt",
        f"{base}/podcast.json",
        f"{base}/metadata.json",
        f"https://api.alphaxiv.org/v1/podcast/{podcast_id}",
        f"https://api.alphaxiv.org/v1/podcast/{podcast_id}/transcript",
    ]


def probe_transcripts(podcast_id: str) -> list[dict]:
    out = []
    for url in transcript_candidates(podcast_id):
        status, headers, body = request(url, timeout=20, headers={"Range": "bytes=0-400"})
        out.append(
            {
                "url": url,
                "status": status,
                "content_type": headers.get("Content-Type", ""),
                "bytes": len(body),
                "preview": body[:180].decode("utf-8", "replace") if body else "",
            }
        )
        time.sleep(1.0)
    return out


def download(url: str, dest_path: str) -> str:
    """Download with .part resume support."""
    parent = os.path.dirname(os.path.abspath(dest_path))
    os.makedirs(parent, exist_ok=True)
    part = dest_path + ".part"
    have = os.path.getsize(part) if os.path.exists(part) else 0
    headers = {"Range": f"bytes={have}-"} if have else {}
    status, _, body = request(url, timeout=120, headers=headers)
    if have and status != 206:
        have = 0  # server ignored Range -> restart clean
        status, _, body = request(url, timeout=120)
    with open(part, "ab" if have else "wb") as fh:
        fh.write(body)
    os.replace(part, dest_path)
    return dest_path


def main() -> int:
    ap = argparse.ArgumentParser(description="alphaXiv paper-podcast probe")
    ap.add_argument("paper", nargs="?", help="arXiv id or alphaXiv /abs/ URL")
    ap.add_argument("--html", help="parse a saved HTML file instead of hitting network")
    ap.add_argument("--download", metavar="DIR", help="download mp3 into DIR")
    ap.add_argument("--probe-transcript", action="store_true", help="probe guessed transcript URLs")
    ap.add_argument("--json", action="store_true", help="print raw JSON result")
    args = ap.parse_args()

    if args.html:
        with open(args.html, encoding="utf-8", errors="replace") as fh:
            info = parse_page(fh.read())
        info["source"] = args.html
    else:
        if not args.paper:
            ap.error("provide an arXiv id / URL, or use --html")
        ident = args.paper.strip()
        m = ARXIV_RE.search(ident)
        paper_id = m.group(0) if m else ident.rstrip("/").split("/")[-1]
        url = f"https://www.alphaxiv.org/abs/{paper_id}"
        status, resp_headers, body = request(url)
        if status != 200:
            print(
                json.dumps(
                    {
                        "url": url,
                        "status": status,
                        "error": resp_headers.get("error", ""),
                    },
                    ensure_ascii=False,
                )
            )
            return 1
        info = parse_page(body.decode("utf-8", "replace"))
        info.update({"source": url, "arxiv_id": paper_id, "status": status})

    result: dict = {"paper": info}

    if info.get("has_podcast") and args.probe_transcript:
        result["transcript_candidates"] = probe_transcripts(info["podcast_id"])

    if info.get("has_podcast") and args.download:
        name = f"{info.get('paper_group_id') or info['podcast_id']}-podcast.mp3"
        dest = os.path.join(args.download, name)
        result["downloaded"] = download(info["audio_url"], dest)

    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0

    print(f"page      : {info.get('page_title', '-')}")
    print(f"group id  : {info.get('paper_group_id', '-')}")
    print(f"podcast   : {'YES' if info.get('has_podcast') else 'no podcast found'}")
    if info.get("has_podcast"):
        print(f"podcast id: {info['podcast_id']}")
        print(f"audio url : {info['audio_url']}")
    for item in result.get("transcript_candidates", []):
        print(f"  probe {item['status']:>3} {item['content_type'][:40]:<40} {item['url']}")
    if result.get("downloaded"):
        print(f"saved     : {result['downloaded']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
