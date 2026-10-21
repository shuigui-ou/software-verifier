'use strict';
/**
 * no-lazy-supervisor.cjs —— 不偷懒监督器（software-verifier 插件）
 * ============================================================================
 *  作用：监督 AI 是否「偷懒」，把检出的问题**转发到宿主既有的
 *        P 类（计划偏离）/ I 类（悬挂未完结）通道**，进内核账本与审计。
 *
 *  设计立场（重要，先读）：
 *  1. **不重复造轮子**。宿主已有 tapPlan / tapHanging（evolution-host.cjs）
 *     与 kernel 的 plan/thread 账本。本插件只做「**自动检测**」——
 *     那些原本要靠人或宿主自觉上报的问题，这里在每轮自动比对并上报。
 *     发明新通道 = 绕过宿主内核的审计与账本，属于破坏而非增强。
 *  2. **绝不干扰宿主主流程**。与宿主 tap* 一致：任何内部异常都被吞掉，
 *     返回 {ok:false, reason:'supervisor_error'}，绝不 throw。
 *     这是插件的红线：监督器出问题不能让被监督者崩溃。
 *  3. **只做有客观判据的检查**，不判断回答质量。
 *     「太浅」「不够深入」无客观阈值，量化它只是注入主观偏见。
 *
 *  检测四类（有机械判据）：
 *    B 契约未完成  → tapPlan  （声明的步骤没全做）
 *    C 承诺未兑现  → tapHanging（说了要做，本轮没做）
 *    D 趋同化      → tapPlan  （与上一轮高度雷同 = 原地踏步）
 *    E 免责搪塞    → 默认关闭（易误伤「诚实澄清」）
 *
 *  用法：
 *    const sup = require('./drivers/no-lazy-supervisor.cjs');
 *    sup.watchTurn({ reply, prevReply, contract, taskId });
 *    // → { ok, flagged: [...], report: {...} }
 *
 *  零依赖，纯 CommonJS。宿主未 init 时自动降级为「本地记录、不上报」。
 * ============================================================================
 */

const HOST = require('../evolution-host.cjs');

// ── 词表 ──────────────────────────────────────────────────────
// 承诺词：说了"稍后/接下来"但本轮没实际动作
const PROMISE_MARKERS = [
  '稍后', '待会', '接下来我会', '接下来我', '我会', '我将', '下面我会',
  '下面我', '后续会', '回头',
];

// 澄清标记：明确指出缺信息 → 诚实澄清，不算搪塞（实测关键区分）
const CLARIFY_MARKERS = [
  '没有看到', '未提供', '请提供', '能否提供', '麻烦提供', '没有给',
  '未给出', '缺少', '需要你提供', '方便提供', '请把', '请贴', '发我',
];

// 免责搪塞句式（默认关闭）
const FILLER_PATTERNS = [
  /一般来说[，,]/, /通常(建议|来说|情况下)/, /具体情况(具体分析|要看)/,
  /因人而异/, /没有(标准|统一)的(答案|做法|方案)/,
  /这是一个(很)?(复杂|广泛)的(问题|话题)/, /需要(根据|结合)(具体|实际)情况/,
];

// ── 工具函数 ──────────────────────────────────────────────────
function bigrams(text) {
  const t = String(text || '');
  const out = new Set();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
}

function hasConcreteOutput(text) {
  const t = String(text || '');
  // 长度门槛实测定的：80 太死（76 字的「三条结论」被误判没干活）→ 50
  if (t.length < 50) return false;
  return /\d{2,}|```|[-*]\s|\d+\.|第[一二三四五六七八九十]|：/.test(t);
}

/** 2-gram Dice 相似度：趋同化判据 */
function similarity(a, b) {
  const A = bigrams(a);
  const B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return (2 * inter) / (A.size + B.size);
}

// ── 四类检查（各自独立，便于单测）──────────────────────────────
function checkContract(reply, contract) {
  if (!Array.isArray(contract) || !contract.length) {
    return { hit: false, missing: [], reason: '未设契约，跳过' };
  }
  const low = String(reply || '').toLowerCase();
  const missing = contract
    .map((c) => String(c).trim().toLowerCase())
    .filter(Boolean)
    .filter((c) => !low.includes(c));
  return {
    hit: missing.length > 0,
    missing,
    reason: missing.length
      ? `任务契约未完成：缺少 ${missing.join('、')}`
      : '契约已覆盖',
  };
}

function checkPromise(reply) {
  const t = String(reply || '');
  const low = t.toLowerCase();
  const promised = PROMISE_MARKERS.some((m) => low.includes(m));
  if (!promised) return { hit: false, promised: false, reason: '无承诺' };
  // ⚠ 不能只看「是否出现动作词」：「稍后我会把完整的分析报告发给你」
  //   含「分析」，但那只是承诺里提到报告，本轮一字未干。改为要求实质产出。
  if (!hasConcreteOutput(t)) {
    return { hit: true, promised: true, reason: '本轮只做承诺、无实质产出' };
  }
  return { hit: false, promised: true, reason: '有承诺也有实质产出' };
}

function checkRepetition(reply, prevReply, threshold) {
  if (!prevReply) return { hit: false, similarity: null, reason: '无上一轮可比' };
  const sim = similarity(reply, prevReply);
  return {
    hit: sim >= threshold,
    similarity: Number(sim.toFixed(3)),
    reason: `与上一轮相似度 ${sim.toFixed(2)}（阈值 ${threshold}）`,
  };
}

function checkFiller(reply, enabled) {
  if (!enabled) return { hit: false, reason: '搪塞检测未启用' };
  const t = String(reply || '');
  const low = t.toLowerCase();
  if (CLARIFY_MARKERS.some((m) => low.includes(m))) {
    return { hit: false, reason: '属于诚实澄清，非搪塞' };
  }
  const hits = FILLER_PATTERNS.filter((re) => re.test(low));
  // 命中 ≥1 条 **且** 全文无具体产出才判搪塞
  if (hits.length && !hasConcreteOutput(t)) {
    return { hit: true, reason: `泛泛搪塞且无具体产出（命中 ${hits.length} 类句式）` };
  }
  return { hit: false, reason: hits.length ? '有具体产出，句式不算搪塞' : '无搪塞' };
}

// ── 上报（全部 try/catch，绝不抛出）────────────────────────────
function reportPlan(title, detail, taskId) {
  try {
    if (!HOST.ready()) return { ok: false, reason: 'host_not_ready' };
    return HOST.tapPlan(title, detail, { taskId: taskId || '' });
  } catch (e) {
    return { ok: false, reason: 'supervisor_error', detail: String(e && e.message || e) };
  }
}

function reportHanging(title, detail, taskId) {
  try {
    if (!HOST.ready()) return { ok: false, reason: 'host_not_ready' };
    return HOST.tapHanging(title, detail, { taskId: taskId || '' });
  } catch (e) {
    return { ok: false, reason: 'supervisor_error', detail: String(e && e.message || e) };
  }
}

// ── 主入口 ────────────────────────────────────────────────────
const DEFAULTS = {
  repetitionThreshold: 0.6,
  enableFiller: false,      // 默认关闭：易误伤「诚实澄清」
  autoReport: true,         // true=自动上报内核；false=只返回报告不写账本
  maxReportPerTurn: 2,      // 单轮最多上报几条，避免刷屏
};

let cfg = Object.assign({}, DEFAULTS);
const history = { lastReply: '', turns: 0, flaggedTotal: 0 };

/** 读配置（宿主可覆盖） */
function configure(opts) {
  try {
    cfg = Object.assign({}, DEFAULTS, cfg, opts || {});
    return { ok: true, config: cfg };
  } catch (e) {
    return { ok: false, reason: 'bad_config' };
  }
}

/**
 * 监督一轮对话。
 * @param {object} input
 *   reply        {string} 必填 —— 本轮 AI 回复
 *   prevReply    {string} 可选 —— 上一轮回复（用于趋同化）
 *   contract     {string[]} 可选 —— 本轮任务契约锚点
 *   taskId       {string} 可选
 * @returns {{ok:boolean, flagged:Array, report:object}}
 */
function watchTurn(input) {
  // 顶层兜底：本函数**永不抛错**（宿主红线）
  try {
    const { reply, prevReply, contract, taskId } = input || {};
    if (typeof reply !== 'string' || !reply.trim()) {
      return { ok: false, reason: 'empty_reply', flagged: [], report: {} };
    }

    const c = checkContract(reply, contract);
    const p = checkPromise(reply);
    const r = checkRepetition(reply, prevReply, cfg.repetitionThreshold);
    const f = checkFiller(reply, cfg.enableFiller);

    const flagged = [];
    if (c.hit) flagged.push({ type: 'contract', reason: c.reason, missing: c.missing });
    if (p.hit) flagged.push({ type: 'promise', reason: p.reason });
    if (r.hit) flagged.push({ type: 'repetition', reason: r.reason, similarity: r.similarity });
    if (f.hit) flagged.push({ type: 'filler', reason: f.reason });

    const report = {
      turn: history.turns + 1,
      flagged,
      checks: {
        contract: c, promise: p, repetition: r, filler: f,
      },
    };

    // 上报内核（映射到宿主既有通道，不新建）
    const reported = [];
    if (flagged.length && cfg.autoReport) {
      const slice = flagged.slice(0, Math.max(1, cfg.maxReportPerTurn));
      for (const item of slice) {
        const title = `[不偷懒] ${item.type}`;
        const detail = item.reason + (item.missing ? ` | 缺：${item.missing.join('、')}` : '');
        // 承诺未兑现 → I 类（悬挂）；其余 → P 类（计划偏离）
        const res = item.type === 'promise'
          ? reportHanging(title, detail, taskId)
          : reportPlan(title, detail, taskId);
        reported.push({ type: item.type, ...res });
      }
    }
    report.reported = reported;

    history.turns += 1;
    history.flaggedTotal += flagged.length;
    history.lastReply = reply;

    return { ok: true, flagged, report };
  } catch (e) {
    // 兜底：绝不让监督器把宿主带崩
    return {
      ok: false, reason: 'supervisor_error',
      detail: String(e && e.message || e), flagged: [], report: {},
    };
  }
}

/**
 * 只检测不上报（用于 dry-run / 评估误伤率）。
 *
 * 参数兼容两种写法（实测踩过：签名与用法不一致导致全 pass，
 * 看起来像「功能没生效」，实则是传参错了）：
 *   analyze('回复文本')                       —— 简写
 *   analyze({ reply, prevReply, contract })    —— 完整
 *   analyze('回复文本', { prevReply })         —— 混合
 */
function analyze(replyOrInput, opts) {
  const prev = cfg.autoReport;
  cfg.autoReport = false;
  try {
    let input;
    if (replyOrInput && typeof replyOrInput === 'object') {
      input = Object.assign({}, opts || {}, replyOrInput);
    } else {
      input = Object.assign({}, opts || {}, { reply: replyOrInput });
    }
    return watchTurn(input);
  } finally {
    cfg.autoReport = prev;
  }
}

function reset() {
  history.lastReply = '';
  history.turns = 0;
  history.flaggedTotal = 0;
}

function status() {
  try {
    return {
      ok: true,
      turns: history.turns,
      flaggedTotal: history.flaggedTotal,
      hostReady: (() => { try { return !!HOST.ready(); } catch (_) { return false; } })(),
      config: Object.assign({}, cfg),
    };
  } catch (e) {
    return { ok: false, reason: 'supervisor_error' };
  }
}

module.exports = {
  watchTurn,
  analyze,
  configure,
  reset,
  status,
  // 导出内部检查函数供单测
  _internal: {
    checkContract, checkPromise, checkRepetition, checkFiller,
    similarity, hasConcreteOutput,
  },
  DEFAULTS,
};

// 直接执行时打印自检结果（便于验证插件是否可用）
if (require.main === module) {
  const c = new module.exports._internal.constructor; // 保持 require 安全
  void c;
  const I = module.exports._internal;
  console.log('[不偷懒监督器] 自检');
  console.log('  契约：只做1步 →', I.checkContract('好的，我来帮你分析这个问题。', ['分析', '方案', '代码']).hit ? '拦' : '放');
  console.log('  承诺：稍后再说 →', I.checkPromise('稍后我会把完整报告发给你。').hit ? '拦' : '放');
  console.log('  趋同：复制上轮 →', I.checkRepetition('abcabc', 'abcabc', 0.6).hit ? '拦' : '放');
  console.log('  诚实澄清 →', I.checkFiller('请把代码贴出来，目前消息中没有看到代码。', true).hit ? '拦' : '放');
  console.log('  宿主就绪 →', module.exports.status().hostReady);
}
