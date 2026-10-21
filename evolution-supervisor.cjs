'use strict';
/**
 * evolution-supervisor.cjs —— 不偷懒监督器 ·宿主接线层（v1.5.0）
 * ============================================================================
 *  作用：把 plugins/anti-lazy-supervisor/ 的闭环能力接给 verify.cjs 消费。
 *
 *  与 evolution-host.cjs 的关系：
 *    evolution-host.cjs    —— agent-evolution 接入层（G/P/I 信号、账本、审计）
 *    本文件                 —— anti-lazy-supervisor 接入层（追问、对账、门禁）
 *  两者同构：都只消费、不重造通道，都 fail-open。
 *
 *  ⚠ fail-open 原则（与宿主 tap* 一致）：
 *    插件缺失 / 加载失败 / 任何内部异常 → 返回 {enabled:false}，
 *    verify.cjs 据此**完全不注入、不拦截**，宿主行为与接入前逐字节相同。
 *    监督器出问题，不能让被验证的流程崩溃。
 *
 *  用法：
 *    const sup = require('./evolution-supervisor.cjs');
 *    const st = sup.start({ initial: ['登录流程'], host });
 *    sup.answer(st, category, items);
 *    sup.seal(st);
 *    const supView = sup.finalize(st, { claimed, skipNotes });
 *    // → { enabled, block, banner, blocked, verdict }
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');

const PLUGIN_DIR = path.join(__dirname, 'plugins', 'anti-lazy-supervisor');

function loadCore() {
  try {
    return require(path.join(PLUGIN_DIR, 'reconcile-core.cjs'));
  } catch (_) {
    return null;
  }
}

function getDataDir(host) {
  try {
    if (host && host.status && host.status()) {
      const s = host.status();
      if (s && s.dataDir) return s.dataDir;
    }
  } catch (_) { /* 拿不到就用默认 */ }
  return path.join(__dirname, '.evolution');
}

/**
 * 开始一次追问会话。
 * @param {object} opts
 *   initial : string[]  初始验证计划
 *   host    : object    evolution-host.cjs 模块（可传，缺失则不写 tapPlan）
 *   enable  : boolean   默认 **false** —— 监督默认关闭，由使用者显式开启。
 *              理由：它会改变报告内容与落盘行为，属于使用者决策而非默认行为。
 * @returns session 或 {enabled:false, reason}
 */
function start(opts) {
  const o = opts || {};
  try {
    // ⚠ 必须 **显式 enable:true** 才开。写成 `o.enable === false` 会让
    //   「不传 enable」也走到开启分支 —— 默认关闭形同虚设
    //   （实测踩过：start({initial:['x']}) 未带 enable 却返回 __enabled:true）。
    if (o.enable !== true) return { enabled: false, reason: 'disabled_by_default' };
    const core = loadCore();
    if (!core) return { enabled: false, reason: 'plugin_missing' };

    const host = o.host || null;
    const s = core.createQuestioning({ initial: o.initial || [], host });
    s.__enabled = true;
    s.__dataDir = getDataDir(host);
    return s;
  } catch (e) {
    return { enabled: false, reason: String(e && e.message || e) };
  }
}

/** 记录一轮追问答案 */
function answer(session, category, items) {
  try {
    if (!session || !session.__enabled) return { enabled: false, accepted: 0 };
    const core = loadCore();
    if (!core) return { enabled: false, accepted: 0 };
    return core.submitAnswer(session, category, items);
  } catch (_) {
    return { enabled: false, accepted: 0 };
  }
}

/** 追问是否还有下一题 */
function nextQuestion(session) {
  try {
    if (!session || !session.__enabled) return null;
    const core = loadCore();
    return core ? core.nextQuestion(session) : null;
  } catch (_) {
    return null;
  }
}

/** 收敛并把契约写入宿主 tapPlan */
function seal(session) {
  try {
    if (!session || !session.__enabled) return { enabled: false, written: 0 };
    const core = loadCore();
    return core ? core.sealQuestioning(session) : { enabled: false, written: 0 };
  } catch (_) {
    return { enabled: false, written: 0 };
  }
}

/**
 * 结束：对账 + 门禁，产出 verify.cjs 直接消费的结构。
 * @returns {enabled, block, banner, blocked, verdict, recon}
 */
function finalize(session, opts) {
  try {
    if (!session || !session.__enabled) {
      return { enabled: false, reason: 'not_started' };
    }
    const core = loadCore();
    if (!core) return { enabled: false, reason: 'plugin_missing' };

    const o = opts || {};
    const execLog = core.readExecutionLog(session.__dataDir || getDataDir(null));
    const recon = core.reconcile(session, execLog, {
      claimed: o.claimed || {},
      skipNotes: o.skipNotes || {},
    });
    const g = core.gate(session, recon);

    return {
      enabled: true,
      verdict: g.verdict,
      blocked: !g.allow,
      banner: g.banner,
      block: g.block,
      recon,
    };
  } catch (e) {
    // fail-open：监督自身异常 → 不注入不拦截，宿主行为不变
    return { enabled: false, reason: String(e && e.message || e) };
  }
}

/** 只检测对话偷懒（复用 drivers 版），失败同样降级 */
function watchTurn(input) {
  try {
    const mod = require(path.join(__dirname, 'drivers', 'no-lazy-supervisor.cjs'));
    return mod.watchTurn(input || {});
  } catch (_) {
    return { ok: false, reason: 'driver_missing', flagged: [] };
  }
}

/** 状态自检：插件是否可用（供 verify.cjs 或人工查询） */
function status() {
  const core = loadCore();
  return {
    ok: true,
    pluginPresent: !!core,
    driverPresent: fs.existsSync(path.join(__dirname, 'drivers', 'no-lazy-supervisor.cjs')),
    categories: core ? core.CATEGORIES.map((c) => c.name) : [],
    limits: core ? core.DEFAULT_LIMITS : null,
    note: '默认关闭；需 start({enable:true}) 才会影响报告',
  };
}

module.exports = { start, answer, nextQuestion, seal, finalize, watchTurn, status };
