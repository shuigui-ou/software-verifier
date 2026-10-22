'use strict';
/**
 * heal-adapter.cjs —— 自愈 handle 模型 + 三驱动适配器（T3b）
 *
 * T3b 把 heal.cjs 从「playwright page.evaluate 浏览器内打分」重构成「驱动无关 handle 模型」：
 *   - 评分算法 scoreElement(tokens, signals) 只吃 signals（text/class/attrs/tag），不吃 document；
 *   - 元素信号由适配器 readSignals(el) 一次取齐（驱动原生批量接口优先；无则退化固定属性列表）；
 *   - heal*Sel(adapter, sel, ...) 在 Node 侧打分 + 触发，三驱动复用同一套算法。
 *
 * 往返预算硬约束（六点 #2 硬门槛，严禁 3N）：
 *   真实预算 = 1(queryCandidates) + min(N, MAX_CANDIDATES) × (批量 1 次 / 退化 K 次)，K = FIXED_ATTRS.length。
 *   playwright 用单次 evaluate 取齐（批量，1 次）；miniprogram 无批量接口 → 退化按 FIXED_ATTRS 逐属性取（K 次）。
 *
 * 断连不吞错（六点 #6）：readSignals/clickEl/fillEl 抛错时，heal*Sel 返回
 *   { ok:false, reason:'heal-adapter-error', err:<原始 Error> }，调用方再把它挂到 originalError.healError 上抛。
 */

const FIXED_ATTRS = ['data-testid', 'aria-label', 'role', 'class', 'id'];
const MAX_CANDIDATES = 200;

function parseSel(sel) {
  const tokens = [];
  if (!sel) return tokens;
  const idm = sel.match(/#([\w-]+)/);
  if (idm) tokens.push({ type: 'id', v: idm[1] });
  const attrRe = /\[([\w-]+)\s*=\s*["']?([^"'\]]+)["']?\]/g;
  let m;
  while ((m = attrRe.exec(sel))) tokens.push({ type: 'attr', k: m[1].toLowerCase(), v: m[2] });
  const cls = [...sel.matchAll(/\.([\w-]+)/g)].map(x => x[1]).filter(c => c.length >= 3);
  if (cls.length) tokens.push({ type: 'class', v: cls.sort((a, b) => b.length - a.length)[0] });
  const tagm = sel.match(/^([a-zA-Z][\w-]*)/);
  if (tagm) tokens.push({ type: 'tag', v: tagm[1].toLowerCase() });
  return tokens;
}

function scoreElement(tokens, signals) {
  let s = 0;
  const txt = (signals && signals.text ? '' + signals.text : '').trim();
  const cls = (signals && signals.class ? '' + signals.class : '').trim();
  const attrs = (signals && signals.attrs) || {};
  const tag = (signals && signals.tag ? '' + signals.tag : '').toLowerCase();
  for (const t of tokens) {
    if (t.type === 'id') { if (attrs.id === t.v) s += 100; }
    else if (t.type === 'attr') {
      const av = attrs[t.k];
      if (av) {
        if (t.k === 'data-testid') s += 90;
        else if (t.k === 'aria-label') s += 70;
        else s += 50;
        if (av.includes(t.v) || t.v.includes(av)) s += 10;
      }
    }
    else if (t.type === 'class') { if (cls && cls.split(/\s+/).includes(t.v)) s += 40; }
    else if (t.type === 'tag') { if (tag === t.v) s += 5; }
  }
  if (txt && txt.length <= 140) {
    for (const t of tokens) {
      if (t.type === 'attr' && (t.k === 'aria-label' || t.k === 'data-testid') && txt.includes(t.v)) s += 30;
      if (t.type === 'class' && txt.includes(t.v)) s += 15;
    }
  }
  return s;
}

function deriveStrategy(tokens, signals) {
  const a = (signals && signals.attrs) || {};
  if (a.id) return 'id#' + a.id;
  if (a['data-testid']) return 'data-testid=' + a['data-testid'];
  if (a['aria-label']) return 'aria-label';
  const cls = (signals && signals.class ? '' + signals.class : '').split(/\s+/);
  if (tokens.some(t => t.type === 'class' && cls.includes(t.v))) return 'class';
  return 'text';
}

async function genericWaitFor(pred, opts) {
  const timeout = (opts && opts.timeout) || 10000;
  const interval = (opts && opts.interval) || 250;
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    let hit = false;
    try { hit = !!(await pred()); } catch (e) { hit = false; }
    if (hit) return true;
    await new Promise(r => setTimeout(r, interval));
  }
  return false;
}

function createHealAdapter(kind, ctx) {
  if (kind === 'playwright') {
    const page = ctx;
    return {
      kind, usesBatch: true,
      async queryCandidates() { const all = await page.$$('*'); return Array.isArray(all) ? all : []; },
      async readSignals(el) {
        // 单次 evaluate 取齐（批量路径，1 次往返）——规避逐属性 3N。
        const data = await el.evaluate(e => ({
          text: (e.textContent || '').trim(),
          class: e.getAttribute('class'),
          tag: e.tagName,
          attrs: {
            'data-testid': e.getAttribute('data-testid'),
            'aria-label': e.getAttribute('aria-label'),
            role: e.getAttribute('role'),
            class: e.getAttribute('class'),
            id: e.getAttribute('id'),
          },
        }));
        return data;
      },
      async clickEl(el) { await el.click(); },
      async fillEl(el, value) {
        await el.evaluate(({ value }) => {
          const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
          setter.call(el, value);
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }, { value });
      },
      waitFor: (pred, opts) => genericWaitFor(pred, opts),
    };
  }
  if (kind === 'webdriverio') {
    const driver = ctx;
    return {
      kind, usesBatch: true,
      async queryCandidates() { const all = await driver.$$('*'); return Array.isArray(all) ? all : []; },
      async readSignals(el) {
        let attrs = {};
        if (typeof el.getAttributes === 'function') {
          try { attrs = (await el.getAttributes()) || {}; } catch (e) { attrs = {}; }
        } else {
          for (const k of FIXED_ATTRS) { try { attrs[k] = await el.getAttribute(k); } catch (e) { attrs[k] = null; } }
        }
        const text = (typeof el.getText === 'function') ? (await el.getText()) : '';
        return { text, class: attrs['class'] || '', attrs, tag: (typeof el.getTagName === 'function') ? (await el.getTagName()) : (attrs['tag'] || null) };
      },
      async clickEl(el) { await el.click(); },
      async fillEl(el, value) { await el.setValue(value); },
      waitFor: (pred, opts) => genericWaitFor(pred, opts),
    };
  }
  if (kind === 'miniprogram') {
    const miniProgram = ctx && ctx.miniProgram;
    const page = ctx && ctx.page;
    const scopePage = page || (miniProgram && miniProgram.currentPage ? miniProgram.currentPage() : null);
    return {
      kind, usesBatch: false,
      async queryCandidates() {
        const TAGS = ['button', 'text', 'view', 'navigator'];
        let els = [];
        const p = scopePage || page;
        if (!p) return els;
        for (const t of TAGS) { try { const r = await p.$$(t); if (r) els = els.concat(r); } catch (e) {} }
        return els;
      },
      async readSignals(el) {
        // 退化路径：miniprogram-automator 无批量接口，按 FIXED_ATTRS 逐属性取（K 次，K=5，固定有限）。
        const attrs = {};
        for (const k of FIXED_ATTRS) { try { attrs[k] = el.attribute ? await el.attribute(k) : null; } catch (e) { attrs[k] = null; } }
        const text = (el.text ? await el.text() : '') || '';
        const cls = attrs['class'] || '';
        const tag = (el.tagName ? await el.tagName() : null) || null;
        return { text, class: cls, attrs, tag };
      },
      async clickEl(el) { await (el.tap ? el.tap() : el.click()); },
      async fillEl(el, value) { await el.trigger('input', { value }); },
      waitFor: (pred, opts) => genericWaitFor(pred, opts),
    };
  }
  throw new Error('createHealAdapter: 未知驱动类型 ' + kind);
}

async function healClickSel(adapter, sel, nth = 0) {
  const tokens = parseSel(sel);
  if (!tokens.length) return { ok: false, reason: 'no-tokens' };
  let els;
  try { els = await adapter.queryCandidates(tokens); }
  catch (e) { const err = e instanceof Error ? e : new Error(String(e)); return { ok: false, reason: 'heal-adapter-error', err }; }
  const ranked = [];
  for (const el of els.slice(0, MAX_CANDIDATES)) {
    let signals;
    try { signals = await adapter.readSignals(el); }
    catch (e) { const err = e instanceof Error ? e : new Error(String(e)); return { ok: false, reason: 'heal-adapter-error', err }; }
    const s = scoreElement(tokens, signals);
    if (s > 0) ranked.push({ el, s, signals });
  }
  ranked.sort((a, b) => b.s - a.s);
  const pick = ranked[nth] || ranked[0];
  if (!pick) return { ok: false, scored: ranked.length };
  try { await adapter.clickEl(pick.el); }
  catch (e) { const err = e instanceof Error ? e : new Error(String(e)); return { ok: false, reason: 'heal-adapter-error', err }; }
  return { ok: true, strategy: deriveStrategy(tokens, pick.signals), tag: pick.signals.tag, text: (pick.signals.text || '').slice(0, 48) };
}

async function healFillSel(adapter, sel, value, nth = 0) {
  const tokens = parseSel(sel);
  if (!tokens.length) return { ok: false, reason: 'no-tokens' };
  let els;
  try { els = await adapter.queryCandidates(tokens); }
  catch (e) { const err = e instanceof Error ? e : new Error(String(e)); return { ok: false, reason: 'heal-adapter-error', err }; }
  const ranked = [];
  for (const el of els.slice(0, MAX_CANDIDATES)) {
    let signals;
    try { signals = await adapter.readSignals(el); }
    catch (e) { const err = e instanceof Error ? e : new Error(String(e)); return { ok: false, reason: 'heal-adapter-error', err }; }
    const s = scoreElement(tokens, signals);
    if (s > 0) ranked.push({ el, s, signals });
  }
  ranked.sort((a, b) => b.s - a.s);
  const pick = ranked[nth] || ranked[0];
  if (!pick) return { ok: false, scored: ranked.length };
  try { await adapter.fillEl(pick.el, value); }
  catch (e) { const err = e instanceof Error ? e : new Error(String(e)); return { ok: false, reason: 'heal-adapter-error', err }; }
  return { ok: true, strategy: deriveStrategy(tokens, pick.signals), tag: pick.signals.tag };
}

async function healWaitSel(adapter, sel, timeout = 10000, interval = 250) {
  const tokens = parseSel(sel);
  if (!tokens.length) return { ok: false, reason: 'no-tokens' };
  const ok = await adapter.waitFor(async () => {
    let els;
    try { els = await adapter.queryCandidates(tokens); } catch (e) { return false; }
    for (const el of els.slice(0, MAX_CANDIDATES)) {
      let signals;
      try { signals = await adapter.readSignals(el); } catch (e) { continue; }
      if (scoreElement(tokens, signals) > 0) return true;
    }
    return false;
  }, { timeout, interval });
  return ok ? { ok: true } : { ok: false, reason: 'timeout' };
}

module.exports = {
  parseSel, scoreElement, deriveStrategy, createHealAdapter,
  healClickSel, healFillSel, healWaitSel,
  FIXED_ATTRS, MAX_CANDIDATES,
};
