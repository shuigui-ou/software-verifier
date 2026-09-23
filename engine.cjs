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
const crypto = require("crypto");
function sha256(buf){ return crypto.createHash("sha256").update(buf).digest("hex"); }
function jsonPathGet(obj, p){
  if(!obj||!p) return undefined;
  let sp = String(p);
  while(sp.charAt(0)==="$"||sp.charAt(0)===".") sp = sp.slice(1);
  const parts = sp.split(".");
  let cur = obj;
  for(const k of parts){ if(cur==null) return undefined; cur = (Array.isArray(cur) && !isNaN(k)) ? cur[Number(k)] : cur[k]; }
  return cur;
}


/**
 * 工具自检上报（v1.4.3）：把"验证器自身降级/能力边界"与"被测软件缺陷"分开记录。
 * 曾经的问题：截图失败在这里被改写成 { ok: true }，消费者只看到"有截图"，看不到"截图其实没采到"。
 * 现在统一上报到 ctx.toolIssues（verify.cjs 写入 result.toolIssues + 控制台告警 + 报告「工具自身问题」段）。
 */
function noteToolIssue(ctx, kind, msg) {
  const rec = { kind, msg, at: new Date().toISOString() };
  try { if (ctx && Array.isArray(ctx.toolIssues)) ctx.toolIssues.push(rec); } catch (_e) { /* ignore */ }
  return rec;
}

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
      // v1.4.3 修复（静默失效）：此前失败被改写成 { ok: true } 且 warn 无人消费，报告照写"截图"、
      // 消费者以为有证据而 PNG 实际不存在。现语义：截图是**证据材料**而非被测软件的功能声明，
      // 缺图不翻转功能点判定；但必须显式上报（toolIssues + 控制台 + 报告「工具自身问题」段）。
      const r = await drv.screenshot(ctx.SHOTS + '/' + step.name).catch(e => ({ ok: false, err: (e && e.message) || 'screenshot 失败' }));
      if (r.ok) return { ok: true };
      const msg = '截图未采集（' + (step.name || '?') + '）：' + (r.err || '未知原因');
      noteToolIssue(ctx, 'screenshot', msg);
      return { ok: true, warn: msg, degraded: 'screenshot' };
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

    case "setLocale": {
      ctx.locale = step.locale || step.lang || step.value || "";
      if (step.url) { await drv.goto(step.url); return { ok: true, locale: ctx.locale }; }
      if (step.path) { await drv.goto(ctx.BASE + step.path); return { ok: true, locale: ctx.locale }; }
      if (step.sel) { const r = await drv.clickSel(step.sel, step.nth || 0); return r.ok ? { ok: true, locale: ctx.locale } : { ok: false, err: "setLocale 点击语言切换失败: " + (r.err || "") }; }
      if (step.exec) { const r = await drv.exec(step.exec); return r.ok ? { ok: true, locale: ctx.locale } : { ok: false, err: "setLocale exec 失败: " + (r.err || "") }; }
      return { ok: true, locale: ctx.locale };
    }
    case "download": {
      if (typeof drv.downloadSel !== "function") return { ok: false, err: "当前驱动不支持 download 步骤（仅 browser/electron 支持）" };
      const dlDir = step.dir || (ctx.SHOTS ? ctx.SHOTS + "/downloads" : require("os").tmpdir());
      const r = await drv.downloadSel(step.sel, dlDir);
      if (!r.ok) return r;
      if (step.minBytes != null && r.bytes < step.minBytes) return { ok: false, err: "下载大小 " + r.bytes + " 字节 < 要求 " + step.minBytes, path: r.path, bytes: r.bytes, sha: r.sha };
      if (step.sha && r.sha !== step.sha) return { ok: false, err: "下载 SHA-256 不匹配（期望 " + step.sha + "）", path: r.path, bytes: r.bytes, sha: r.sha };
      if (step.expectSha && r.sha !== step.expectSha) return { ok: false, err: "下载 SHA-256 不匹配", path: r.path, bytes: r.bytes, sha: r.sha };
      ctx._lastDownload = r;
      return { ok: true, path: r.path, bytes: r.bytes, sha: r.sha, filename: r.filename };
    }
    case "api": {
      if (!ctx.allowApi) return { ok: false, err: "api 步骤需显式开启网络（verify.cjs --allow-api 或 spec.allowApi=true）" };
      if (typeof fetch !== "function") return { ok: false, err: "运行环境无 fetch（需 Node 18+）" };
      try {
        const resp = await fetch(step.url, { method: step.method || "GET", headers: step.headers || {}, body: step.body });
        const text = await resp.text();
        let json = null; try { json = JSON.parse(text); } catch (_e) { }
        if (step.expectStatus != null && resp.status !== step.expectStatus) return { ok: false, err: "HTTP 状态 " + resp.status + " != 期望 " + step.expectStatus };
        if (step.contains && !text.includes(step.contains)) return { ok: false, err: "响应不含「" + step.contains + "」" };
        if (step.jsonPath) { const v = jsonPathGet(json, step.jsonPath); if (step.equals != null && String(v) !== String(step.equals)) return { ok: false, err: "jsonPath " + step.jsonPath + "=" + JSON.stringify(v) + " != " + step.equals }; if (step.expectTruthy && !v) return { ok: false, err: "jsonPath " + step.jsonPath + " 为空" }; }
        return { ok: true, status: resp.status, bodyLen: text.length, sample: text.slice(0, 200) };
      } catch (e) { return { ok: false, err: "api 请求失败: " + (e && e.message || e) }; }
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

  if (a.download) {
    const pth = a.path || (ctx._lastDownload && ctx._lastDownload.path);
    if (!pth) return { pass: false, detail: "download 断言缺少 path 且无上次下载记录（先跑 download 步骤）" };
    const fso = require("fs");
    if (!fso.existsSync(pth)) return { pass: false, detail: "下载文件不存在: " + pth };
    const buf = fso.readFileSync(pth);
    let ok = true; let detail = "下载文件存在: " + pth + " (" + buf.length + " 字节)";
    if (a.minBytes != null && buf.length < a.minBytes) { ok = false; detail = "大小 " + buf.length + " 字节 < 要求 " + a.minBytes; }
    if ((a.sha || a.expectSha) && sha256(buf) !== (a.sha || a.expectSha)) { ok = false; detail = "SHA-256 不匹配"; }
    return { pass: ok, detail };
  }
  if (a.api) {
    if (!ctx.allowApi) return { pass: false, detail: "api 断言需显式开启网络（verify.cjs --allow-api）" };
    if (typeof fetch !== "function") return { pass: false, detail: "运行环境无 fetch（需 Node 18+）" };
    try {
      const opt = a.api || {};
      const resp = await fetch(opt.url || a.url, { method: opt.method || a.method || "GET", headers: opt.headers || a.headers || {}, body: opt.body || a.body });
      const text = await resp.text();
      let json = null; try { json = JSON.parse(text); } catch (_e) {}
      if (opt.expectStatus != null && resp.status !== opt.expectStatus) return { pass: false, detail: "HTTP 状态 " + resp.status + " != 期望 " + opt.expectStatus };
      if (opt.contains && !text.includes(opt.contains)) return { pass: false, detail: "响应不含「" + opt.contains + "」" };
      if (opt.jsonPath) { const v = jsonPathGet(json, opt.jsonPath); if (opt.equals != null && String(v) !== String(opt.equals)) return { pass: false, detail: "jsonPath " + opt.jsonPath + "=" + JSON.stringify(v) + " != " + opt.equals }; }
      return { pass: true, detail: "api 校验通过 (status " + resp.status + ")" };
    } catch (e) { return { pass: false, detail: "api 请求失败: " + (e && e.message || e) }; }
  }
  if (a.openapi) {
    if (!ctx.allowApi) return { pass: false, detail: "openapi 断言需显式开启网络（verify.cjs --allow-api）" };
    try {
      const resp = await fetch(a.openapi.specUrl || a.openapi.url);
      const spec = await resp.json();
      const paths = (spec && spec.paths) || {};
      const item = paths[a.openapi.path];
      const m = (a.openapi.method || "get").toLowerCase();
      if (!item || !item[m]) return { pass: false, detail: "OpenAPI 未声明 " + m.toUpperCase() + " " + a.openapi.path };
      return { pass: true, detail: "OpenAPI 声明存在: " + m.toUpperCase() + " " + a.openapi.path };
    } catch (e) { return { pass: false, detail: "openapi 校验失败: " + (e && e.message || e) }; }
  }
  // 严格化（v1.4.2）：只有"确实没写任何断言"才算跳过；写了引擎不认识的断言键 → 明确失败。
  // 此前统一 return { pass: true, detail: '无断言' }，导致任何未实现的断言键被静默判为通过（假绿）——比直接失败更危险。
  // 注：v1.4.5 起 {api}/{openapi}/{download} 已在上方实现并有真实探针证据，不再落入此分支；
  //    此分支仅用于真正未知的断言键（如笔误）。
  const META_KEYS = ['desc', 'min', 'severity', 'moveThreshold'];
  const keys = Object.keys(a || {}).filter(k => META_KEYS.indexOf(k) < 0);
  if (keys.length === 0) return { pass: true, detail: '无断言（跳过）' };
  return { pass: false, detail: '未知断言类型: ' + keys.join(',') + '（引擎不支持该断言，已按失败处理以免静默假绿）' };
}

module.exports = { runStep, runAssert, noteToolIssue };
