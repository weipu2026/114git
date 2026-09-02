# 114Git

个人用 GitHub 反代，部署在 **Cloudflare Workers 免费版**。

- 零外部依赖：不需要 KV / 数据库 / 任何第三方库，单文件 `index.js` 即完整部署。
- 最新 ES 语法（模块 Worker，`export default` 写法）。
- 免费额度内个人日常使用完全够（10 万请求/天，个人用不到零头）。
- **推 GitHub = 上线**：GitHub Actions 自动部署，敏感配置全集中在 GitHub Secrets，密钥不进代码。

## 功能

| 功能 | 说明 |
|---|---|
| 路径反代 | 地址栏把 `github.com` 换成你的域名即可，其余路径不变 |
| git clone | 直接 `git clone https://你的域名/.../repo.git`，含 smart HTTP / LFS |
| 源码包 | 自动识别默认分支（main/master），分支/标签均可下载 zip |
| release 下载 | `/user/repo/releases/download/...`，自动跟随跳转到对象存储 |
| 单文件 | `/user/repo/raw/...` 直接拿文件内容；`blob` 自动转 `raw` |
| gist / 补丁 | gist 文件、patch-diff 补丁均可 |
| 网页生成 | 登录后输入仓库地址，自动生成带令牌的 clone / 源码包链接，一键复制 |
| 每日令牌 | Web Crypto 由主密钥+日期派生，每天自动更换，16 位短令牌 |
| 游客配额 | 无令牌视为游客：IP + 全站总量双限（默认各 50 次/24h） |
| 安全设计 | 白名单防 SSRF、过滤敏感请求头、令牌页禁止缓存、UA 伪装 |

## 文件结构

```
index.js                        Worker 代码（部署的核心，唯一入口）
wrangler.toml                    Wrangler 配置（Worker 名、DOMAIN 等非敏感项）
.github/workflows/deploy.yml     GitHub Actions 自动部署脚本（push 即上线）
.gitignore                       忽略本地预览与缓存
LICENSE                          MIT 许可证（来自 hunshcn/gh-proxy，合规保留）
README.md                        本文档
preview-*.html                   UI 本地预览（临时，已被 .gitignore 忽略）
```

## 部署步骤

### 方式一：GitHub 自动部署（推荐，push 即上线，配置全集中在 GitHub）

1. 在 GitHub 新建仓库，把本目录推上去（`index.js`、`wrangler.toml`、`.github/workflows/deploy.yml`、`LICENSE`、`README.md`、`.gitignore`）。
2. 在 Cloudflare 拿到两样东西：
   - **账户 ID**：Workers 首页右侧可见。
   - **API Token**：右上角头像 → My Profile → API Tokens → 创建，权限选 **Workers Scripts — Edit**。
3. GitHub 仓库 → Settings → Secrets and variables → Actions → 添加 **4 个 secret**（全在一处，方便管理）：
   - `CLOUDFLARE_ACCOUNT_ID`（账户 ID）
   - `CLOUDFLARE_API_TOKEN`（API Token，部署钥匙）
   - `PASSWORD`（登录密码）
   - `TOKEN_KEY`（令牌主密钥）
4. 以后每次 `git push` 到 `main`，GitHub Actions 自动 `wrangler deploy`，并**自动把 `PASSWORD` / `TOKEN_KEY` 写入 Worker 机密**（wrangler-action 的 `secrets` 功能，等价 `wrangler secret put`，加密存储）。Cloudflare 那边不需要手动配这两个。
5. **改配置**（如换密码/密钥）：直接改 GitHub Secret 的值，然后到 Actions 页点「Run workflow」手动触发一次部署即同步。
6. `DOMAIN` 等非敏感配置写在 `wrangler.toml`，随代码走。

> 💡 **若忘了配 `PASSWORD` / `TOKEN_KEY`**：首次打开会显示「首次部署引导」页，5 步指引 + 「生成随机密钥」按钮，照着点即可。

### 方式二：Dashboard 手动粘贴（无 Git 集成）

1. 登录 [Cloudflare](https://dash.cloudflare.com) → **Workers & Pages** → **创建** → **Workers**。
2. 删掉模板代码，把 `index.js` 全文粘贴进去。
3. **设置 → 变量与机密** 配 `PASSWORD`、`TOKEN_KEY`（与可选 `DOMAIN`）。
4. 点 **部署**，访问 `你的Worker名.你的子域.workers.dev`。
5. 可选：**设置 → 域与路由** 为你的域名（如 `git.114448.xyz`）添加路由。

### 环境变量

| 变量 | 默认值 | 在哪设置 | 说明 |
|---|---|---|---|
| `PASSWORD` | （无，**必填**） | **GitHub Secrets** | 主页登录密码，**缺则无法登录** |
| `TOKEN_KEY` | （无，**必填**） | **GitHub Secrets** | 令牌主密钥，**务必设随机长字符串**（不要用密码当这个） |
| `DOMAIN` | `git.114448.xyz` | **`wrangler.toml` `[vars]`** | 反代域名（替换 github.com 用的） |
| `ALLOW_MASTER_KEY` | `false` | `wrangler.toml` `[vars]`（可选） | 设为 `true` 才允许 `TOKEN_KEY` 本身直接作令牌 |
| `GUEST_IP_LIMIT` | `50` | `wrangler.toml` `[vars]`（可选） | 单个 IP 在每个配额窗口内的游客次数 |
| `GUEST_GLOBAL_LIMIT` | `50` | `wrangler.toml` `[vars]`（可选） | 全站游客总量（同一窗口内，换 IP 也绕不过） |
| `GUEST_WINDOW_SEC` | `86400` | `wrangler.toml` `[vars]`（可选） | 配额窗口时长（秒），默认 24 小时 |
| `PROXY_TIMEOUT_MS` | `15000` | `wrangler.toml` `[vars]`（可选） | 代理回源超时（毫秒） |
| `MAX_REDIRECTS` | `8` | `wrangler.toml` `[vars]`（可选） | 跳转跟随上限 |

#### 配置来源与优先级

同一名字可能来自不同地方，**从上到下依次生效（高优先级覆盖低优先级）**：

| 优先级 | 来源 | 谁写入 | 用于 |
|---|---|---|---|
| 🥇 最高 | Worker **机密**（secret） | GitHub Secrets → `deploy.yml` 的 `secrets:` → `wrangler secret put` | `PASSWORD`、`TOKEN_KEY` |
| 🥈 第二 | Worker **普通变量**（var） | `wrangler.toml` 的 `[vars]` → `wrangler deploy` | `DOMAIN`、`ALLOW_MASTER_KEY`、配额等 |
| 🥉 最低 | 代码默认兜底 | `index.js` 内置 | 什么都不配时才用 |

规则与要点：

- **敏感项（`PASSWORD` / `TOKEN_KEY`）只放 GitHub Secrets**，绝不写进 `wrangler.toml`、代码或任何提交；部署时由 `deploy.yml` 自动写入 Worker 机密（加密存储）。
- **非敏感项（`DOMAIN`、配额等）放 `wrangler.toml` 的 `[vars]`**，随代码版本管理、一眼可见。
- 同名冲突时 **secret 覆盖 var**（机密优先于普通变量）。
- **改动生效方式**：改 `wrangler.toml` → `git push` 即自动部署；改 GitHub Secret → 到 Actions 点「Run workflow」手动触发一次部署才生效。

> ⚠️ **`PASSWORD` 与 `TOKEN_KEY` 是必填项**。任一缺失，站点会进入「未初始化」状态：登录被禁用、令牌一律无效（游客配额仍可用）。这样忘记配置也绝不会以弱默认密码「裸奔」。

## 使用方式

### 1. 网页生成链接（推荐）

打开主页 → 输入登录密码 → 进入输入框页 → 粘贴 GitHub 仓库地址（如
`https://github.com/user/repo`）→ 点「生成」，得到两条带令牌的链接：

```
git clone https://git.114448.xyz/当天令牌/user/repo.git
源码包    https://git.114448.xyz/当天令牌/user/repo/archive/refs/heads/分支.zip
```

点「复制」即可直接使用。**带令牌 = 登录用户，不受游客配额限制。**

> 💡 **分支不用填**：生成时会自动调用 GitHub API 识别仓库默认分支（`main`/`master`）
> 并回填；识别失败自动回退 `main`。也可以在「分支/标签」框手动指定，或切换到「标签」下载某个 tag。

### 2. 直接替换域名（快捷）

- 原链接：`https://github.com/user/repo/archive/refs/heads/master.zip`
- 替换后：`https://git.114448.xyz/user/repo/archive/refs/heads/master.zip`

其余路径一字不改。这种方式**不带令牌，按游客计费**（50 次/24h）。

### 3. git clone

```bash
git clone https://git.114448.xyz/user/repo.git        # 游客方式（有配额）
git clone https://git.114448.xyz/当天令牌/user/repo.git  # 登录方式（不限）
```

令牌也可用 `?t=令牌` 或请求头 `X-Proxy-Token: 令牌` 携带（命令行工具用 URL 形式最方便）。

### 4. 单文件下载

```bash
curl -LO https://git.114448.xyz/user/repo/raw/branch/path/to/file
```

`/blob/...` 路径会自动转为 `/raw/`，curl/wget 拿到的是文件内容而非网页。

## 令牌与配额机制

- **令牌**：`SHA-256(TOKEN_KEY + 当天日期)` 取前 16 位十六进制，每天 0 点（UTC）自动更换，无法预测下一天的。默认仅接受当日令牌；`TOKEN_KEY` 本身**默认不能**当令牌用（主密钥仅用于派生）。若觉得每天令牌轮换麻烦，可设 `ALLOW_MASTER_KEY=true` 开启主密钥直通，但代价是主密钥一旦泄露就长期有效——请权衡。
- **游客配额**：先同时预检 IP 计数和全局计数，都未超才放行并计数，避免多扣。
- **计数存在内存里**（Worker 重启清零），属于"尽力而为"的防护——能挡路人/爬虫，不追求精确。个人用足够。
- **为什么不用 KV**：为了零外部依赖。KV 的精度对个人用量是过度设计，且增加部署复杂度。

## 安全设计摘要

- **防 SSRF**：反代目标仅限 GitHub 官方域名白名单；代理内的跳转也必须在白名单内，否则交给浏览器自行跟随。
- **敏感头过滤**：转发时剔除 `Cookie`、`Authorization`、`X-Proxy-Token`，防止把客户端的凭据漏给上游。
- **令牌页防缓存**：登录页/输入框页返回 `Cache-Control: no-store`，令牌不会随 CDN/浏览器缓存泄露。
- **UA 伪装**：以普通浏览器 UA 请求 GitHub，降低被 403/429 的概率。
- **超时与跳转上限**：回源 15s 超时；跳转最多跟随 8 次；307/308 保持原方法与请求体。

## 注意事项

1. **部署前必须设置 `PASSWORD` 和 `TOKEN_KEY`**。缺任一项会进入「未初始化」状态（登录禁用、令牌无效），未配置前站点无法正常使用，也绝不会以弱默认密码运行。
2. 令牌在 URL 中会出现在浏览器历史和服务端日志里——**不要把带令牌的链接分享出去**；日常用「直接替换域名」的游客方式更干净。
3. 免费版 Workers 的**单次请求总时长约 30 秒**：普通 release（几百 MB）没问题；GB 级超大文件可能中途超时，这是免费版平台限制，与代码无关。
4. 不需要绑定 KV，不需要任何配置绑定；如果给 Worker 绑了 KV 也不会影响运行（代码根本不读 KV）。
5. 内存配额在 Worker 重启后清零——CF 会不定期回收实例，所以配额是"大致"的，不是精确的每日限制。
6. 只部署这一个文件即可；不要再叠加老号 gh-proxy 的 `addEventListener` 写法（会冲突），本文件用的是模块式 `export default`。

## 更新日志

### v1.0.1（2026-09-02 文档）

- 环境变量表新增「在哪设置」列；新增「配置来源与优先级」小节：敏感项 `PASSWORD`/`TOKEN_KEY` 只在 GitHub Secrets，`DOMAIN` 等非敏感项在 `wrangler.toml [vars]`，同名时 secret 覆盖 var。

### v1.0（2026-09-02 正式发布）

- **投产前收官审计通过**：22 项回归测试全绿——SSRF 攻击向量实测零突破、git 全路径（含 LFS）通过、令牌/配额/登录防暴破逻辑正确、未初始化防护生效。
- **自动部署升级**：GitHub Actions + Wrangler（`push` 到 main 即上线）。`PASSWORD`/`TOKEN_KEY` 等敏感配置集中在 GitHub Secrets，部署时由 wrangler-action 自动写入 Worker 机密，Cloudflare 端零手动配置。

### v0.11（2026-09-02 修复分支误填 + UI 简化）

- **修复**：若「分支」框被误填成完整 URL（如 `https://github.com/...`），会生成 `refs/heads/https://…zip` 的坏链接。现在自动清空并转去识别默认分支。
- **UI 简化**：「分支/标签」折叠进「高级」选项，默认界面只保留仓库地址输入框，避免小白混淆两个输入框。

### v0.10（2026-09-02 部署引导页）

- 「未初始化」页升级为**分步骤部署向导**：5 步图文指引去 CF 后台填 `PASSWORD` / `TOKEN_KEY`，内置「生成随机密钥」+「复制」按钮，忘记配置时打开就能照着做。

### v0.9（2026-09-02 默认分支自动识别）

- 生成源码包链接时，分支留空会自动调用 GitHub API 识别仓库默认分支（`main`/`master`），无需手动填，识别失败回退 `main`。
- 修复分支名含 `/` 时的编码 bug（`encodeURIComponent` → `encodeURI`），多级分支（如 `feature/login`）不再 404。

### v0.8（2026-09-02 主密钥直通改为可配置）

- 主密钥直通默认**关闭**，新增环境变量 `ALLOW_MASTER_KEY`，设为 `true` 才允许 `TOKEN_KEY` 直接作令牌。默认安全、按需开启。

### v0.7（2026-09-02 投产前安全加固）

- **登录暴力破解防护**：同一 IP 连续登录失败 5 次锁定 10 分钟（内存计数，配合 CF 基础防护）。
- **移除主密钥直通**：令牌校验不再接受 `TOKEN_KEY` 本身，仅接受每日派生令牌，杜绝主密钥成为长期后门。

### v0.6（2026-09-02 投产前安全加固）

- **修复 P0 安全隐患**：此前未配置环境变量时，会用明文占位符「你的密码」作默认值，存在被猜测风险。现在 `PASSWORD`/`TOKEN_KEY` 为必填项，任一缺失进入「未初始化」状态——登录禁用、令牌一律无效，杜绝弱默认值裸奔。

### v0.5（2026-09-02 UI & 功能补充）

- **favicon**：内联 SVG 字母 G 图标（绿色圆角块），登录页/输入框页标签页均有图标，`/favicon.ico` 不再 404。
- **今日令牌**：输入框页常驻一个「今日令牌」行，带复制按钮，方便单独取用令牌。
- **分支/标签切换**：源码包链接新增「分支/标签」下拉，按选择生成 `refs/heads/` 或 `refs/tags/`，下载 tag 不再 404。
- **仓库历史**：输入框记忆最近 5 个仓库地址（localStorage + datalist 原生下拉），重输更省事。

### v0.4（2026-09-02 代码审查后）

- 游客 IP 改用 Cloudflare 专有、不可伪造的 `cf-connecting-ip` 头（降级 `x-forwarded-for`），堵住伪造 IP 绕过单 IP 配额。
- 源码包不再硬编码 `master.zip`：输入框页新增「默认分支」输入框（默认 `main`），按用户填的分支生成 zip 链接。
- 配额清理改为惰性（在 `consume`/`peek` 里删过期项 + Map 过大时清扫），移除对 `setInterval` 的依赖（Workers 里定时器不可靠）。
- 复制按钮改用现代 `navigator.clipboard` API，失败自动降级到 `execCommand`。
- `copy()` 改为显式接收 `event` 参数，不再依赖全局 `event`。
- 错误响应（404/429）加 `Cache-Control: no-store`，避免被 CDN 缓存。
- `checkPath` 加 GitHub 路径模式校验，挡掉明显非法路径（如 `/foo/bar/baz/qux`），减少无效回源。

### v0.3（2026-09-02）

- 网站名改为「114Git」。
- UI 调整：git clone 链接行内置「复制」按钮；源码包 (zip) 链接行内置「下载」按钮（点击直接下载 zip）。

### v0.2（2026-09-02 全面核对后）

- 修复首页提示文案错误（替换方向写反）。
- 登录页/输入框页加 `no-store`，防止内嵌令牌被缓存泄露。
- `blob` 路径自动转 `raw`，curl/wget 可直接拿文件内容。
- 白名单补齐 `release-assets.githubusercontent.com`、`patch-diff.githubusercontent.com`。
- 307/308 跳转保持原方法与请求体（clone/LFS 场景更稳）。
- 游客配额改为「预检通过才计数」，不再多扣。
- 兼容老 gh-proxy 的 `/?q=github.com/...` 链接（302 到反代路径）。

### v0.1（2026-09-02 初版）

- 从 hunshcn/gh-proxy 的 Cloudflare Workers 版重写：登录密码 + 每日令牌 + 游客配额 + 网页生成链接 + 路径反代。
- 修复老版 release 大文件跳转、LFS、相对路径跳转等缺陷。
- 移除 Python/Docker 版，只保留 Workers 单文件。

## 许可证

本项目是对 [hunshcn/gh-proxy](https://github.com/hunshcn/gh-proxy)（MIT）的重写与改造。
依照 MIT 许可证要求保留版权声明，详见 `LICENSE`。