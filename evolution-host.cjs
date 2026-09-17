'use strict';
/**
 * @module evolution-host
 * @layer 宿主接入层（turnkey 脚手架）
 *
 * 任意新项目接入 agent-evolution 只需三步：
 *   1. 把本文件 + evolution.yaml + seeds/ 放进项目根
 *   2. 在入口/构建脚本里 require 本文件并 init()
 *   3. 在报错点调用 evo.tapError(err) / evo.tapToolResult(res)
 *
 * 内核/引擎解析顺序（无需手写接线）：
 *   - 引擎：ENV EVOLUTION_ENGINE_PATH > 项目内 lib/evolution-engine/engine.cjs
 *   - 内核：ENV EVOLUTION_KERNEL_ROOT > evolution.yaml 的 kernel.kernelRoot > 引擎内置共享内核
 *
 * 失败全部 fail-open：引擎未就绪时所有方法返回 { ok:false } 且不抛，宿主主流程不受影响。
 */

const path = require('node:path');
const fs = require('node:fs');

let _engine = null;
let _tapHelpers = null;

/** 解析引擎模块路径 */
function resolveEnginePath() {
  if (process.env.EVOLUTION_ENGINE_PATH) return process.env.EVOLUTION_ENGINE_PATH;
  const vendored = path.join(__dirname, 'lib', 'evolution-engine', 'engine.cjs');
  if (fs.existsSync(vendored)) return vendored;
  throw new Error(
    '[evolution-host] 未找到 evolution-engine：请 vendor 到 lib/evolution-engine/engine.cjs，或设置 ENV EVOLUTION_ENGINE_PATH'
  );
}

/**
 * 初始化（幂等）。可多次调用以覆盖 opts。
 * @param {object} [opts]
 * @param {string} [opts.yamlPath] - evolution.yaml 路径（缺省 = 同目录 evolution.yaml）
 * @param {string} [opts.rootDir] - 宿主根目录（缺省 = yaml 所在目录）
 * @param {string} [opts.kernelRoot] - 内核目录（可经 ENV EVOLUTION_KERNEL_ROOT 覆盖）
 * @param {boolean} [opts.autoStart] - 是否立即启动周期分析调度（analyze.intervalMs）
 * @param {number} [opts.autoStartMs] - 覆盖调度间隔
 */
function init(opts = {}) {
  const yamlPath = opts.yamlPath || path.join(__dirname, 'evolution.yaml');
  const enginePath = resolveEnginePath();
  const { load } = require(enginePath);
  // 生成式候选生成器：让 runCycle 对新错误【现场推断】解法，而非只匹配 seeds 里的人工骨架。
  // 加载失败 / 未导出函数 → 传 undefined → 引擎回落内置种子匹配器（向后兼容 + fail-open）。
  let candGen;
  try {
    const mod = require('./evolution-candidate-gen.cjs');
    candGen = typeof mod === 'function' ? mod : (mod && mod.generate);
  } catch (_e) { candGen = undefined; }
  if (typeof candGen !== 'function') candGen = undefined;
  _engine = load(yamlPath, {
    rootDir: opts.rootDir || path.dirname(path.resolve(yamlPath)),
    kernelRoot: opts.kernelRoot || process.env.EVOLUTION_KERNEL_ROOT || undefined,
    candidateGenerator: opts.candidateGenerator || candGen,
  });
  _tapHelpers = require('./tap-helpers.cjs');
  if (opts.autoStart) start(opts.autoStartMs);
  return _engine;
}

/** 取已初始化的引擎 handle（未 init 抛错） */
function engine() {
  if (!_engine) throw new Error('[evolution-host] 尚未 init()，请先调用 init()');
  return _engine;
}

/** 引擎是否就绪（enabled 且未降级） */
function ready() {
  try {
    return !!_engine && _engine.isEnabled();
  } catch (_e) {
    return false;
  }
}

/**
 * 通用错误 tap：接受 Error / string / 含 message 的对象，归一为 E 类信号。
 * 这是宿主接入最低成本入口——直接把 catch 到的 err 喂进来即可。
 * @param {Error|string|object} err
 * @param {object} [ctx] { taskId, source }
 */
function tapError(err, ctx = {}) {
  if (!ready()) return { ok: false, reason: 'not_ready' };
  try {
    const e = err || {};
    const title = String(e.message || e.code || (typeof err === 'string' ? err : 'unknown error')).slice(0, 300);
    const detail = String(e.stack || (typeof err === 'string' ? err : JSON.stringify(err))).slice(0, 2000);
    return engine().tapE({ title, detail, taskId: ctx.taskId || '', source: ctx.source || 'host' });
  } catch (_e) {
    return { ok: false, reason: 'error' };
  }
}

/**
 * 工具/命令结果 tap：传入执行结果对象，按约定字段判定是否失败并 tap。
 * 约定：{ ok:false, error } / { exitCode:非0 } / { stderr } 视为失败。
 * 返回 null 表示未触发 tap（结果成功或无法判定）。
 */
function tapToolResult(res, ctx = {}) {
  if (!ready()) return { ok: false, reason: 'not_ready' };
  try {
    const r = res || {};
    const failed =
      r.ok === false ||
      (typeof r.exitCode === 'number' && r.exitCode !== 0) ||
      (typeof r.code === 'number' && r.code !== 0) ||
      (typeof r.stderr === 'string' && r.stderr.trim().length > 0 && r.ok === undefined);
    if (!failed) return null;
    const title = String(r.error || r.stderr || r.message || 'tool_result_failure').slice(0, 300);
    return engine().tapE({ title, detail: String(JSON.stringify(r)).slice(0, 2000), taskId: ctx.taskId || '', source: ctx.source || 'tool' });
  } catch (_e) {
    return { ok: false, reason: 'error' };
  }
}

/**
 * G 类 tap：期望落差（用户要点未满足 / 显式纠错 / 报告与预期不符 / 断言 FAIL 但被人工判可接受）。
 * 转发到引擎 tapExpectation（写 expectation 账本 + 落 G 信号镜像）。
 */
function tapExpectation(title, detail = '', ctx = {}) {
  if (!ready()) return { ok: false, reason: 'not_ready' };
  try {
    return engine().tapExpectation({ title: String(title), detail: String(detail || ''), taskId: ctx.taskId || '', ttlMs: ctx.ttlMs, source: ctx.source || 'host' });
  } catch (_e) {
    return { ok: false, reason: 'error' };
  }
}

/**
 * P 类 tap：计划偏离（声明步骤 vs 实际执行轨迹）。
 * 转发到引擎 tapPlan（写 plan 账本 + 落 P 信号镜像）。
 */
function tapPlan(title, detail = '', ctx = {}) {
  if (!ready()) return { ok: false, reason: 'not_ready' };
  try {
    return engine().tapPlan({ title: String(title), detail: String(detail || ''), taskId: ctx.taskId || '', ttlMs: ctx.ttlMs, source: ctx.source || 'host' });
  } catch (_e) {
    return { ok: false, reason: 'error' };
  }
}

/**
 * I 类 tap：悬挂未完结（open 承诺超期；默认人审）。
 * 转发到引擎 tapHanging（写 thread 账本 + 落 I 信号镜像）。
 */
function tapHanging(title, detail = '', ctx = {}) {
  if (!ready()) return { ok: false, reason: 'not_ready' };
  try {
    return engine().tapHanging({ title: String(title), detail: String(detail || ''), taskId: ctx.taskId || '', ttlMs: ctx.ttlMs, source: ctx.source || 'host' });
  } catch (_e) {
    return { ok: false, reason: 'error' };
  }
}

/** 长任务开始：开 thread 账本（超期未闭合 → 内核 emit I + 落 I 镜像） */
function openThread(title, detail = '', ctx = {}) {
  if (!ready()) return { ok: false, reason: 'not_ready' };
  return engine().openThread({ title: String(title), detail: String(detail || ''), taskId: ctx.taskId || '', ttlMs: ctx.ttlMs });
}

/** 长任务结束：闭合 thread 账本（在 ttlMs 内收尾则正常闭合，不产出 I 信号） */
function closeThread(threadId, outcome) {
  if (!ready()) return { ok: false, reason: 'not_ready' };
  return engine().closeThread(threadId, outcome || null);
}

/** 启动周期自动分析（内核 analyze 调度；依赖 yaml 的 analyze.intervalMs 或 autoStartMs） */
function start(intervalMs) {
  if (!ready()) return { ok: false, reason: 'not_ready' };
  return engine().startAutoAnalyze({ intervalMs });
}

/** 停止周期自动分析 */
function stop() {
  if (!_engine) return { ok: false, reason: 'not_ready' };
  return engine().stopAutoAnalyze();
}

/** 手动跑一轮八步链路 */
async function runCycle() {
  if (!ready()) return { ok: false, reason: 'not_ready' };
  return engine().runCycle();
}

/** 读取当前知识面广角（playbook）：返回各白名单文件行数 + 解析行 */
function playbook() {
  if (!ready()) return [];
  return engine().listKnowledge();
}

/** 触发一次在报错点前的快照（关键文件保护） */
function checkpoint(files, label) {
  if (!ready()) return { ok: false, reason: 'not_ready' };
  return engine().checkpoint(label || 'host-checkpoint', files || []);
}

/** 行为纠偏上报（用户对输出的显式反馈） */
function tapBehavior(input) {
  if (!ready()) return { ok: false, reason: 'not_ready' };
  return engine().tapBehavior(input);
}

/** 只读状态（供宿主在 /status 或日志里展示） */
function status() {
  if (!_engine) return { ok: false, reason: 'not_initialized' };
  return engine().status();
}

/**
 * 读侧闭环：把 G/P/I 落差 + 外部解法 读回来，供宿主回显/改行为（避免只写不读）。
 * 数据源与引擎写入同源：signals.jsonl（落差信号镜像）/ status（未收尾账本）/ reports.jsonl（落地面）+ 资源层（外部解法）。
 * @returns {{ok:boolean, gaps:{G:number,P:number,I:number}, open:{expectation:number,plan:number,thread:number}, solutions:Array<{fingerprint:string,title:string,content:string}>}} 未就绪/异常返回 {ok:false}
 */
async function advisory() {
  if (!ready()) return { ok: false, reason: 'not_ready' };
  try {
    const st = engine().status();
    const dir = st && st.dataDir ? st.dataDir : '';
    const gaps = { G: 0, P: 0, I: 0 };
    const sigFile = dir ? path.join(dir, 'signals', 'signals.jsonl') : '';
    if (sigFile && fs.existsSync(sigFile)) {
      for (const line of fs.readFileSync(sigFile, 'utf8').split(/\r?\n/)) {
        const t = line.trim(); if (!t) continue;
        let r; try { r = JSON.parse(t); } catch (_e) { continue; }
        if (r && gaps[r.type] !== undefined) gaps[r.type] += 1;
      }
    }
    const open = {
      expectation: (st && st.expectationGaps) || 0,
      plan: (st && st.planDeviations) || 0,
      thread: (st && st.openThreads) || 0,
    };
    const solutions = [];
    const seen = new Set();
    const res = (engine().state && engine().state().resources) || null;
    if (res && typeof res.querySolutions === 'function' && dir) {
      const fps = new Set();
      const repFile = path.join(dir, 'reports', 'reports.jsonl');
      if (fs.existsSync(repFile)) {
        const lines = fs.readFileSync(repFile, 'utf8').trim().split(/\r?\n/).filter(Boolean);
        const last = lines.length ? JSON.parse(lines[lines.length - 1]) : null;
        if (last && Array.isArray(last.decisions)) {
          for (const d of last.decisions) {
            if (!d || (d.action !== 'land' && d.action !== 'land_report') || !d.fingerprint) continue;
            fps.add(d.fingerprint);
          }
        }
      }
      const sigFile = path.join(dir, 'signals', 'signals.jsonl');
      if (fs.existsSync(sigFile)) {
        for (const line of fs.readFileSync(sigFile, 'utf8').split(/\r?\n/)) {
          const t = line.trim(); if (!t) continue;
          let r; try { r = JSON.parse(t); } catch (_e) { continue; }
          if (r && r.fingerprint) fps.add(r.fingerprint);
        }
      }
      for (const fp of fps) {
        const hits = await res.querySolutions({ fingerprint: fp }) || [];
        for (const h of hits) {
          const key = fp + '\u0001' + (h.title || '');
          if (seen.has(key)) continue;
          seen.add(key);
          solutions.push({ fingerprint: fp, title: h.title || '', content: h.content || '' });
        }
      }
    }
    return { ok: true, gaps, open, solutions };
  } catch (_e) {
    return { ok: false, reason: 'error' };
  }
}

/**
 * 读取引擎已学习的"复发错误"（按内核 fingerprint 聚合；同指纹=同类问题）。
 * 行为闭环的**读取侧**——宿主据此决定是否在风险动作前做自愈预检。
 * @param {object} [opts] { minHits } 最少复发次数，默认 1
 * @returns {Array<{fingerprint,type,count,title,lastTs}>} 按复发次数降序；未就绪/异常返回 []
 */
function recurringErrors(opts = {}) {
  if (!ready()) return [];
  const minHits = Math.max(1, Number(opts.minHits) || 1);
  try {
    const dir = (status().dataDir) || '';
    if (!dir) return [];
    const file = path.join(dir, 'signals', 'signals.jsonl');
    if (!fs.existsSync(file)) return [];
    const map = new Map();
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const t = line.trim();
      if (!t) continue;
      let r; try { r = JSON.parse(t); } catch (_e) { continue; }
      const fp = r && r.fingerprint;
      if (!fp) continue;
      const g = map.get(fp) || { fingerprint: fp, type: r.type || '', count: 0, title: r.title || '', lastTs: r.ts || '' };
      g.count += 1;
      if (r.ts && r.ts > g.lastTs) g.lastTs = r.ts;
      if (r.title) g.title = r.title;
      map.set(fp, g);
    }
    return Array.from(map.values()).filter((g) => g.count >= minHits).sort((a, b) => b.count - a.count);
  } catch (_e) {
    return [];
  }
}

/** pre_action 前置查询（读取侧）：返回引擎对某动作的已知经验/拦截建议（fail-open） */
function preActionGate(ctx = {}) {
  try {
    if (!ready()) return { ok: false, reason: 'not_ready', intercept: false };
    return engine().preActionGate(ctx);
  } catch (_e) {
    return { ok: false, reason: 'error', intercept: false };
  }
}

/** 出口选择环：回写一次条目考核结论（可选增强；fail-open） */
function reportOutcome(p = {}) {
  try {
    if (!ready()) return { ok: false, reason: 'not_ready' };
    return engine().reportOutcome(p);
  } catch (_e) {
    return { ok: false, reason: 'error' };
  }
}

/**
 * 复发哨兵：找出"已被 land 但仍在复发 / 被反复 land"的指纹 → 判定候选无效（loop 空转自检）。
 * 读 <dataDir>/signals/signals.jsonl（fp,ts,title）与 <dataDir>/reports/reports.jsonl（decisions）。
 * 空转判据（任一命中）：
 *   ① 同一指纹被 land ≥2 次 —— 反复落地 = 前次候选没能止住；
 *   ② 首次 land 之后该指纹仍复发 ≥ minRecur 次。
 * 尽力回写：对被取代的旧候选 + 落地后仍复发的候选调内核 recordVeto
 * （同候选对同指纹被否 ≥2 次 → 黑名单，选优时排除）。
 * @param {object} [opts] { minRecur } 首次 land 后至少复现几次才判无效，默认 1
 * @returns {{stale:Array, vetoed:number, checked:number}} 未就绪/异常返回空
 */
function recurrenceSentinel(opts = {}) {
  const empty = { stale: [], vetoed: 0, checked: 0 };
  if (!ready()) return empty;
  const minRecur = Math.max(1, Number(opts.minRecur) || 1);
  try {
    const dir = (status().dataDir) || '';
    if (!dir) return empty;
    const sigFile = path.join(dir, 'signals', 'signals.jsonl');
    const repFile = path.join(dir, 'reports', 'reports.jsonl');
    if (!fs.existsSync(sigFile) || !fs.existsSync(repFile)) return empty;

    const sigs = [];
    for (const line of fs.readFileSync(sigFile, 'utf8').split(/\r?\n/)) {
      const t = line.trim(); if (!t) continue;
      let r; try { r = JSON.parse(t); } catch (_e) { continue; }
      if (r && r.fingerprint) sigs.push({ fp: r.fingerprint, ts: r.ts || '', title: r.title || '' });
    }
    // 收集每个指纹的"全部 land 事件"：同一指纹被 land ≥2 次 = 前次候选没止住（核心空转信号）
    const lands = new Map(); // fp -> [{ts,version,candidateId}]
    for (const line of fs.readFileSync(repFile, 'utf8').split(/\r?\n/)) {
      const t = line.trim(); if (!t) continue;
      let r; try { r = JSON.parse(t); } catch (_e) { continue; }
      const ts = r && r.ts; if (!ts) continue;
      for (const d of (r.decisions || [])) {
        if (!d || !d.fingerprint) continue;
        if (d.action !== 'land' && d.action !== 'land_report') continue;
        if (!lands.has(d.fingerprint)) lands.set(d.fingerprint, []);
        lands.get(d.fingerprint).push({ ts, version: d.version || '', candidateId: d.candidate_id || '' });
      }
    }
    const stale = [];
    for (const [fp, evs] of lands) {
      evs.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
      const firstLand = evs[0].ts;
      const lastLand = evs[evs.length - 1].ts;
      const afterFirst = sigs.filter((s) => s.fp === fp && s.ts > firstLand);
      const afterLast = sigs.filter((s) => s.fp === fp && s.ts > lastLand);
      // 空转判据：① 同一指纹被反复 land（≥2 次 → 前次候选无效）；② 首次落地后仍复发 ≥ minRecur
      if (evs.length >= 2 || afterFirst.length >= minRecur) {
        const last = afterFirst[afterFirst.length - 1] || sigs.filter((s) => s.fp === fp).slice(-1)[0] || {};
        stale.push({
          fingerprint: fp, title: last.title || '',
          landTs: lastLand, firstLandTs: firstLand, version: evs[evs.length - 1].version,
          candidateId: evs[evs.length - 1].candidateId,
          landCount: evs.length,
          recursAfter: afterFirst.length,        // 首次落地后仍复发数（"没止住"的强度）
          recursAfterLast: afterLast.length,
          staleCandidates: evs.slice(0, -1).map((e) => e.candidateId).filter(Boolean), // 被后续 land 取代 = 无效
        });
      }
    }
    let vetoed = 0;
    try {
      const k = engine().state && engine().state().kernel;
      if (k && typeof k.recordVeto === 'function') {
        for (const s of stale) {
          // 否决：被重复 land 取代的旧候选 + 落地后仍复发的最终候选
          const ids = new Set([...(s.staleCandidates || []), s.candidateId].filter(Boolean));
          for (const cid of ids) {
            k.recordVeto(s.fingerprint, cid, {
              reason: 'recurrence-sentinel: landed ' + s.landCount + 'x, still recurring ' + s.recursAfter + 'x after first land',
              source: 'host',
            });
            vetoed += 1;
          }
        }
      }
    } catch (_e) { /* 回写失败不影响检测 */ }
    return { stale, vetoed, checked: lands.size };
  } catch (_e) {
    return empty;
  }
}

module.exports = {
  init,
  engine,
  ready,
  tapError,
  tapToolResult,
  tapExpectation,
  tapPlan,
  tapHanging,
  openThread,
  closeThread,
  start,
  stop,
  runCycle,
  playbook,
  checkpoint,
  tapBehavior,
  status,
  advisory,
  recurringErrors,
  preActionGate,
  reportOutcome,
  recurrenceSentinel,
  _tapHelpers: () => _tapHelpers,
};
