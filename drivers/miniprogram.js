'use strict';
const { assertSafeExpr } = require('./safe-expr.cjs');
const { healClickSel, healFillSel, healWaitSel } = require('./heal.cjs');
/**
 * ⚠️ HEAL INTEGRATION：INERT for this driver（接口预留，功能未生效）.
 *   heal.cjs 的 heal*Sel 依赖 playwright 的 page.evaluate / page.waitForFunction，须在浏览器 DOM 上下文运行；
 *   本驱动（miniprogram-automator）只暴露 $$/tap，无 playwright page 原语。setHeal(v) 只接布尔开关：
 *   HEAL_ENABLED 生效，但 healPage 恒为 null（除非传入带 evaluate+waitForFunction 的对象）。
 *   当前 `if (HEAL_ENABLED && healPage)` 分支对小程序驱动是死代码，直到驱动暴露 playwright 兼容句柄，
 *   或 heal.cjs 为 miniprogram-automator 原语重写。feature flag 默认关闭（不传 page 即不激活）。
 *   切勿把此分支误读为「自愈已可用」——T3 定性为「接口预留，功能 inert」。
 */
/**
 * 微信小程序驱动（基于 miniprogram-automator，驱动微信开发者工具模拟器）
 *
 * ⚠️ UNTESTED IN SANDBOX：本环境未安装微信开发者工具与 miniprogram-automator，
 *    以下为按官方 API 编写的最佳实现，需在本机装好工具链后实跑校准。
 *
 * 前置条件：
 *   - 安装微信开发者工具（并开启「设置 → 安全 → 服务端口」）
 *   - npm i -D miniprogram-automator
 *   - spec 里用 --app 传 projectPath（小程序工程根目录）
 *
 * 选择器差异（写小程序 spec 时注意）：
 *   - clickText: 按元素文本匹配（内部遍历 text/button/view 取 text()）
 *   - clickSel: 支持 .class #id tag 组合；不支持 document 查询
 *   - fillSel:   input 组件用 element.trigger('input',{value})
 *   - assert.eval: 在 miniProgram 全局上下文执行，勿用 document.*（用页面 data / 组件方法）
 */
function createMiniprogramDriver(PW_CORE) {
  let miniProgram, page, automator;
  const errors = [], featureErrors = [];

  async function launch(opts) {
    try { automator = require('miniprogram-automator'); }
    catch (e) { throw new Error('小程序驱动需要 miniprogram-automator：npm i -D miniprogram-automator'); }
    if (!opts.appPath) throw new Error('小程序驱动需要 --app <小程序工程 projectPath>');
    miniProgram = await automator.launch({ projectPath: opts.appPath, port: opts.port || 9420 });
    page = await miniProgram.currentPage();
    return { page };
  }

  const TEXT_TAGS = ['button', 'text', 'view', 'navigator'];

  async function allTextEls() {
    let els = [];
    for (const t of TEXT_TAGS) { try { const r = await page.$$(t); if (r) els = els.concat(r); } catch (e) {} }
    return els;
  }

  async function clickText(text, nth = 0) {
    const els = await allTextEls();
    const matched = [];
    for (const e of els) { try { const tx = await e.text(); if (tx && tx.includes(text)) matched.push(e); } catch (e2) {} }
    const el = matched[nth];
    if (!el) return { ok: false, count: matched.length };
    await el.tap();
    return { ok: true, count: matched.length };
  }

  async function clickSel(sel, nth = 0) {
    const els = await page.$$(sel);
    if (!els[nth]) {
      // 条件接线：仅当 healPage 有效（playwright 上下文）时委托 heal.cjs 等价定位；否则如实失败。
      if (HEAL_ENABLED && healPage) {
        const h = await healClickSel(healPage, sel, nth);
        if (h.ok) { heals.push({ sel, strategy: h.strategy, ok: true, action: 'click', text: h.text }); return { ok: true, healed: true, strategy: h.strategy, info: h.text }; }
        heals.push({ sel, ok: false, action: 'click' });
      }
      return { ok: false, count: els.length };
    }
    await els[nth].tap();
    return { ok: true, count: els.length };
  }

  async function fillSel(sel, value) {
    const els = await page.$$(sel);
    if (!els[0]) {
      if (HEAL_ENABLED && healPage) {
        const h = await healFillSel(healPage, sel, value);
        if (h.ok) { heals.push({ sel, strategy: h.strategy, ok: true, action: 'fill' }); return { ok: true, healed: true }; }
        heals.push({ sel, ok: false, action: 'fill' });
      }
      return { ok: false, err: 'fillSel 未找到: ' + sel };
    }
    try { await els[0].trigger('input', { value }); return { ok: true }; }
    catch (e) {
      if (HEAL_ENABLED && healPage) {
        const h = await healFillSel(healPage, sel, value);
        if (h.ok) { heals.push({ sel, strategy: h.strategy, ok: true, action: 'fill' }); return { ok: true, healed: true }; }
        heals.push({ sel, ok: false, action: 'fill' });
      }
      return { ok: false, err: e.message };
    }
  }

  async function fillNear(label, value) {
    // 小程序无 label/input 关联模型：按「文本含 label 的视图」后相邻 input 触发
    try {
      const els = await allTextEls();
      for (const e of els) {
        const tx = await e.text();
        if (tx && tx.includes(label)) {
          const sib = await e.parent ? await e.parent.$$(sel => sel) : null;
          const inp = sib || null;
          if (inp) { await inp.trigger('input', { value }); return { ok: true }; }
        }
      }
      return { ok: false, err: 'fillNear 未找到邻近输入: ' + label };
    } catch (e) { return { ok: false, err: e.message }; }
  }

  async function countSel(sel) {
    try { const els = await page.$$(sel); return els ? els.length : 0; } catch (e) { return 0; }
  }

  async function bodyText() {
    const els = await page.$$('text');
    const txs = [];
    for (const e of els) { try { txs.push(await e.text()); } catch (e2) {} }
    return txs.join('\n');
  }

  async function assertEval(expr) {
    const chk = assertSafeExpr(expr);
    if (!chk.ok) return { pass: false, detail: '安全校验未通过: ' + chk.reason };
    try {
      const pass = await miniProgram.evaluate(new Function('return (' + expr + ');'));
      return { pass: !!pass, detail: `eval(${expr}) = ${!!pass}` };
    } catch (e) { return { pass: false, detail: 'eval 异常: ' + e.message }; }
  }

  async function goto() { page = await miniProgram.currentPage(); return { ok: true }; }
  async function wait(ms) { await new Promise(r => setTimeout(r, ms)); return { ok: true }; }
  async function waitSel(sel, timeout) {
    const t0 = Date.now();
    while (Date.now() - t0 < (timeout || 10000)) {
      if ((await countSel(sel)) > 0) return { ok: true };
      await new Promise(r => setTimeout(r, 500));
    }
    if (HEAL_ENABLED && healPage) {
      const h = await healWaitSel(healPage, sel, timeout || 10000);
      if (h.ok) { heals.push({ sel, strategy: 'wait-heal', ok: true, action: 'wait' }); return { ok: true, healed: true }; }
      heals.push({ sel, ok: false, action: 'wait' });
    }
    return { ok: false, err: 'waitSel 超时: ' + sel };
  }
  async function waitText(text, timeout) {
    const t0 = Date.now();
    while (Date.now() - t0 < (timeout || 10000)) {
      if ((await bodyText()).includes(text)) return { ok: true };
      await new Promise(r => setTimeout(r, 500));
    }
    return { ok: false, err: 'waitText 超时: ' + text };
  }
  async function exec(js) {
    const chk = assertSafeExpr(js);
    if (!chk.ok) return { ok: false, err: '安全校验未通过: ' + chk.reason };
    try { const r = await miniProgram.evaluate(new Function(js)); return { ok: true, r }; }
    catch (e) { return { ok: false, err: e.message }; }
  }
  async function screenshot(p) {
    try { const buf = await miniProgram.screenshot(); require('fs').writeFileSync(p, buf); return { ok: true }; }
    catch (e) { return { ok: false, err: e.message }; }
  }
  async function getBusyDone(busySel, doneEval) {
    // 小程序无通用 busy 标识：用 doneEval 在 miniProgram 全局求值；busy 默认 false
    if (doneEval) {
      const chk = assertSafeExpr(doneEval);
      if (!chk.ok) return { busy: false, done: false, err: '安全校验未通过: ' + chk.reason };
    }
    let done = false;
    if (doneEval) { try { done = !!(await miniProgram.evaluate(new Function('return (' + doneEval + ');'))); } catch (e) {} }
    return { busy: false, done };
  }
  async function preFeatureCleanup() { /* 小程序无遮罩弹窗模型，留空 */ }
  async function close() { if (miniProgram) await miniProgram.close(); }
  function clearFeatureErrors() { featureErrors.length = 0; }

  // 自愈（heal）接口：与 dom.js 对齐，使主流程 drv.setHeal / drv.heals / drv.clearHeals 不再抛 TypeError。
  // 条件接线：仅当 setHeal 收到 playwright page（DOM/WebView 上下文）时才委托 heal.cjs 做等价定位；
  // 小程序驱动用 miniprogram-automator，本身没有 playwright page，故默认 healPage 为空、heals 恒为空（不强行塞入不兼容调用）。
  let heals = [];
  let HEAL_ENABLED = false;
  let healPage = null;
  function clearHeals() { heals.length = 0; }
  function setHeal(v) {
    HEAL_ENABLED = !!v;
    // 仅当传入对象具备 playwright page 原语（evaluate + waitForFunction）时才接管自愈，
    // 否则保持空（小程序无 playwright 上下文，强行调用会在运行时报 TypeError）。
    healPage = (v && typeof v.evaluate === 'function' && typeof v.waitForFunction === 'function') ? v : null;
  }

  // 文件上传（fileSel）：小程序无 web <input type=file> 模型，显式标记不支持（返回结构化错误而非抛 TypeError）。
  async function fileSel(sel, p) {
    return { ok: false, err: '小程序驱动不支持文件上传断言（fileSel）：请用 browser/electron 驱动' };
  }
  // 视觉签名（visualCapture/visualDiff）：小程序无 DOM 布局指纹，显式标记不支持；
  // visualDiff 返回高严重度使断言必然 FAIL（而非静默通过），并带 err 说明原因。
  async function visualCapture(opts) {
    return { ok: false, err: '小程序驱动不支持视觉签名（visualCapture）：请用 browser/electron 驱动' };
  }
  function visualDiff(base, cur, opts) {
    return { ok: false, changed: true, moved: [], disappeared: [], appeared: [], severity: 999,
             err: '小程序驱动不支持视觉比对（visualDiff）：请用 browser/electron 驱动' };
  }

  return {
    type: 'miniprogram',
    launch, preFeatureCleanup,
    clickText, clickSel, fillNear, fillSel, fileSel, countSel, bodyText, assertEval,
    goto, wait, waitSel, waitText, exec, screenshot, getBusyDone, close,
    visualCapture, visualDiff,
    get errors() { return errors; },
    get featureErrors() { return featureErrors; },
    get heals() { return heals; },
    clearFeatureErrors, clearHeals, setHeal,
  };
}

module.exports = { createMiniprogramDriver };
