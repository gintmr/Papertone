# Papertone

把 alphaXiv 的论文播客抓成本地英语精听素材库：音频 + 句级时间轴 + 中英对照。

## 快速开始

播放器需要本地服务器（`fetch` 不能走 `file://`）。这里就是网站根目录：

```bash
cd /Users/gintmr/Downloads/Projects/Podcast-alphaXiv
python3 scripts/serve.py           # 默认端口 8765
# 浏览器打开 http://localhost:8765/
```

用 `scripts/serve.py` 而不是 `python3 -m http.server`，是因为**标准库的 http.server
不支持 HTTP Range 请求**，请求音频时会整文件返回 200 而不是 206。GitHub Pages 是支持
Range 的，本地用 http.server 测拖动进度条会得到和线上不一致的行为。这个脚本补上了
Range 支持，本地环境尽量贴近线上。

手机同 Wi-Fi 访问时，用本机局域网 IP，例如 `http://192.168.1.5:8765/`
（脚本启动时会打印提示；macOS 上可在「系统设置 → 网络」里查 IP）。

## 部署到 GitHub Pages

仓库已经按"**仓库根目录即网站根目录**"组织好了，所以不需要任何构建步骤，
也不需要 `gh-pages` 分支或 GitHub Actions。

```bash
cd /Users/gintmr/Downloads/Projects/Podcast-alphaXiv
git init
git add .
git commit -m "Papertone: alphaXiv 播客精听库"
git branch -M main
git remote add origin git@github.com:<你的用户名>/Podcast-alphaXiv.git
git push -u origin main
```

然后在仓库页面 **Settings → Pages**：

- Source 选 `Deploy from a branch`
- Branch 选 `main`，目录选 `/ (root)`
- 保存后等一两分钟

访问地址是 `https://<你的用户名>.github.io/Podcast-alphaXiv/`。

播放器里所有路径都是相对的（`data/papers.json`、`data/<id>/...`），
所以不管是用户站（`user.github.io`）还是项目站（`user.github.io/repo/`）都能直接用。

### 三个必须注意的点

**一、`_work/` 绝对不能提交。** 它有 970MB，GitHub 会拒绝超过 100MB 的单文件。
仓库里的 `.gitignore` 已经排除了它，`git add .` 时不会带上。提交前可以自查：

```bash
git status --short | head          # _work/ 不应出现在列表里
du -sh --exclude=_work .           # 实际会提交的体积，应该在 4MB 左右
```

**二、免费账号的 Pages 网站是公开的。** 即使仓库设为 private，Pages 站点本身仍然
任何人都能访问（私有仓库的 Pages 需要 GitHub Pro）。这也意味着音频文件会被公开分发，
而多数 arXiv 论文用的是默认非独占许可，并不授权第三方再分发。
页面已加 `<meta name="robots" content="noindex">`，不会被搜索引擎收录，
但这只是"不被发现"，不等于"访问受控"。

如果这个库将来要放几十上百篇，建议要么只部署播放器 + 少量样片，要么换成
支持访问控制的托管（Cloudflare Pages + Cloudflare Access）。

**三、仓库体积与 Pages 的体积上限是两回事**（以下均为 GitHub 官方文档原文口径）：

| 限制 | 数值 | 性质 |
|---|---|---|
| 仓库体积 | 建议 < 1GB，**< 5GB 强烈建议** | 建议，不是硬上限 |
| 单个文件 | 100MB | 硬上限，超过直接拒绝 |
| 单次推送 | 2GB | 硬上限 |
| **Pages 站点体积** | **不得超过 1GB** | 硬性使用限制 |
| Pages 带宽 | 每月 100GB（soft） | 软上限 |

也就是说：**仓库本身确实可以超过 1GB**，但既然你要部署到 Pages，
**1GB 是真正卡住你的那条线**。

单集音频约 4.2MB（音频 4MB + 预览图 50KB），所以约 240 集触顶。
另外要记住 Git 是快照式版本控制——**二进制文件一旦进入历史就永久留着**，
替换一集音频等于再占一份空间。所以这个上限只会越来越紧。

超过之后的正路是把音频挪到对象存储（Cloudflare R2 出站免费），
仓库里只留播放器、索引和字幕。

## 目录结构

仓库根目录就是网站根目录，`index.html` 打开即用，没有构建步骤。

```
Podcast-alphaXiv/                ← 仓库根 = 网站根
├── index.html                   播放器页面
├── app.css                      样式（设计令牌沿用 gintmr.github.io）
├── app.js                       播放逻辑、时间轴高亮、定时停止
├── data/                        成品数据：播放器真正要用的东西
│   ├── papers.json                   列表页数据源
│   └── <paper_id>/
│       ├── episode.json              标题/作者/摘要/封面 + 句级时间轴 + 中英对照
│       ├── segments.json             对齐中间产物（含 speaker 与原始句）
│       ├── transcript.json           官方原文
│       ├── transcript.zh.json        中文稿
│       ├── meta.json                 抓取时的元数据（许可证、BibTeX 等）
│       ├── cover.png                 论文首页预览图
│       └── audio/podcast.mp3         音频
├── scripts/                     抓取、处理与验收脚本
│   ├── add_episode.py                增量抓取一篇或多篇（主入口）
│   ├── align_transcript.py           官方文本 + 本地 ASR 对齐出句级时间轴
│   ├── build_episode.py              合成播放器数据
│   ├── extract_paper.py              只抓元数据
│   ├── serve.py                      本地服务器（带 Range 支持）
│   ├── device-frame.html             多设备验收台（见下文）
│   └── shoot.py / probe.py           截图与诊断工具
├── docs/                        设计与调研文档
├── README.md
├── .gitignore                   排除 _work/
├── .nojekyll                    让 Pages 跳过 Jekyll 处理
└── _work/                       ★ 中途产物，全部可删，且不提交
    ├── venv/                    Python 虚拟环境（faster-whisper）
    ├── hf/                      语音识别模型权重（tiny / base / small）
    ├── raw/                     原始页面 HTML、站点 JS 切片、元数据
    ├── tmp/shots/               设计验收截图
    └── logs/
```

## 关于 `_work/`

`_work/` 里全是过程性资产，不参与最终网站运行：

- `venv/` + `hf/` 约 970MB，是跑语音对齐用的运行环境和模型
- `raw/` 是抓取时存下来的原始页面，只在调试解析器时有用
- `tmp/shots/` 是设计验收用的截图

**项目开发完成、确认不再需要重抓或重跑对齐之后，可以整目录删除：**

```bash
rm -rf _work/
```

`data/` 必须保留——那是播放器要读的数据。
只想省空间但保留调试样本的话，删 `_work/venv` 和 `_work/hf` 即可。

## 播放器

单页应用，无构建步骤，无依赖。打开 `web/index.html` 所需的一切都在 `web/` 里。

**路由**

| 地址 | 内容 |
|---|---|
| `/` | 论文卡片列表（标题、作者、时长、收听进度） |
| `/#/<paper_id>` | 播放器 + 台词面板 |
| `/?mode=both#/<paper_id>` | 直接以指定显示模式打开 |

**界面结构**

自上而下三段：顶栏（返回 / 显示模式 / 主题）→ 台词区（可滚动，占据中上部）
→ 控制台（贴底固定：曲目信息、进度条、一行控制键、倍速与工具）。

**列表页**

- 顶栏左侧是品牌标识，右侧是主题切换
- 搜索框（填充胶囊，无边框）
- **继续收听**：只在你有一条未听完的内容时出现，显示封面、进度和上次听到的位置
- **筛选条**：横向滚动，`全部` / `在听` / `已听完` 三个状态，加一条分隔，
  后面是标签（按出现次数排序）。一次只激活一个筛选
- **卡片**：每条显示论文首页预览图、标题、作者、时长；听过的会多一行
  「已听 38% · 2 小时前」这样的历史信息
  底栏左边是收听记录（没听过时显示该论文的主标签），右边是指向论文原文的
   `alphaXiv ↗` 外链

**卡片的 DOM 结构有个约束**：卡片主体是打开播放器的按钮，右下角还要放一个外链。
**按钮里嵌链接是非法 HTML**，浏览器会把标签拆开导致链接点不动，所以卡片是
「按钮 + 独立底栏」的兄弟结构，链接不能塞进按钮里。

链接也不能用绝对定位贴在卡片右下角——那样它会和最后一行文字压在同一行上。
所以底栏是文档流里独立的一行：`display: flex` + `space-between`，
左边记录、右边链接。

桌面端卡片是竖向网格（图在上、字在下）；**手机上自动变成横向条目**
（缩略图 74px 在左，标题作者在右），一屏能看到更多。

收听记录存在 `localStorage` 的 `podcast-progress` 里，形如
`{ "<arxivId>": { time, at } }`，不需要后端。

**界面语言**

### 数据存在哪：本机存储 vs 随站点发布

论文库可以两种方式运行，互不影响：

| 模式 | 论文库在哪 | 适合 |
|---|---|---|
| 站点模式 | 仓库 `data/`，随站点发布 | 想开箱即用、多设备共享同一份 |
| 本机模式 | 访客自己的 IndexedDB | 想绕开 Pages 体积上限、不对外分发音频 |

不管哪种模式，**收听历史、Continue listening、主题、播进度一直在浏览器里**
（`localStorage` 的 `podcast-progress`），本来就是每个访问者独立的。

本机模式在 Sync 面板里操作：

- `Save library to this device` → 把 `data/` 下的单集元数据、句级时间轴、
  音频与封面全部写进 IndexedDB，之后播放读的是 Blob，**断网也能听**
- `Remove device copy` → 清空本机副本，回到站点模式
- 面板会显示占用（`navigator.storage.estimate()`）

IndexedDB 结构：

```
episodes   keyPath: id   单集元数据 + segments（含中英对照）+ cover 字段
blobs      key: "<id>:audio" / "<id>:cover"   音频与封面的 Blob
```

实测占用：**每集约 4.5 MB**（音频 4.1 MB + 封面 50 KB + 台词若干），
200 集约 900 MB。Chrome 给的配额是 10.75 GB，空间很充裕。

把 `data/` 从仓库里删掉、只留这个按钮，仓库就能从 14 MB 降到 100 KB 以内。

除中文台词本身，**整个界面都是英文**（导航、筛选、菜单、按钮、提示文案）。
`<html lang="en">`，中文台词所在的 `<div class="line-zh">` 单独标 `lang="zh-Hans"`，
方便屏幕阅读器正确切换发音。

**波形进度条**

播放器的进度不是一根线，而是音频波形。数据来自 `add_episode.py`：
ffmpeg 解码成单声道 PCM，按 72 个桶算 RMS 能量。

用 RMS 而不是峰值——语音里瞬态太多，取最大值会得到一条几乎等高的方块。
TTS 播客又是连续无停顿的，动态范围天生很窄（实测只在 0.67–1.0 之间），
所以还要按每篇自身的范围做归一化并压一次对比，波形才有起伏。
数据仍然真实反映相对响度，只是视觉上放大了差异。

渲染用 canvas：已听部分用 `--wave-on`，未听用 `--wave-off`，
换主题时重绘。拖拽由覆盖在 canvas 上的透明 `range` 接管，
所以键盘和辅助设备仍然可用。

**显示模式**在顶栏右侧，是一个收敛的下拉菜单，不在页面上平铺四个按钮：

| 模式 | 内容 |
|---|---|
| 英文 | 只显示原文（默认） |
| 中英对照 | 原文 + 中文 |
| 中文 | 只显示译文 |
| 听写模式 | 隐藏全部文本，点击逐句揭示 |

也可以用 `?mode=en` / `both` / `zh` / `dictation` 直接以指定模式打开。

**字体**

拉丁字体必须排在中文字体之前，否则英文会被中文字体的拉丁字形接管，
字距会明显偏松。当前栈：

```css
'Gill Sans', 'Gill Sans MT', 'Helvetica Neue', Helvetica, Arial,
'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', system-ui, sans-serif
```

Gill Sans 是 Apple 平台字体，Mac 与 iPhone 都有，Windows / Android 会回退到
Helvetica Neue / Arial。若哪天要在非苹果设备上看，字形会变。

**怎么验收移动端（重要）**

无头 Chrome 拿不到真正的手机视口：`--window-size=430` 会被系统最小窗口宽度
钳制到 500px，而 `--force-device-scale-factor` 只改变输出图片分辨率，
**不会改变 CSS 视口宽度**。用 880 的窗口去截图，其实是平板布局。

正确做法是用 `scripts/device-frame.html`：它把站点放进 390px 和 430px 宽的
iframe 里，iframe 内部会按真实手机宽度触发媒体查询。

```bash
python3 scripts/serve.py
# 浏览器打开 http://localhost:8765/scripts/device-frame.html
# 播放页加 hash：/scripts/device-frame.html#/2609.07303
```

**视觉原则**

整体走极简：**不给按钮画边框**，全部用留白、字重和细线组织层次，
只在必要处出现 1px 细线（列表行分隔、搜索框下划线、控制台顶部）。
字体统一为无衬线，不再使用衬线体。

**图标：粗线条简笔画**

所有图标都是 24 视图框的内联 SVG，描边 2.2–2.4、圆头圆角，实心图形直接填充。
包括返回箭头、主题切换（半填充圆）、播放/暂停、上一句/下一句、
定时（时钟）、更多（三点）、搜索。字号类按钮（−5 / −3 / +3 / +5）用 600 字重
保持同样的视觉重量。视觉基准是波形进度条那组柱子的粗细。

**品牌标识**

粗线条扁平二维线稿，没有渐变、投影或玻璃质感：一副耳机 + 一个带折角的纸页，
纸面上画着声波柱——一副图里同时表达 paper 和 podcast。
标题只有一行 `Papertone`。

用色**严格取自站点调色板**，只用紫色系两档，并保持「轮廓深、声波浅」的关系：

| 主题 | 轮廓（耳机＋纸页） | 声波 |
|---|---|---|
| 浅色 | `--accent-ink` `#74509f` | `--accent` `#b992ff` |
| 深色 | `accent` 与 `muted` 调出的中紫 | `--accent` `#d7a2ff` |

深色主题里 `--accent` 与 `--accent-ink` 同值，直接取用会分不出层次，
所以往 `--muted` 压一档得到中紫——两个来源仍然是站点自己的令牌。

几何上做了两件事：整幅图的含描边外沿在 24×24 里居中（水平 1.9–22.1、
垂直 2.6–21.4）；纸页和声波柱的水平中心都落在 12。
头梁用「竖直的腿 + 椭圆顶」而不是纯半圆——纯半圆的下缘会在纸页顶边高度处
贴住纸页侧边，两块黏成一团。

**快捷键**

| 键 | 动作 |
|---|---|
| 空格 | 播放 / 暂停 |
| ← / → | 后退 / 前进 3 秒 |
| Shift + ← / → | 后退 / 前进 5 秒 |
| ↑ / ↓ | 上一句 / 下一句 |

**定时停止**

播放器右下角的 `⏱ 定时` 按钮，可选 15 / 30 / 45 / 60 分钟、播完本集、取消。
设定后按钮上会实时显示剩余时间（如 `27:14`），迷你条上也会同步显示 `⏱27:14`。

两个刻意的设计：

- **到时音量渐弱再暂停**，约 3 秒淡出，而不是硬切——睡前被突然静音容易惊醒。
- **判定用墙钟，但靠 `timeupdate` 兜底检查**。手机浏览器会把后台 `setInterval`
  节流到几乎不触发，如果只靠定时器会漏停；`timeupdate` 在后台音频播放时仍然触发，
  所以两者结合才可靠。

**手机端（主场景）**

整个网站以手机为第一场景设计，触控尺寸按 44px 下限：

| 元素 | 尺寸 |
|---|---|
| 传输控制键 | 46px 圆形，播放键 60px，七个同排一行 |
| 顶部工具 / 筛选 chip | 最小高度 44 / 32px |
| 台词行 | 整行可点，无最小高度限制（靠行距保证可点性） |
| 台词字号 | 英文 14px、中文 12.5px，与首页卡片同级（桌面端为 16 / 14px） |
| 搜索框字号 | 16px（低于 16px 的输入框会在 iOS 上触发页面自动放大） |

手机端台词刻意压紧：缩小字号、收紧行距与内边距，并收窄左侧时间／说话人列，
让一屏能多看约三分之一的内容。桌面端保持 16px 不变。

卡片在手机上会从竖向网格切换成**横向条目**：74px 的论文缩略图在左，
标题、作者、收听历史在右。

**底部迷你播放条**：滚动看台词时，播放控制固定在屏幕底部（封面 + 标题 +
进度 + `−5 / ▶ / +5`），点标题区域回到播放器。这是手机上最实用的一处改动——
否则读台词和控播放要来回滚动。

另外适配了 iPhone 的刘海与 home indicator 安全区（`viewport-fit=cover` +
`env(safe-area-inset-bottom)`）。

**交互细节**

- 点台词任意一行跳到该句，跳转留了 0.15 秒余量，避免切掉句首辅音
- 当前句高亮并自动滚动；手动滚动后自动滚动暂停 5 秒，不会把人拽回去
- 播放进度按论文存 `localStorage`，下次打开续听
- 深浅色主题切换，选择存 `localStorage`
- 去掉了点按高亮和 300ms 点击延迟（`touch-action: manipulation`）

**设计令牌**沿用 `gintmr.github.io`：强调色 `#b992ff`（暗色 `#d7a2ff`）、
底色 `#fffaff`（暗色 `#191919`）、磨砂玻璃卡片、衬线字体。
封面是按论文 id 稳定生成的紫调渐变，离线也能显示。

## 依赖

| 工具 | 用途 |
|---|---|
| `ffmpeg` / `ffprobe` | 取音频时长、静音检测 |
| Python 3.9+ | 脚本运行环境 |
| faster-whisper（装在 `_work/venv`） | 语音识别，为官方文本生成时间轴 |

## 数据来源与已知事实

这些都是实测结论，改动管线前请先读：

1. **论文列表**：`GET https://api.alphaxiv.org/papers/v3/feed`
   参数 `sort` / `interval` / `topics` / `pageSize`，一次拿 100 篇。
2. **排序必须用 `Views` 或 `Likes`**。用 `Hot` 或 `Recent` 拿到的都是刚发布的新论文，
   播客覆盖率接近 0；用 `Views` / `Likes` 覆盖率约 93%。
3. **`sort=ForYou` 需要登录**（HTTP 401），匿名拿不到个性化推荐流。
4. **播客音频**：`https://paper-podcasts.alphaxiv.org/<paper_group_id>/podcast.mp3`
   探测存在性用 Range 请求：`206` = 有，`403` = 无。约 5 分钟一段的对话式讲解。
5. **台词**：同目录 `transcript.json`，只有 `speaker` 和 `line` 两个字段。
6. **官方不提供任何时间戳**，句级的也没有。存储桶里只有 `transcript.json` 和 `podcast.mp3`。
   所以时间轴由本地模型对齐生成。
7. feed 里的 `narration_audio_url` 是 29 秒的摘要朗读，**不是**播客，别用错。

8. **标签需要收敛后再用**。alphaXiv 给一篇论文的标签可以多到 11 个，而且混着
   `Computer Science` 这种过宽的分类和 `cs.LG` 这种纯分类号。
   `add_episode.py` 里的 `normalize_topics()` 做三件事：把同义标签映射到规范名
   （`agents` / `agentic-frameworks` → `Agents`）、丢掉过宽与纯分类号的标签、
   每篇最多保留 `MAX_TAGS`（当前 3）个。原始标签会保留在 `meta.json` 的
   `raw_topics` 里，方便以后调整规则时回查。

## 管线

### 网页里的增量抓取（Sync 按钮）

顶栏右侧的同步图标打开 Sync 面板，流程是：

1. `Scan for new episodes` → 调本地服务的 `/api/discover`
2. 服务扫描最近 N 天的推荐流，筛出 AI 相关论文，探测哪些有播客，剔除已入库的
3. 面板列出新增清单（arXiv id / 标题 / 浏览量）
4. 填翻译 API key → `Import selected & translate` → 调 `/api/import`
5. 服务逐篇下载音频与台词、本地 ASR 对齐、调翻译接口生成中文稿、
   合成 `episode.json`、刷新 `papers.json`
6. 前端轮询 `/api/job` 显示实时日志，完成后自动刷新列表

**为什么抓取必须跑在本地，而不是网页里直接做：**

| 环节 | 能不能在浏览器里做 |
|---|---|
| 拿候选名单（feed 接口） | ❌ CORS 只放行 `alphaxiv.org` 自己 |
| 下载音频 / 台词 | ✅ CDN 是 `access-control-allow-origin: *` |
| ASR 对齐 | ❌ 要 ffmpeg 和语音模型 |
| 写回 `data/` 并部署 | ❌ 静态站点没有后端 |

所以「扫描 + 抓取」由 `scripts/serve.py` 承担，网页只负责按钮、清单与进度。
这也意味着 **Sync 按钮只在通过本地服务打开站点时可用**：

```bash
python3 scripts/serve.py
# 电脑上开 http://localhost:8765/
# 手机上开 http://<本机局域网IP>:8765/
```

从 GitHub Pages 打开时，面板会提示服务不可达——这是预期行为。

### 抓取 API

### 两种同步方式

| | 本机同步 | 云端同步 |
|---|---|---|
| 跑在哪 | 你的 Mac（`scripts/serve.py`） | GitHub Actions runner |
| 需要本机开机 | ✅ 要 | ❌ 不用 |
| ASR | 本机 faster-whisper | runner 里装 ffmpeg + faster-whisper |
| 翻译 key | 网页里输入，传给本机服务 | 存成仓库 Secret，更安全 |
| 触发方式 | 面板上的 Scan / Import | 面板上的 Run sync on GitHub，或 GitHub 界面，或每天定时 |
| 成本 | 只有电费 | 公共仓库 Actions 免费 |

**云端那条路怎么搭：**

1. 仓库里已有 `.github/workflows/sync.yml`
2. `Settings → Secrets and variables → Actions` 加一个 Secret：
   `TRANSLATE_API_KEY`（不配也能跑，只是不生成中文）
   可选再加快变量 `TRANSLATE_BASE_URL`、`TRANSLATE_MODEL`
3. `Settings → Actions → General` 把 Workflow permissions 设成
   **Read and write**（否则最后一步推不上去）
4. 面板里填仓库名 `owner/name` 和一个细粒度 PAT（只要 `Actions: read and write`），
   点 `Run sync on GitHub` 就能远程触发

**为什么浏览器不能独立完成同步：** feed 接口的 CORS 只放行 alphaxiv 自己，
浏览器拿不到候选名单；ASR 也需要 ffmpeg 与语音模型。所以「本机服务」和
「GitHub Actions」是仅有的两条路——区别只是那台跑 Python 的机器在谁那儿。

注意：GitHub token 存在浏览器 `localStorage` 里，只在这台设备上。
它是细粒度 PAT，权限只有 Actions，泄露的影响面有限，但仍建议只在自己的设备上用。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/ping` | 服务状态与库内集数 |
| GET | `/api/discover?days=30&pages=8&refresh=1` | 扫描并返回增量清单 |
| POST | `/api/import` | `{ids, key, model, baseUrl, asrModel}` 启动抓取 |
| GET | `/api/job` | 抓取进度与日志 |

`discover` 的结果会缓存 30 分钟，重复点 Scan 不会重复扫。

### 浏览量门槛（按论文年龄分档）

单一绝对阈值不合理——刚上线三天 300 浏览，和上线三周 500 浏览，含金量完全不同。
所以门槛随年龄放宽，**用「浏览量 / 年龄」代替绝对浏览量**：

| 上线时间 | 浏览量要求 |
|---|---|
| ≤ 7 天 | > 300 |
| ≤ 14 天 | > 400 |
| ≤ 30 天 | > 500 |
| > 30 天 | 直接排除（本来也在窗口外） |

实现在 `serve.py` 的 `VIEW_RULES`，**放在探测播客之前**——先过滤再探测，
能省掉大量无谓请求。

**三档是「或」的关系，不是层层加严。** 先命中哪档就按哪档判：
一篇 7 天以内的论文只要超过 300 就通过，不会被再要求 500。
这正是分级的用意——短时间冲到 300 就说明它有价值。

`match_tier()` 返回命中的档位，写进每条结果里，面板的清单首列会显示
`7d` / `14d` / `30d` 标记，鼠标悬停能看到具体依据
（`≤7 days needs >300 · 477 views in 3.2 days`）。

实测（30 天窗口 / 8 页）三档命中分布：

```
7d  15 篇   例：3.2 天 / 477 浏览   ← 低于 500，靠短档位进来
14d 10 篇   例：10.3 天 / 479 浏览  ← 同上
30d 14 篇   例：20.1 天 / 2282 浏览
```

注意前两条的例子都低于 500 浏览——如果统一按 500 判就会被误杀。

实测效果（扫 4 页 / 400 篇）：

| | 论文数 | 探测 | 新增播客 |
|---|---|---|---|
| 不开门槛 | 364 | 200 | 107 |
| **开门槛** | **38** | **38** | **31** |

门槛砍掉约 90% 的候选，但留下的是真正经过热度验证的。面板上的
`View threshold by age` 可以临时关掉对比。

### 翻译

`scripts/translate.py` 走 OpenAI 兼容的 `/chat/completions`，所以 OpenAI、
Azure、DeepSeek、通义、本地 vLLM 都能用，靠 `--base-url` 切换。
逐句翻译并把前后各一句作为上下文；按「模型名 + 原文哈希」缓存，
重跑不会重复花钱；术语表固定 attention / encoder / policy 等译法，避免同一篇里漂移。

API key 只传给本机服务，再由本机去调你的翻译服务，不经过任何第三方中转。

### 抓取新的一篇（主入口）

```bash
cd /Users/gintmr/Downloads/Projects/Podcast-alphaXiv
HF_HOME="$PWD/_work/hf" _work/venv/bin/python scripts/add_episode.py \
    2609.07303 2609.17523 --model tiny
```

一条命令会依次完成：抓论文页元数据（许可证 / BibTeX）、下载音频、
下载官方台词、下载论文首页预览图、用官方文本 + 本地 ASR 对齐出句级时间轴，
最后刷新 `data/papers.json`。已存在的文件默认跳过，加 `--force` 可重抓。

中文稿目前是单独生成的：把译文写成 `transcript.zh.json` 后用 `build_episode.py` 合成。
这一步还没自动化（见下方进度）。

### 从零跑通一篇（分步）

```bash
# 1. 抽取论文元数据（标题 / 作者 / 摘要 / 许可证 / 音频地址）
_work/venv/bin/python scripts/extract_paper.py 1706.03762 --out _work/tmp

# 2. 用官方文本 + 本地 ASR 对齐，生成句级时间轴（tiny 模型约 10 秒）
HF_HOME="$PWD/_work/hf" _work/venv/bin/python scripts/align_transcript.py \
    --audio      data/1706.03762/audio/podcast.mp3 \
    --transcript data/1706.03762/transcript.json \
    --out        data/1706.03762/segments.json \
    --model tiny --no-words

# 3. 合成播放器数据
python3 scripts/build_episode.py \
    --meta     _work/raw/1706.03762.meta.json \
    --segments data/1706.03762/segments.json \
    --zh       data/1706.03762/transcript.zh.json \
    --out      data/1706.03762/episode.json
```

模型选择：`tiny` 约 10 秒 / 篇，句级偏差平均 0.18 秒；`base` 约 16 秒；
`small` 约 46 秒。**只做句级精听的话 `tiny` 完全够用。**

## 进度

- [x] 接口侦察：feed / 播客 / 台词
- [x] 端到端跑通，当前收录 3 篇真实论文（含预览图与中英对照）
- [x] 句级时间轴（tiny 模型，约 10 秒/篇）
- [x] 中英对照
- [x] 播放器前端（列表 + 播放器 + 台词跳转 + 听写模式 + 定时停止）
- [x] 增量抓取脚本 `add_episode.py`
- [ ] 批量抓取与增量更新
- [ ] 翻译自动化
