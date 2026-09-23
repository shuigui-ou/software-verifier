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

// v1.4.4：采集侧只记"原始事件"，读取侧统一渲染+去重。
// 为什么不在采集侧去重：response 与 requestfailed 的到达顺序不保证，采集侧无法可靠判定先后。
// 去重规则（A/B 实测踩出来的，收敛为三条；目标：同一次失败只出一条，且尽量保留 console 文本口径，
// 这样报告文本与坑库匹配规则不受影响）：
//   ① console 已报「状态层 NNN」的 (status,url) → 丢掉对应的 requestfailed 条目
//   ② console 已报「net::ERR_*」的 url          → 丢掉对应的 requestfailed 条目
//   ③ 同一 URL 既有 4xx/5xx 应答（状态层）又有 net::ERR_ABORTED（传输层）→ 只保留状态层那条
//      （ERR_ABORTED 是"有应答后中止"的伴生信号，不是独立失败；留着会把一次失败记成两次并可能归错层）
// 注意：console 静默的情形（真实站点上实测存在，如 google-analytics 的 ERR_ABORTED）
// 不会被去重吃掉——那些通道本来就没有 console 条目。
function stOf(t) { const m = String(t).match(/the server responded with a status of\s*(\d{3})/i); return m ? parseInt(m[1], 10) : null; }
function render(list) {
  const consoleStatusKeys = new Set();   // 'status|url' —— console 报过的状态层
  const consoleNetUrls = new Set();      // url          —— console 报过的传输层
  const responseUrls = new Set();        // url          —— 有 4xx/5xx 应答
  for (const e of list) {
    if (e.kind === 'console') {
      if (e.status != null && e.url) consoleStatusKeys.add(e.status + '|' + e.url);
      if (e.url && /net::ERR_/i.test(e.text)) consoleNetUrls.add(e.url);
    }
    if (e.kind === 'response' && e.status >= 400 && e.url) responseUrls.add(e.url);
  }
  const out = [];
  for (const e of list) {
    if (e.kind === 'requestfailed') {
      if (e.status == null && e.errText === 'net::ERR_ABORTED' && responseUrls.has(e.url)) continue; // ③
      if (consoleNetUrls.has(e.url)) continue;                                                       // ②
      if (e.url && [...consoleStatusKeys].some(k => k.endsWith('|' + e.url))) continue;              // ①
    }
    if (e.kind === 'response') {
      if (e.url && consoleStatusKeys.has(e.status + '|' + e.url)) continue;                           // ①
    }
    out.push(e.text);
  }
  return out;
}

function makeDomDriver(kind, PW_CORE) {
  let browser, page;
  const rawErrors = [];
  const rawFeatureErrors = [];
  const evPush = (ev) => { rawErrors.push(ev); rawFeatureErrors.push(ev); };
  const heals = [];
  let HEAL_ENABLED = true;

  async function launch(opts) {
    if (kind === 'browser') {
      const { chromium } = require(PW_CORE);
      browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-sandbox', '--disable-gpu'] });
      // 必须显式开启 acceptDownloads：否则本 Playwright 版本下 download 步骤的下载事件永不触发
      // （browser.newPage() 的默认 context 不接收下载 → downloadSel 等待超时）。
      const dlCtx = await browser.newContext({ acceptDownloads: true });
      page = await dlCtx.newPage();
    } else {
      // Electron：需要完整 playwright 包（playwright-core 不含 electron 导出）
      let electron;
      try { electron = require('playwright').electron; }
      catch (e) { throw new Error('Electron 驱动需要安装完整 playwright 包：npm i -D playwright'); }
      if (!opts.appPath) throw new Error('Electron 驱动需要 --app <应用入口 main.js 路径>');
      browser = await electron.launch({ args: [opts.appPath] });
      page = await browser.firstWindow();
    }
    // v1.4.3 修复（无标注过滤）：此前 `Failed to load resource` 被静默排除在 featureErrors 之外，
    // 报告里看不出"这条为什么不算问题"，也无法区分"宿主缺陷/环境噪声/工具自身"。
    // 现在采集侧一律如实记录，归类交给 drivers/error-classify.cjs，由 verify.cjs 统一决定
    // 是否计入功能点 FAIL —— 并且**任何一条都不会从报告消失**（环境噪声单独成段 + result.envNoise）。
    //
    // v1.4.4 修复（采集通道缺口）：审计实测真实站点上 **18/31 条 requestfailed 对工具完全不可见**——
    // 它们既没进 console，驱动也没监听 requestfailed / response，于是"根本没采集"。
    // 本机复核：element-plus.org 上 1 条 net::ERR_ABORTED(www.google-analytics.com) 控制台完全静默。
    // 现补两个通道，并把请求 URL 附在消息尾部（` | url=...`），供归因层判"同源 / 跨源"。
    page.on('pageerror', e => { const m = 'pageerror: ' + String(e); evPush({ text: m, kind: 'pageerror' }); });
    page.on('console', m => {
      if (m.type() !== 'error') return;
      const loc = (m.location && m.location()) || {};
      evPush({ text: 'console.error: ' + m.text() + (loc.url ? ' | url=' + loc.url : ''), kind: 'console', url: loc.url || null, status: stOf(m.text()) });
    });
    // 通道缺口补采 ①：传输层（未拿到服务器应答）
    page.on('requestfailed', r => {
      const errText = (r.failure() && r.failure().errorText) || 'unknown';
      evPush({ text: 'requestfailed: ' + errText + ' | url=' + r.url(), kind: 'requestfailed', url: r.url(), errText });
    });
    // 通道缺口补采 ②：HTTP 状态层（有服务器应答，但控制台可能完全静默）
    page.on('response', r => {
      const st = r.status();
      if (st < 400) return;
      evPush({ text: 'http-status: ' + st + ' | url=' + r.url(), kind: 'response', url: r.url(), status: st });
    });
    // 自动接受 dialog：confirm→继续；alert→关闭；prompt→返回占位值（让"任务模板/新项目"等需要输入名称的流程能继续）
    page.on('dialog', async d => { try { if (d.type() === 'prompt') await d.accept('自动验证'); else await d.accept(); } catch (e) {} });
    return { page };
  }

  // 进入每个功能前关闭残留弹窗/浮层（浏览器/Electron 通用）
  async function preFeatureCleanup() {
    await page.evaluate(() => {
      // 通用遮罩弹窗（Vue 类 SPA 常见写法 .modal-mask）
      document.querySelectorAll('.modal-mask').forEach(m => {
        const b = [...m.querySelectorAll('button')].find(x => (x.textContent || '').includes('取消') || (x.textContent || '').includes('关闭'));
        if (b) b.click();
      });
      // 单例 #modal 弹窗（自建弹窗组件常见写法）
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

  // 遮挡自愈：点击/等待命中"遮罩拦截"时走阶梯 —— ①正常点击 ②清掉遮罩后重试 ③原生 DOM click 兜底。
  // 只"等待/关闭浮层"，不删除被测页面元素；兜底档记入 heals（报告可见）。
  // 注：兜底刻意不用 playwright force:true —— 它按坐标派发，事件打在遮罩上，不报错却没点到。
  const INTERCEPT_RE = /intercepts pointer events|subtree intercepts|not clickable|would receive the click|element is not visible|timeout|exceeded/i;
  async function dismissOverlays() {
    try { await page.keyboard.press('Escape'); } catch (_e) { /* ignore */ }
    try {
      await page.evaluate(() => {
        const closers = ['.modal-close', '.el-dialog__headerbtn', '.ant-modal-close', '.close', '[aria-label="Close"]', '[aria-label="关闭"]'];
        for (const s of closers) { const b = document.querySelector(s); if (b && b.offsetParent) { try { b.click(); } catch (_e) { /* ignore */ } } }
      });
    } catch (_e) { /* ignore */ }
    try {
      await page.waitForFunction(() => {
        const masks = [...document.querySelectorAll('.el-loading-mask,.loading-mask,.ant-modal-mask,.v-modal,.modal-mask,.mask,.overlay,.loading')];
        return masks.every((m) => {
          const cs = getComputedStyle(m);
          return cs.display === 'none' || cs.visibility === 'hidden' || cs.pointerEvents === 'none' || m.offsetParent === null;
        });
      }, { timeout: 2500 });
    } catch (_e) { /* ignore */ }
  }
  async function robustClick(el) {
    try { await el.click({ timeout: 4000 }); return { ok: true }; }
    catch (e1) {
      const msg = String((e1 && e1.message) || e1);
      if (!INTERCEPT_RE.test(msg)) return { ok: false, err: msg };
      // 档 2：清掉遮罩后按"真实用户点击"重试
      await dismissOverlays();
      try { await el.click({ timeout: 4000 }); return { ok: true, strategy: 'overlay-wait' }; }
      catch (_e2) {
        // 档 3：兜底用原生 DOM click —— 绕过命中测试，但"确实触发目标 handler"。
        // 不用 playwright force:true：它只按坐标派发，事件会打在遮罩上 → 不报错却没点到（静默失效）。
        try {
          await el.evaluate((e) => e.click());
          return { ok: true, strategy: 'dom-click' };
        } catch (e3) { return { ok: false, err: String((e3 && e3.message) || e3) }; }
      }
    }
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
    if (els[nth]) {
      const rc = await robustClick(els[nth]);
      if (rc.ok) {
        if (rc.strategy) heals.push({ sel, strategy: rc.strategy, ok: true, action: 'click' });
        return { ok: true, count: els.length, ...(rc.strategy ? { healed: true, strategy: rc.strategy } : {}) };
      }
      // 被遮挡/不可点：先自愈找回等价元素再试（遮挡与定位失效常同时出现）
      if (HEAL_ENABLED) {
        const h = await healClickSel(page, sel, nth);
        if (h.ok) { heals.push({ sel, strategy: h.strategy, ok: true, action: 'click', text: h.text }); return { ok: true, healed: true, strategy: h.strategy, info: h.text }; }
      }
      heals.push({ sel, ok: false, action: 'click' });
      return { ok: false, count: els.length, err: rc.err };
    }
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
      // 遮挡自愈：先清掉遮罩再等一次（#submit 之类常被 loading/mask 挡住而"未出现"）
      await dismissOverlays();
      try {
        await page.waitForSelector(sel, { timeout: Math.min(timeout || 10000, 4000) });
        heals.push({ sel, strategy: 'overlay-wait', ok: true, action: 'wait' });
        return { ok: true, healed: true, strategy: 'overlay-wait' };
      } catch (_e2) { /* 继续走定位自愈 */ }
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

  // 文件下载：点击触发下载，捕获 download 事件并落盘，返回字节数 + SHA-256（供 download 步骤/断言校验内容）
  async function downloadSel(sel, dir) {
    const fso = require('fs');
    const crypto = require('crypto');
    try {
      fso.mkdirSync(dir, { recursive: true });
      let dl = null;
      const onDl = (d) => { dl = d; };
      page.on('download', onDl);
      // v1.4.5 修复（此前必然超时）：原实现在 click 之后才 waitForEvent('download')，
      // 而 download 事件在 click 期间就已派发 → 必然错过。裸 playwright 对照已证明事件确实发生
      // （page.on('download') 计数=1，但 waitForEvent 超时）。现在 click 前先建等待 promise。
      const dlWait = page.waitForEvent('download', { timeout: 30000 }).catch(() => null);
      try {
        const els = await page.$$(sel);
        if (!els[0]) { page.off('download', onDl); return { ok: false, err: 'downloadSel 未找到: ' + sel }; }
        await els[0].click();
      } catch (e) { page.off('download', onDl); return { ok: false, err: 'downloadSel 点击失败: ' + e.message }; }
      // 优先用已注册回调捕获到的事件（通常 click 返回时已就绪），否则等 click 前建立的 promise
      let download = dl || (await dlWait);
      if (!download) { page.off('download', onDl); return { ok: false, err: '等待下载事件超时: ' + sel }; }
      try {
        const suggested = download.suggestedFilename ? download.suggestedFilename() : ('download_' + Date.now());
        const dest = path.join(dir, suggested);
        await download.saveAs(dest);
        const buf = fso.readFileSync(dest);
        const sha = crypto.createHash('sha256').update(buf).digest('hex');
        page.off('download', onDl);
        return { ok: true, path: dest, bytes: buf.length, sha, filename: suggested };
      } catch (e) { page.off('download', onDl); return { ok: false, err: '下载保存失败: ' + e.message }; }
    } catch (e) { return { ok: false, err: e.message }; }
  }

  async function close() { if (browser) await browser.close(); }
  function clearFeatureErrors() { rawFeatureErrors.length = 0; }
  function clearHeals() { heals.length = 0; }
  function setHeal(v) { HEAL_ENABLED = !!v; }

  return {
    type: kind,
    launch, preFeatureCleanup,
    clickText, clickSel, fillNear, fillSel, fileSel, countSel, bodyText, assertEval,
    goto, wait, waitSel, waitText, exec, screenshot, getBusyDone, close,
    visualCapture, visualDiff, downloadSel,
    get errors() { return render(rawErrors); },
    get featureErrors() { return render(rawFeatureErrors); },
    get heals() { return heals; },
    clearFeatureErrors, clearHeals, setHeal,
  };
}

module.exports = { makeDomDriver };
