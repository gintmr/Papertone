# 访客统计：后端部署

前端已经接好了（资料库面板 → **Open visitor statistics**，路由 `#/visitors`）。
但页面要真的开始计数，还需要把后端部署一次。**这一步需要你的 Supabase 账号，
我这边没有凭据，无法代跑。**

## 为什么不能直接用你博客上那套

你博客（`gintmr.github.io` 学术主页）的统计后端，路径白名单是写死的：

```
('/', '/publication/', '/project/', '/cv/')
```

出现在四个地方：客户端的 `TRACKED_PATHS`、Edge Function 的 `PATHS`，
以及两张表的 `CHECK` 约束和一个 RPC 的参数校验。

Papertone 的 pathname 是 `/Papertone/`，不在名单里，上报会被后端直接拒掉。

而且**不能简单地把 `/Papertone/` 加进那个名单**：`visitor_analytics` 这个 schema
里的 `daily_totals` / `country_daily_totals` 是**不区分路径**的聚合表，
一旦共用，你学术主页和 Papertone 的数字会永久混在一起，两边都失真。

所以这里走的是**完全独立的一套**：新 schema `papertone_analytics` + 新函数
`papertone-analytics`。你博客原有 schema、表、函数、授权**一行都不动**。

`supabase/` 下的四个迁移和函数，是从你博客那套**机械改写**生成
（`visitor_analytics` → `papertone_analytics`，路径名单 → `/Papertone/`），
逻辑本身没有改动。

## 部署步骤

前提：装好 [Supabase CLI](https://supabase.com/docs/guides/cli)，并登录。

```bash
cd /Users/gintmr/Downloads/Projects/Podcast-alphaXiv
supabase login
supabase link --project-ref gjofwuihpzjfqeaysuuy
```

### 1. 建 schema 与表

在你已有的项目里按顺序执行四个迁移。用 CLI：

```bash
supabase db push
```

或者打开 Supabase 控制台 → SQL Editor，按文件名顺序依次粘贴执行：

1. `supabase/migrations/202610010001_papertone_analytics_core.sql`
2. `supabase/migrations/202610010002_papertone_analytics_activity.sql`
3. `supabase/migrations/202610010003_papertone_analytics_activity_pages.sql`
4. `supabase/migrations/202610010004_papertone_analytics_write_order.sql`

这几个迁移是**刻意不用 `IF NOT EXISTS`** 的：如果 `papertone_analytics`
这个名字已经被占用，它会直接报错回滚，而不是悄悄改掉别的对象。

### 2. 配好函数的环境变量

Edge Function 靠这些 secrets 工作，值和你博客那套**必须不同**（尤其是哈希盐，
否则两边算出来的 visitor hash 会一致）。

```bash
openssl rand -hex 32          # 生成一个新的 VISITOR_HASH_SECRET

supabase secrets set \
  VISITOR_ALLOWED_ORIGINS=https://gintmr.github.io \
  VISITOR_HASH_SECRET=<上面生成的值> \
  VISITOR_CLIENT_IP_HEADER=cf-connecting-ip \
  VISITOR_PROXY_HEADERS_VERIFIED=true \
  VISITOR_GEO_PROVIDER=none
```

说明：

- `VISITOR_ALLOWED_ORIGINS`：Papertone 和你的博客同源（都是
  `https://gintmr.github.io`），所以这个值一样。
- `VISITOR_PROXY_HEADERS_VERIFIED=true`：必须和你博客那套的取值保持一致。
  取 `true` 的前提是你已经验证过托管代理会覆写 `cf-connecting-ip`
  （你博客的 README 里记录过这项验证）。**如果那边没验证过，这里也要留 `false`**，
  否则拿不到真实 IP，日志里会少记录来源。
- `VISITOR_GEO_PROVIDER=none`：不查第三方地理库，国家留空。想解析国家就照
  `.env.example` 里的说明换成 `country-is` 或 `ipinfo`（后者需要 `IPINFO_TOKEN`）。
- `SUPABASE_URL` 与 `SUPABASE_SERVICE_ROLE_KEY` 由 Edge 运行时自动注入，
  不要手动设置、更不要写进前端。

### 3. 部署函数

```bash
supabase functions deploy papertone-analytics --no-verify-jwt
```

部署完检查一下端点是否活着（返回一个合法但为空的汇总，而不是 401/404）：

```bash
curl -s "https://gjofwuihpzjfqeaysuuy.supabase.co/functions/v1/papertone-analytics" | head -c 300
```

### 4. 验证

1. 打开 https://gintmr.github.io/Papertone/
2. 硬刷新一次（浏览器会缓存 `app.js`）
3. 点右上角同步图标 → **Open visitor statistics**
4. 首次打开时数字可能还是 0 或显示“temporarily unavailable”，
   刷新页面再进一次就能看到刚记下的这一次

## 排查

| 现象 | 原因 |
|---|---|
| 面板显示 `temporarily unavailable` | 函数没部署，或端点路径写错（`index.html` 里的 `visitor-config`） |
| 一直 0 | 函数返回 401/403：secrets 没配全，`VISITOR_ALLOWED_ORIGINS` 或 `VISITOR_PROXY_HEADERS_VERIFIED` 不对 |
| 本地 `localhost` 完全不计数 | 设计如此，本地永远不上报 |
| 想看设计稿 | 本机 `?visitor-demo=1#/visitors`，用样例数据渲染，不写入任何记录 |

## 隐私边界

与原版一致，没有改动：

- 不存原始 IP。IP 与 UA 经 HMAC（`VISITOR_HASH_SECRET`）算出当日 visitor hash，
  当天结束后无法反推
- 浏览器开了 GPC 或 DNT 就直接不采集
- 只记录 UTC 时间、近似国家/地区、页面路径
- 访问记录每次 20 条分页，`#/visitors` 也不在任何公开导航或卡片里
