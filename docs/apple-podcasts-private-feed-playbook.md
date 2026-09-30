# 把抓下来的播客接进 Apple Podcasts：操作手册

核心前提：**Apple Podcasts 是订阅型客户端，iOS 版没有任何"导入本地文件"的入口。**
所以"上传到 Apple Podcasts"的真实含义是：**自建一个私有 RSS 源，让 Apple Podcasts 订阅它。**

---

## 1. 三条路线对比

| 路线 | 做法 | 手机上能看台词 | 难度 | 成本 | 维护 |
|---|---|---|---|---|---|
| **A 自建私有 RSS**（推荐） | MP3 + 字幕放对象存储，自己生成 feed.xml，用 URL 订阅 | 可以 | 中 | ≈$0.5/月 | 自动化后接近零 |
| **B 买私有播客托管** | Transistor / Buzzsprout / Podbean 的 private podcast 功能 | 取决于是否允许自定义字幕标签 | 低 | $20+/月 | 低 |
| **C 本地文件同步** | macOS 音乐 App + Finder 同步到 iPhone | 不行（音乐 App 无转录） | 低 | 免费 | 每次新增都要同步一次 |
| **D 换个 App** | Pocket Casts Plus 上传 / VLC / 自建网页播放器 | 看具体 App | 低 | 0~$20/月 | 低 |

路线 A 是唯一能同时满足"手机 + 跨设备同步 + 台词跟随"的方案，下面全部按 A 展开。

---

## 2. 目标形态

```
Cloudflare R2 桶（一个不可猜的随机路径前缀）
└── <token>/
    ├── feed.xml                      ← 订阅地址，填进 Apple Podcasts
    ├── cover.jpg                     ← 方形封面
    ├── audio/<group_id>/podcast.mp3  ← enclosure 指向这里
    └── transcript/<group_id>/podcast.vtt
```

手机端体验：订阅后能看到节目列表 → 播放 → 点转录按钮 → 逐句高亮、点某句跳到对应时间。

---

## 3. feed.xml 模板（可直接用）

```xml
<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
     xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"
     xmlns:podcast="https://podcastindex.org/namespace/1.0">
  <channel>
    <title>Paper Listening</title>
    <link>https://TOKEN.example.com/</link>
    <language>en</language>
    <description>Private listening practice feed.</description>
    <itunes:author>Local</itunes:author>
    <itunes:explicit>false</itunes:explicit>
    <itunes:category text="Education"/>
    <itunes:image href="https://TOKEN.example.com/cover.jpg"/>

    <item>
      <title>Attention Is All You Need</title>
      <guid isPermaLink="false">015c9ef4-ac30-768d-928b-847320902575</guid>
      <pubDate>Tue, 30 Sep 2026 09:00:00 +0000</pubDate>
      <description>Transformer 论文播客</description>
      <enclosure
        url="https://TOKEN.example.com/audio/015c9ef4-ac30-768d-928b-847320902575/podcast.mp3"
        length="7412345"
        type="audio/mpeg"/>
      <itunes:duration>15:32</itunes:duration>
      <itunes:explicit>false</itunes:explicit>
      <podcast:transcript
        url="https://TOKEN.example.com/transcript/015c9ef4-ac30-768d-928b-847320902575/podcast.vtt"
        type="text/vtt"
        language="en"
        rel="captions"/>
    </item>
  </channel>
</rss>
```

四个容易写错、写错就不工作的字段：

1. `enclosure/@length` **必须等于文件的真实字节数**，不是近似值。
2. `enclosure/@type`：MP3 用 `audio/mpeg`；M4A 用 `audio/x-m4a`。
3. `guid` 必须**永久稳定**，用它作为唯一 ID（直接用 `paper_group_id`）。改了 guid，手机上会当成新剧集或丢播放进度。
4. `podcast:transcript` 必须带 `rel="captions"`，字幕文件必须**带时间戳**（VTT/SRT）。纯 .txt 无法实现"点一句跳一句"。

---

## 4. 部署步骤

### 4.1 对象存储（Cloudflare R2）

选 R2 的原因：**出站流量免费**，存储 $0.015/GB·月。订阅 2000 集、每集 7MB ≈ 14GB ≈ 每月 $0.21。

```bash
# 1. 建立桶（Cloudflare 控制台 → R2 → Create bucket）
# 2. 生成 32 位随机 token 作为路径前缀，避免被猜到
python3 -c "import secrets; print(secrets.token_urlsafe(24))"

# 3. 用 S3 兼容 API 上传（需先在 R2 里创建 API Token）
export R2_ACCOUNT_ID=xxx
export AWS_ACCESS_KEY_ID=xxx
export AWS_SECRET_ACCESS_KEY=xxx
aws s3 sync ./publish/ s3://listening/ \
  --endpoint-url https://$R2_ACCOUNT_ID.r2.cloudflarestorage.com
```

**测速阶段可以用 R2 自带的 `pub-<hash>.r2.dev` 公开域名，正式使用建议绑一个自己的域名。**

### 4.2 三个必须避开的坑

- **不要用 Cloudflare Access（Zero Trust）保护这个桶。** Apple 的抓取器和手机会匿名拉取文件，任何需要认证的网关都会让订阅直接失败。
- **不要开 Bot Fight Mode / Under Attack 模式。** 手机下载音频走的是普通 URLSession 请求，会被当成爬虫拦掉，表现为"能订阅但播放不了"。
- **不要用签名过期 URL（presigned URL）。** Apple 会在任意时间重新拉取，链接必须长期有效。

"私有"的正确实现方式是**不可猜的路径 + 不公开分享**，这也是商业私有播客的标准做法——不是加鉴权。

---

## 5. 音频转码

**不要把音频转成 Opus。** iOS 原生播放器对 Opus 支持很差，Apple Podcasts 会播不了。这是最容易踩的坑。

```bash
# 推荐：MP3 单声道 64kbps，兼容性最好，15 分钟约 7MB
ffmpeg -i in.mp3 -ac 1 -ar 24000 -c:a libmp3lame -b:a 64k out.mp3

# 想要更小：AAC-LC 48kbps 的 m4a
ffmpeg -i in.mp3 -ac 1 -ar 24000 -c:a aac -b:a 48k out.m4a

# 取真实字节数（填进 enclosure/@length）
stat -f%z out.mp3

# 取时长（填进 itunes:duration）
ffprobe -v error -show_entries format=duration -of csv=p=0 out.mp3
```

---

## 6. 从抓取库自动生成 feed

沿用上一份指南里的 SQLite 表结构，扩一个发布脚本：

```python
import sqlite3, os
from email.utils import format_datetime
from datetime import datetime, timezone

TOKEN = os.environ["FEED_TOKEN"]
BASE = f"https://listening.example.com/{TOKEN}"

ITEM = """    <item>
      <title>{title}</title>
      <guid isPermaLink="false">{gid}</guid>
      <pubDate>{pub}</pubDate>
      <enclosure url="{base}/audio/{gid}/podcast.mp3" length="{size}" type="audio/mpeg"/>
      <itunes:duration>{dur}</itunes:duration>
      <podcast:transcript url="{base}/transcript/{gid}/podcast.vtt"
                         type="text/vtt" language="en" rel="captions"/>
    </item>
"""

def build_feed(db_path: str, out_path: str) -> None:
    con = sqlite3.connect(db_path)
    rows = con.execute(
        """SELECT group_id, title, audio_bytes, published_at, duration_s
           FROM papers
           WHERE status = 'packaged' AND group_id IS NOT NULL
           ORDER BY published_at DESC"""
    ).fetchall()

    items = []
    for gid, title, size, pub, dur in rows:
        stamp = format_datetime(
            datetime.fromisoformat(pub).replace(tzinfo=timezone.utc)
        )
        mins, secs = divmod(int(dur or 0), 60)
        items.append(ITEM.format(
            title=title.replace("&", "&amp;"),
            gid=gid, pub=stamp, size=size,
            dur=f"{mins}:{secs:02d}", base=BASE,
        ))

    template = open("feed_template.xml", encoding="utf-8").read()
    with open(out_path, "w", encoding="utf-8") as fh:
        fh.write(template.format(items="\n".join(items)))

build_feed("data/state.sqlite", "publish/feed.xml")
```

配合一个 `make publish`：重新生成 feed.xml → `aws s3 sync` 增量上传 → 完成。日常增量就是这一条命令。

---

## 7. Pilot 验证清单（先做这个，别先做全量）

只放 **3 集**，30~60 分钟内能跑完：

1. 3 个 MP3 + 3 个 VTT 上传到 R2，路径带 token。
2. 手写/生成 feed.xml，上传。
3. macOS 打开 Podcasts.app → 菜单 **File → Add a Show by URL…**，填入 feed 地址。
   （放在 Mac 上订阅更稳妥，iCloud 会自动同步到 iPhone；iOS 端路径随版本变化较大。）
4. 逐项检查：
   - [ ] 能成功订阅，节目出现在资料库
   - [ ] 音频能播放（不用切代理、不用点两次）
   - [ ] 手机播放页出现**转录/文字稿按钮**
   - [ ] 点字幕某一句，播放头跳到对应时间
   - [ ] 新增第 4 集后，刷新能看到

**第 3、4 项是这个方案最关键的不确定点**：Apple 的自动转录对目录内节目有明确保障，但你提供自定义字幕（`podcast:transcript`）在**私有 URL 订阅**的节目上是否被采纳，需要实测。若第 3/4 项失败，说明这条路走不通，直接转路线 B 或 D。

---

## 8. 常见故障对照

| 现象 | 原因 | 处理 |
|---|---|---|
| 订阅时报"无法找到节目" | feed.xml 语法错误或返回非 XML | 用 W3C feed validator 验证；确认 Content-Type 是 XML |
| 能订阅但列表为空 | `item` 结构错误、缺 `enclosure` | 检查 enclosure 的 url/length/type |
| 有列表但点播放失败 | 音频 URL 被鉴权网关拦住 / 格式不支持 / type 写错 | 用手机浏览器直接打开该 URL 测试；确认不是 Opus |
| 没有转录按钮 | Apple 未采纳 `podcast:transcript`，或字幕无时间戳 | 换 VTT 重试；确认 `rel="captions"` |
| 点字幕不跳转 | 字幕是纯文本，没有时间码 | 改用带时间戳的 VTT/SRT |
| 新增剧集不出现 | Apple 侧缓存 | 下拉刷新，或等几分钟；极少数情况需取消订阅重订 |
| 进度/已播放状态错乱 | guid 变化 | guid 必须永久稳定，绝不要用会变的 URL |
