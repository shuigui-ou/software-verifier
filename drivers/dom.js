'use strict';
/**
 * DOM 驱动（浏览器 / Electron 共用）
 *
 * 两种类型都是「标准 Web 环境」，所以用同一套 Playwright 页面原语：
 *   - browser : chromium.launch({ channel:'msedge' })（本机无头 Edge）
 *   - electron: electron.launch({ args:[appPath] })（Playwright 原生支持 Electron）
 *
 * 仅 launch 方式不同，其余点击/填表/断言逻辑完全一致。
 * 自愈：clickSel/fillSel/waitSel 失败时自动用 drivers/heal.cjs 找回等价元素。
 */
const path = require('path');
const { healClickSel, healFillSel, healWaitSel } = require(path.join(__dirname, '..', 'drivers', 'heal.cjs'));
const visual = require(path.join(__dirname, '..', 'drivers', 'visual.cjs'));
const { assertSafeExpr } = require(path.join(__dirname, 'safe-expr.cjs'));

function makeDomDriver(kind, PW_CORE) {
  let browser, page;
  const errors = [];
  const featureErrors = [];
  const heals = [];
  let HEAL_ENABLED = true;

  async function launch(opts) {
    if (kind === 'browser') {
      const { chromium } = require(PW_CORE);
      browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-sandbox', '--disable-gpu'] });
      page = await browser.newPage();
    } else {
      // Electron：需要完整 playwright 包（playwright-core 不含 electron 导出）
      let electron;
      try { electron = require('playwright').electron; }
      catch (e) { throw new Error('Electron 驱动需要安装完整 playwright 包：npm i -D playwright'); }
      if (!opts.appPath) throw new Error('Electron 驱动需要 --app <应用入口 main.js 路径>');
      browser = await electron.launch({ args: [opts.appPath] });
      page = await browser.firstWindow();
    }
    page.on('pageerror', e => { const m = 'pageerror: ' + String(e); errors.push(m); featureErrors.push(m); });
    page.on('console', m => {
      if (m.type() === 'error') {
        const t = m.text(); const m2 = 'console.error: ' + t; errors.push(m2);
        if (!/Failed to load resource/i.test(t)) featureErrors.push(m2);
      }
    });
    // 自动接受 dialog：confirm→继续；alert→关闭；prompt→返回占位值（让"任务模板/新项目"等需要输入名称的流程能继续）
    page.on('dialog', async d => { try { if (d.type() === 'prompt') await d.accept('自动验证'); else await d.accept(); } catch (e) {} });
    return { page };
  }

  // 进入每个功能前关闭残留弹窗/浮层（浏览器/Electron 通用）
  async function preFeatureCleanup() {
    await page.evaluate(() => {
      // 通用遮罩弹窗（ai-novel-studio 等）
      document.querySelectorAll('.modal-mask').forEach(m => {
        const b = [...m.querySelectorAll('button')].find(x => (x.textContent || '').includes('取消') || (x.textContent || '').includes('关闭'));
        if (b) b.click();
      });
      // #modal 弹窗（block-workplan 等：设置 / 任务模板 / 组合构建器）
      const modal = document.getElementById('modal');
      if (modal && modal.classList.contains('show')) {
        const c = modal.querySelector('.modal-close'); if (c) c.click();
      }
      // 浮层菜单（预设短语 / 子积木 / 同级选择）
      document.querySelectorAll('.preset-menu').forEach(m => m.remove());
      // 顶栏"更多"菜单收起
      const more = document.getElementById('moreMenu'); if (more) more.hidden = true;
    }).catch(() => {});
  }

  async function clickText(text, nth = 0) {
    return await page.evaluate(({ text, nth }) => {
      const norm = (s) => (s || '').trim();
      const btns = [...document.querySelectorAll('button, [role="button"]')]
        .filter(e => e.offsetParent && norm(e.textContent).includes(text));
      const list = btns.length ? btns
        : [...document.querySelectorAll('*')].filter(e => {
            if (!e.offsetParent) return false;
            const t = norm(e.textContent);
            if (!t.includes(text)) return false;
            if (e.children.length && [...e.children].some(c => norm(c.textContent).includes(text))) return false;
            return t.length <= text.length + 10;
          });
      const el = list[nth];
      if (!el) return { ok: false, count: list.length };
      el.click();
      return { ok: true, count: list.length, text: el.textContent.trim() };
    }, { text, nth });
  }

  async function clickSel(sel, nth = 0) {
    const els = await page.$$(sel);
    if (els[nth]) { await els[nth].click(); return { ok: true, count: els.length }; }
    // 自愈：原选择器失效时，用稳定信号找回等价元素
    if (HEAL_ENABLED) {
      const h = await healClickSel(page, sel, nth);
      if (h.ok) { heals.push({ sel, strategy: h.strategy, ok: true, action: 'click', text: h.text }); return { ok: true, healed: true, strategy: h.strategy, info: h.text }; }
    }
    heals.push({ sel, ok: false, action: 'click' });
    return { ok: false, count: els.length };
  }

  async function fillNear(label, value) {
    return await page.evaluate(({ label, value }) => {
      const setVal = (el, v) => {
        const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
        setter.call(el, v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      };
      const spans = [...document.querySelectorAll('span, label, div, h4')];
      const lab = spans.find(e => (e.textContent || '').trim().includes(label) && e.children.length <= 2);
      let inp = null;
      if (lab) inp = lab.querySelector('input,textarea') || (lab.parentElement && lab.parentElement.querySelector('input,textarea'));
      if (!inp) inp = [...document.querySelectorAll('input,textarea')].find(e => (e.placeholder || '').includes(label) || (e.getAttribute('aria-label') || '').includes(label));
      if (!inp) return { ok: false };
      setVal(inp, value);
      return { ok: true, tag: inp.tagName };
    }, { label, value });
  }

  async function fillSel(sel, value) {
    try { await page.fill(sel, value, { timeout: 5000 }); return { ok: true }; }
    catch (e) {
      if (HEAL_ENABLED) {
        const h = await healFillSel(page, sel, value);
        if (h.ok) { heals.push({ sel, strategy: h.strategy, ok: true, action: 'fill' }); return { ok: true, healed: true }; }
      }
      heals.push({ sel, ok: false, action: 'fill' });
      return { ok: false, err: e.message };
    }
  }

  // 文件上传：把本地文件设到 <input type=file>（导出模板 / 从工单提取 / 导入工单 JSON 等）
  async function fileSel(sel, path) {
    try { const el = await page.$(sel); if (!el) return { ok: false, err: 'fileSel 找不到: ' + sel }; await el.setInputFiles(path); return { ok: true }; }
    catch (e) { return { ok: false, err: e.message }; }
  }

  async function countSel(sel) {
    return await page.$$eval(sel, els => els.length).catch(() => 0);
  }

  async function bodyText() {
    return await page.evaluate(() => document.body.innerText).catch(() => '');
  }

  async function assertEval(expr) {
    const chk = assertSafeExpr(expr);
    if (!chk.ok) return { pass: false, detail: '安全校验未通过: ' + chk.reason };
    try {
      const pass = await page.evaluate(`(function(){ try { return !!(${expr}); } catch(e){ return false; } })()`);
      return { pass, detail: `eval(${expr}) = ${pass}` };
    } catch (e) { return { pass: false, detail: 'eval 异常: ' + e.message }; }
  }

  async function goto(target) {
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 20000 });
    return { ok: true };
  }
  async function wait(ms) { await new Promise(r => setTimeout(r, ms)); return { ok: true }; }
  async function waitSel(sel, timeout) {
    try { await page.waitForSelector(sel, { timeout: timeout || 10000 }); return { ok: true }; }
    catch (e) {
      if (HEAL_ENABLED) {
        const h = await healWaitSel(page, sel, timeout || 10000);
        if (h.ok) { heals.push({ sel, strategy: 'wait-heal', ok: true, action: 'wait' }); return { ok: true, healed: true }; }
      }
      heals.push({ sel, ok: false, action: 'wait' });
      return { ok: false, err: 'waitSel 超时(含自愈): ' + sel };
    }
  }
  async function waitText(text, timeout) {
    try { await page.waitForFunction(t => document.body.innerText.includes(t), text, { timeout: timeout || 10000 }); return { ok: true }; }
    catch (e) { return { ok: false, err: 'waitText 超时: ' + text }; }
  }
  async function exec(js) {
    const chk = assertSafeExpr(js);
    if (!chk.ok) return { ok: false, err: '安全校验未通过: ' + chk.reason };
    try { const r = await page.evaluate(js); return { ok: true, r }; }
    catch (e) { return { ok: false, err: e.message }; }
  }
  async function screenshot(p) {
    try { await page.screenshot({ path: p }); return { ok: true }; }
    catch (e) { return { ok: false, err: e.message }; }
  }
  // AI 步骤轮询：返回 {busy, done}
  async function getBusyDone(busySel, doneEval) {
    if (doneEval) {
      const chk = assertSafeExpr(doneEval);
      if (!chk.ok) return { busy: false, done: false, err: '安全校验未通过: ' + chk.reason };
    }
    return await page.evaluate(({ busySel, doneEval }) => {
      let busy = false;
      try { busy = !!document.querySelector(busySel); } catch (e) {}
      let done = false;
      if (doneEval) { try { done = !!eval(doneEval); } catch (e) {} }
      return { busy, done };
    }, { busySel, doneEval: doneEval || '' });
  }

  // 视觉签名：委托 drivers/visual.cjs（零依赖布局指纹回归）
  async function visualCapture(opts) { return await visual.captureSignature(page, opts || {}); }
  function visualDiff(base, cur, opts) { return visual.diffSignature(base, cur, opts || {}); }

  async function close() { if (browser) await browser.close(); }
  function clearFeatureErrors() { featureErrors.length = 0; }
  function clearHeals() { heals.length = 0; }
  function setHeal(v) { HEAL_ENABLED = !!v; }

  return {
    type: kind,
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

module.exports = { makeDomDriver };
