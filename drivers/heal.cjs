'use strict';
/**
 * heal.cjs —— 自愈定位器（Healer 角色）
 *
 * 当 spec 里的 CSS 选择器失效（DOM 重构 / 属性改名 / 框架重渲染 / nth 错位）时，
 * 用「稳定信号」找回等价元素，让验证在低风险下自愈，而不是立即 FAIL。
 *
 * 稳定信号优先级（分数越高越可信）：
 *   data-testid 精确/包含  >  aria-label 包含  >  role + 文本  >  class 包含  >  文本包含  >  tag
 *
 * 设计原则：
 *   - 纯函数，只接收 playwright page 对象 + 原始选择器，返回胜任的元素或 null；
 *   - 不修改被测软件任何东西（只在浏览器内做只读查询 + 等价点击/填值），符合 skill 铁律「只验证不修复」；
 *   - 自愈成功也不算「通过」的让步——它只是把「选择器写错」这种测试设计问题修对，断言照常严格。
 *
 * 被 drivers/dom.js（点击/填表/等待失败时自动调用）与 mcp-server.cjs（heal_selector 工具）复用。
 */
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

// 在浏览器内给一个候选元素打分：分数越高越可能是「原选择器的等价元素」
function scoreFn(tokens) {
  return function (e) {
    let s = 0;
    const txt = (e.textContent || '').trim();
    const cls = ('' + (e.className || '')).trim();
    for (const t of tokens) {
      if (t.type === 'id') { if (e.id === t.v) s += 100; }
      else if (t.type === 'attr') {
        const av = e.getAttribute(t.k);
        if (av) {
          if (t.k === 'data-testid') s += 90;
          else if (t.k === 'aria-label') s += 70;
          else s += 50;
          if (av.includes(t.v) || t.v.includes(av)) s += 10;
        }
      }
      else if (t.type === 'class') { if (cls && cls.split(/\s+/).includes(t.v)) s += 40; }
      else if (t.type === 'tag') { if (e.tagName.toLowerCase() === t.v) s += 5; }
    }
    if (txt && txt.length <= 140) {
      for (const t of tokens) {
        if (t.type === 'attr' && (t.k === 'aria-label' || t.k === 'data-testid') && txt.includes(t.v)) s += 30;
        if (t.type === 'class' && txt.includes(t.v)) s += 15;
      }
    }
    return s;
  };
}

async function healClickSel(page, sel, nth = 0) {
  const tokens = parseSel(sel);
  if (!tokens.length) return { ok: false, reason: 'no-tokens' };
  try {
    const r = await page.evaluate(({ tokens, nth }) => {
      const norm = s => (s || '').trim();
      const all = [...document.querySelectorAll('*')].filter(e => e.offsetParent);
      const score = (function (ts) {
        return function (e) {
          let s = 0; const txt = norm(e.textContent); const cls = ('' + (e.className || '')).trim();
          for (const t of ts) {
            if (t.type === 'id') { if (e.id === t.v) s += 100; }
            else if (t.type === 'attr') {
              const av = e.getAttribute(t.k);
              if (av) { s += (t.k === 'data-testid' ? 90 : t.k === 'aria-label' ? 70 : 50); if (av.includes(t.v) || t.v.includes(av)) s += 10; }
            }
            else if (t.type === 'class') { if (cls && cls.split(/\s+/).includes(t.v)) s += 40; }
            else if (t.type === 'tag') { if (e.tagName.toLowerCase() === t.v) s += 5; }
          }
          if (txt && txt.length <= 140) for (const t of ts) {
            if (t.type === 'attr' && (t.k === 'aria-label' || t.k === 'data-testid') && txt.includes(t.v)) s += 30;
            if (t.type === 'class' && txt.includes(t.v)) s += 15;
          }
          return s;
        };
      })(tokens);
      const ranked = all.map(e => ({ e, s: score(e) })).filter(x => x.s > 0).sort((a, b) => b.s - a.s);
      const pick = ranked[nth] || ranked[0];
      if (!pick) return { ok: false, scored: ranked.length };
      const txt = norm(pick.e.textContent);
      let strategy = 'text';
      if (pick.e.id) strategy = 'id#' + pick.e.id;
      else if (pick.e.getAttribute('data-testid')) strategy = 'data-testid=' + pick.e.getAttribute('data-testid');
      else if (pick.e.getAttribute('aria-label')) strategy = 'aria-label';
      else if (('' + (pick.e.className || '')).split(/\s+/).some(c => tokens.some(t => t.type === 'class' && t.v === c))) strategy = 'class';
      pick.e.click();
      return { ok: true, score: pick.s, strategy, tag: pick.e.tagName, text: txt.slice(0, 48) };
    }, { tokens, nth });
    return r;
  } catch (e) { return { ok: false, reason: 'eval-error', err: e.message }; }
}

async function healFillSel(page, sel, value, nth = 0) {
  const tokens = parseSel(sel);
  if (!tokens.length) return { ok: false, reason: 'no-tokens' };
  try {
    const r = await page.evaluate(({ tokens, nth, value }) => {
      const norm = s => (s || '').trim();
      const all = [...document.querySelectorAll('input,textarea,select')].filter(e => e.offsetParent);
      const score = (function (ts) {
        return function (e) {
          let s = 0; const ph = (e.getAttribute('placeholder') || '') + (e.getAttribute('aria-label') || '');
          for (const t of ts) {
            if (t.type === 'id') { if (e.id === t.v) s += 100; }
            else if (t.type === 'attr') { const av = e.getAttribute(t.k); if (av) { s += (t.k === 'data-testid' ? 90 : 70); if (av.includes(t.v) || t.v.includes(av)) s += 10; } if (ph.includes(t.v)) s += 20; }
            else if (t.type === 'class') { if (('' + (e.className || '')).split(/\s+/).includes(t.v)) s += 40; }
            else if (t.type === 'tag') { if (e.tagName.toLowerCase() === t.v) s += 5; }
          }
          return s;
        };
      })(tokens);
      const ranked = all.map(e => ({ e, s: score(e) })).filter(x => x.s > 0).sort((a, b) => b.s - a.s);
      const pick = ranked[nth] || ranked[0];
      if (!pick) return { ok: false, scored: ranked.length };
      const proto = pick.e.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(pick.e, value);
      pick.e.dispatchEvent(new Event('input', { bubbles: true }));
      pick.e.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, strategy: pick.e.id ? 'id#' + pick.e.id : (pick.e.getAttribute('data-testid') ? 'data-testid' : 'class'), tag: pick.e.tagName };
    }, { tokens, nth, value });
    return r;
  } catch (e) { return { ok: false, reason: 'eval-error', err: e.message }; }
}

async function healWaitSel(page, sel, timeout = 10000) {
  const tokens = parseSel(sel);
  if (!tokens.length) return { ok: false, reason: 'no-tokens' };
  try {
    await page.waitForFunction(({ tokens }) => {
      const norm = s => (s || '').trim();
      const all = [...document.querySelectorAll('*')].filter(e => e.offsetParent);
      const score = (function (ts) {
        return function (e) {
          let s = 0; const txt = norm(e.textContent); const cls = ('' + (e.className || '')).trim();
          for (const t of ts) {
            if (t.type === 'id') { if (e.id === t.v) s += 100; }
            else if (t.type === 'attr') { const av = e.getAttribute(t.k); if (av) { s += (t.k === 'data-testid' ? 90 : 70); if (av.includes(t.v) || t.v.includes(av)) s += 10; } }
            else if (t.type === 'class') { if (cls && cls.split(/\s+/).includes(t.v)) s += 40; }
            else if (t.type === 'tag') { if (e.tagName.toLowerCase() === t.v) s += 5; }
          }
          return s;
        };
      })(tokens);
      return all.some(e => score(e) > 0);
    }, { tokens }, { timeout });
    return { ok: true };
  } catch (e) { return { ok: false, reason: 'timeout' }; }
}

module.exports = { parseSel, healClickSel, healFillSel, healWaitSel };
