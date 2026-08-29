#!/usr/bin/env node
/**
 * engine.cjs —— software-verifier 步骤/断言执行核心（驱动无关）
 *
 * 从 verify.cjs 抽出的纯逻辑，供 verify.cjs 与 mcp-server.cjs 共用，避免两套实现漂移。
 * 新增能力：
 *   - 自愈由 drivers/dom.js 在底层 clickSel/fillSel/waitSel 失败时自动触发（本层不感知）；
 *   - visual 步骤 / visual 断言：零依赖视觉回归（见 drivers/visual.cjs）。
 *
 * ctx 约定：
 *   { BASE, SHOTS, SKILL_DIR, visualBase(name)->baselinePath }
 */
'use strict';
const fs = require('fs');
const path = require('path');

async function runStep(drv, step, ctx) {
  switch (step.do) {
    case 'goto':
      await drv.goto(ctx.BASE + (step.path || '/'));
      return { ok: true };
    case 'wait':
      await drv.wait(step.ms || 1000); return { ok: true };
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
    case 'screenshot': {
      const r = await drv.screenshot(ctx.SHOTS + '/' + step.name).catch(() => ({ ok: false, err: 'screenshot 失败' }));
      return r.ok ? r : { ok: true, warn: r.err };
    }
    case 'assert': {
      const ar = await runAssert(drv, step, ctx);
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
        await drv.wait(1500);
      }
      return { ok: false, reason: 'timeout', appeared };
    }
    case 'visual': {
      const vname = step.name || 'visual';
      const bp = ctx.visualBase(vname);
      const cur = await drv.visualCapture({ sel: step.sel });
      if (step.baseline || !fs.existsSync(bp)) {
        fs.mkdirSync(path.dirname(bp), { recursive: true });
        fs.writeFileSync(bp, JSON.stringify(cur));
        return { ok: true, baseline: true, detail: '已建视觉基线: ' + vname };
      }
      const base = JSON.parse(fs.readFileSync(bp, 'utf8'));
      const d = drv.visualDiff(base, cur, { moveThreshold: step.moveThreshold || 12 });
      const failOn = step.failOn || 'change';
      let ok = true;
      if (failOn === 'disappear') ok = d.disappeared.length === 0;
      else if (failOn === 'change') ok = !d.changed;
      return {
        ok,
        detail: '视觉变化=' + d.changed + ' 位移:' + d.moved.length + ' 消失:' + d.disappeared.length + ' 新增:' + d.appeared.length + ' 严重度:' + d.severity,
        visual: d
      };
    }
    default:
      return { ok: false, err: '未知步骤类型: ' + step.do };
  }
}

async function runAssert(drv, a, ctx) {
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
  if (a.visual) {
    const vname = a.visual;
    const bp = ctx.visualBase(vname);
    const cur = await drv.visualCapture({ sel: a.sel });
    if (!fs.existsSync(bp)) return { pass: true, detail: '视觉基线已建（首次）: ' + vname };
    const base = JSON.parse(fs.readFileSync(bp, 'utf8'));
    const d = drv.visualDiff(base, cur, { moveThreshold: a.moveThreshold || 12 });
    const sev = a.severity != null ? a.severity : 3;
    const pass = d.severity <= sev;
    return { pass, detail: `视觉严重度 ${d.severity} ≤ 阈值 ${sev} ? ${pass}（消失:${d.disappeared.length} 新增:${d.appeared.length} 位移:${d.moved.length}）` };
  }
  return { pass: true, detail: '无断言' };
}

module.exports = { runStep, runAssert };
