// ============================================================================
//  114Git —— 个人用 GitHub 反代 (Cloudflare Workers)
//  零外部依赖 · 最新 ES 语法 · 安全/稳定/高效
//
//  部署：Worker 设置里配环境变量（PASSWORD、TOKEN_KEY 必填）：
//    PASSWORD         登录密码（必填）
//    TOKEN_KEY        令牌主密钥（必填，随机长字符串）
//    ALLOW_MASTER_KEY 设为 true 才允许主密钥直接作令牌（默认关闭，更安全）
//    DOMAIN           反代域名；不配则自动用当前访问域名（如 xxx.workers.dev）
//  用法（路径反代，直接替换域名即可）：
//    https://git.abc.xyz/user/repo(.git)        -> git clone
//    https://git.abc.xyz/user/repo/archive/...   -> 源码包 zip
//    https://git.abc.xyz/user/repo/releases/...  -> release 下载
//    https://git.abc.xyz/user/repo/blob|raw/...  -> 单文件
//  令牌：Web Crypto 由主密钥+日期派生，每天自动更换，16 位十六进制。
//    可放 URL ?t=…、请求头 X-Proxy-Token、或作为路径首段。
//  配额：内存计数（零外部依赖），重启清零，尽力而为。
// ============================================================================

// ------------------------------ 配置（惰性，从 env 读取） ------------------------------
const _configCache = new Map();

function getConfig(env = {}) {
  if (_configCache.has('cfg')) return _configCache.get('cfg');
  const cfg = {
    password: env.PASSWORD ?? '',
    tokenKey: env.TOKEN_KEY ?? '',
    domain: env.DOMAIN ?? '', // 空则回退为请求进来的域名（见 handle）
    guestIpLimit: Number(env.GUEST_IP_LIMIT ?? 50),
    guestGlobalLimit: Number(env.GUEST_GLOBAL_LIMIT ?? 50),
    guestWindowSec: Number(env.GUEST_WINDOW_SEC ?? 86400),
    timeoutMs: Number(env.PROXY_TIMEOUT_MS ?? 15000),
    maxRedirects: Number(env.MAX_REDIRECTS ?? 8),
    // 主密钥直通：默认关闭。设为 true/1/yes 时才允许 TOKEN_KEY 本身作为令牌（跨日方便，但降低安全性）
    allowMasterKey: ['true', '1', 'yes'].includes(String(env.ALLOW_MASTER_KEY ?? '').toLowerCase()),
  };
  // 生产安全：PASSWORD 与 TOKEN_KEY 缺一不可；未配置即视为未初始化，拒绝登录/令牌
  cfg.initialized = Boolean(cfg.password && cfg.tokenKey);
  _configCache.set('cfg', cfg);
  return cfg;
}

// ----------------------- 允许走反代的 host（严格白名单，防 SSRF） -----------------------
const ALLOWED_HOSTS = new Set([
  'github.com',
  'raw.githubusercontent.com',
  'gist.github.com',
  'gist.githubusercontent.com',
  'codeload.github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'patch-diff.githubusercontent.com',
  'github.githubassets.com',
]);

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// 内联 SVG favicon（字母 G），避免外部文件 & /favicon.ico 404
const FAVICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">' +
  '<rect width="32" height="32" rx="8" fill="#1f883d"/>' +
  '<text x="16" y="23" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-size="22" font-weight="bold" fill="#fff">G</text>' +
  '</svg>';
const FAVICON = 'data:image/svg+xml,' + encodeURIComponent(FAVICON_SVG);

// --------------------------- 内存配额（零外部依赖） ---------------------------
const quota = new Map();

function consume(key, limit, windowSec, now = Date.now()) {
  // 惰性清理：Map 过大时顺带清过期项（不依赖 setInterval，Workers 里定时器不可靠）
  if (quota.size > 2000) sweepQuota(now);
  let rec = quota.get(key);
  if (rec && now >= rec.until) { quota.delete(key); rec = null; }
  if (!rec) { rec = { count: 0, until: now + windowSec * 1000 }; quota.set(key, rec); }
  if (rec.count >= limit) return false;
  rec.count++;
  return true;
}

function peek(key, limit, windowSec, now = Date.now()) {
  const rec = quota.get(key);
  if (!rec) return 0;
  if (now >= rec.until) { quota.delete(key); return 0; }
  return rec.count;
}

function sweepQuota(now = Date.now()) {
  for (const [k, v] of quota) if (now >= v.until) quota.delete(k);
}

// 登录暴力破解防护（内存计数，Worker 重启清零，配合 CF 基础防护）
const loginFails = new Map(); // ip -> { count, lockUntil }
const MAX_LOGIN_FAILS = 5;    // 连续失败次数阈值
const LOGIN_LOCK_MS = 10 * 60 * 1000; // 锁定 10 分钟

// --------------------------- 令牌（Web Crypto，异步） ---------------------------
const enc = new TextEncoder();

async function sha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(str));
  const bytes = new Uint8Array(buf);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
  return hex;
}

function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getUTCFullYear() + p(d.getUTCMonth() + 1) + p(d.getUTCDate());
}

async function todayToken(cfg) {
  return (await sha256Hex(cfg.tokenKey + '/' + todayStr())).slice(0, 16);
}

async function tokenValid(t, cfg) {
  if (!t || typeof t !== 'string') return false;
  if (!cfg.initialized) return false; // 未配置密钥时，令牌一律无效
  const real = await todayToken(cfg);
  if (t === real) return true;
  // 主密钥直通：仅当显式开启（ALLOW_MASTER_KEY=true）时才接受主密钥本身
  return cfg.allowMasterKey && t === cfg.tokenKey;
}

// --------------------------- 校验 & 归一化 ---------------------------
function checkPath(p) {
  if (!p || !p.startsWith('/')) return false;
  // 完整 URL 前缀 / 完整域名前缀：直接放行（显式写明上游域名，可信）
  if (/^\/https?:\/\//i.test(p)) return true;
  if (/^\/(github\.com|raw\.githubusercontent\.com|gist\.(?:githubusercontent|github)\.com|codeload\.github\.com|objects\.githubusercontent\.com|release-assets\.githubusercontent\.com|patch-diff\.githubusercontent\.com|github\.githubassets\.com)\//i.test(p)) return true;
  // raw/ gist/ 短前缀：后续是 user/repo/branch/file，直接放行
  if (/^\/(raw|gist)\//i.test(p)) return true;
  // 纯路径形式 /user/repo[/(已知关键词|git-...)]
  const seg = p.split('/').filter(Boolean);
  if (seg.length < 2) return false;
  if (seg.length === 2) return true; // user/repo 或 user/repo.git（clone 入口）
  if (/\.git$/i.test(seg[1])) return true; // user/repo.git/任意（smart HTTP）
  const third = seg[2].toLowerCase();
  if (seg[2].startsWith('git-') || ['releases','archive','blob','raw','info','tags','tarball','zipball','commit','compare','branches'].includes(third)) return true;
  return false;
}

function toFullUrl(path) {
  let s = path;
  if (/^\/https?:\/\//i.test(s)) s = s.replace(/^\/https?:\/\//i, '');
  else if (/^\/github\.com\//i.test(s)) s = s.slice('/github.com/'.length);
  else s = s.replace(/^\/+/, ''); // 去掉所有前导斜杠（防止 // 双斜杠归一化出错）

  if (/^raw\.githubusercontent\.com\//i.test(s)) return 'https://' + s;
  if (/^gist\.(?:githubusercontent|github)\.com\//i.test(s)) return 'https://' + s;
  if (/^codeload\.github\.com\//i.test(s)) return 'https://' + s;
  if (/^objects\.githubusercontent\.com\//i.test(s)) return 'https://' + s;
  if (/^release-assets\.githubusercontent\.com\//i.test(s)) return 'https://' + s;
  if (/^patch-diff\.githubusercontent\.com\//i.test(s)) return 'https://' + s;
  if (/^github\.githubassets\.com\//i.test(s)) return 'https://' + s;
  if (/^raw\//i.test(s)) return 'https://raw.githubusercontent.com/' + s.slice(4);
  if (/^gist\//i.test(s)) return 'https://gist.githubusercontent.com/' + s.slice(5);

  s = s.replace(/^github\.com\//i, '');
  // blob 网页路径 → raw 文件路径，让 curl/wget 直接拿到文件内容而非 HTML 页面
  s = s.replace(/\/blob\//i, '/raw/');
  return 'https://github.com/' + s;
}

function isAllowedHost(urlStr) {
  try {
    return ALLOWED_HOSTS.has(new URL(urlStr).hostname);
  } catch {
    return false;
  }
}

// --------------------------- 页面渲染 HTML ---------------------------
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function renderLogin(wrong = false, msg = '') {
  const showErr = wrong ? '' : 'display:none';
  const errText = msg || '密码错误，请重试';
  return `<!DOCTYPE html><html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>114Git · 登录</title>
<link rel="icon" href="${FAVICON}">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;background:#f6f8fa;color:#1f2328;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:16px}
.card{background:#fff;border:1px solid #d0d7de;border-radius:12px;padding:36px 30px;width:100%;max-width:380px;box-shadow:0 1px 0 rgba(27,31,36,.04)}
h1{font-size:20px;font-weight:700;margin-bottom:6px}
p.sub{color:#656d76;font-size:13px;margin-bottom:22px}
input{width:100%;padding:10px 12px;border:1px solid #d0d7de;border-radius:6px;font-size:14px;margin-bottom:14px;-webkit-appearance:none}
input:focus{outline:none;border-color:#0969da;box-shadow:0 0 0 3px rgba(9,105,218,.15)}
button{width:100%;padding:10px;border:none;border-radius:6px;background:#1f883d;color:#fff;font-size:14px;font-weight:500;cursor:pointer}
button:active{background:#1a7f37}
.err{color:#cf222e;font-size:13px;margin-top:12px;${showErr}}
.foot{margin-top:22px;font-size:11px;color:#8b949e;text-align:center}
</style></head><body>
<form method="post" action="/" class="card">
  <h1>114Git</h1><p class="sub">个人 GitHub 反代</p>
  <input type="password" name="p" placeholder="登录密码" autofocus autocomplete="current-password">
  <button type="submit">进入</button>
  <div class="err">${errText}</div>
  <div class="foot">仅供站长自用</div>
</form></body></html>`;
}

function renderSetup() {
  return `<!DOCTYPE html><html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>114Git · 首次部署引导</title>
<link rel="icon" href="${FAVICON}">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;background:#f6f8fa;color:#1f2328;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:16px}
.card{background:#fff;border:1px solid #d0d7de;border-radius:12px;padding:32px 30px;width:100%;max-width:540px;box-shadow:0 1px 0 rgba(27,31,36,.04);line-height:1.7;font-size:14px}
h1{font-size:20px;font-weight:700;margin-bottom:4px}
p.sub{color:#656d76;font-size:13px;margin-bottom:18px}
.steps{margin:14px 0}
.step{display:flex;gap:10px;margin-bottom:10px}
.num{flex:none;width:22px;height:22px;border-radius:50%;background:#1f883d;color:#fff;font-size:12px;font-weight:600;display:flex;align-items:center;justify-content:center;margin-top:2px}
.step b{font-weight:600}
.vars{width:100%;border-collapse:collapse;margin:14px 0}
.vars td{padding:8px 10px;border:1px solid #e1e4e8;font-size:13px}
.vars td:first-child{background:#f6f8fa;white-space:nowrap}
.tag{color:#cf222e;font-weight:600;font-size:12px;white-space:nowrap}
code{background:#f6f8fa;border:1px solid #e1e4e8;border-radius:4px;padding:1px 6px;font-size:13px}
.genkey{background:#f6f8fa;border:1px solid #e1e4e8;border-radius:8px;padding:12px;margin:14px 0}
.genkey .kv{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;word-break:break-all;color:#1f2328;display:block;margin-bottom:10px;min-height:18px}
.btnrow{display:flex;gap:8px}
button{padding:8px 14px;border:none;border-radius:6px;background:#1f883d;color:#fff;font-size:13px;font-weight:500;cursor:pointer}
button.ghost{background:#fff;color:#0969da;border:1px solid #d0d7de}
.opt{margin:12px 0;font-size:13px;color:#656d76}
.foot{margin-top:16px;font-size:11px;color:#8b949e;text-align:center}
</style></head><body>
<div class="card">
  <h1>114Git · 首次部署引导</h1>
  <p class="sub">配置未完成：请先在 GitHub 仓库配好下面两项，否则无法登录</p>

  <div class="steps">
    <div class="step"><span class="num">1</span><div>打开 <b>GitHub 仓库</b> → <b>Settings</b> → <b>Secrets and variables</b> → <b>Actions</b></div></div>
    <div class="step"><span class="num">2</span><div>点「New repository secret」，添加下面两项（<b>必填</b>）</div></div>
  </div>

  <table class="vars">
    <tr><td><code>PASSWORD</code></td><td>登录密码，随便设一个</td><td class="tag">必填</td></tr>
    <tr><td><code>TOKEN_KEY</code></td><td>令牌主密钥（用下方按钮生成）</td><td class="tag">必填</td></tr>
    <tr><td><code>DOMAIN</code></td><td>反代域名（可选，不配自动用 workers.dev）</td><td>可选</td></tr>
  </table>

  <div class="genkey">
    <span class="kv" id="key">点「生成」得到一串随机密钥，粘贴到 TOKEN_KEY</span>
    <div class="btnrow">
      <button onclick="genKey()">生成随机密钥</button>
      <button class="ghost" onclick="copyKey(event)">复制</button>
    </div>
  </div>

  <div class="opt">其他配置项（<code>GUEST_IP_LIMIT</code>、<code>ALLOW_MASTER_KEY</code> 等）都有默认值，不填也能用。<br>若你是手动部署（不用 GitHub），则在 Cloudflare 后台的「变量和机密」里配同样两项。</div>

  <div class="steps">
    <div class="step"><span class="num">3</span><div>到 Actions 页点 <b>Run workflow</b> 触发一次部署</div></div>
    <div class="step"><span class="num">4</span><div><b>刷新本页</b> → 出现登录页即成功</div></div>
  </div>

  <div class="foot">114Git · 配置完成后本页会自动消失</div>
</div>
<script>
const $=(id)=>document.getElementById(id);
let _key='';
function genKey(){
  const chars='ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const arr=new Uint8Array(40); crypto.getRandomValues(arr);
  _key=''; for(let i=0;i<arr.length;i++) _key+=chars[arr[i]%chars.length];
  $('key').textContent=_key;
}
async function copyKey(ev){
  if(!_key) genKey();
  try{ await navigator.clipboard.writeText(_key); }
  catch(e){ const r=document.createRange();r.selectNodeContents($('key'));const s=window.getSelection();s.removeAllRanges();s.addRange(r);document.execCommand('copy');s.removeAllRanges(); }
  const b=ev&&ev.target; if(b){const o=b.textContent;b.textContent='已复制';setTimeout(()=>b.textContent=o,1200);}
}
</script>
</body></html>`;
}

function renderIndex(domain, token) {
  const d = domain;
  const t = token;
  return `<!DOCTYPE html><html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>114Git</title>
<link rel="icon" href="${FAVICON}">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;background:#f6f8fa;color:#1f2328;padding:40px 16px}
.wrap{max-width:640px;margin:0 auto}
header{margin-bottom:22px}
h1{font-size:22px;font-weight:700;margin-bottom:4px}
p.sub{color:#656d76;font-size:14px}
.box{background:#fff;border:1px solid #d0d7de;border-radius:12px;padding:22px;box-shadow:0 1px 0 rgba(27,31,36,.04)}
label{font-size:13px;font-weight:600;display:block;margin-bottom:8px}
label.sm{font-size:12px;margin-top:12px;margin-bottom:6px}
.br{width:100%;padding:8px 10px;border:1px solid #d0d7de;border-radius:6px;font-size:13px;-webkit-appearance:none}
select.bt{padding:8px 10px;border:1px solid #d0d7de;border-radius:6px;font-size:13px;background:#fff;-webkit-appearance:none;white-space:nowrap}
.row.br-row{align-items:stretch}
details.adv{margin-top:12px}
details.adv summary{cursor:pointer;font-size:13px;color:#0969da;user-select:none}
details.adv[open] summary{margin-bottom:8px}
.token-row{display:flex;align-items:center;gap:8px;margin-top:12px;background:#f6f8fa;border:1px solid #e1e4e8;border-radius:8px;padding:8px 12px}
.token-row .k{font-size:12px;color:#656d76;white-space:nowrap}
.token-row .v{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px;word-break:break-all;color:#24292f;flex:1}
.row{display:flex;gap:8px}
input{flex:1;padding:10px 12px;border:1px solid #d0d7de;border-radius:6px;font-size:14px;-webkit-appearance:none}
input:focus{outline:none;border-color:#0969da;box-shadow:0 0 0 3px rgba(9,105,218,.15)}
button{padding:10px 16px;border:none;border-radius:6px;background:#1f883d;color:#fff;font-size:14px;font-weight:500;cursor:pointer;white-space:nowrap}
button.ghost{background:#fff;color:#0969da;border:1px solid #d0d7de;margin-right:8px}
button.ghost:hover{background:#f6f8fa}
button.ghost.sm{padding:5px 10px;font-size:12px;margin:0}
a.btn.sm{display:inline-block;padding:5px 10px;font-size:12px;font-weight:500;border-radius:6px;background:#1f883d;color:#fff;text-decoration:none;white-space:nowrap}
a.btn.sm:hover{background:#1a7f37}
.item-hd{display:flex;justify-content:space-between;align-items:center;margin-bottom:4px}
.item-hd .k{font-size:12px;color:#656d76;margin-bottom:0}
.out{margin-top:16px;display:none}
.out.show{display:block}
.item{background:#f6f8fa;border:1px solid #e1e4e8;border-radius:8px;padding:10px 12px;margin-bottom:10px}
.item .k{font-size:12px;color:#656d76;margin-bottom:4px}
.item .v{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px;word-break:break-all;color:#24292f}
.btnrow{margin-bottom:16px}
.err{color:#cf222e;font-size:13px;margin-top:10px}
.hint{font-size:12.5px;color:#656d76;line-height:1.7;margin-top:16px}
.hint code{background:#f6f8fa;border:1px solid #e1e4e8;border-radius:4px;padding:1px 5px;font-size:11.5px}
.foot{margin-top:26px;font-size:11px;color:#8b949e;text-align:center}
</style></head><body>
<div class="wrap">
  <header><h1>114Git</h1><p class="sub">输入 GitHub 仓库地址 → 生成反代链接</p></header>
  <div class="box">
    <label>GitHub 仓库地址</label>
    <div class="row">
      <input type="text" id="u" list="hist" placeholder="https://github.com/user/repo" autofocus>
      <button onclick="gen()">生成</button>
    </div>
    <details class="adv">
      <summary>高级：手动指定分支 / 标签</summary>
      <label class="sm" for="br">分支 / 标签（留空自动识别）</label>
      <div class="row br-row">
        <select id="bt" class="bt"><option value="heads">分支</option><option value="tags">标签</option></select>
        <input type="text" id="br" class="br" value="" placeholder="留空自动识别 main/master">
      </div>
    </details>
    <div class="token-row">
      <span class="k">今日令牌</span>
      <span class="v" id="tok">${esc(t)}</span>
      <button class="ghost sm" onclick="copy('tok', event)">复制</button>
    </div>
    <datalist id="hist"></datalist>
    <div class="out" id="out">
      <div class="item">
        <div class="item-hd"><span class="k">git clone</span><button class="ghost sm" onclick="copy('c', event)">复制</button></div>
        <div class="v" id="c"></div>
      </div>
      <div class="item">
        <div class="item-hd"><span class="k">源码包 (zip)</span><a class="btn sm" id="dz" href="#" target="_blank" rel="noopener">下载</a></div>
        <div class="v" id="z"></div>
      </div>
    </div>
    <div class="err" id="err"></div>
    <div class="hint">
      将地址栏中的 <code>github.com</code> 替换为 <code>${esc(d)}</code>（其余路径不变）即可访问。<br>
      也可直接 <code>git clone https://${esc(d)}/user/repo.git</code>。
    </div>
  </div>
  <div class="foot">114Git · 个人自用</div>
</div>
<script>
const DOMAIN = ${JSON.stringify(d)}, TOKEN = ${JSON.stringify(t)};
const $ = (id) => document.getElementById(id);
async function gen() {
  const err = $('err'); err.textContent = '';
  const raw = $('u').value.trim();
  if (!raw) { err.textContent = '请输入仓库地址'; return; }
  let u = raw.replace(/^https?:\\/\\//i, '').replace(/^github\\.com\\//i, '');
  const m = u.match(/^([^/]+\\/[^/]+)/);
  if (!m) { err.textContent = '无法识别的地址'; return; }
  const repo = m[1].replace(/\\.git$/i, '');
  const cloneUrl = 'https://' + DOMAIN + '/' + TOKEN + '/' + repo + '.git';
  $('c').textContent = cloneUrl;
  $('out').classList.add('show');

  const bt = $('bt').value; // heads | tags
  let br = $('br').value.trim();
  // 防御：分支框若被误填成 URL，清空走自动识别（避免生成 refs/heads/https://… 坏链接）
  if (br && (br.includes('://') || br.startsWith('www.'))) { br = ''; $('br').value = ''; }
  if (!br) {
    // 留空则自动识别仓库默认分支（main/master），失败回退 main
    $('z').textContent = '正在识别默认分支…';
    $('dz').href = '#';
    br = await getDefaultBranch(repo);
    $('br').value = br;
  }
  const zipUrl = 'https://' + DOMAIN + '/' + TOKEN + '/' + repo + '/archive/refs/' + bt + '/' + encodeURI(br) + '.zip';
  $('z').textContent = zipUrl;
  $('dz').href = zipUrl;
  saveHist(raw);
}

async function getDefaultBranch(repo) {
  try {
    const r = await fetch('https://api.github.com/repos/' + repo);
    if (!r.ok) return 'main';
    const d = await r.json();
    return d.default_branch || 'main';
  } catch (e) { return 'main'; }
}
async function copy(id, ev) {
  const el = $(id);
  const txt = el.textContent;
  let ok = false;
  try { await navigator.clipboard.writeText(txt); ok = true; }
  catch (e) {
    // 降级到 execCommand
    const range = document.createRange(), sel = window.getSelection();
    sel.removeAllRanges(); range.selectNodeContents(el); sel.addRange(range);
    try { ok = document.execCommand('copy'); } catch (e2) {}
    sel.removeAllRanges();
  }
  const btn = ev && ev.target;
  if (btn) { const o = btn.textContent; btn.textContent = ok ? '已复制' : '复制失败'; setTimeout(() => (btn.textContent = o), 1100); }
}
$('u').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); gen(); } });
function loadHist() {
  try {
    const arr = JSON.parse(localStorage.getItem('gh114hist') || '[]');
    $('hist').innerHTML = arr.map((s) => '<option value="' + s.replace(/&/g, '&amp;').replace(/"/g, '&quot;') + '">').join('');
  } catch (e) {}
}
function saveHist(s) {
  try {
    let arr = JSON.parse(localStorage.getItem('gh114hist') || '[]');
    arr = arr.filter((x) => x !== s);
    arr.unshift(s);
    arr = arr.slice(0, 5);
    localStorage.setItem('gh114hist', JSON.stringify(arr));
    loadHist();
  } catch (e) {}
}
loadHist();
</script>
</body></html>`;
}

// --------------------------- 代理（迭代跟随跳转，防栈溢出） ---------------------------
async function proxy(req, target, cfg) {
  let url = target;
  let method = req.method;
  let body = ['GET', 'HEAD'].includes(method) ? undefined : req.body;

  for (let i = 0; i <= cfg.maxRedirects; i++) {
    const h = new Headers();
    for (const [k, v] of req.headers) {
      const lk = k.toLowerCase();
      if (lk === 'host' || lk === 'cookie' || lk === 'authorization' || lk === 'x-proxy-token') continue;
      h.set(k, v);
    }
    h.set('user-agent', UA);
    h.set('accept', '*/*');

    let res;
    try {
      res = await fetch(url, {
        method,
        headers: h,
        redirect: 'manual',
        body,
        signal: typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(cfg.timeoutMs) : undefined,
      });
    } catch (e) {
      return new Response('proxy error: ' + (e?.message ?? e), { status: 502 });
    }

    const out = new Headers(res.headers);
    out.set('access-control-allow-origin', '*');
    out.delete('content-security-policy');
    out.delete('content-security-policy-report-only');
    out.delete('clear-site-data');

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) return new Response(res.body, { status: res.status, headers: out });
      const abs = new URL(loc, url).href;
      if (!isAllowedHost(abs)) {
        // 外部跳转：交给浏览器自己跟（仅重写一次到目标）
        out.set('location', abs);
        return new Response(null, { status: res.status, headers: out });
      }
      url = abs;
      if (res.status === 307 || res.status === 308) {
        // 307/308 必须保持原方法与请求体（clone 大仓库/lfs 场景）
      } else {
        method = 'GET'; // 301/302/303 通常转 GET
        body = undefined;
      }
      continue;
    }
    return new Response(res.body, { status: res.status, headers: out });
  }
  return new Response('redirect loop', { status: 502 });
}

// --------------------------- 入口 ---------------------------
function html(s, extraHeaders = {}) {
  // 页面内嵌当天令牌，禁止缓存，防止令牌随 CDN/浏览器缓存泄露
  return new Response(s, {
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store, max-age=0', ...extraHeaders },
  });
}
function text(s, status = 200) {
  return new Response(s, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store, max-age=0' } });
}

async function handle(req, env) {
  const cfg = getConfig(env);
  const url = new URL(req.url);
  const path = url.pathname;

  // favicon：返回内联 SVG，避免 /favicon.ico 404
  if (path === '/favicon.ico' || path === '/favicon.svg') {
    return new Response(FAVICON_SVG, { headers: { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': 'public, max-age=86400' } });
  }

  // 老 gh-proxy 兼容：/?q=github.com/user/repo → 302 到反代路径（避免老链接 404）
  if (path === '/' && url.searchParams.has('q')) {
    const q = url.searchParams.get('q').replace(/^https?:\/\//i, '');
    if (/^github\.com\//i.test(q)) return Response.redirect(encodeURI('/' + q), 302);
  }

  // 主页
  if (path === '/' || path === '') {
    if (!cfg.initialized) return html(renderSetup());
    const loginIp = (req.headers.get('cf-connecting-ip') || req.headers.get('x-forwarded-for') || 'unknown').split(',')[0].trim();
    if (req.method === 'POST') {
      // 暴力破解防护：锁定期内直接拒绝
      const lf = loginFails.get(loginIp);
      if (lf && Date.now() < lf.lockUntil) {
        return html(renderLogin(true, '尝试次数过多，请 10 分钟后再试'));
      }
      const f = await req.formData().catch(() => null);
      const p = f?.get('p') ?? '';
      if (p === cfg.password) {
        loginFails.delete(loginIp);
        const token = await todayToken(cfg);
        // 域名：优先用自定义 DOMAIN；未配置则回退为当前请求域名（CF 默认 xxx.workers.dev 或自定义路由域名）
        const domain = cfg.domain || new URL(req.url).hostname;
        return html(renderIndex(domain, token));
      }
      // 记录失败；达阈值则锁定（顺带清理已过期的锁定记录，防 Map 无限增长）
      if (loginFails.size > 500) {
        const now0 = Date.now();
        for (const [k, v] of loginFails) if (now0 >= v.lockUntil) loginFails.delete(k);
      }
      const now = Date.now();
      let r = loginFails.get(loginIp) || { count: 0, lockUntil: 0 };
      r.count++;
      if (r.count >= MAX_LOGIN_FAILS) { r.count = 0; r.lockUntil = now + LOGIN_LOCK_MS; }
      loginFails.set(loginIp, r);
      return html(renderLogin(true));
    }
    return html(renderLogin(false));
  }

  // 解析令牌：路径首段 / ?t= / X-Proxy-Token 头
  const segs = path.split('/').filter(Boolean);
  let rest = path;
  let hasToken = false;
  if (segs.length && (await tokenValid(segs[0], cfg))) {
    hasToken = true;
    // 精确切掉首段令牌，保留其余原文（含 //，避免 https:// 被拆坏）
    rest = path.slice(1 + segs[0].length) || '/';
  } else {
    const t = url.searchParams.get('t') ?? req.headers.get('x-proxy-token') ?? '';
    if (await tokenValid(t, cfg)) hasToken = true;
  }

  if (!checkPath(rest)) return text('Not Found', 404);

  // 配额（先预检两个额度，都通过才计数，避免只扣一半导致少放行）
  // 优先 CF 专有头（不可伪造），降级 x-forwarded-for（本地/其他环境）
  const ip = (req.headers.get('cf-connecting-ip') || req.headers.get('x-forwarded-for') || 'unknown').split(',')[0].trim();
  if (!hasToken) {
    const ipUsed = peek('ip:' + ip, cfg.guestIpLimit, cfg.guestWindowSec);
    const gUsed = peek('global', cfg.guestGlobalLimit, cfg.guestWindowSec);
    if (ipUsed >= cfg.guestIpLimit || gUsed >= cfg.guestGlobalLimit) {
      return text('游客配额已用完，请使用带令牌的链接。', 429);
    }
    consume('ip:' + ip, cfg.guestIpLimit, cfg.guestWindowSec);
    consume('global', cfg.guestGlobalLimit, cfg.guestWindowSec);
  }

  const target = toFullUrl(rest);
  return proxy(req, target, cfg);
}

export default {
  async fetch(request, env) {
    return handle(request, env);
  },
};
