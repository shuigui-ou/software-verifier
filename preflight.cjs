'use strict';
/**
 * preflight.cjs —— 宿主"启动前自愈预检"（agent-evolution 行为闭环的执行器）
 *
 * 定位：把"引擎学到的 recurring 风险"落成**真实行为改变**——在会产生该风险的
 * 动作之前先做无副作用的自愈，而不是只把经验写进没人读的存储。
 *
 * 首个策略 = 端口预检：
 *   - EADDRINUSE（端口被旧实例占用）是 software-verifier 的高频 recurring 失败：
 *     driver 启动的调试端口被占 → launch 抛错 → 整轮 FATAL。
 *   - 预检：launch 前探测端口；被占则改用系统分配的空闲端口 → 失败变成功。
 *
 * 第二个策略 = 网络/连接/超时预检（网络类，见文件下半部）：
 *   - ECONNREFUSED / ETIMEDOUT / 502 / net::ERR_* —— 目标"还没起来"或"短暂不可达"。
 *   - 预检：导航前等待目标可达（重试探测）+ 导航失败重试 → 失败变成功。
 *
 * 全部 fail-open：任何异常都返回原端口/原状态，绝不阻断宿主主流程。
 */

const net = require('node:net');

/** 探测端口是否空闲（能 listen = 空闲）。超时视为空闲（宁可放行，不误杀） */
function probePort(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    let done = false;
    const finish = (free) => { if (done) return; done = true; try { srv.close(); } catch (_e) { /* ignore */ } resolve(free); };
    srv.once('error', (e) => finish(!(e && e.code === 'EADDRINUSE')));
    srv.once('listening', () => finish(true));
    try { srv.listen(port, '127.0.0.1'); } catch (_e) { finish(true); }
    const t = setTimeout(() => finish(true), 1500);
    if (t.unref) t.unref();
  });
}

/** 让系统分配一个空闲端口 */
function findFreePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    let done = false;
    const finish = (p) => { if (done) return; done = true; try { srv.close(); } catch (_e) { /* ignore */ } resolve(p); };
    srv.once('error', () => finish(0));
    srv.listen(0, '127.0.0.1', () => { finish(srv.address().port); });
    const t = setTimeout(() => finish(0), 1500);
    if (t.unref) t.unref();
  });
}

/**
 * 确保端口可用：被占用则改用一个空闲端口。
 * @returns {Promise<{port:number, moved:boolean, original:number, reason:string}>}
 */
async function ensureFreePort(port) {
  const original = Number(port) || 0;
  try {
    if (!original) return { port: original, moved: false, original, reason: 'no_port' };
    if (await probePort(original)) return { port: original, moved: false, original, reason: 'free' };
    const alt = await findFreePort();
    if (alt && alt !== original) return { port: alt, moved: true, original, reason: 'occupied' };
    return { port: original, moved: false, original, reason: 'no_alt' };
  } catch (_e) {
    return { port: original, moved: false, original, reason: 'error' };
  }
}

/** 文本是否是"端口被占用"类风险 */
const PORT_RISK_RE = /eaddrinuse|already in use|address already in use|端口占用|port\s*(is\s*)?(occupied|in use)/i;
function isPortLike(text) { return PORT_RISK_RE.test(String(text || '')); }

/**
 * 从"引擎复发记忆(risks)"判定是否存在端口类复发风险。
 * **证据驱动**：自动动作只认"本机学到的东西"，坑库只用于提示（hintFor），不驱动动作——
 * 否则泛化关键词会产生大量无依据探测（时延代价）。
 * @param {{risks?:object[]}} p
 */
function portRisk({ risks = [] } = {}) {
  try {
    for (const r of risks) {
      if (r && isPortLike((r.title || '') + ' ' + (r.fingerprint || ''))) return true;
    }
    return false;
  } catch (_e) {
    return false;
  }
}

// ---------- 策略 2：网络 / 连接 / 超时类自愈 ----------
// 对应 recurring 失败：ECONNREFUSED（目标还没起来）/ ETIMEDOUT / 502、503 /
// net::ERR_CONNECTION_REFUSED（goto 立即失败）等 —— 与端口占用同属"时序问题"，
// 但成因是"目标未就绪"而非"端口被占"，故用"等待可达 + 重试导航"来消除。

/** 文本是否是"网络/连接失败"类风险（精确到连接层签名，避免被泛化的"超时"字样误触发） */
const NET_RISK_RE = /econnrefused|econnreset|ehostunreach|enetunreach|etimedout|enotfound|eai_again|socket hang up|bad gateway|connect tunnel failed|\b50[234]\b|net::err_(connection|name|address|timedout|empty_response|failed)|connection (refused|reset|timed out|closed)|(?:page\.)?goto[^\n]{0,60}(timeout|timed out)|navigat\w*[^\n]{0,60}(timeout|timed out)|连接被拒绝|无法连接|连接超时/i;
function isNetworkLike(text) { return NET_RISK_RE.test(String(text || '')); }

/**
 * 判定是否存在网络类复发风险。**证据驱动**：只认引擎学到的复发记忆（risks）。
 * @param {{risks?:object[]}} p
 * @returns {{risky:boolean, hits:string[]}}
 */
function networkRisk({ risks = [] } = {}) {
  const hits = [];
  try {
    for (const r of risks) {
      const t = (r && ((r.title || '') + ' ' + (r.fingerprint || ''))) || '';
      if (isNetworkLike(t)) hits.push(String((r && r.title) || r.fingerprint || '').slice(0, 60));
    }
    return { risky: hits.length > 0, hits: hits.slice(0, 5) };
  } catch (_e) {
    return { risky: false, hits: [] };
  }
}

/** 单次 HTTP 探测（GET，2xx/3xx/4xx 视为可达；5xx / 连接错误 / 超时视为不可达） */
function probeHttp(url, timeoutMs = 2000) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok, info) => { if (settled) return; settled = true; resolve(Object.assign({ ok }, info || {})); };
    try {
      const u = new URL(String(url));
      const mod = u.protocol === 'https:' ? require('node:https') : require('node:http');
      const req = mod.request({
        method: 'GET', hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: (u.pathname || '/') + (u.search || ''), timeout: timeoutMs,
      }, (res) => { res.resume(); done(res.statusCode < 500, { status: res.statusCode }); });
      req.on('timeout', () => { try { req.destroy(); } catch (_e) { /* ignore */ } done(false, { error: 'timeout' }); });
      req.on('error', (e) => done(false, { error: (e && e.code) || String(e) }));
      req.end();
    } catch (e) { done(false, { error: 'bad_url' }); }
  });
}

/**
 * 等待目标可达（重试探测）：把"目标尚未起来导致的 ECONNREFUSED"变成"等一下就好了"。
 * @returns {Promise<{reachable:boolean, attempts:number, waitedMs:number, status?:number, error?:string}>}
 */
async function waitReachable(url, { retries = 6, delayMs = 700, timeoutMs = 2000 } = {}) {
  const startedAt = Date.now();
  const n = Math.max(1, Number(retries) || 1);
  let last = null;
  for (let i = 0; i < n; i++) {
    last = await probeHttp(url, timeoutMs);
    if (last.ok) return { reachable: true, attempts: i + 1, waitedMs: Date.now() - startedAt, status: last.status };
    if (i < n - 1) await new Promise((r) => setTimeout(r, Math.max(0, Number(delayMs) || 0)));
  }
  return { reachable: false, attempts: n, waitedMs: Date.now() - startedAt, error: (last && last.error) || 'unreachable' };
}

module.exports = { probePort, findFreePort, ensureFreePort, isPortLike, portRisk, isNetworkLike, networkRisk, probeHttp, waitReachable };
