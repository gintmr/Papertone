#!/usr/bin/env python3
"""Stage 1 extractor: alphaXiv paper page -> structured meta.json.

Reads everything the player site needs from the server-rendered page, without
executing JavaScript and without logging in.

Usage:
    python3 extract_paper.py --html samples/1706.03762.html --out out/
    python3 extract_paper.py 1706.03762 --out out/

Sources inside the page (in priority order):
  1. JSON-LD (schema.org ScholarlyArticle)  - stable, SEO contract
  2. Dehydrated query state ($R[n])         - framework internals, may change
  3. BibTeX embedded as citationBibtex
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone

UA = "axlisten/0.1 (personal listening practice; contact: CHANGE_ME)"

JSONLD_RE = re.compile(
    r'<script[^>]*data-alphaxiv-id="json-ld-paper-detail-view"[^>]*>(.*?)</script>',
    re.S,
)
AUDIO_RE = re.compile(
    r"https://paper-podcasts\.alphaxiv\.org/([0-9a-fA-F-]{36})/([^\s\"'<>]+)"
)
PODCAST_STATE_RE = re.compile(r'state:"(\w+)",podcastPath:"([^"]+)"')
ARXIV_RE = re.compile(r"(\d{4}\.\d{4,5})(v\d+)?")

# arXiv 许可证 -> 语义分类
LICENSE_MAP = [
    ("creativecommons.org/publicdomain/zero", "CC0 1.0", True, False),
    ("creativecommons.org/publicdomain/mark", "Public Domain Mark", True, False),
    ("creativecommons.org/licenses/by-nc-nd", "CC BY-NC-ND", False, True),
    ("creativecommons.org/licenses/by-nc-sa", "CC BY-NC-SA", False, False),
    ("creativecommons.org/licenses/by-nc", "CC BY-NC", False, False),
    ("creativecommons.org/licenses/by-nd", "CC BY-ND", True, True),
    ("creativecommons.org/licenses/by-sa", "CC BY-SA", True, False),
    ("creativecommons.org/licenses/by", "CC BY", True, False),
    ("arxiv.org/licenses/nonexclusive-distrib", "arXiv 默认非独占许可", False, False),
    ("arxiv.org/licenses/assumed-1991-2003", "arXiv 早期默认许可", False, False),
]


def js_string(html: str, key: str):
    """Pull a double-quoted JS string value by key, decoding JS/JSON escapes."""
    m = re.search(r'\b%s:\s*"((?:[^"\\]|\\.)*)"' % re.escape(key), html)
    if not m:
        return None
    try:
        return json.loads('"' + m.group(1) + '"')
    except Exception:
        return m.group(1).replace("\\n", "\n").replace('\\"', '"')


def js_array(html: str, key: str):
    m = re.search(r'\b%s:\s*\$R\[\d+\]=\[(.*?)\]' % re.escape(key), html, re.S)
    if not m:
        m = re.search(r'\b%s:\s*\[([^\]]*)\]' % re.escape(key), html)
    if not m:
        return []
    try:
        return json.loads("[" + m.group(1) + "]")
    except Exception:
        return re.findall(r'"([^"]*)"', m.group(1))


def iso(value: str | None) -> str | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).isoformat()
    except Exception:
        return value


def classify_license(url: str | None) -> dict:
    if not url:
        return {"url": None, "class": "unknown", "allows_redistribution": None}
    low = url.lower()
    for needle, label, redist, nd in LICENSE_MAP:
        if needle in low:
            return {
                "url": url,
                "class": label,
                "allows_redistribution": redist,
                "no_derivatives": nd,
            }
    return {"url": url, "class": "unknown", "allows_redistribution": None}


def extract(html: str, source: str) -> dict:
    paper: dict = {}

    # ---- 1. JSON-LD ----
    m = JSONLD_RE.search(html)
    ld = json.loads(m.group(1)) if m else {}
    paper["title"] = ld.get("headline")
    paper["abstract"] = ld.get("abstract")
    paper["authors"] = [a.get("name") for a in ld.get("author", []) if a.get("name")]
    paper["author_details"] = [
        {
            "name": a.get("name"),
            "affiliation": (a.get("affiliation") or {}).get("name"),
            "alphaxiv_url": a.get("url"),
            "same_as": a.get("sameAs", []),
        }
        for a in ld.get("author", [])
    ]
    citation = ld.get("citation") or {}
    paper["arxiv_id_jsonld"] = citation.get("identifier")

    # ---- 2. Dehydrated state ----
    paper["summary"] = js_string(html, "description")
    paper["authors_short"] = js_array(html, "authors")
    paper["author_profiles"] = js_array(html, "authorProfileUrls")
    paper["arxiv_id"] = js_string(html, "arxivId")
    paper["canonical_id"] = js_string(html, "canonicalId")
    paper["version_id"] = js_string(html, "versionId")
    paper["group_id"] = js_string(html, "groupId")
    paper["pdf_url"] = js_string(html, "pdfUrl")
    paper["markdown_path"] = js_string(html, "markdownPath")
    paper["thumbnail_url"] = js_string(html, "thumbnailImage")
    paper["source_name"] = js_string(html, "sourceName")
    paper["source_url"] = js_string(html, "sourceUrl")

    fp = re.search(r'firstPublicationDate:\$R\[\d+\]=new Date\("([^"]+)"\)', html)
    paper["first_published"] = iso(fp.group(1)) if fp else None

    versions = re.findall(r'id:"([0-9a-fA-F-]{36})",label:"(v\d+)"', html)
    paper["versions"] = [{"label": lbl, "version_id": vid} for vid, lbl in versions]

    lic = js_string(html, "license")
    paper["license"] = classify_license(lic)

    bib = js_string(html, "citationBibtex")
    bib_key = re.search(r"@\w+\{\s*([^,]+),", bib) if bib else None
    paper["bibtex"] = {
        "key": bib_key.group(1).strip() if bib_key else None,
        "raw": bib,
    }

    # ---- 3. Podcast ----
    podcast = {"available": False, "state": None, "podcast_id": None, "audio_url": None}
    st = PODCAST_STATE_RE.search(html)
    if st:
        podcast["state"] = st.group(1)
    audio = AUDIO_RE.search(html)
    if audio:
        podcast.update(
            available=True,
            podcast_id=audio.group(1),
            file=audio.group(2),
            audio_url=audio.group(0).replace("&amp;", "&"),
        )
    elif st:
        path = st.group(2)
        podcast.update(
            available=True,
            podcast_id=path.split("/")[0],
            file=path.split("/")[-1],
            audio_url=f"https://paper-podcasts.alphaxiv.org/{path}",
        )

    # 时长与文件大小必须下载后由 ffprobe 得到，页面里没有
    podcast["duration_s"] = None
    podcast["bytes"] = None

    return {
        "schema_version": 1,
        "extracted_at": datetime.now(timezone.utc).isoformat(),
        "source": source,
        "paper": paper,
        "podcast": podcast,
        "transcript": {
            "available": None,
            "source": None,
            "segment_count": None,
            "note": "文字稿为客户端懒加载，页面 HTML 中不含，需 Stage 4 获取",
        },
    }


def fetch(url: str) -> tuple[int, str]:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=45) as resp:
            return resp.status, resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        return exc.code, ""
    except Exception:
        return 0, ""


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("paper", nargs="?")
    ap.add_argument("--html", help="parse a saved HTML file")
    ap.add_argument("--out", default=".", help="output directory")
    args = ap.parse_args()

    if args.html:
        html = open(args.html, encoding="utf-8", errors="replace").read()
        result = extract(html, os.path.abspath(args.html))
    else:
        if not args.paper:
            ap.error("provide an arXiv id / URL, or --html")
        m = ARXIV_RE.search(args.paper)
        arxiv_id = m.group(0) if m else args.paper.rstrip("/").split("/")[-1]
        url = f"https://www.alphaxiv.org/abs/{arxiv_id}"
        status, html = fetch(url)
        if status != 200:
            print(json.dumps({"url": url, "status": status}, ensure_ascii=False))
            return 1
        result = extract(html, url)

    os.makedirs(args.out, exist_ok=True)
    gid = result["paper"].get("group_id") or result["paper"].get("arxiv_id")
    path = os.path.join(args.out, f"{gid}.meta.json")
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(result, fh, ensure_ascii=False, indent=2)

    print(json.dumps(result, ensure_ascii=False, indent=2))
    print(f"\n[written] {path}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
