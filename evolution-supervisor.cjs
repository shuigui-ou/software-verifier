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
 *   enable  : boolean   默认 **true**（与宿主 evolution.yaml 的 enabled:true 一致）。
 *              传 false 可显式关闭。安全由「未声明契约不介入」保证，而非默认关。
 * @returns session 或 {enabled:false, reason}
 */
function start(opts) {
  const o = opts || {};
  try {
    // ── 默认开启（2026-10-21 修正，此前是默认关闭）──────────────────
    // 为什么改：宿主 evolution.yaml 对内核是 `enabled: true`，
    //   插件却默认关闭 = **装了等于没装**。用户加了它却看不到任何效果，
    //   反而会得出「这东西没用」的结论 —— 那是最坏的结果。
    //
    // 安全性不靠「默认关」，而靠两道防线：
    //   ① 没起会话（session 为 null）→ 对账判 REJECT，绝不放行
    //   ② 起了会话但还没声明契约 → NOT_APPLICABLE，不拦
    //   换言之：**没声明过测试点就不介入，一旦声明就必须对账**。
    //   这才是符合直觉的语义，也与宿主惯例一致。
    //
    // 显式关闭仍然可用：enable: false。
    if (o.enable === false) return { enabled: false, reason: 'disabled_by_caller' };
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
    // ⚠ 2026-10-23 新增 resultPath 透传（靶子站端到端实测暴露的第二个接线缺口）：
    //   对账的执行证据主源是宿主写的 result.json，而此前这里只能「猜路径」
    //   （guessResultPath 只找 dataDir 及其上溯三层下的 verify_report/result.json 或 result.json）。
    //   verify.cjs 的 --out 可指定任意目录 → 猜不到 → execLog.results 为空 →
    //   每个契约都 hasExecLog=false → 哪怕全部跑过也全判 dangling → verdict=REJECT。
    //   症状与「验证器偷懒」完全一样，但根因是读不到证据 —— 必须让宿主显式告诉它证据在哪。
    const execLog = core.readExecutionLog(session.__dataDir || getDataDir(null), o.resultPath || null);
    const recon = core.reconcile(session, execLog, {
      claimed: o.claimed || {},
      skipNotes: o.skipNotes || {},
    });
    const g = core.gate(session, recon, { strict: !!o.strict });

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
    note: '默认开启；未声明契约时不介入。显式关闭用 enable:false',
  };
}

/**
 * 6 类覆盖检查（建议用 · v1.9.0 新增）。
 * 与 start/answer/finalize 等同构：只消费 core、fail-open、不重造通道。
 * ⚠ 覆盖缺口**绝不入契约**（机器猜的入契约 = 制造假 FAIL），只作为建议出口。
 * @returns {enabled:true, categories:[...]} 或 {enabled:false, reason}
 */
function coverage(session) {
  try {
    if (!session) return { enabled: false, reason: 'no_session' };
    const core = loadCore();
    if (!core || typeof core.suggestCoverage !== 'function') return { enabled: false, reason: 'plugin_missing' };
    const items = (session && session.items) || [];
    return { enabled: true, categories: core.suggestCoverage(items) };
  } catch (e) {
    return { enabled: false, reason: String((e && e.message) || e) };
  }
}

module.exports = { start, answer, nextQuestion, seal, finalize, coverage, watchTurn, status };
