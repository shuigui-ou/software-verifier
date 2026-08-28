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

const PW_CORE = process.env.PW_CORE ||
  'C:/Users/199720.PC2775/.workbuddy/binaries/node/versions/22.22.2/node_modules/playwright-core';
const SKILL_DIR = __dirname;

// ---------- 参数解析 ----------
const args = process.argv.slice(2);
const opt = {
  spec: null, url: null, out: null, uiOnly: false, also: [], only: [], ai: 'off',
  driver: 'browser', app: null, platform: 'android', caps: null,
  appiumUrl: 'localhost', appiumPort: 4723, port: 9420,
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
}
if (!opt.spec || !opt.url) {
  console.error('用法: node verify.cjs --spec <spec.json> --url <baseUrl> [--driver browser|electron|miniprogram|appium] [--out <dir>]');
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
const { runEvolution, loadPitfalls, matchPitfall } = require(SKILL_DIR + '/evolve.cjs');
const PITFALLS = loadPitfalls();
const hintFor = (text) => { const p = matchPitfall(text || '', PITFALLS); return p ? ' 💡 已知坑[' + p.id + ']: ' + p.fix : ''; };

// ---------- 驱动加载 ----------
function loadDriver(name) {
  if (name === 'browser' || name === 'electron') {
    const { makeDomDriver } = require(SKILL_DIR + '/drivers/dom.js');
    return makeDomDriver(name, PW_CORE);
  }
  if (name === 'miniprogram') {
    const { createMiniprogramDriver } = require(SKILL_DIR + '/drivers/miniprogram.js');
    return createMiniprogramDriver(PW_CORE);
  }
  if (name === 'appium') {
    const { createAppiumDriver } = require(SKILL_DIR + '/drivers/appium.js');
    return createAppiumDriver(PW_CORE);
  }
  throw new Error('未知驱动: ' + name + '（支持 browser|electron|miniprogram|appium）');
}

// ---------- 步骤执行（驱动无关） ----------
async function runStep(drv, step) {
  switch (step.do) {
    case 'goto':
      await drv.goto(BASE + (step.path || '/'));
      return { ok: true };
    case 'wait':
      await sleep(step.ms || 1000); return { ok: true };
    case 'waitSel':
      return await drv.waitSel(step.sel, step.timeout);
    case 'waitText':
      return await drv.waitText(step.text, step.timeout);
    case 'clickText':
      return await drv.clickText(step.text, step.nth || 0);
    case 'clickSel':
      return await drv.clickSel(step.sel, step.nth || 0);
    case 'fillSel':
      return await drv.fillSel(step.sel, step.value || '');
    case 'fileSel':
      return await drv.fileSel(step.sel, step.path);
    case 'fillNear':
      return await drv.fillNear(step.label, step.value || '');
    case 'exec':
      return await drv.exec(step.js);
    case 'screenshot':
      return await drv.screenshot(SHOTS + '/' + step.name);
    case 'assert': {
      const ar = await runAssert(drv, step);
      return { ok: ar.pass, detail: ar.detail };
    }
    case 'ai': {
      const click = step.clickText ? await drv.clickText(step.clickText, step.nth || 0)
        : step.clickSel ? await drv.clickSel(step.clickSel, step.nth || 0)
        : { ok: false, err: 'ai 步骤缺 clickText/clickSel' };
      if (!click.ok) return { ok: false, err: 'ai 点击失败: ' + (click.err || ''), clicked: false };
      const timeout = step.timeout || 150000;
      const busySel = step.busySel || '';
      const start = Date.now();
      let appeared = false;
      while (Date.now() - start < timeout) {
        const st = await drv.getBusyDone(busySel, step.doneEval);
        if (st.busy) appeared = true;
        if (st.done) return { ok: true, reason: 'done', appeared };
        if (appeared && !st.busy) return { ok: true, reason: 'idle-cleared', appeared };
        if (!appeared && !step.doneEval && Date.now() - start > 8000) return { ok: false, reason: 'no-busy-detected', appeared };
        await sleep(1500);
      }
      return { ok: false, reason: 'timeout', appeared };
    }
    default:
      return { ok: false, err: '未知步骤类型: ' + step.do };
  }
}

async function runAssert(drv, a) {
  if (a.sel) {
    const n = await drv.countSel(a.sel);
    const min = a.min != null ? a.min : 1;
    return { pass: n >= min, detail: `选择器 ${a.sel} 命中 ${n} 个（要求≥${min}）` };
  }
  if (a.notSel) {
    const n = await drv.countSel(a.notSel);
    return { pass: n === 0, detail: `选择器 ${a.notSel} 命中 ${n} 个（要求=0）` };
  }
  if (a.includes) {
    const txt = await drv.bodyText();
    const pass = txt.includes(a.includes);
    return { pass, detail: `页面文本包含「${a.includes}」= ${pass}` };
  }
  if (a.eval) {
    return await drv.assertEval(a.eval);
  }
  return { pass: true, detail: '无断言' };
}

// ---------- 主流程 ----------
(async () => {
  let result = { name: spec.name || spec.app || '未知软件', baseUrl: BASE, driver: opt.driver, startedAt: new Date().toISOString(), features: [] };
  let drv;
  const errors = []; // 全局错误（最终汇总）
  try {
    drv = loadDriver(opt.driver);
    await drv.launch({ appPath: opt.app, platform: opt.platform, caps: opt.caps, appiumUrl: opt.appiumUrl, appiumPort: opt.appiumPort, port: opt.port });
    log('=== software-verifier [' + opt.driver + ']: ' + spec.name + ' @ ' + BASE + ' ===');

    // 启动即导航到被测地址（URL 类驱动：browser/electron/miniprogram/appium 都基于一个可访问的入口）
    await drv.goto(BASE + '/');
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

    for (const f of selected) {
      drv.clearFeatureErrors();
      await drv.preFeatureCleanup();
      const frec = { id: f.id, name: f.name, type: f.type, group: f.group || '', steps: [], asserts: [], pass: true, errors: [] };
      const featureErrors = []; // 本 feature 错误（来自驱动）
      log('▶ [' + f.id + '] ' + f.name + ' (' + f.type + ')');
      try {
        if (f.setup) for (const s of f.setup) { const r = await runStep(drv, s); frec.steps.push({ do: s.do, ...r }); }

        for (const s of (f.steps || [])) {
          const r = await runStep(drv, s);
          frec.steps.push({ do: s.do, text: s.text || s.sel || '', ...r });
          if (!r.ok) { frec.pass = false; frec.errors.push('步骤 ' + s.do + ' 失败: ' + (r.err || r.detail || '')); log('   ✗ 步骤 ' + s.do + ': ' + (r.err || r.detail || '')); }
          if (s.screenshot) await drv.screenshot(SHOTS + '/' + s.screenshot).catch(() => {});
        }
        const shot = (f.id + '_' + f.name).replace(/[^\w一-龥]/g, '_') + '.png';
        await drv.screenshot(SHOTS + '/' + shot).catch(() => {});
        frec.screenshot = 'shots/' + shot;

        for (const a of (f.asserts || [])) {
          const ar = await runAssert(drv, a);
          frec.asserts.push({ desc: a.desc || a.sel || a.eval || a.includes || '', ...ar });
          if (!ar.pass) { frec.pass = false; frec.errors.push('断言失败: ' + ar.detail + hintFor(ar.detail)); }
          log('   ' + (ar.pass ? '✓' : '✗') + ' ' + (a.desc || ar.detail));
        }
        const drvErrs = (drv.featureErrors || []).slice();
        if (drvErrs.length) { frec.pass = false; frec.errors = frec.errors.concat(drvErrs.map(e => e + hintFor(e))); (errors.push.apply(errors, drvErrs)); }
      } catch (e) {
        const em = (e && e.message || String(e));
        frec.pass = false; frec.errors.push('异常: ' + em + hintFor(em));
        log('   ✗ 异常: ' + em);
        const shotE = 'ERR_' + f.id + '.png';
        await drv.screenshot(SHOTS + '/' + shotE).catch(() => {});
        frec.screenshot = 'shots/' + shotE;
      }
      log('   → ' + (frec.pass ? 'PASS' : 'FAIL') + (frec.errors.length ? '  (' + frec.errors.length + ' 处)' : '') + '\n');
      result.features.push(frec);
    }

    result.endedAt = new Date().toISOString();
    result.totalErrors = errors;
    const passN = result.features.filter(f => f.pass).length;
    result.summary = { total: result.features.length, pass: passN, fail: result.features.length - passN };
    log('\n========== 汇总: ' + passN + '/' + result.features.length + ' 通过 ==========');

    fs.writeFileSync(OUT + '/result.json', JSON.stringify(result, null, 2));
    writeMarkdown(result, OUT + '/VERIFY-报告.md');
    writeHtml(result, OUT + '/VERIFY-报告.html');
    log('报告已写入: ' + OUT);
    runEvolution(OUT + '/result.json');
    log('💡 若本次有新踩坑想回馈社区：node contribute.cjs --make（打包后发回维护者合并）');
  } catch (e) {
    log('FATAL ' + (e && e.stack || e));
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
a{color:#2f6fed}
</style></head><body>
<h1>功能验证报告：${esc(r.name)}</h1>
<div class="meta">目标 ${esc(r.baseUrl)} · 驱动 ${esc(r.driver)} · ${esc(r.startedAt)}</div>
<div class="summary"><b>${r.summary.pass}/${r.summary.total}</b> 通过 · 失败 ${r.summary.fail}</div>
<table><thead><tr><th>状态</th><th>ID</th><th>功能</th><th>类型</th><th>关键断言</th><th>截图/错误</th></tr></thead><tbody>${rows}</tbody></table>
</body></html>`;
  fs.writeFileSync(file, html);
}
