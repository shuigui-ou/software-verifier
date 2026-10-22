'use strict';
const { assertSafeExpr } = require('./safe-expr.cjs');
const { healClickSel, healFillSel, healWaitSel, createHealAdapter } = require('./heal.cjs');
/**
 * 原生移动 App 驱动（基于 Appium + webdriverio）
 *
 * ⚠️ UNTESTED IN SANDBOX：本环境未安装 Appium server / 模拟器 / 真机，
 *    以下为按 webdriverio API 编写的最佳实现，真机自愈行为需在本机装好工具链后实跑校准。
 *
 * 前置条件：
 *   - 启动 Appium server（默认 http://localhost:4723）
 *   - npm i -D webdriverio
 *   - --platform android|ios ；--caps 可传 capability JSON 文件路径
 *
 * 选择器差异：
 *   - clickText: 按平台用 UiAutomator / XCUITest 文本谓词匹配
 *   - clickSel:  建议用 accessibility id（'~id'）或 xpath（'//*[@resource-id=...]'）
 *   - fillSel:   element.setValue(...)
 *   - assert.eval: 通过 driver.executeScript 在 WebView 上下文执行；原生上下文请用 sel/text 断言
 *
 * T3b：已接入 HealAdapter（webdriverio 适配器），原选择器失效时走 handle 模型自愈（真实设备 e2e 见 T3b spec §0.2，沙箱 N/A）。
 * 启用路径（OR 无优先级）：(a) 显式 setHeal(adapter) / (b) launch opts.healEnabled=true /
 *   (c) 环境变量 SV_HEAL=1。任一 + 合法 adapter 即激活；否则默认关闭。
 */
function createAppiumDriver(PW_CORE) {
  let driver;
  const errors = [], featureErrors = [];
  let heals = [];
  let HEAL_ENABLED = false;
  let healAdapter = null;
  let HEAL_EXPLICIT = false;

  function textXpath(platform, text) {
    if (platform === 'ios') return `//*[contains(@label,"${text}") or contains(@name,"${text}") or contains(@value,"${text}")]`;
    return `//*[contains(@text,"${text}") or contains(@content-desc,"${text}")]`;
  }

  function defaultCaps(platform) {
    if (platform === 'ios') return { platformName: 'iOS', 'appium:automationName': 'XCUITest', 'appium:deviceName': 'iPhone Simulator', 'appium:app': '' };
    return { platformName: 'Android', 'appium:automationName': 'UiAutomator2', 'appium:deviceName': 'Android Emulator', 'appium:app': '' };
  }

  async function launch(opts) {
    // 测试 seam：注入 mock driver 以绕过外部依赖（生产不传 injectDriver）。
    if (opts && opts.injectDriver) {
      driver = opts.injectDriver;
      const wantHeal = HEAL_EXPLICIT || (opts && opts.healEnabled === true) || (process.env.SV_HEAL === '1');
      if (wantHeal && !healAdapter) {
        try { healAdapter = createHealAdapter('webdriverio', driver); HEAL_ENABLED = true; }
        catch (e) { HEAL_ENABLED = false; healAdapter = null; }
      }
      return { page: driver };
    }
    let remote;
    try { ({ remote } = require('webdriverio')); }
    catch (e) { throw new Error('Appium 驱动需要 webdriverio：npm i -D webdriverio'); }
    const platform = opts.platform || 'android';
    let caps = defaultCaps(platform);
    if (opts.caps) { try { caps = Object.assign(caps, JSON.parse(require('fs').readFileSync(opts.caps, 'utf8'))); } catch (e) {} }
    if (opts.appPath && caps.app !== undefined) caps.app = opts.appPath;
    driver = await remote({ hostname: opts.appiumUrl || 'localhost', port: opts.appiumPort || 4723, capabilities: caps, logLevel: 'error' });
    // T3b 启用路径 (b)/(c)：launch 时按 opts.healEnabled / 环境变量 自动建 webdriverio adapter。
    const wantHeal = HEAL_EXPLICIT || (opts && opts.healEnabled === true) || (process.env.SV_HEAL === '1');
    if (wantHeal && !healAdapter) {
      try { healAdapter = createHealAdapter('webdriverio', driver); HEAL_ENABLED = true; }
      catch (e) { HEAL_ENABLED = false; healAdapter = null; }
    }
    return { page: driver };
  }

  async function clickText(text, nth = 0) {
    try {
      const els = await driver.$$(textXpath(opts.platform || 'android', text));
      if (!els[nth]) return { ok: false, count: els.length };
      await els[nth].click();
      return { ok: true, count: els.length };
    } catch (e) { return { ok: false, err: e.message }; }
  }
  async function clickSel(sel, nth = 0) {
    let els = [];
    try { els = await driver.$$(sel); } catch (e) { els = []; }
    if (els[nth]) { await els[nth].click(); return { ok: true, count: els.length }; }
    // T3b：原选择器失效 → 走 handle 模型自愈（死分支已激活）。
    if (HEAL_ENABLED && healAdapter) {
      const h = await healClickSel(healAdapter, sel, nth);
      if (h.ok) { heals.push({ sel, strategy: h.strategy, ok: true, action: 'click', text: h.text }); return { ok: true, healed: true, strategy: h.strategy, info: h.text }; }
      heals.push({ sel, ok: false, action: 'click' });
      return { ok: false, count: els.length, ...(h.err ? { healError: h.err } : {}) };
    }
    return { ok: false, count: els.length };
  }
  async function fillSel(sel, value) {
    let el = null;
    try { el = await driver.$(sel); } catch (e) { el = null; }
    if (!el) {
      if (HEAL_ENABLED && healAdapter) {
        const h = await healFillSel(healAdapter, sel, value);
        if (h.ok) { heals.push({ sel, strategy: h.strategy, ok: true, action: 'fill' }); return { ok: true, healed: true }; }
        heals.push({ sel, ok: false, action: 'fill' });
        return { ok: false, err: 'fillSel 未找到: ' + sel, ...(h.err ? { healError: h.err } : {}) };
      }
      return { ok: false, err: 'fillSel 未找到: ' + sel };
    }
    try { await el.setValue(value); return { ok: true }; }
    catch (e) {
      if (HEAL_ENABLED && healAdapter) {
        const h = await healFillSel(healAdapter, sel, value);
        if (h.ok) { heals.push({ sel, strategy: h.strategy, ok: true, action: 'fill' }); return { ok: true, healed: true }; }
        // 自愈也失败：保留原始错误为主错误，heal 错误作为附加信息挂载。
        const oe = new Error(e.message); if (h.err) oe.healError = h.err;
        heals.push({ sel, ok: false, action: 'fill' });
        return { ok: false, err: e.message, ...(h.err ? { healError: h.err } : {}) };
      }
      return { ok: false, err: e.message };
    }
  }
  async function fillNear(label, value) {
    const xp = (opts.platform || 'android') === 'ios'
      ? `//*[contains(@label,"${label}")]/following-sibling::*//*[@visible="true"]`
      : `//*[contains(@text,"${label}")]/following-sibling::*//*[@class="android.widget.EditText"]`;
    try { const el = await driver.$(xp); await el.setValue(value); return { ok: true }; }
    catch (e) { return { ok: false, err: e.message }; }
  }
  async function countSel(sel) {
    try { const els = await driver.$$(sel); return els.length; } catch (e) { return 0; }
  }
  async function bodyText() {
    try { return await driver.getPageSource(); } catch (e) { return ''; }
  }
  async function assertEval(expr) {
    const chk = assertSafeExpr(expr);
    if (!chk.ok) return { pass: false, detail: '安全校验未通过: ' + chk.reason };
    try { const pass = await driver.executeScript('return (' + expr + ');'); return { pass: !!pass, detail: `eval(${expr}) = ${!!pass}` }; }
    catch (e) { return { pass: false, detail: 'eval 异常: ' + e.message }; }
  }
  async function goto() { return { ok: true }; }
  async function wait(ms) { await new Promise(r => setTimeout(r, ms)); return { ok: true }; }
  async function waitSel(sel, timeout) {
    try { await driver.waitUntil(async () => (await driver.$$(sel)).length > 0, { timeout: timeout || 10000 }); return { ok: true }; }
    catch (e) {
      if (HEAL_ENABLED && healAdapter) {
        const h = await healWaitSel(healAdapter, sel, timeout || 10000);
        if (h.ok) { heals.push({ sel, strategy: 'wait-heal', ok: true, action: 'wait' }); return { ok: true, healed: true }; }
        heals.push({ sel, ok: false, action: 'wait' });
      }
      return { ok: false, err: 'waitSel 超时: ' + sel };
    }
  }
  async function waitText(text, timeout) {
    try { await driver.waitUntil(async () => (await bodyText()).includes(text), { timeout: timeout || 10000 }); return { ok: true }; }
    catch (e) { return { ok: false, err: 'waitText 超时: ' + text }; }
  }
  async function exec(js) {
    try { const r = await driver.executeScript(js); return { ok: true, r }; }
    catch (e) { return { ok: false, err: e.message }; }
  }
  async function screenshot(p) {
    try { await driver.saveScreenshot(p); return { ok: true }; }
    catch (e) { return { ok: false, err: e.message }; }
  }
  async function getBusyDone(busySel, doneEval) {
    let busy = false, done = false;
    try { if (busySel) busy = (await countSel(busySel)) > 0; } catch (e) {}
    if (doneEval) { try { done = !!(await driver.executeScript('return (' + doneEval + ');')); } catch (e) {} }
    return { busy, done };
  }
  async function preFeatureCleanup() { /* 原生 App 无 web 遮罩，留空 */ }
  async function close() { if (driver) await driver.deleteSession(); }
  function clearFeatureErrors() { featureErrors.length = 0; }

  // T3b 自愈接口：setHeal 接受 HealAdapter 实例（路径 a），或 true（表示按驱动自身 ctx 在 launch 时激活）。
  function clearHeals() { heals.length = 0; }
  function setHeal(v) {
    if (v && typeof v.queryCandidates === 'function' && typeof v.readSignals === 'function' && typeof v.clickEl === 'function') {
      healAdapter = v; HEAL_ENABLED = true; HEAL_EXPLICIT = false; return;
    }
    if (v === true) { HEAL_EXPLICIT = true; HEAL_ENABLED = false; healAdapter = null; return; }
    HEAL_ENABLED = false; healAdapter = null; HEAL_EXPLICIT = false;
  }

  // 文件上传（fileSel）：原生 App 无 web <input type=file> 模型，显式标记不支持（返回结构化错误而非抛 TypeError）。
  async function fileSel(sel, p) {
    return { ok: false, err: '原生 App 驱动不支持文件上传断言（fileSel）：请用 browser/electron 驱动' };
  }
  // 视觉签名（visualCapture/visualDiff）：原生 App 无 DOM 布局指纹，显式标记不支持；
  // visualDiff 返回高严重度使断言必然 FAIL（而非静默通过），并带 err 说明原因。
  async function visualCapture(opts) {
    return { ok: false, err: '原生 App 驱动不支持视觉签名（visualCapture）：请用 browser/electron 驱动' };
  }
  function visualDiff(base, cur, opts) {
    return { ok: false, changed: true, moved: [], disappeared: [], appeared: [], severity: 999,
             err: '原生 App 驱动不支持视觉比对（visualDiff）：请用 browser/electron 驱动' };
  }

  return {
    type: 'appium',
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

module.exports = { createAppiumDriver };
