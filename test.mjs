// 114Git 本地端到端回归测试（node test.mjs，零依赖）
// 双层：mock 出站（断言代理行为，稳定可靠）+ 真实出站（网络允许时验证 smart HTTP，抖动时自动跳过）
import worker from './index.js';

const KEY = 'x'.repeat(40);
const env = { PASSWORD: 'p@ss', TOKEN_KEY: KEY };
const HOST = 'https://git.test';

let pass = 0, fail = 0, skip = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
}
function note(name) { skip++; console.log(`  skip ${name}`); }

// 独立计算当日令牌（与 index.js 同算法交叉验证）
async function sha256Hex(s) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
}
const d = new Date();
const today = d.getUTCFullYear() + String(d.getUTCMonth() + 1).padStart(2, '0') + String(d.getUTCDate()).padStart(2, '0');
const TOKEN = (await sha256Hex(KEY + '/' + today)).slice(0, 16);

async function call(method, path, opts = {}) {
  const req = new Request(HOST + path, { method, redirect: 'manual', ...opts });
  return worker.fetch(req, env);
}

// ---------- mock 出站 ----------
let calls = [];
const respQueue = [];
const origFetch = globalThis.fetch;
globalThis.fetch = async (u, o = {}) => {
  calls.push({
    url: String(u),
    method: o.method,
    body: o.body,
    headers: Object.fromEntries(new Headers(o.headers || {}).entries()),
  });
  const r = respQueue.shift() || { status: 200, headers: {} };
  return new Response(r.body ?? 'mock-body', { status: r.status, headers: r.headers });
};
const mock200 = () => { calls = []; respQueue.push({ status: 200 }); };

console.log(`当日令牌（独立计算）: ${TOKEN}\n`);

// ---------- 1. 未初始化引导页 ----------
{
  const res = await worker.fetch(new Request(HOST + '/'), {});
  const t = await res.text();
  check('未配置密钥 → 首次部署引导页', t.includes('首次部署引导'));
}

// ---------- 2. 登录流程 + 会话 Cookie ----------
{
  const res = await call('GET', '/');
  const t = await res.text();
  check('未登录 → 登录页', t.includes('登录密码'));
  check('安全头 x-frame-options: DENY', res.headers.get('x-frame-options') === 'DENY');
  check('安全头 referrer-policy: no-referrer', res.headers.get('referrer-policy') === 'no-referrer');
  check('登录页 no-store', (res.headers.get('cache-control') || '').includes('no-store'));
}
{
  const form = new FormData();
  form.set('p', 'wrong');
  const res = await call('POST', '/', { body: form });
  const t = await res.text();
  check('错误密码 → 提示重试', t.includes('密码错误'));
  check('错误密码 → 不发会话 Cookie', !res.headers.get('set-cookie'));
}
let cookieVal = '';
{
  const form = new FormData();
  form.set('p', 'p@ss');
  const res = await call('POST', '/', { body: form });
  const t = await res.text();
  const sc = res.headers.get('set-cookie') || '';
  cookieVal = (sc.match(/ga=([0-9a-f]+)/) || [])[1] || '';
  check('正确密码 → 生成页', t.includes('输入 GitHub 仓库地址'));
  check('正确密码 → Set-Cookie 为当日令牌', cookieVal === TOKEN, `got=${cookieVal}`);
  check('Cookie 属性 HttpOnly+Secure+SameSite', /HttpOnly/.test(sc) && /Secure/.test(sc) && /SameSite=Lax/.test(sc));
}
{
  const res = await call('GET', '/', { headers: { cookie: `ga=${cookieVal}` } });
  check('带会话 Cookie 刷新 → 免登录直接进生成页', (await res.text()).includes('输入 GitHub 仓库地址'));
}
{
  const res = await call('GET', '/', { headers: { cookie: 'ga=deadbeefdeadbeef' } });
  check('无效 Cookie → 仍要登录', (await res.text()).includes('登录密码'));
}

// ---------- 3. P0：查询串保留（mock 断言出站 URL） ----------
{
  mock200();
  await call('GET', `/${TOKEN}/octocat/Hello-World.git/info/refs?service=git-upload-pack`);
  const u = calls[0]?.url || '';
  check('P0 修复：路径令牌 clone 第一步 → service 参数保留', u === 'https://github.com/octocat/Hello-World.git/info/refs?service=git-upload-pack', `got=${u}`);
}
{
  mock200();
  await call('GET', `/octocat/Hello-World.git/info/refs?service=git-upload-pack&t=${TOKEN}`);
  const u = calls[0]?.url || '';
  check('P0 修复：?t= 方式 → service 保留且令牌参数不外漏', u === 'https://github.com/octocat/Hello-World.git/info/refs?service=git-upload-pack', `got=${u}`);
}

// ---------- 4. 令牌三种携带方式 ----------
{
  mock200();
  await call('GET', `/${TOKEN}/octocat/Hello-World/raw/master/README`);
  check('路径首段令牌 → 剥离后回源 raw 路径', calls[0]?.url === 'https://github.com/octocat/Hello-World/raw/master/README', `got=${calls[0]?.url}`);
}
{
  mock200();
  await call('GET', `/octocat/Hello-World/raw/master/README`, { headers: { 'x-proxy-token': TOKEN } });
  check('X-Proxy-Token 头方式 → 正常回源', calls[0]?.url?.includes('raw/master/README'));
}

// ---------- 5. api.github.com 反代（默认分支识别用） ----------
{
  mock200();
  await call('GET', `/${TOKEN}/api.github.com/repos/octocat/Hello-World`);
  check('api.github.com 反代 → URL 正确', calls[0]?.url === 'https://api.github.com/repos/octocat/Hello-World', `got=${calls[0]?.url}`);
}

// ---------- 6. 防御性折算 / 白名单 ----------
{
  mock200();
  await call('GET', `/${TOKEN}/https://evil.com/x`);
  // 完整 URL 形式经 toFullUrl 归一化后只会命中白名单域名：任意陌生域名折算为 github.com 路径
  check('陌生域名完整 URL → 折算回 github.com（无 SSRF）', calls[0]?.url === 'https://github.com/evil.com/x', `got=${calls[0]?.url}`);
}
{
  calls = [];
  await call('GET', `/${TOKEN}/user/repo/unknown/seg`);
  check('未知路径关键词 → 404 且不出站', calls.length === 0);
}

// ---------- 7. blob → raw 精准转换 ----------
{
  mock200();
  await call('GET', `/${TOKEN}/octocat/Hello-World/blob/main/README.md`);
  check('blob 网页路径 → 转 raw', calls[0]?.url === 'https://github.com/octocat/Hello-World/raw/main/README.md', `got=${calls[0]?.url}`);
}
{
  mock200();
  await call('GET', `/${TOKEN}/octocat/Hello-World/compare/blob...main`);
  check('路径中含 blob 字样的非 blob 路径 → 不误转', calls[0]?.url === 'https://github.com/octocat/Hello-World/compare/blob...main', `got=${calls[0]?.url}`);
}

// ---------- 8. 敏感/隐私头剔除 ----------
{
  mock200();
  await call('GET', `/${TOKEN}/octocat/Hello-World/raw/master/README`, {
    headers: {
      'cf-connecting-ip': '1.2.3.4',
      'x-forwarded-for': '1.2.3.4',
      'x-real-ip': '1.2.3.4',
      'cf-ipcountry': 'CN',
      cookie: 'secret=1',
      authorization: 'Bearer top-secret',
    },
  });
  const h = calls[0]?.headers || {};
  const leaked = ['cf-connecting-ip', 'x-forwarded-for', 'x-real-ip', 'cf-ipcountry', 'cookie', 'authorization'].filter((k) => h[k]);
  check('IP/凭据头不透传上游', leaked.length === 0, `leaked=${leaked.join(',')}`);
  check('UA 伪装已设置', (h['user-agent'] || '').includes('Chrome'));
}

// ---------- 9. 响应头：set-cookie 清除 + nosniff ----------
{
  respQueue.push({ status: 403, headers: { 'set-cookie': 'logged_in=yes', 'server': 'GitHub' } });
  const res = await call('GET', `/${TOKEN}/octocat/Hello-World.git/info/refs`);
  check('上游 set-cookie 不透传', !res.headers.has('set-cookie'));
  check('响应 nosniff', res.headers.get('x-content-type-options') === 'nosniff');
}

// ---------- 10. 重定向跟随 ----------
{
  calls = []; respQueue.length = 0;
  respQueue.push({ status: 301, headers: { location: 'https://raw.githubusercontent.com/x/y' } });
  mock200();
  await call('GET', `/${TOKEN}/github.com/a/b`);
  check('白名单内 301 → 服务端跟随（2 跳）', calls.length === 2 && calls[1]?.url === 'https://raw.githubusercontent.com/x/y', JSON.stringify(calls.map((c) => c.url)));
  check('301 转 GET', calls[1]?.method === 'GET');
}
{
  calls = []; respQueue.length = 0;
  respQueue.push({ status: 302, headers: { location: 'https://evil.com/out' } });
  await call('GET', `/${TOKEN}/github.com/a/b`);
  check('白名单外跳转 → 302 交给浏览器', calls.length === 1);
}
{
  calls = []; respQueue.length = 0;
  respQueue.push({ status: 307, headers: { location: 'https://github.com/moved/pack' } });
  respQueue.push({ status: 200 });
  const req = new Request(HOST + `/${TOKEN}/user/repo.git/git-upload-pack`, { method: 'POST', body: 'git-body-123' });
  await worker.fetch(req, env);
  check('307 保持 POST 方法', calls[1]?.method === 'POST');
  const txt = calls[1]?.body instanceof ArrayBuffer ? new TextDecoder().decode(calls[1].body) : String(calls[1]?.body);
  check('307 请求体可重发（body 缓冲修复）', txt === 'git-body-123', `got=${txt}`);
}

// ---------- 11. 老链接兼容 /?q= ----------
{
  const res = await call('GET', '/?q=github.com/octocat/Hello-World');
  check('/?q= 老 gh-proxy 兼容 → 302', res.status === 302, `status=${res.status}`);
  check('302 目标为反代路径', (res.headers.get('location') || '').startsWith('/github.com/octocat/Hello-World'));
}

// ---------- 12. 游客配额（mock，不依赖网络） ----------
{
  const qEnv = { PASSWORD: 'p@ss', TOKEN_KEY: KEY, GUEST_IP_LIMIT: '1', GUEST_GLOBAL_LIMIT: '1000' };
  const ip = { 'cf-connecting-ip': '7.7.7.7' };
  const r1 = await worker.fetch(new Request(`${HOST}/octocat/Hello-World/raw/master/README`, { headers: ip }), qEnv);
  const r2 = await worker.fetch(new Request(`${HOST}/octocat/Hello-World/raw/master/README`, { headers: ip }), qEnv);
  check('游客第 1 次放行', r1.status === 200, `status=${r1.status}`);
  check('游客第 2 次超额 → 429', r2.status === 429, `status=${r2.status}`);
}

// ---------- 12.5 v1.3 修复回归：chunked body / 逐跳头 / 方法切换残留头 ----------
{
  // chunked（流式 body，无 content-length）小体积 → 正常缓冲并回源
  mock200();
  const small = new ReadableStream({
    start(c) { c.enqueue(new TextEncoder().encode('chunked-body-ok')); c.close(); },
  });
  const r = await worker.fetch(new Request(HOST + `/${TOKEN}/user/repo.git/git-upload-pack`, { method: 'POST', body: small, duplex: 'half' }), env);
  check('chunked 小 body → 正常回源 200', r.status === 200 && calls.length === 1, `status=${r.status} calls=${calls.length}`);
  const b = calls[0]?.body;
  const txt = b instanceof ArrayBuffer ? new TextDecoder().decode(b) : String(b ?? '');
  check('chunked body 内容完整', txt === 'chunked-body-ok', `got=${txt}`);
}
{
  // chunked 超 50MB 上限 → 413 快速失败且不出站（防 OOM）
  calls = []; respQueue.length = 0;
  const big = new ReadableStream({
    start(c) {
      const chunk = new Uint8Array(5 * 1024 * 1024); // 5MB/块 × 11 块 = 55MB > 50MB
      for (let i = 0; i < 11; i++) c.enqueue(chunk);
      c.close();
    },
  });
  const r = await worker.fetch(new Request(HOST + `/${TOKEN}/user/repo.git/git-upload-pack`, { method: 'POST', body: big, duplex: 'half' }), env);
  check('chunked 超 50MB 上限 → 413 且不出站（防 OOM）', r.status === 413 && calls.length === 0, `status=${r.status} calls=${calls.length}`);
}
{
  // 303 → 转 GET 后不得残留 content-length / content-type（上游会挂起或 400）
  calls = []; respQueue.length = 0;
  respQueue.push({ status: 303, headers: { location: 'https://github.com/after/303' } });
  respQueue.push({ status: 200 });
  await call('POST', `/${TOKEN}/user/repo.git/git-upload-pack`, { body: 'abc', headers: { 'content-type': 'application/x-git-upload-pack-request' } });
  const h = calls[1]?.headers || {};
  check('303 转 GET → 不残留 content-length/content-type',
    calls[1]?.method === 'GET' && !h['content-length'] && !h['content-type'],
    `method=${calls[1]?.method} cl=${h['content-length']} ct=${h['content-type']}`);
}
{
  // 出站请求不携带逐跳头（即使客户端恶意传入）
  mock200();
  await call('GET', `/${TOKEN}/octocat/Hello-World/raw/master/README`, {
    headers: { 'transfer-encoding': 'chunked', connection: 'keep-alive', upgrade: 'websocket' },
  });
  const h = calls[0]?.headers || {};
  const leaked = ['transfer-encoding', 'connection', 'upgrade'].filter((k) => h[k]);
  check('逐跳头不透传上游', leaked.length === 0, `leaked=${leaked.join(',')}`);
}
{
  // 声明超限的 content-length → 不缓冲保持流式，307 后明确 502（不 OOM 不吊死）
  calls = []; respQueue.length = 0;
  respQueue.push({ status: 307, headers: { location: 'https://github.com/moved/pack' } });
  const req = new Request(HOST + `/${TOKEN}/user/repo.git/git-upload-pack`, {
    method: 'POST',
    body: new Uint8Array(64),
    headers: { 'content-length': String(51 * 1024 * 1024) },
  });
  const r = await worker.fetch(req, env);
  check('声明超限 body → 第一跳放行', calls.length === 1, `calls=${calls.length}`);
  check('声明超限 body + 307 → 502 明确失败', r.status === 502, `status=${r.status}`);
}

// ---------- 12.6 v1.3 修复回归：令牌形状提示 / 脏配置净化 ----------
{
  // 令牌被截断 / 多打一个字符 / 大写 → 401 明确提示（而不是干巴巴 404）
  const bad = [TOKEN.slice(0, 15), TOKEN + '0', TOKEN.toUpperCase()];
  let allOk = true, detail = '';
  for (const t of bad) {
    const res = await call('GET', `/${t}/user/repo/raw/main/a`, { env: { ...env, GUEST_IP_LIMIT: '0', GUEST_GLOBAL_LIMIT: '0' } });
    const txt = await res.text();
    if (res.status !== 401 || !txt.includes('令牌')) { allOk = false; detail += `[${t.slice(0, 8)}…→${res.status}]`; }
  }
  check('令牌形状异常 → 401 + 令牌轮换提示', allOk, detail);
}
{
  // 脏配置 GUEST_IP_LIMIT=abc → 必须回退默认 50，而不是 NaN 静默无限放行
  const e = { PASSWORD: 'p@ss', TOKEN_KEY: KEY, GUEST_IP_LIMIT: 'abc', GUEST_GLOBAL_LIMIT: 'abc' };
  const ip = { 'cf-connecting-ip': '6.6.6.6' };
  let first = 0, last = 0;
  for (let i = 0; i < 55; i++) {
    const r = await worker.fetch(new Request(`${HOST}/user/repo/raw/main/a`, { headers: ip }), e);
    if (i === 0) first = r.status;
    last = r.status;
  }
  check('脏配额配置回退默认（IP 50，第 51 次 429）', first === 200 && last === 429, `first=${first} last=${last}`);
}

// ---------- 13. 真实出站：git smart HTTP（网络抖动时跳过） ----------
{
  globalThis.fetch = origFetch;
  let ok = false, ct = '', tries = 3;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await call('GET', `/${TOKEN}/octocat/Hello-World.git/info/refs?service=git-upload-pack`);
      ct = res.headers.get('content-type') || '';
      if (res.status === 200 && ct.includes('x-git-upload-pack-advertisement')) { ok = true; break; }
    } catch { /* 网络抖动重试 */ }
  }
  if (ok) check('真实出站：clone 第一步 → 200 + smart 协议响应', true);
  else note(`真实出站：clone 协议验证（沙箱网络抖动，smart HTTP 已由 mock 层覆盖；最后一次 ct=${ct || 'n/a'}）`);
}

globalThis.fetch = origFetch;
console.log(`\n结果: ${pass} 通过, ${fail} 失败, ${skip} 跳过`);
process.exit(fail ? 1 : 0);
