#!/usr/bin/env node
/**
 * software-verifier —— 通用「按说明书全量走查」验证引擎（驱动可插拔）
 *
 * 用本机无头 Edge（playwright-core）像真人一样打开软件、逐条点击/填表/触发功能、
 * 截图 + 抓页面错误 + 断言预期状态，最后产出 ✅/❌ 报告。
 *
 * 支持驱动（--driver）：
 *   browser     : 标准 Web 应用（默认，无需额外依赖）
 *   electron    : Electron 桌面应用（需 playwright 完整包 + --app <main.js>）
 *   miniprogram : 微信小程序（需 miniprogram-automator + 微信开发者工具 + --app <projectPath>）
 *   appium      : 原生移动 App（需 webdriverio + Appium server + --platform android|ios）
 *
 * 用法：
 *   node verify.cjs --spec <spec.json> --url http://localhost:3000 [--driver browser]
 *                   [--ui-only] [--also F04,F16] [--only F01,F02] [--ai on]
 *                   [--app <path>] [--platform android|ios] [--caps <caps.json>]
 *
 * spec 结构见 SKILL.md。引擎与具体软件解耦：换软件只需换 spec；换运行环境只需换 --driver。
 */
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');

const SKILL_DIR = __dirname;

// 自动定位 playwright-core（源码内零硬编码路径）：
//   env PW_CORE → require.resolve → 与当前 node 同级 / WorkBuddy 托管各版本 / 全局 npm → 明确报错
function resolvePwCore() {
  if (process.env.PW_CORE) return process.env.PW_CORE;
  for (const base of [SKILL_DIR, process.cwd(), path.dirname(process.execPath)].filter(Boolean)) {
    try { const p = require.resolve('playwright-core', { paths: [base] }); if (p) return p; } catch (e) {}
  }
  const cands = [path.join(path.dirname(process.execPath), 'node_modules', 'playwright-core')];
  try {
    const binRoot = path.join(os.homedir(), '.workbuddy', 'binaries', 'node', 'versions');
    for (const v of fs.readdirSync(binRoot)) cands.push(path.join(binRoot, v, 'node_modules', 'playwright-core'));
  } catch (e) {}
  try {
    const out = require('child_process').execSync('npm root -g', { encoding: 'utf8' }).trim().split(/\r?\n/);
    for (const gr of out) cands.push(path.join(gr, 'playwright-core'));
  } catch (e) {}
  for (const c of cands) { try { if (c && fs.existsSync(c)) return c; } catch (e) {} }
  throw new Error(
    '[software-verifier] 未找到 playwright-core。请任选其一：\n' +
    '  (a) 设环境变量 PW_CORE=<node_modules/playwright-core 的绝对路径>\n' +
    '  (b) 在 skill 目录安装依赖：npm i playwright-core'
  );
}

// ---------- 参数解析 ----------
const args = process.argv.slice(2);
const opt = {
  spec: null, url: null, out: null, uiOnly: false, also: [], only: [], ai: 'off',
  driver: 'browser', app: null, platform: 'android', caps: null,
  appiumUrl: 'localhost', appiumPort: 4723, port: 9420, heal: true, evolve: false,
};
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--spec') opt.spec = args[++i];
  else if (a === '--url') opt.url = args[++i];
  else if (a === '--out') opt.out = args[++i];
  else if (a === '--ui-only') opt.uiOnly = true;
  else if (a === '--also') opt.also = args[++i].split(',').map(s => s.trim());
  else if (a === '--only') opt.only = args[++i].split(',').map(s => s.trim());
  else if (a === '--ai') opt.ai = args[++i];
  else if (a === '--driver') opt.driver = args[++i];
  else if (a === '--app') opt.app = args[++i];
  else if (a === '--platform') opt.platform = args[++i];
  else if (a === '--caps') opt.caps = args[++i];
  else if (a === '--appium-url') opt.appiumUrl = args[++i];
  else if (a === '--appium-port') opt.appiumPort = parseInt(args[++i], 10);
  else if (a === '--port') opt.port = parseInt(args[++i], 10);
  else if (a === '--no-heal') opt.heal = false;
  else if (a === '--evolve') opt.evolve = args[++i] === 'on';
}
if (!opt.spec || !opt.url) {
  console.error('用法: node verify.cjs --spec <spec.json> --url <baseUrl> [--driver browser|electron|miniprogram|appium] [--out <dir>] [--evolve on]');
  process.exit(2);
}

const spec = JSON.parse(fs.readFileSync(opt.spec, 'utf8'));
const BASE = opt.url.replace(/\/$/, '');
const OUT = opt.out || (path.dirname(opt.spec) + '/verify_report');
fs.mkdirSync(OUT, { recursive: true });
const SHOTS = OUT + '/shots';
fs.mkdirSync(SHOTS, { recursive: true });

const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------- 自进化知识库 ----------
const { runEvolution, loadPitfalls, matchPitfall, anonymize } = require(SKILL_DIR + '/evolve.cjs');
const PITFALLS = loadPitfalls();
const hintFor = (text) => { const p = matchPitfall(anonymize(text || ''), PITFALLS); return p ? ' 💡 已知坑[' + p.id + ']: ' + p.fix : ''; };

// ---------- agent-evolution 共享进化引擎接入（turnkey 适配器，全程 fail-open） ----------
// 引擎未就绪 / require 失败 / 初始化异常 → evo 为 null，所有调用安全 no-op，不影响验证主流程。
let evo = null;
try { evo = require(SKILL_DIR + '/evolution-host.cjs'); evo.init({ autoStart: false }); }
catch (_e) { /* 引擎未就绪则完全旁路 */ }
const evoTap = (e, ctx) => { try { if (evo) evo.tapError(e, ctx); } catch (_e) {} };
const evoRun = async () => { try { if (evo) await evo.runCycle(); } catch (_e) {} };
// 行为闭环：读取侧（引擎复发记忆 + pre_action 已知经验）与执行器（启动前自愈预检）
const evoSelfHeal = require(SKILL_DIR + '/preflight.cjs');
const evoRecurring = () => { try { return evo ? evo.recurringErrors({ minHits: 1 }) : []; } catch (_e) { return []; } };
const evoAdvisory = (action) => { try { const g = evo ? evo.preActionGate({ action }) : null; return (g && g.inject && g.inject.text) ? g.inject.text : ''; } catch (_e) { return ''; } };

// ---------- 驱动加载 ----------
function loadDriver(name) {
  const pwCore = resolvePwCore();
  if (name === 'browser' || name === 'electron') {
    const { makeDomDriver } = require(SKILL_DIR + '/drivers/dom.js');
    return makeDomDriver(name, pwCore);
  }
  if (name === 'miniprogram') {
    const { createMiniprogramDriver } = require(SKILL_DIR + '/drivers/miniprogram.js');
    return createMiniprogramDriver(pwCore);
  }
  if (name === 'appium') {
    const { createAppiumDriver } = require(SKILL_DIR + '/drivers/appium.js');
    return createAppiumDriver(pwCore);
  }
  throw new Error('未知驱动: ' + name + '（支持 browser|electron|miniprogram|appium）');
}

// ---------- 步骤执行（驱动无关，委托 engine.cjs） ----------
const { runStep: _runStep, runAssert: _runAssert } = require(SKILL_DIR + '/engine.cjs');
const visKey = (name) => {
  const app = (spec.app || spec.name || 'app');
  return path.join(SKILL_DIR, 'evolution', 'visual-baselines', (app + '_' + name).replace(/[^\w一-龥]/g, '_').slice(0, 80) + '.json');
};
const CTX = { BASE, SHOTS, SKILL_DIR, visualBase: visKey };
async function runStep(drv, step) { return _runStep(drv, step, CTX); }
async function runAssert(drv, a) { return _runAssert(drv, a, CTX); }

// ---------- 主流程 ----------
(async () => {
  let result = { name: spec.name || spec.app || '未知软件', baseUrl: BASE, driver: opt.driver, startedAt: new Date().toISOString(), features: [] };
  let drv;
  const errors = []; // 全局错误（最终汇总）
  try {
    drv = loadDriver(opt.driver);
    drv.setHeal(opt.heal);

    // ---------- 进化闭环（读取侧 + 行为改变）：启动前自愈预检 ----------
    // 从引擎"学到的复发记忆"判定该动作是否有"端口占用"类复发风险（**证据驱动**：只有本机学到过才动作；
    // 坑库仅用于提示）→ 若有，则 launch 前先探测端口，占用就改用空闲端口（把反复出现的 EADDRINUSE 变成不再发生）。
    try {
      const adv = evoAdvisory('driver.launch');
      if (adv) log('🧠 进化经验（launch 动作）：' + adv);
      const risks = evoRecurring();
      if (evoSelfHeal.portRisk({ risks })) {
        const pf = await evoSelfHeal.ensureFreePort(opt.port);
        if (pf.moved) {
          log('🛡 预检自愈：端口 ' + pf.original + ' 被占用 → 自动改用 ' + pf.port + '（知识库判定为复发风险，已避免 EADDRINUSE）');
          opt.port = pf.port;
        }
      }
    } catch (_e) { /* 预检失败不影响主流程 */ }

    await drv.launch({ appPath: opt.app, platform: opt.platform, caps: opt.caps, appiumUrl: opt.appiumUrl, appiumPort: opt.appiumPort, port: opt.port });
    log('=== software-verifier [' + opt.driver + ']: ' + spec.name + ' @ ' + BASE + ' ===');

    // ---------- 进化闭环（网络类）：导航前等待目标可达 + 导航重试 ----------
    // 与端口预检同构：读侧判定"是否有网络类复发记忆"，命中则把"目标还没起来"变成"等一下就好了"。
    let netRisky = false;
    try {
      const nr = evoSelfHeal.networkRisk({ risks: evoRecurring() });
      netRisky = !!(nr && nr.risky);
      if (netRisky) {
        const wr = await evoSelfHeal.waitReachable(BASE + '/', { retries: 6, delayMs: 700, timeoutMs: 2000 });
        log(wr.reachable
          ? '🛡 预检自愈：目标 ' + BASE + ' 等待 ' + wr.waitedMs + 'ms 后可达（第 ' + wr.attempts + ' 次探测 · 知识库判定为网络类复发风险，已避免 ECONNREFUSED）'
          : '⚠ 预检自愈：目标 ' + BASE + ' 探测 ' + wr.attempts + ' 次仍不可达（' + (wr.error || '') + '），仍按原流程尝试导航');
      }
    } catch (_e) { /* 网络预检失败不影响主流程 */ }

    // 启动即导航到被测地址（命中网络风险时带重试）
    const gotoAttempts = netRisky ? 3 : 1;
    let gotoOk = false, gotoErr = null;
    for (let i = 0; i < gotoAttempts; i++) {
      try { await drv.goto(BASE + '/'); gotoOk = true; if (i > 0) log('🛡 导航重试成功（第 ' + (i + 1) + ' 次）'); break; }
      catch (e) { gotoErr = e; if (i < gotoAttempts - 1) await drv.wait(800); }
    }
    if (!gotoOk) throw (gotoErr || new Error('导航失败: ' + BASE));
    await drv.wait(1000);

    if (spec.setup) for (const s of spec.setup) { const r = await runStep(drv, s); if (!r.ok) log('  setup 步骤失败: ' + (r.err || '')); }

    let selected = spec.features;
    if (opt.only.length) selected = spec.features.filter(f => opt.only.includes(f.id));
    else if (opt.uiOnly) selected = spec.features.filter(f => f.type !== 'ai' || opt.also.includes(f.id));
    if (opt.also.length && !opt.only.length) {
      const extra = spec.features.filter(f => opt.also.includes(f.id) && !selected.includes(f));
      selected = selected.concat(extra);
    }
    if (opt.ai === 'on') selected = spec.features;

    log('将验证 ' + selected.length + ' / ' + spec.features.length + ' 个功能点\n');

    const allHeals = [];
    for (const f of selected) {
      drv.clearFeatureErrors();
      drv.clearHeals();
      await drv.preFeatureCleanup();
      const frec = { id: f.id, name: f.name, type: f.type, group: f.group || '', steps: [], asserts: [], pass: true, errors: [] };
      const featureErrors = []; // 本 feature 错误（来自驱动）
      log('▶ [' + f.id + '] ' + f.name + ' (' + f.type + ')');
      try {
        if (f.setup) for (const s of f.setup) { const r = await runStep(drv, s); frec.steps.push({ do: s.do, ...r }); }

        for (const s of (f.steps || [])) {
          const r = await runStep(drv, s);
          frec.steps.push({ do: s.do, text: s.text || s.sel || '', ...r });
          if (!r.ok) { frec.pass = false; frec.errors.push('步骤 ' + s.do + ' 失败: ' + (r.err || r.detail || '')); log('   ✗ 步骤 ' + s.do + ': ' + (r.err || r.detail || '')); evoTap(new Error('步骤 ' + s.do + ' 失败: ' + (r.err || r.detail || '')), { taskId: 'verify' }); }
          if (s.screenshot) await drv.screenshot(SHOTS + '/' + s.screenshot).catch(() => {});
        }
        const shot = (f.id + '_' + f.name).replace(/[^\w一-龥]/g, '_') + '.png';
        await drv.screenshot(SHOTS + '/' + shot).catch(() => {});
        frec.screenshot = 'shots/' + shot;

        for (const a of (f.asserts || [])) {
          const ar = await runAssert(drv, a);
          frec.asserts.push({ desc: a.desc || a.sel || a.eval || a.includes || '', ...ar });
          if (!ar.pass) { frec.pass = false; frec.errors.push('断言失败: ' + ar.detail + hintFor(ar.detail)); evoTap(new Error('断言失败: ' + ar.detail), { taskId: 'verify' }); }
          log('   ' + (ar.pass ? '✓' : '✗') + ' ' + (a.desc || ar.detail));
        }
        const drvErrs = (drv.featureErrors || []).slice();
        if (drvErrs.length) { frec.pass = false; frec.errors = frec.errors.concat(drvErrs.map(e => e + hintFor(e))); (errors.push.apply(errors, drvErrs)); drvErrs.forEach(e => evoTap(new Error(e), { taskId: 'verify', source: 'driver' })); }
      } catch (e) {
        const em = (e && e.message || String(e));
        frec.pass = false; frec.errors.push('异常: ' + em + hintFor(em));
        log('   ✗ 异常: ' + em);
        evoTap(e, { taskId: 'verify', source: 'feature' });
        const shotE = 'ERR_' + f.id + '.png';
        await drv.screenshot(SHOTS + '/' + shotE).catch(() => {});
        frec.screenshot = 'shots/' + shotE;
      }
      frec.heals = drv.heals.slice();
      allHeals.push(...frec.heals);
      log('   → ' + (frec.pass ? 'PASS' : 'FAIL') + (frec.errors.length ? '  (' + frec.errors.length + ' 处)' : '') + (frec.heals.length ? '  ♻自愈' + frec.heals.length : '') + '\n');
      result.features.push(frec);
    }

    result.endedAt = new Date().toISOString();
    result.totalErrors = errors;
    result.healTotal = allHeals.length;
    result.heals = allHeals;
    const passN = result.features.filter(f => f.pass).length;
    result.summary = { total: result.features.length, pass: passN, fail: result.features.length - passN };
    log('\n========== 汇总: ' + passN + '/' + result.features.length + ' 通过 ==========');
    if (result.healTotal) log('♻ 本次自愈 ' + result.healTotal + ' 处失效选择器（见报告「自愈记录」）');

    fs.writeFileSync(OUT + '/result.json', JSON.stringify(result, null, 2));
    writeMarkdown(result, OUT + '/VERIFY-报告.md');
    writeHtml(result, OUT + '/VERIFY-报告.html');
    log('报告已写入: ' + OUT);
    // 自进化默认静默：接入共享进化引擎前，不再无审计地自动落盘 pitfalls/learnings。
    // 需要旧行为时显式 --evolve on（仍可手动: node evolve.cjs --result <result.json>）。
    if (opt.evolve) runEvolution(OUT + '/result.json');
    // 共享进化引擎：把本轮采集到的错误信号跑一轮八步链路（tap 已在各报错点完成），落盘 learnings + 审计。
    await evoRun();
    // 进化闭环（显性化）：把引擎状态回显出来，避免"学到的经验没人看"。
    try {
      const st = evo ? evo.status() : null;
      if (st && st.tier) log('🧠 进化：tier=' + st.tier + ' · 已捕获错误信号 ' + (st.errorSignals || 0) + ' 条 · 审计链 ' + (st.auditVerify ? '完整' : '异常'));
    } catch (_e) { /* ignore */ }
    // 复发哨兵：检测"已落地但仍在复发"的候选（loop 自检——land 了却没止住 → 判候选无效并回写否决）
    try {
      const sen = evo ? evo.recurrenceSentinel({ minRecur: 1 }) : null;
      if (sen && sen.stale && sen.stale.length) {
        log('⚠ 复发哨兵：' + sen.stale.length + ' 个指纹在"落地后仍复发" → 判定候选无效' + (sen.vetoed ? '（已否决 ' + sen.vetoed + ' 个）' : ''));
        for (const s of sen.stale.slice(0, 5)) log('   • ' + s.fingerprint + ' v' + (s.version || '?') + ' 已落地 ' + (s.landCount || 1) + ' 次、首次落地后仍复发 ' + s.recursAfter + ' 次：' + String(s.title || '').slice(0, 70));
      }
    } catch (_e) { /* ignore */ }
    log('💡 若本次有新踩坑想回馈社区：node contribute.cjs --make（打包后发回维护者合并）');
  } catch (e) {
    log('FATAL ' + (e && e.stack || e));
    evoTap(e, { taskId: 'verify', source: 'fatal' });
  } finally {
    if (drv) await drv.close().catch(() => {});
  }
})();

// ---------- 报告生成 ----------
function writeMarkdown(r, file) {
  let md = `# 功能验证报告：${r.name}\n\n`;
  md += `- 目标：${r.baseUrl}\n- 驱动：${r.driver}\n- 时间：${r.startedAt}\n- 结果：**${r.summary.pass}/${r.summary.total} 通过**\n\n`;
  md += `## 汇总\n\n| 状态 | ID | 功能 | 类型 | 关键断言 |\n|---|---|---|---|---|\n`;
  for (const f of r.features) {
    const icon = f.pass ? '✅' : '❌';
    const key = (f.asserts || []).map(a => a.desc || '').filter(Boolean).slice(0, 2).join('；') || '-';
    md += `| ${icon} | ${f.id} | ${f.name} | ${f.type} | ${key} |\n`;
  }
  md += `\n## 失败明细\n\n`;
  const fails = r.features.filter(f => !f.pass);
  if (!fails.length) md += '无。\n';
  for (const f of fails) {
    md += `### ❌ ${f.id} ${f.name}\n`;
    for (const e of f.errors) md += `- ${e}\n`;
    if (f.screenshot) md += `\n![截图](./${f.screenshot})\n`;
    md += `\n`;
  }
  if (r.totalErrors && r.totalErrors.length) {
    md += `## 页面级错误日志\n\n`;
    for (const e of r.totalErrors.slice(0, 50)) md += `- ${e}\n`;
  }
  if (r.heals && r.heals.length) {
    md += `\n## 自愈记录（选择器失效后自动找回等价元素 · 仅修复测试定位，不改软件）\n\n`;
    for (const h of r.heals) md += `- \`${h.sel}\` → 策略 \`${h.strategy || '?'}\` ${h.ok ? '✅ 已恢复' : '❌ 未找到等价元素'}${h.text ? '（' + h.text + '）' : ''}\n`;
  }
  fs.writeFileSync(file, md);
}

function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function writeHtml(r, file) {
  let rows = '';
  for (const f of r.features) {
    const cls = f.pass ? 'pass' : 'fail';
    const icon = f.pass ? '✅' : '❌';
    const key = (f.asserts || []).map(a => a.desc || '').filter(Boolean).slice(0, 3).join('；') || '-';
    const errs = f.errors.length ? `<div class="err">${f.errors.map(e => esc(e)).join('<br>')}</div>` : '';
    const shot = f.screenshot ? `<a href="./${f.screenshot}">截图</a>` : '';
    rows += `<tr class="${cls}"><td>${icon}</td><td>${esc(f.id)}</td><td>${esc(f.name)}</td><td>${esc(f.type)}</td><td>${esc(key)}</td><td>${shot}${errs}</td></tr>`;
  }
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>验证报告 ${esc(r.name)}</title>
<style>
body{font-family:-apple-system,Segoe UI,Roboto,'Microsoft YaHei',sans-serif;background:#f6f7f9;color:#1c1e21;margin:0;padding:24px}
h1{font-size:20px;margin:0 0 4px}
.meta{color:#666;font-size:13px;margin-bottom:16px}
.summary{display:inline-block;background:#fff;border:1px solid #e3e6ea;border-radius:10px;padding:10px 16px;font-size:14px;margin-bottom:16px}
table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #e3e6ea;border-radius:10px;overflow:hidden}
th,td{text-align:left;padding:9px 11px;border-bottom:1px solid #eef0f2;font-size:13px;vertical-align:top}
th{background:#f0f2f5;font-weight:600}
tr.pass td:first-child{color:#1a7f37}
tr.fail{background:#fff5f5}
tr.fail td:first-child{color:#c0392b}
.err{color:#c0392b;font-size:12px;margin-top:4px}
.heal{background:#fff;border:1px solid #e3e6ea;border-radius:10px;padding:12px 16px;margin-top:16px;font-size:13px}
.heal code{background:#f0f2f5;padding:1px 5px;border-radius:4px;font-size:12px}
a{color:#2f6fed}
</style></head><body>
<h1>功能验证报告：${esc(r.name)}</h1>
<div class="meta">目标 ${esc(r.baseUrl)} · 驱动 ${esc(r.driver)} · ${esc(r.startedAt)}</div>
<div class="summary"><b>${r.summary.pass}/${r.summary.total}</b> 通过 · 失败 ${r.summary.fail}</div>
<table><thead><tr><th>状态</th><th>ID</th><th>功能</th><th>类型</th><th>关键断言</th><th>截图/错误</th></tr></thead><tbody>${rows}</tbody></table>
${r.heals && r.heals.length ? `<div class="heal"><b>♻ 自愈 ${r.heals.length} 处</b>：选择器失效后自动用稳定信号找回等价元素（仅修正测试定位，不改被测软件）。<ul>${r.heals.map(h => `<li><code>${esc(h.sel)}</code> → <code>${esc(h.strategy || '?')}</code> ${h.ok ? '✅' : '❌'}${h.text ? '（' + esc(h.text) + '）' : ''}</li>`).join('')}</ul></div>` : ''}
</body></html>`;
  fs.writeFileSync(file, html);
}
