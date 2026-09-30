# alphaXiv 播客：抓取与转码管线设计

## 0. 先说三个已验证的事实

用不带任何 cookie / token 的匿名请求实测：

| 验证项 | 结果 | 含义 |
|---|---|---|
| `GET /abs/1706.03762` | `200`，HTML 内含标题、作者、音频直链 | 读论文页**不需要登录** |
| `GET paper-podcasts.alphaxiv.org/<uuid>/podcast.mp3`（Range 0-1024） | `206` + `audio/mpeg` | 音频是**公开 CDN，无鉴权** |
| `robots.txt` | `Allow: /`，`Disallow: /?` 与 `/signin?` | 不反对匿名抓取，但禁止查询串路径 |

**结论：核心链路（元数据 + 音频）完全不需要登录。**

需要登录的是另一批功能：评论、点赞、收藏、AI 助手、AI overview、个人主页。这些和抓取目标无关。

仍未验证：**文字稿接口是否需要登录或签名**。它的请求是懒加载触发的，必须实际抓一次才知道。

---

## 1. 关于登录的决策原则

即便某个接口需要登录，也**不建议用账号 cookie 去批量抓**，理由有四条：

1. ToS 违约性质更明确——匿名抓取是"访问公开页面"，带账号批量抓是"用你的身份做自动化"。
2. 封号风险由你个人承担。
3. 一旦被封，cookie 失效，整条管线的更新能力直接归零。
4. 匿名 + 限速的抓取才是可持续、可长期无人值守运行的。

**正确顺序：**

```
匿名能不能拿到？
  ├─ 能 → 直接用（当前状态）
  └─ 不能 → 不要登录抓，改走 ASR 兜底生成台词
```

对精听来说，ASR 稿本来就能用，而且自带词级时间戳，做听写 diff 的效果甚至更好。**不要为了文字稿去冒封号的风险。**

---

## 2. 关于 BibTeX 与版权的关系（需要修正一个理解）

原话是"附上引用，这样就能规避版权问题"。这个推断只对了一半：

- **引用能满足 CC-BY 系列的署名要求**，让"本来被允许的使用"变得完全合规。
- **引用不能把"没有授权的内容"变成"有授权的内容"。** arXiv 上多数论文用的是默认的「永久非独占许可」，该许可**根本不授予第三方再分发权**——加不加引用都一样。

所以引用是**必要条件（针对 CC-BY 论文）**，不是**充分条件**。

真正保护你的是架构选择：**内容只在本机/局域网内提供，不对外发布。** 在这个前提下，引用与不引用都不产生法律问题。

引用真正的价值在别处，而且这些价值是实打实的：

- 学术诚信与可追溯性；
- 你复习时能从播客跳回原文；
- 如果将来某篇论文是 CC-BY，你的署名已经合规；
- 做整库时能一眼看出哪些论文是开放许可（这也是后面「许可证字段」要入库的原因）。

建议照做，但别把它当护身符。

---

## 3. 管线总览

```
Stage 0  Seed        arXiv id 清单 / sitemap / 你的阅读单
   ↓
Stage 1  Extract     JSON-LD + 音频直链 + group_id + 论文许可
   ↓
Stage 2  Fetch       音频下载（Range 断点续传 + 校验）
   ↓
Stage 3  Transcode   统一格式 + ffprobe 取时长 + 可选波形
   ↓
Stage 4  Transcript  官方接口优先，ASR 兜底 → segments.json
   ↓
Stage 5  Cite        arXiv API → BibTeX（自建，不依赖网站按钮）
   ↓
Stage 6  Package     生成静态站点数据（papers.json + 每篇目录）
   ↓
Stage 7  Serve       本地 http.server / 局域网访问
```

每一阶段独立可重跑，用 SQLite 记账，任何一步中断都能从断点继续。

---

## 4. 各阶段设计

### Stage 1 — Extract（最关键的设计决策）

**优先解析 JSON-LD，不要依赖 `$R[n]` 状态树。**

论文页里有一段给搜索引擎用的结构化数据：

```html
<script data-alphaxiv-id="json-ld-paper-detail-view" type="application/ld+json">
{"@context":"https://schema.org","@type":"ScholarlyArticle",
 "headline":"Attention Is All You Need",
 "author":[{"@type":"Person","name":"Ashish Vaswani", ...}],
 "abstract":"...", ...}
</script>
```

理由：JSON-LD 是对外的稳定契约（改了会影响 SEO），而 `$R[n]` 是前端框架的内部实现，随版本变化。**能用前者就不要用后者。**

抽取清单：

| 字段 | 来源 | 用途 |
|---|---|---|
| `arxiv_id` | URL 路径 | 主键 |
| `title` | JSON-LD `headline` | 卡片标题 |
| `authors[]` | JSON-LD `author[].name` | 卡片作者 |
| `abstract` | JSON-LD `abstract` | 详情页简介 |
| `published` | JSON-LD `datePublished` | 排序 |
| `group_id` | HTML 中 `["paper-group","<uuid>"]` | 稳定主键、目录名、音频文件名 |
| `audio_url` | HTML 中 `paper-podcasts.alphaxiv.org/<uuid>/podcast.mp3` | 下载 |
| `license` | arXiv API 的 `rel="license"` | 版权判断、署名 |

判定：HTML 里没有 `paper-podcasts.alphaxiv.org` → 该论文无播客 → 写 `no_podcast` 终态。

**时长不在首屏 HTML 里**，不要试图解析页面拿时长——下载后用 `ffprobe` 量，这是唯一可靠来源。

### Stage 2 — Fetch

- `Range` 断点续传，写 `.part`，完成校验后原子改名。
- 校验 `Content-Length` 与本地字节数一致，记录 `sha256`。
- 并发上限 2~3；音频走 CDN，可以比页面抓取更宽松。
- 失败重试 3 次，指数退避 1→2→4→8s，仍失败进失败队列隔天重试。

存储：`data/audio/<group_id>/original.mp3`

### Stage 3 — Transcode

```bash
# 统一为 MP3 64kbps 单声道：浏览器全兼容、体积可控
ffmpeg -i original.mp3 -ac 1 -ar 24000 -c:a libmp3lame -b:a 64k \
       -id3v2_version 3 -metadata title="..." episode.mp3

# 取时长（卡片上显示的播客时长）
ffprobe -v error -show_entries format=duration -of csv=p=0 episode.mp3

# 可选：播放器画波形用的降采样峰值
ffmpeg -i episode.mp3 -ac 1 -filter:a "aresample=8000" -map 0:a \
       -c:a pcm_s16le -f s16le - | python3 -c "..." > peaks.json
```

**不要转 Opus。** 如果将来有一天想接回 Apple Podcasts，Opus 会直接播不了。MP3 64k 单声道 15 分钟约 7MB，性价比最好。

### Stage 4 — Transcript

两条路线，产出统一格式：

**路线 A（优先）**：抓官方接口。侦察方法见 `docs/endpoints.md` 流程——无痕窗口打开论文页，DevTools 勾 `Fetch/XHR` + `WS`，展开 Transcript 折叠区，抓那条请求。

**路线 B（兜底）**：ASR。

```python
from faster_whisper import WhisperModel

model = WhisperModel("large-v3", device="cpu", compute_type="int8")
segments, info = model.transcribe(
    "episode.mp3",
    word_timestamps=True,   # 词级时间戳是听写 diff 的前提，务必开
    vad_filter=True,
    beam_size=5,
    initial_prompt="arXiv, Transformer, attention, BLEU, benchmark, ablation",
)
```

归一化输出 `segments.json`：

```json
{
  "group_id": "015c9ef4-ac30-768d-928b-847320902575",
  "source": "official",
  "language": "en",
  "duration": 932.4,
  "segments": [
    {
      "i": 0,
      "start": 0.0,
      "end": 8.42,
      "speaker": "host",
      "text": "Welcome back to the paper discussion.",
      "words": [
        {"w": "Welcome", "s": 0.0, "e": 0.62}
      ]
    }
  ]
}
```

同时生成 `episode.vtt`（用于导出、iOS 原生播放器、以及任何外部播放器）。

### Stage 5 — Cite

**不要依赖网站上的 "Copy BibTeX" 按钮**（页面确实有这个按钮，但它不可批量、不可复现）。用 arXiv 官方 API 拿结构化字段自己拼：

```
https://export.arxiv.org/api/query?id_list=1706.03762
```

返回 Atom，含 `title`、`author[].name`、`published`、`arxiv:primary_category`、`arxiv:doi`。拼成：

```bibtex
@misc{arxiv1706.03762,
  title        = {Attention Is All You Need},
  author       = {Vaswani, Ashish and Shazeer, Noam and others},
  year         = {2017},
  eprint       = {1706.03762},
  archivePrefix= {arXiv},
  primaryClass = {cs.CL},
  url          = {https://arxiv.org/abs/1706.03762}
}
```

好处：批量、可离线、可复现、不增加对目标站的请求量。

### Stage 6 — Package

产出静态站点可直接消费的数据：

```
site/
├── index.html
├── app.js
├── data/
│   ├── papers.json                  ← 卡片列表的全部数据源
│   └── <group_id>/
│       ├── episode.mp3
│       ├── transcript.json          ← segments.json
│       ├── episode.vtt
│       ├── citation.bib
│       └── meta.json                ← 单篇的全部元数据
```

`papers.json` 的形态（首页只加载这一个文件）：

```json
[
  {
    "group_id": "015c9ef4-ac30-768d-928b-847320902575",
    "arxiv_id": "1706.03762",
    "title": "Attention Is All You Need",
    "authors": ["Ashish Vaswani", "Noam Shazeer"],
    "duration": 932.4,
    "license": "http://arxiv.org/licenses/nonexclusive-distrib/1.0/",
    "published": "2017-06-12",
    "has_transcript": true,
    "audio": "data/015c9ef4-.../episode.mp3",
    "transcript": "data/015c9ef4-.../transcript.json",
    "citation": "data/015c9ef4-.../citation.bib"
  }
]
```

**首页只加载 `papers.json`，点进卡片才按需加载音频和台词。** 几千篇也不会卡。

---

## 5. 状态机与数据库

```
discovered → extracted → audio_done → transcoded → transcript_done → packaged
                 └→ no_podcast（终态）
                 └→ failed（带 last_error，隔天重试）
```

```sql
CREATE TABLE papers (
  arxiv_id       TEXT PRIMARY KEY,
  group_id       TEXT UNIQUE,
  title          TEXT,
  authors        TEXT,          -- JSON 数组
  abstract       TEXT,
  published      TEXT,
  license        TEXT,
  audio_url      TEXT,
  audio_bytes    INTEGER,
  audio_sha256   TEXT,
  duration_s     REAL,
  transcript_src TEXT,          -- official | asr
  bibtex         TEXT,
  status         TEXT NOT NULL,
  updated_at     TEXT,
  last_error     TEXT
);
```

`no_podcast` 必须落表并终态化，否则每轮重跑都会把无播客的论文重新请求一遍（这类占多数）。

---

## 6. 静态播放器的交互设计

### 一个重要的技术决策

**不要用 `<track>` 原生字幕。** 原生字幕只能"显示"，做不到你要的三件事：点击某行跳转、当前句高亮、听写模式。

正确做法：**用 JS 把 `segments` 渲染成 DOM 列表**，`episode.vtt` 只作为导出格式保留。

### 首页：论文卡片列表

```
┌──────────────────────────────────────────────┐
│ Attention Is All You Need                    │
│ Vaswani, Shazeer, Parmar +5      [15:32] ●●● │
└──────────────────────────────────────────────┘
```

卡片字段：标题、作者（超过 3 位折叠成 `+N`）、时长（`mm:ss`）、已听进度、有无台词标记。
筛选：按标题/作者搜、按时长筛、按"未听/已听"筛、按论文许可筛。

### 详情页：播放器 + 台词面板

```
┌─ Attention Is All You Need ──────────── Vaswani+5 ─┐
│  ⏮  ⟲3s  ▶  ⟳3s  ⏭      1.0x   00:42 / 15:32     │
│  ══════════════●═══════════════════════════════════  │
├────────────────────────────────────────────────────┤
│  0:38  Welcome back to the paper discussion.        │
│  0:42  Today we're looking at the Transformer,  ●   │  ← 当前句高亮
│  0:51  which replaced recurrence with attention.    │
│  1:03  Let's start with the encoder stack.          │
├────────────────────────────────────────────────────┤
│  [BibTeX]  [复制全文]  [听写模式]  [导出 VTT]        │
└────────────────────────────────────────────────────┘
```

控制条：播放/暂停、`-5s`、`-3s`、`+3s`、`+5s`、上一句、下一句、倍速（0.75/1.0/1.25/1.5）。

快捷键：`空格` 播放暂停、`←/→` 前后 3 秒、`↑/↓` 上一句/下一句、`1~4` 切倍速。

### 四个实现细节（决定手感）

1. **当前句定位用二分查找。** `timeupdate` 每 250ms 触发一次，若每次遍历几千条会掉帧。对 `segments` 的 `start` 数组做二分。
2. **自动滚动要能被用户打断。** 用户手动滚动后，暂停自动滚动 5 秒再恢复，否则看后面台词时会被反复拽回。
3. **点击跳转要留 0.15s 余量。** `audio.currentTime = seg.start - 0.15`，否则会切掉句首的辅音，听感上像"少了一个词"。
4. **进度用 `localStorage`。** 按 `group_id` 存 `{lastTime, playCount, finished}`，不需要后端。

### 听写模式

台词默认模糊（`filter: blur(4px)`），点击某行展开；空格键逐句推进。你输入的内容与 `segment.text` 做词级 diff，同时用 `segment.words` 的词级时间戳定位漏听的词，一键收进生词表。

---

## 7. 待验证清单（在自己机器上跑）

网络在我这边不稳定，下面三项必须在你的环境复测：

1. **文字稿接口**：无痕窗口 + DevTools，展开 Transcript，看请求是否 200、是否需要带 token。这决定 Stage 4 走 A 还是 B。
2. **音频 CDN 的稳定性**：连续拉 50 个不同文件的 Range，看是否有速率限制。
3. **`api.alphaxiv.org` 是否需要鉴权**：如需要，Stage 1 全部走 HTML 解析，不碰 API。

三项测完再动手写代码，能避免大量返工。

---

## 8. 命令行形态

```bash
# 发现并入库
python3 -m axlisten discover --ids 1706.03762,2501.00001

# 跑完整管线（可中断，重跑只做未完成的）
python3 -m axlisten build --limit 50 --workers 2 --rate 1

# 只重做台词（比如换了 ASR 模型）
python3 -m axlisten transcribe --redo --model large-v3

# 生成静态站点数据
python3 -m axlisten package --out ./site

# 本地起服务，手机同 Wi-Fi 访问
python3 -m http.server 8765 --directory ./site
```

`build` 必须是幂等的：已 `packaged` 的论文零下载请求，最多一次 HEAD 校验。
