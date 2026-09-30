# alphaXiv 播客抓取工具：开发指南与流程计划

目标：把 alphaXiv 上论文的 AI 播客（音频 + 文字稿）批量抓到本地，做成可用于**英语精听核对**的资料库。

本指南中的接口结构来自 2026-09-30 对线上站点的实测，不是推测。

---

## 0. 实测侦察结果（先看这个，能省掉一半试错）

抓取 `https://www.alphaxiv.org/abs/1706.03762` 的原始 HTML 后得到：

| 项目 | 实测结果 |
|---|---|
| 前端框架 | TanStack Start（SSR）+ TanStack Query 脱水状态，HTML 内含 `$R[n]` 状态树 |
| 音频直链 | `https://paper-podcasts.alphaxiv.org/<podcast_uuid>/podcast.mp3` |
| 音频在 HTML 中的位置 | `<audio src="https://paper-podcasts.alphaxiv.org/.../podcast.mp3" preload="metadata">`，**SSR 直出，无需执行 JS** |
| 播客状态字段 | `{state:"done", podcastPath:"015c9ef4-.../podcast.mp3"}`，挂在 query key `["live","paper-podcast;<paper_group_id>"]` 下 |
| ID 体系 | 播客主键是 **paper group id**（如 `015c9ef4-ac30-768d-928b-847320902575`），不是 arXiv id；同一论文的不同版本另有 `paper-version` uuid |
| 文字稿 | 页面上有 `Transcript` 折叠区块，但 SSR 阶段只有骨架屏 → **文字稿是展开时才请求的**，需自行抓真实接口 |
| 已知 API 主机 | `api.alphaxiv.org`（例：`https://api.alphaxiv.org/open-graph/v1/paper/1706.03762.png`） |
| 其他资源域 | `paper-podcasts.alphaxiv.org`、`paper-assets.alphaxiv.org`、`pdfs.assets.alphaxiv.org`、`thumbnails.assets.alphaxiv.org`、`proxy.assets.alphaxiv.org` |
| robots.txt | `User-agent: *` → `Allow: /`，但 **`Disallow: /?`**（禁止带查询串的 URL）与 `Disallow: /signin?` |
| 站点地图 | `https://www.alphaxiv.org/sitemaps/sitemap-index.xml`（robots.txt 中声明） |
| 播放器能力 | 存在 `aria-label="Download audio"`、`Playback speed`、`Seek`、前后 15 秒等控件 |
| 官方渠道线索 | 页面存在 `MCP Server`、`Browser Extension` 入口 → 值得先确认官方是否已提供 API / MCP，可能省掉整个爬虫 |

三条最重要的结论：

1. 音频 URL 就在论文页 HTML 里，正则即可提取，**不需要无头浏览器**跑几千个页面。
2. 音频主键是 `paper_group_id`，论文页 URL 用 arXiv id，两者需映射；映射关系同样在 HTML 中（`["paper-group","<uuid>"]`）。
3. robots 明确禁止 `/?` 这类查询串路径 → 论文枚举要走路径型 URL（sitemap、`/abs/<id>`），不要翻带 `?` 的列表页。

---

## 1. 需求定义与验收标准

### 功能需求

- **F1 发现**：枚举站点上存在播客的论文，产出待抓清单。
- **F2 音频**：下载 `podcast.mp3`，断点续传、去重、完整性校验。
- **F3 文字稿**：拿到与音频一致的文字稿（优先官方接口，兜底 ASR），最好带句级/词级时间戳。
- **F4 对齐与打包**：产出 `音频 + .vtt/.srt + 逐段 Markdown`，可边听边看。
- **F5 增量更新**：只抓新增；重跑不重复下载。
- **F6 核对工作流**（核心诉求）：按句跳转、隐藏文字做听写、标记没听清的词。

### 验收标准（建议写进 README）

- 给定 10 篇指定论文，音频抓取率 100%，可播放且时长与页面一致。
- 文字稿段落与音频时间轴一一对应，任抽 3 处可对齐。
- 重复运行不产生重复文件，已抓论文零下载请求（至多 HEAD 校验）。
- 全程限速：单线程 ≥1s 间隔，遇 429/503 立即退避。

---

## 2. 合规红线（先定边界，再写代码）

- **遵守 robots.txt**：`Disallow: /?` 是硬约束，别用 `?page=2` 翻页。
- **控制速率**：默认 1~2 请求/秒，并发 ≤2，夜间跑，无条件服从 `Retry-After`。
- **不绕过鉴权**：需要登录才能看的内容不抓；不处理 CAPTCHA、不伪造 token。
- **UA 署名 + 联系方式**：写明用途与邮箱，出问题时对方能联系你而不是直接封段。
- **仅个人学习**：下载内容不公开分发、不二次上传、不商用。
- **先确认官方 API / MCP**：有官方渠道就优先用，既合规又省力。

若站点后续加强 Cloudflare 校验或条款明确禁止自动抓取，正确做法是停手并联系官方要授权，而不是加代理池硬顶。

---

## 3. 总体架构

```
        ┌──────────────┐
        │  Discovery   │  sitemap / 你的论文清单 → papers 表
        └──────┬───────┘
               ▼
    ┌────────────────────────────────┐
    │  Extractor（论文页 HTML 解析）  │
    │  → group_id, audio_url, state  │
    └──────┬─────────────────────────┘
           ▼
    ┌──────────────┐   ┌───────────────┐   ┌────────────┐
    │  Downloader  │   │  Transcript   │   │  State/DB  │
    │  mp3 断点续传 │   │ 官方接口 / ASR │   │ SQLite 账本 │
    └──────┬───────┘   └───────┬───────┘   └──────┬─────┘
           └──────────┬────────┘                  │
                      ▼                           │
               ┌─────────────┐                    │
               │  Aligner    │◄───────────────────┘
               │  VTT / SRT  │
               └──────┬──────┘
                      ▼
               ┌─────────────┐
               │  Exporter   │  Markdown / Anki / 本地播放页
               └─────────────┘
```

五个模块各自独立、可单独重跑。不要写成一跑到底的大脚本：跑到第 3000 篇崩了，你要的是从崩溃点继续，而不是从头再来。

### 推荐技术栈

| 层 | 选择 | 理由 |
|---|---|---|
| 语言 | Python 3.11+ | ASR / 音频生态最全 |
| HTTP | `httpx`（HTTP/2 + Range 流式） | 连接池、重试、断点 |
| HTML 解析 | 正则为主，`selectolax` 兜底 | 只抽 3 个字段，不必上 Playwright |
| 状态库 | SQLite | 无依赖，支持断点、幂等、统计 |
| 音频处理 | `ffmpeg` | 转码压缩、切片、波形 |
| 兜底 ASR | `faster-whisper` | 本机可跑，带词级时间戳 |
| 调度 | `APScheduler` 或系统 `launchd`/`cron` | 每日增量 |
| 可选界面 | 静态 HTML + `<audio>` + VTT | 不引前端框架，够用 |

只有当文字稿接口藏在前端签名逻辑里、无法复现时，才上 Playwright。

---

## 4. 关键接口与数据结构

### 4.1 论文页解析（已实测可行）

从 `/abs/<arxiv_id>` 的 HTML 抽取：

```python
AUDIO_RE = r"https://paper-podcasts\.alphaxiv\.org/([0-9a-f-]{36})/([^\s\"'>]+)"
STATE_RE = r'state:"(\w+)",podcastPath:"([^"]+)"'
GROUP_RE = r'\["paper-group","([0-9a-f-]{36})"'
```

- `state:"done"` → 播客已生成，可下载。
- 页面无 `paper-podcasts.alphaxiv.org` → 该论文无播客，标记跳过。
- `paper_group_id` 作为去重主键：论文换版本，播客是同一个。

### 4.2 文字稿（需要你补一次侦察）

文字稿懒加载，必须抓真实请求：

1. 打开有播客的论文页，DevTools → Network，勾选 `Fetch/XHR` 与 `WS`。
2. 展开页面的 `Transcript` 折叠区。
3. 记录那条请求的完整 URL、方法、请求头、响应结构（纯文本 / JSON / 分段时间轴？）。
4. 特别留意 WebSocket/SSE：该站存在 query key `["live","paper-podcast;<group_id>"]`，说明有实时通道，文字稿可能通过流推送而非 REST。
5. 右键 → `Copy as cURL`，存入 `docs/endpoints.md`，作为唯一事实来源。

拿到接口后统一成：

```json
{
  "podcast_id": "015c9ef4-...",
  "segments": [
    {"start": 0.0, "end": 8.4, "speaker": "host", "text": "..."}
  ]
}
```

若确实没有公开文字稿接口，走 ASR 兜底（见 6.2）。对精听而言 ASR 稿够用，且自带词级时间戳，核对体验甚至更好。

### 4.3 发现（Discovery）

优先级从高到低：

1. `https://www.alphaxiv.org/sitemaps/sitemap-index.xml` → 分片 sitemap → 论文 URL 列表。
2. 你自己的阅读清单 / 收藏 / arXiv 订阅（**建议从这里起步**，几百篇够练半年）。
3. 站内搜索 / 列表页——只能走路径型 URL，带 `?` 的会被 robots 拒绝。

---

## 5. 分阶段实施计划

工时按"每天有效投入 3~4 小时"估算。

| 阶段 | 内容 | 产出 | 工时 |
|---|---|---|---|
| **P0 侦察** | DevTools 抓文字稿接口；确认官方 API/MCP；存 20 篇样本页 | `docs/endpoints.md` + `samples/` | 0.5~1 天 |
| **P1 单篇 MVP** | 输入 arXiv id → 输出 mp3 + 文字稿 + VTT | 跑通一篇 | 1 天 |
| **P2 批量与幂等** | SQLite 账本、断点续传、限速、重试、日志 | 100 篇可中断续跑 | 2~3 天 |
| **P3 全量发现** | sitemap 解析、播客存在性探测、增量更新 | 全站清单 + 每日增量 | 1~2 天 |
| **P4 对齐与学习化** | 分段 VTT、播放页、听写模式、生词标记 | 真正能拿来练听力 | 2~3 天 |
| **P5 运维** | 定时任务、磁盘监控、失败队列、后台运行 | 无人值守 | 1 天 |

关键建议：P1 之后先用 10 篇真实跑完并自己听一遍。只有听完才知道分段对不对、时间轴偏不偏、播放页还缺什么。提前跳到 P3 做全量，几乎一定会返工重下。

---

## 6. 关键技术难点与对策

### 6.1 音频下载

- 用 **HTTP Range 断点续传**，写 `.part` 临时文件，完成后原子改名。
- 下载前记 `Content-Length`，完成后校验字节数；有 `ETag`/`Content-MD5` 一并落库。
- 单文件几 MB 到几十 MB。建议转码保存：mp3 → opus/m4a 32~48 kbps 语音码率，体积可减 70% 以上，精听体验无损。
- 并发上限 2~3；不要对单个文件开多线程分段下载。

### 6.2 文字稿兜底：ASR

```bash
pip install faster-whisper
```

```python
from faster_whisper import WhisperModel

model = WhisperModel("large-v3", device="cpu", compute_type="int8")
segments, info = model.transcribe(
    "podcast.mp3",
    word_timestamps=True,
    vad_filter=True,
    beam_size=5,
)
```

- 双人对谈建议直接上 `large-v3`；`distil-large-v3` 更快但精度略低。
- `vad_filter=True` 去掉静音段，时间轴更准。
- 专有名词（术语、作者名）易错，把术语表塞进 `initial_prompt` 能显著改善。
- **混合方案精度最高**：官方文字稿提供文本，ASR 提供时间轴。

### 6.3 时间轴对齐与分段

- 精听理想片段长度 **8~15 秒**；过长会失去定位意义。
- 分段策略：优先官方分段；否则用 ASR 句边界 + 静音检测合并到目标长度。
- 输出两份：`.vtt`（播放器字幕）与 `.md`（每段前带 `[mm:ss]`，便于跳转核对）。

### 6.4 幂等与状态机

```
discovered → has_podcast → audio_done → transcript_done → packaged
                    └→ no_podcast（终态，不再重试）
```

```sql
CREATE TABLE papers (
  arxiv_id       TEXT PRIMARY KEY,
  group_id       TEXT,
  title          TEXT,
  status         TEXT NOT NULL,
  audio_url      TEXT,
  audio_bytes    INTEGER,
  audio_sha256   TEXT,
  transcript_src TEXT,          -- official | asr
  updated_at     TEXT,
  last_error     TEXT
);
CREATE UNIQUE INDEX idx_group ON papers(group_id) WHERE group_id IS NOT NULL;
```

`no_podcast` 必须是终态并落表，否则每次重跑都会把无播客论文重新请求一遍——这类论文占多数。

### 6.5 反爬与稳定性

- 先用 5 篇压测：连续 50 次请求后观察是否出现 403/429/挑战页。
- 出现 Cloudflare 挑战页（HTML 含 `Just a moment`）立刻停止，不要重试打满。
- 请求全部走指数退避（1s → 2s → 4s → 8s），失败 3 次进失败队列，隔天重试。
- 记录每次响应状态码统计，异常比例上升说明策略需调整。

---

## 7. 目录结构建议

```
alphaxiv-listening/
├── data/
│   ├── state.sqlite
│   ├── audio/<group_id>/podcast.mp3
│   └── transcript/<group_id>/
│       ├── raw.json          # 官方接口原始响应
│       ├── segments.json     # 统一格式
│       ├── podcast.vtt
│       ├── podcast.srt
│       └── podcast.md        # 带 [mm:ss] 的逐段稿
├── samples/                  # 原始 HTML 样本，用于回归测试解析器
├── docs/endpoints.md         # 抓包记录（唯一事实来源）
├── logs/
└── src/
    ├── discover.py
    ├── extract.py
    ├── download.py
    ├── transcribe.py
    ├── align.py
    ├── export.py
    └── cli.py
```

把**原始 HTML 样本存下来**很重要：`$R[n]` 状态树随时可能变动，有样本就能写离线回归测试，改解析器时不必反复打线上。

---

## 8. 学习用途增强（决定工具好不好用）

抓下来只是原料，精听体验靠这些：

1. **播放页**：HTML + `<audio>` + `track` 加载 VTT，点句子跳到对应时间点。
2. **听写模式**：文字稿默认隐藏，逐句显示；输入听写结果做词级 diff，高亮漏听与错听。
3. **疑难词清单**：把 diff 中错过的词收进 `words.csv`，带对应音频切片（`ffmpeg -ss ... -t ...`）导出 Anki。
4. **进度记录**：每篇听过几遍、最后听到第几段。
5. **慢速副本**：生成 0.75x 版本，第一遍慢速精听，第二遍原速复核。
6. **通用导出**：`.vtt` 可直接拖进 VLC / IINA / iOS 播客 App，通勤也能练。

---

## 9. 风险清单

| 风险 | 影响 | 对策 |
|---|---|---|
| 文字稿无公开接口 | 拿不到官方稿 | ASR 兜底；或"官方文本 + ASR 时间轴"混合 |
| 前端状态树改版 | 解析器失效 | 存 HTML 样本 + 解析失败告警；解析逻辑独立成函数 |
| Cloudflare 加强校验 | 全线不可用 | 降速、暂停、联系官方；不做绕过 |
| 磁盘爆满 | 抓一半崩 | 转码压缩 + 磁盘阈值告警 + 限定清单 |
| 站点条款变化 | 合规风险 | 每季度复查 robots.txt 与 ToS |
| UUID 与论文映射错误 | 张冠李戴 | 一律以 HTML 中的 `paper_group_id` 为键，不自行拼接 |

---

## 10. 最小可用原型

同目录的 `alphaxiv_podcast_probe.py` 是 P1 起点，零依赖（纯标准库）：

```bash
# 单篇：抽取音频直链与 group id
python3 alphaxiv_podcast_probe.py 1706.03762

# 下载音频（带 .part 断点续传）
python3 alphaxiv_podcast_probe.py 1706.03762 --download ./audio

# 探测候选文字稿地址（抓到真实接口后请替换成真实 URL）
python3 alphaxiv_podcast_probe.py 1706.03762 --probe-transcript

# 离线解析已保存页面（改解析器时用，不打线上）
python3 alphaxiv_podcast_probe.py --html samples/1706.03762.html --json
```

已实现：音频直链抽取、`paper_group_id` 抽取、播客状态判定、断点续传下载、候选文字稿探测。P2 要做的是把它扩成带 SQLite 账本与限速的批处理。

---

## 11. 现在就该做的三件事

1. **去 DevTools 展开一次 Transcript，把接口抄下来。** 这一步决定后面是 2 天工作量还是 2 周工作量。
2. **先确认官方是否有 API / MCP。** 页面上有 `MCP Server` 入口，若官方已提供接口，整个爬虫方案可砍掉一大半。
3. **拿 10 篇你真正想听的论文跑通全流程，并自己听一遍。** 听完再决定是否扩展成全站清单。

优先级排序：**官方接口 > 页面解析 > 浏览器自动化**。能用低层级方案解决的，不要上高层级。
