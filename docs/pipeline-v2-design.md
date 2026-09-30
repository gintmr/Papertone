# 管线 v2：推荐流驱动 + 轻量字段 + 中文翻译

本版基于 2026-09-30 实测，替换 v1 里「抓 sitemap 全站」的思路。

---

## 1. 抓取源改为推荐流 API（实测可用）

### 1.1 接口

```
GET https://api.alphaxiv.org/papers/v3/feed
  ?pageNum=1
  &pageSize=100
  &sort=Hot
  &interval=3 Days
  &topics=["cs.CL"]
  &linkBlogs=true
```

| 参数 | 合法值 | 说明 |
|---|---|---|
| `sort` | `Hot` `Comments` `Views` `Likes` `GitHub` `ForYou` `Recent` | `Recent` 按最新发布，`Hot` 按热度 |
| `interval` | `3 Days` `7 Days` `30 Days` `90 Days` `All time` | 时间窗口 |
| `topics` | JSON 数组字符串，如 `["cs.CL","cs.LG"]` | 门类筛选，实测生效 |
| `pageSize` / `pageNum` | 整数 | 分页 |

### 1.1.1 排序参数极其关键（实测修正）

不同 `sort` 拿到的论文天差地别，**播客覆盖率差 90 个百分点**：

| sort | 年龄中位 | 浏览量中位 | 播客覆盖率 |
|---|---|---|---|
| `Hot` | 不到 3 天 | 7 | 约 0% |
| `Recent` | 0.8 天 | 0 | 0% |
| **`Views`** | **51 天** | **2,241** | **93%** |
| **`Likes`** | **44 天** | **2,214** | **93%** |

原因：播客不是实时生成的。新论文发布后要过一段时间才会被生成播客，
所以刚发布的论文覆盖率接近 0，而已经积累了几百上千浏览量的论文接近 100%。

**结论：抓播客必须用 `sort=Views` 或 `sort=Likes`，绝不能用 `Hot` 或 `Recent`。**

### 1.2 登录要求（关键）

源码里写的是：

```js
credentials: sort === `ForYou` ? `include` : `omit`
```

实测结果：

| sort | 匿名访问 |
|---|---|
| `Hot` / `Recent` / `Views` 等 | 可以，HTTP 200 正常返回 |
| `ForYou` | 不行，HTTP 401「You must be logged in to see recommended papers」 |

所以你截图里的「For you」那一栏是拿不到的（除非用你的账号 cookie，不建议）。
但「Trending」（`sort=Hot`）匿名完全可用，再叠加 `interval=3 Days` 和 `topics` 门类筛选，
效果就等同于你要的「每天 / 近期的推荐论文」。

### 1.3 feed 返回的字段（一条）

```json
{
  "paper_group_id": "01a0f075-7897-7252-bd15-f54e5b6ecb2a",
  "universal_paper_id": "2609.37053",
  "title": "...",
  "abstract": "...",
  "feed_description": "MatToolBench lets researchers test whether ...",
  "authors": ["Mei Wu", "Rui Xie", "..."],
  "organization_info": [{"name": "Shanghai Jiao Tong University", "...": "..."}],
  "image_url": "https://thumbnails.assets.alphaxiv.org/2609.37053v1.png",
  "narration_audio_url": null,
  "topics": ["Computer Science", "cs.AI"],
  "metrics": {"visits_count": {"all": 382}, "total_votes": 21},
  "publication_date": "2026-09-29T08:58:51.000Z",
  "canonical_id": "2609.37053v1"
}
```

一次请求就把卡片列表需要的所有字段都拿到了，不用解析 HTML。

### 1.4 播客发现（重要）

feed 里的 `narration_audio_url` 指向 `briefs-tts.alphaxiv.org/tts/<uuid>.mp3`，
那是约 29 秒的摘要朗读，**不是**你要的听力材料。

你要的论文播客在另一个位置：

```
https://paper-podcasts.alphaxiv.org/<paper_group_id>/podcast.mp3      约 5 分钟对话讲解
https://paper-podcasts.alphaxiv.org/<paper_group_id>/transcript.json  对应台词
```

存在性判定（20 篇抽样实测）：

| 返回码 | 含义 |
|---|---|
| `206`（带 Range 请求） | 有播客 |
| `403`（S3 AccessDenied） | 没有播客 |

`podcast.mp3` 和 `transcript.json` 的返回码完全一致，所以一个 Range 请求就能判定。

抽样结果（`sort=Views`，90 天窗口，取前 30 篇）：**28/30 有播客，覆盖率 93%**。

存储桶里只有两个文件，已逐一探测确认：

| 文件名 | 结果 |
|---|---|
| `transcript.json` | 206 存在 |
| `podcast.mp3` | 206 存在 |
| `timing.json` / `cues.json` / `alignment.json` / `words.json` | 403 不存在 |
| `podcast.vtt` / `podcast.srt` / `captions.vtt` / `transcript.vtt` | 403 不存在 |

---

## 2. 轻量化字段（按需求裁剪）

### 保留

| 字段 | 来源 | 用途 |
|---|---|---|
| `id`（arXiv id） | feed `universal_paper_id` | 主键、外链 |
| `title` | feed `title` | 卡片标题 |
| `authors` | feed `authors` | 卡片作者 |
| `abstract` | feed `abstract` | 详情页 |
| `links` | 拼装 | alphaxiv / arXiv 原文跳转 |
| `license` | 论文页 `license` 字段 | 版权标记，建议保留 |
| `audio` | podcast.mp3 | 播放 |
| `segments[]` | 官方文本 + 对齐 + 翻译 | 台词、跳转、听写 |

### 丢弃

`pdf_url`、`markdown_path`、`thumbnail_url`（不需要卡片配图的话）、`versions[]`、
`author_details`（sameAs 与学术主页）、`source_name`、`pageWidthPt`、`comments`、
`recommended-papers` 等。

体积对比：v1 的 meta.json 8.6KB，裁剪后约 1KB（不含台词）。

---

## 3. 新增：中文翻译阶段

### 3.1 位置

放在对齐之后，因为需要 `segments[]` 的完整句子。逐句翻译比整篇翻译更适合对照显示。

### 3.2 为什么逐句翻译

- 播放器要按行对照，逐句粒度天然对齐；
- 逐句翻译时把前后各 1 句一起传进去作为上下文，质量接近整篇翻译；
- 单篇 5 分钟播客只有 15~20 句、约 5500 字符，成本极低。

### 3.3 实现要点

```python
def translate_segments(segments, prev_ctx=1):
    for i, seg in enumerate(segments):
        ctx = segments[max(0, i - prev_ctx): i + prev_ctx + 1]
        seg["zh"] = call_llm(build_prompt(ctx, target=seg))
        seg["zh_model"] = MODEL_ID
```

三条必须遵守的工程约束：

1. 缓存：按「英文句哈希 + 模型名」存翻译结果，重跑不重复花钱。
2. 术语表：把 attention / self-attention / encoder / decoder / multi-head 固定成
   注意力 / 自注意力 / 编码器 / 解码器 / 多头，否则同一篇里译名会漂移。
3. 失败降级：翻译失败就保留英文、`zh` 置 null，播放器只显示英文，不要让整篇失败。

### 3.4 播放器侧的开关

四条独立模式，互不干扰：

| 模式 | 显示内容 |
|---|---|
| 纯英文 | 只显示 `en` |
| 英文 + 中文对照 | `en` 在上，`zh` 在下（小字灰色） |
| 纯中文 | 只显示 `zh` |
| 听写模式 | 两者都隐藏，逐句揭示 |

建议默认把中文折叠起来：精听时中文很容易变成拐杖，先盲听，对不上再展开。

---

## 4. 管线 v2 全流程

| 阶段 | 动作 | 输出 |
|---|---|---|
| Stage 1 Feed | 调 `/papers/v3/feed`，**`sort=Views`**，`interval=30 Days`，`topics=你的门类` | 候选清单 |
| Stage 2 Probe | 对每个 groupId 发 Range 请求探测 podcast.mp3 | 206 保留，403 记终态 |
| Stage 3 Fetch | 下载 podcast.mp3 和官方 transcript.json | 音频 + 官方文本 |
| Stage 4 Align | ffprobe 取时长，ASR 取时间轴，对齐官方文本 | segments 含词级时间戳 |
| Stage 5 Translate | 逐句翻译，带缓存和术语表 | segments 增加 zh 字段 |
| Stage 6 Publish | 生成 papers.json 和每篇 episode.json | 静态站点数据 |

每天跑一次的增量逻辑：Stage 1 用 `sort=Views` + `interval=7 Days` 拉最近一周的热门，
Stage 2 用本地已抓列表去重，只处理新增。这一批的播客覆盖率约 90%，
所以一周累积下来是相当可观的听力素材量。

---

## 5. 官方没有时间戳（已彻底确认）

三种独立验证都指向同一结论：

1. 抽查 16 篇有播客的论文，`transcript.json` 的键只有 `speaker` 和 `line`，**无任何时间字段**；
2. 存储桶里除 `transcript.json` 和 `podcast.mp3` 外，所有候选时间轴文件名一律 403；
3. 站点播放器源码里是 `e.start == null ? <p> : <button>`，说明它自己也没有时间数据，
   那个"点击台词跳转"的功能在该站点上实际是失效的。

**所以句级时间戳只能自己生成**，做法是：官方文本当准绳，ASR 只提供时间轴。

### 5.1 模型选择（实测耗时，5 分 18 秒音频）

| 模型 | 磁盘占用 | 耗时 | 词匹配率 | 句级偏差（相对 small） |
|---|---|---|---|---|
| `tiny` | 75MB | **9.6 秒** | 94.8% | 平均 0.18s，最大 0.66s |
| `base` | 141MB | **16.0 秒** | 95.0% | 平均 0.09s，最大 0.56s |
| `small` | 464MB | 45.9 秒 | 95.9% | 基准 |

如果只需要句级时间戳，**`base` 是最佳性价比**：偏差不到 0.1 秒，
速度是 `small` 的近 3 倍。只有在需要词级听写比对时才有必要上 `small`。

### 5.2 单篇总耗时预算

| 环节 | 耗时 |
|---|---|
| feed 请求 | 一次拿 100 篇，摊到每篇约 0.01 次请求 |
| 播客探测 | 一个 Range 请求，不到 1 秒 |
| 音频下载 | 3.8MB，几秒 |
| 对齐 | 16 秒（base） |
| 翻译 | 约 5500 字符，几秒 |

单篇约 30 秒，一天新增 30 篇有播客的论文，后台 15 分钟跑完。
