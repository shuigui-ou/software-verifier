'use strict';
/**
 * T3b 验收：heal-adapter handle 模型 + 三驱动适配器（F1~F8，mock 级；真实设备 e2e 见 spec §0.2，沙箱 N/A）。
 * 运行：node test/heal-adapter.test.cjs  （退出码 0=全绿，非0=有失败）
 */
const H = require('../drivers/heal-adapter.cjs');
const { createHealAdapter, scoreElement, healClickSel, healFillSel, healWaitSel, FIXED_ATTRS, parseSel } = H;
const { createMiniprogramDriver } = require('../drivers/miniprogram.js');
const { createAppiumDriver } = require('../drivers/appium.js');

let pass = 0, fail = 0;
function ok(cond, name) { if (cond) { pass++; console.log('  PASS ' + name); } else { fail++; console.log('  FAIL ' + name); } }

// ---- mock 构造 ----
function mkPwEl(signals) {
  let ev = 0;
  const el = {
    _signals: signals,
    evaluate: async () => { ev++; return signals; },
    click: async () => { el._clicked = (el._clicked || 0) + 1; },
    getAttribute: async (k) => (signals.attrs ? signals.attrs[k] : null),
    _evCalls: () => ev,
  };
  return el;
}
function mkPwPage(els) { return { $$: async () => els, evaluate: async () => null }; }

function mkMpEl(signals) {
  let attrCalls = 0;
  const el = {
    _signals: signals,
    text: async () => signals.text || '',
    attribute: async (k) => { attrCalls++; return signals.attrs ? signals.attrs[k] : null; },
    tap: async () => { el._tapped = (el._tapped || 0) + 1; },
    trigger: async () => { el._triggered = (el._triggered || 0) + 1; },
    _attrCalls: () => attrCalls,
  };
  return el;
}
function mkMpPage(els) { const p = { $$: async (t) => (t === 'button' ? els : []), currentPage: () => p }; return p; }

function mkWdEl(signals) {
  let ga = 0;
  const el = {
    _signals: signals,
    getAttributes: async () => { ga++; return signals.attrs || {}; },
    getText: async () => signals.text || '',
    click: async () => { el._clicked = (el._clicked || 0) + 1; },
    setValue: async () => { el._set = (el._set || 0) + 1; },
    _gaCalls: () => ga,
  };
  return el;
}
function mkWdDriver(els) { return { $$: async () => els }; }

function sig(o) { return { text: o.text || '', class: o.class || '', tag: o.tag || '', attrs: o.attrs || {} }; }

async function main() {
  // ===== F1 接口一致 =====
  console.log('F1 接口一致');
  for (const kind of ['playwright', 'webdriverio', 'miniprogram']) {
    const ctx = kind === 'playwright' ? mkPwPage([]) : kind === 'webdriverio' ? mkWdDriver([]) : { miniProgram: null, page: mkMpPage([]) };
    const a = createHealAdapter(kind, ctx);
    ok(typeof a.queryCandidates === 'function' && typeof a.readSignals === 'function' && typeof a.clickEl === 'function' && typeof a.fillEl === 'function' && typeof a.waitFor === 'function',
       'createHealAdapter(' + kind + ') 实现全部原语');
  }

  // ===== F2 评分权重 + 往返预算（批量/退化分别断言）=====
  console.log('F2 handle 评分 + 往返预算');
  ok(scoreElement([{ type: 'attr', k: 'data-testid', v: 'x' }], sig({ attrs: { 'data-testid': 'x' } })) > scoreElement([{ type: 'class', v: 'btn' }], sig({ class: 'btn' })),
     'data-testid(90) > class(40)');
  ok(scoreElement([{ type: 'class', v: 'btn' }], sig({ class: 'btn' })) > scoreElement([{ type: 'tag', v: 'button' }], sig({ tag: 'button' })),
     'class(40) > tag(5)');

  // 批量路径（playwright，1 次 evaluate/候选）
  {
    const els = [mkPwEl(sig({ attrs: { id: 'a' }, text: '提交' })), mkPwEl(sig({ attrs: { 'data-testid': 'go' }, text: '去' }))];
    const a = createHealAdapter('playwright', mkPwPage(els));
    const r = await healClickSel(a, '[data-testid="go"]', 0);
    ok(r.ok && r.strategy === 'data-testid=go', 'playwright 批量定位 data-testid 元素');
    ok(els.every(e => e._evCalls() === 1), '批量路径：每个候选 readSignals 调用次数 === 1（非 3×）');
  }
  // 退化路径（miniprogram，K=5 次 attribute/候选）
  {
    const N = 3;
    const els = [];
    for (let i = 0; i < N; i++) els.push(mkMpEl(sig({ attrs: { id: 'm' + i, 'data-testid': 't' + i, 'aria-label': 'a' + i, role: 'r' + i, class: 'c' + i }, text: 'x' + i })));
    const a = createHealAdapter('miniprogram', { miniProgram: null, page: mkMpPage(els) });
    const r = await healClickSel(a, '#m0', 0);
    ok(r.ok, 'miniprogram 退化路径定位成功');
    const totalAttr = els.reduce((s, e) => s + e._attrCalls(), 0);
    ok(totalAttr === N * FIXED_ATTRS.length, '退化路径：attribute 调用次数 === 候选数×K (' + totalAttr + ' == ' + (N * FIXED_ATTRS.length) + ')');
    ok(a.usesBatch === false, 'miniprogram adapter.usesBatch === false（确为退化）');
  }

  // ===== F3 小程序 heal 路由生效（死分支已活）=====
  console.log('F3 小程序 heal 路由');
  {
    const els = [mkMpEl(sig({ attrs: { id: 'submit', 'data-testid': 'submit' }, text: '提交订单' }))];
    const adapter = createHealAdapter('miniprogram', { miniProgram: null, page: mkMpPage(els) });
    const drv = createMiniprogramDriver(null);
    drv.setHeal(adapter);                 // 路径 (a) 显式 adapter
    const r = await drv.clickSel('#submit', 0);  // page 为 null → els 空 → 进 heal
    ok(r.ok && r.healed === true, 'clickSel 未命中 → heal 自救成功');
    ok(drv.heals.length === 1 && drv.heals[0].ok === true && drv.heals[0].action === 'click', 'heals 记录 {sel, ok:true, action:click}');
    ok(els[0]._tapped === 1, 'miniprogram 句柄 .tap() 被调用（等价点击）');
  }

  // ===== F4 Appium heal 路由生效（死分支已活）=====
  console.log('F4 Appium heal 路由');
  {
    const els = [mkWdEl(sig({ attrs: { id: 'inp', 'data-testid': 'email' }, text: '邮箱' }))];
    const adapter = createHealAdapter('webdriverio', mkWdDriver(els));
    const drv = createAppiumDriver(null);
    drv.setHeal(adapter);
    const r = await drv.fillSel('[data-testid="email"]', 'a@b.com'); // driver 为 null → el 空 → 进 heal
    ok(r.ok && r.healed === true, 'fillSel 未命中 → heal 自救成功');
    ok(drv.heals.length === 1 && drv.heals[0].ok === true && drv.heals[0].action === 'fill', 'heals 记录 {sel, ok:true, action:fill}');
    ok(els[0]._set === 1, 'webdriverio 句柄 .setValue() 被调用');
  }

  // ===== F5 playwright 逐分一致（旧 page.evaluate 路径 vs 新 handle 路径）=====
  console.log('F5 playwright 逐分一致');
  {
    function oldScoreFn(tokens) {
      return function (e) {
        let s = 0;
        const txt = (e.textContent || '').trim();
        const cls = ('' + (e.className || '')).trim();
        for (const t of tokens) {
          if (t.type === 'id') { if (e.id === t.v) s += 100; }
          else if (t.type === 'attr') {
            const av = e.getAttribute(t.k);
            if (av) { if (t.k === 'data-testid') s += 90; else if (t.k === 'aria-label') s += 70; else s += 50; if (av.includes(t.v) || t.v.includes(av)) s += 10; }
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
    function domEl(o) {
      return {
        textContent: o.text, className: o.class, id: (o.attrs && o.attrs.id) || '', tagName: (o.tag || 'div').toUpperCase(),
        getAttribute(k) { const v = o.attrs ? o.attrs[k] : null; return v == null ? null : v; },
      };
    }
    const cases = [
      { text: '提交', class: 'btn primary', tag: 'button', attrs: { id: 'ok', 'data-testid': 'submit', 'aria-label': '提交按钮', role: 'button' } },
      { text: '取消', class: 'btn', tag: 'a', attrs: { id: 'cancel', 'aria-label': '取消' } },
      { text: '纯文本', class: '', tag: 'span', attrs: {} },
    ];
    let allEq = true;
    for (const c of cases) {
      const tokens = parseSel('#' + (c.attrs.id || 'x') + (c.attrs['data-testid'] ? '[data-testid="' + c.attrs['data-testid'] + '"]' : ''));
      const oldS = oldScoreFn(tokens)(domEl(c));
      const newS = scoreElement(tokens, sig(c));
      if (oldS !== newS) { allEq = false; console.log('    不一致: old=' + oldS + ' new=' + newS + ' case=' + JSON.stringify(c)); }
    }
    ok(allEq, '旧路径与新 handle 路径逐分一致（同输入同策略）');
  }

  // ===== F6 waitFor 映射 =====
  console.log('F6 waitFor 映射');
  {
    const els = [mkMpEl(sig({ attrs: { id: 'ready', 'data-testid': 'ready' }, text: '就绪' }))];
    const a = createHealAdapter('miniprogram', { miniProgram: null, page: mkMpPage(els) });
    const rOk = await healWaitSel(a, '#ready', 500, 50);
    ok(rOk.ok === true, 'miniprogram waitFor 命中即 ok');
    const empty = createHealAdapter('miniprogram', { miniProgram: null, page: mkMpPage([]) });
    const rTo = await healWaitSel(empty, '#nope', 300, 50);
    ok(rTo.ok === false && rTo.reason === 'timeout', 'miniprogram waitFor 超时返回 {ok:false,reason:timeout}');
  }

  // ===== F7 无 adapter 不误触发 =====
  console.log('F7 无 adapter 不误触发');
  {
    const drv = createMiniprogramDriver(null); // 未 setHeal，HEAL_ENABLED 默认 false
    const r = await drv.clickSel('#missing', 0);
    ok(r.ok === false && drv.heals.length === 0, '默认关闭：clickSel 未命中如实失败，不进 heal、heals 空');
    const drv2 = createAppiumDriver(null);
    const r2 = await drv2.fillSel('#missing', 'v');
    ok(r2.ok === false && drv2.heals.length === 0, '默认关闭：fillSel 未命中如实失败，不进 heal');
  }

  // ===== F8 断连不吞原始错误 + 调用方 healError 挂载 =====
  console.log('F8 断连不吞错');
  {
    const broken = {
      kind: 'broken',
      queryCandidates: async () => [{}],
      readSignals: async () => { throw new Error('WS closed'); },
      clickEl: async () => {},
      fillEl: async () => {},
      waitFor: async () => false,
    };
    const h = await healClickSel(broken, '#x', 0);
    ok(h.ok === false && h.reason === 'heal-adapter-error' && h.err && h.err.message === 'WS closed',
       'heal*Sel 返回 {ok:false, reason:heal-adapter-error, err:原始 Error}');
    // 调用方语义：miniprogram fillSel 真实元素 trigger 抛原始错误，heal 也失败 → 主错误=原始，healError 挂载
    const mockPage = { $$: async () => [{ trigger: async () => { throw new Error('original fail'); } }] };
    const drv = createMiniprogramDriver(null);
    await drv.launch({ injectPage: mockPage });   // 注入 mock page，绕过 automator
    const adapter = createHealAdapter('miniprogram', { miniProgram: null, page: mockPage });
    adapter.readSignals = async () => { throw new Error('WS closed'); };
    drv.setHeal(adapter);
    const r = await drv.fillSel('#f', 'v');
    ok(r.ok === false && r.err === 'original fail' && r.healError && r.healError.message === 'WS closed',
       'fillSel 原错误保留为主错误，heal 错误挂 originalError.healError（不吞、不盖）');
  }

  console.log('\n==== T3b 验收结果: ' + pass + ' PASS / ' + fail + ' FAIL ====');
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(e => { console.error('TEST CRASH:', e); process.exit(1); });
