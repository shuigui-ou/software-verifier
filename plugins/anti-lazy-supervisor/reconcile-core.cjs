'use strict';
/**
 * anti-lazy-supervisor · 对账内核
 * ============================================================================
 *  三阶段闭环：
 *    ① 追问扩容 Questioning  —— 逼验证器把"没想到要测"的说出口
 *    ② 硬对账   Reconciliation —— 拿契约对执行日志，抓造假与漏检
 *    ③ 门禁     Gating         —— 有漏检就 REJECT，并注入不可篡改区块
 *
 *  ── 红线（写进实现，不只是文档）─────────────────────────────
 *  1. **只信执行日志，不信口头声明。** 验证器说"测了"但日志无记录 → dangling。
 *     这是整个插件存在的理由：否则追问逼出的契约可以随口认领。
 *  2. **追问不能逼出编造。** 追问产出的每一项都必须经 phase2 对账，
 *     无日志的一律 dangling —— 追问只是"逼他说"，不是"信他说"。
 *  3. **跳过必须留痕。** skipped 必须带原因，无理由的跳过判 dangling。
 *  4. **不重造通道。** 契约走宿主既有 tapPlan/tapHanging，插件只消费。
 *  5. **绝不抛错。** 任何内部异常吞掉返回 {ok:false}，不中断宿主验证流程。
 *
 *  零依赖 · CommonJS
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');

// ── 类型分类（方案要求至少这6 类）──────────────────────────────
const CATEGORIES = [
  { key: 'input',       name: '输入边界',   probes: ['空值', '超长', '特殊字符', '负数', 'null/undefined'] },
  { key: 'state',       name: '状态转换',   probes: ['从A到B', '回退', '重入', '中间态'] },
  { key: 'concurrency', name: '并发/竞态',  probes: ['并发调用', '竞态条件', '重复提交', '锁'] },
  { key: 'error',       name: '异常/错误恢复', probes: ['抛异常', '超时', '重试', '降级'] },
  { key: 'performance', name: '性能/超时',  probes: ['响应时间', '大输入', '内存'] },
  { key: 'security',    name: '安全/注入',  probes: ['注入', '越权', '敏感信息泄露', '路径穿越'] },
];

const CAT_MAP = {};
for (const c of CATEGORIES) CAT_MAP[c.key] = c;

// ── 收敛参数（方案要求）────────────────────────────────────────
const DEFAULT_LIMITS = {
  maxRoundsPerCategory: 3,   // 每类型最多 3 轮
  noNewStreakToStop: 2,      // 连续 2 轮无新增即停
};

function newId(prefix) {
  const s = Math.random().toString(36).slice(2, 8)
          + Date.now().toString(36).slice(-4);
  return `${prefix}_${s}`;
}

function normalizeItem(x) {
  return String(x == null ? '' : x).trim();
}

// ════════════════════════════════════════════════════════════════
// 阶段一：追问扩容
// ════════════════════════════════════════════════════════════════

/**
 * 创建一次追问会话。
 * @param {object} opts
 *   initial : string[] 验证器初始声明的验证计划
 *   limits  : object  覆盖默认收敛参数
 *   host    : object  宿主模块（evolution-host.cjs），可选；不给则只记录不写tap
 */
function createQuestioning(opts) {
  const o = opts || {};
  const limits = Object.assign({}, DEFAULT_LIMITS, o.limits || {});
  const items = [];
  const transcript = [];     // 每轮问答记录（对账时区分 initial / questioning）
  const byCat = {};
  for (const c of CATEGORIES) byCat[c.key] = { newCount: 0, rounds: 0, noNewStreak: 0, done: false };

  // 初始契约入库
  for (const d of (o.initial || [])) {
    const desc = normalizeItem(d);
    if (!desc) continue;
    items.push({
      id: newId('contract'),
      source: 'initial',
      category: 'input',        // 初始项未分类，标 input 以免丢失（对账不依赖分类）
      description: desc,
      status: 'open',
      skipReason: null,
    });
    transcript.push({ round: 0, source: 'initial', description: desc });
  }

  const session = {
    items,
    transcript,
    byCat,
    limits,
    host: o.host || null,
    initialCount: items.length,
    finished: false,
  };
  return session;
}

/**
 * 下一个追问问题（按未收敛类型轮转）。
 * 返回 null 表示所有类型都已收敛。
 */
function nextQuestion(session) {
  if (!session || session.finished) return null;
  for (const c of CATEGORIES) {
    const st = session.byCat[c.key];
    if (st.done) continue;
    if (st.rounds >= session.limits.maxRoundsPerCategory) { st.done = true; continue; }
    return {
      category: c.key,
      categoryName: c.name,
      round: st.rounds + 1,
      roundsLeft: session.limits.maxRoundsPerCategory - st.rounds,
      asked: c.probes,
      prompt: `【${c.name}】你当前的验证计划里，有没有覆盖：${c.probes.join('、')}？`
              + `若有，请逐条列出具体测试点；若确无，请明确说"无"。`,
    };
  }
  return null;
}

/**
 * 记录一轮追问的回答。
 * @param answers string[] 验证器给出的新测试点（空数组 = 明确说无）
 * @returns {{accepted:number, session:object}}
 */
function submitAnswer(session, category, answers) {
  try {
    if (!session || session.finished) return { accepted: 0, session };
    const st = session.byCat[category];
    if (!st) return { accepted: 0, session };
    st.rounds += 1;

    const list = (Array.isArray(answers) ? answers : [answers])
      .map(normalizeItem).filter(Boolean);

    // 去重：描述已存在则不新增
    const existing = new Set(session.items.map((i) => i.description));
    let accepted = 0;
    for (const desc of list) {
      if (existing.has(desc)) continue;
      existing.add(desc);
      const item = {
        id: newId('contract'),
        source: 'questioning',
        category,
        description: desc,
        status: 'open',
        skipReason: null,
      };
      session.items.push(item);
      accepted += 1;
      session.transcript.push({ round: st.rounds, source: 'questioning', category, description: desc });
    }

    session.byCat[category].newCount += accepted;
    if (accepted > 0) {
      st.noNewStreak = 0;
    } else {
      st.noNewStreak += 1;
      // 连续 2 轮无新增 → 该类型收敛
      if (st.noNewStreak >= session.limits.noNewStreakToStop) st.done = true;
      // 轮次用尽也收敛（防死循环）
      if (st.rounds >= session.limits.maxRoundsPerCategory) st.done = true;
    }

    if (!nextQuestion(session)) session.finished = true;
    return { accepted, session };
  } catch (e) {
    // 红线5：绝不抛错
    return { accepted: 0, session, error: String(e && e.message || e) };
  }
}

/**
 * 结束追问，并把全部契约写入宿主 tapPlan（方案要求：追问项必须入契约）。
 * @returns {{written:number, hostOk:boolean, reason?:string}}
 */
/**
 * 显式追加契约（追问收敛后仍可补充）。
 * 用途：收敛是有界的（每类最多 3 轮），若调用方还需要更多契约，
 * 应走这个显式入口，而不是反复调用 submitAnswer —— 那会在 finished 后被拒。
 */
function addContract(session, description, category) {
  try {
    if (!session) return { ok: false, reason: 'no_session' };
    const desc = normalizeItem(description);
    if (!desc) return { ok: false, reason: 'empty' };
    const existing = new Set(session.items.map((i) => i.description));
    if (existing.has(desc)) return { ok: false, reason: 'duplicate', id: null };
    const item = {
      id: newId('contract'),
      source: 'questioning',
      category: CAT_MAP[category] ? category : 'input',
      description: desc,
      status: 'open',
      skipReason: null,
    };
    session.items.push(item);
    session.transcript.push({
      round: (session.byCat[item.category] ? session.byCat[item.category].rounds : 0),
      source: 'questioning', category: item.category, description: desc,
    });
    return { ok: true, id: item.id, total: session.items.length };
  } catch (e) {
    return { ok: false, reason: String(e && e.message || e) };
  }
}

function sealQuestioning(session) {
  try {
    if (!session) return { written: 0, hostOk: false, reason: 'no_session' };
    session.finished = true;
    if (!session.host) {
      return { written: 0, hostOk: false, reason: 'no_host_绑定' };
    }
    try {
      if (!session.host.ready || !session.host.ready()) {
        return { written: 0, hostOk: false, reason: 'host_not_ready' };
      }
    } catch (_) {
      return { written: 0, hostOk: false, reason: 'host_not_ready' };
    }

    let written = 0;
    for (const it of session.items) {
      try {
        const r = session.host.tapPlan(
          `[契约] ${it.category} · ${it.description}`,
          `source=${it.source};id=${it.id}`,
          { taskId: 'anti-lazy-supervisor' },
        );
        if (r && r.ok) written += 1;
      } catch (_) { /* 单条失败不影响其他 */ }
    }
    return { written, hostOk: written > 0 };
  } catch (e) {
    return { written: 0, hostOk: false, reason: String(e && e.message || e) };
  }
}

// ════════════════════════════════════════════════════════════════
// 阶段二：硬对账
// ════════════════════════════════════════════════════════════════

/**
 * 读宿主执行日志（ledger.jsonl / audit.jsonl）。
 * 只认**实际存在的记录**——这是「抓造假」的唯一依据。
 */
function readExecutionLog(dataDir) {
  const out = { ledger: [], audit: [], available: false, reason: null };
  try {
    const lp = path.join(dataDir, 'ledger', 'ledger.jsonl');
    const ap = path.join(dataDir, 'audit', 'audit.jsonl');
    if (fs.existsSync(lp)) {
      out.ledger = fs.readFileSync(lp, 'utf8').split('\n')
        .filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } })
        .filter(Boolean);
      out.available = true;
    } else {
      out.reason = 'ledger_missing';
    }
    if (fs.existsSync(ap)) {
      out.audit = fs.readFileSync(ap, 'utf8').split('\n')
        .filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } })
        .filter(Boolean);
    }
  } catch (e) {
    out.reason = String(e && e.message || e);
  }
  return out;
}

/**
 * 硬对账。
 * @param session  阶段一产物
 * @param execLog  readExecutionLog 的结果
 * @param opts.claimed   {id: 'completed'} 验证器的**口头声明**（只作参考，不作数）
 * @param opts.skipNotes {id: '原因'}       跳过理由（无理由 → dangling）
 * @returns 对账结果（见方案数据结构）
 */
function reconcile(session, execLog, opts) {
  try {
    const o = opts || {};
    const claimed = o.claimed || {};
    const skipNotes = o.skipNotes || {};
    const log = execLog || { ledger: [], audit: [] };

    // 执行日志里出现过的契约（小写比对）
    // ⚠ 匹配纪律（2026-10-21 实测踩过）：
    //   · **优先按 id 精确匹配**（seal 写入 tapPlan 时 detail 带 id=xxx）—— 唯一可靠依据。
    //   · 描述文本匹配**仅作兜底**，且要求描述足够长（>=4 字）。
    //     否则「x」「测试」这种短描述会命中日志里任意含该字的条目，
    //     把没执行的契约误判成 completed —— 那是把造假放过去，比漏检更糟。
    const MIN_DESC_LEN = 4;
    const executed = new Set();

    const matchOne = (hay, entry) => {
      const low = String(hay || '').toLowerCase();
      const detail = String(entry.detail || '');
      // ① id 精确匹配（最可靠）
      if (entry.id && detail.toLowerCase().includes(String(entry.id).toLowerCase())) return true;
      if (entry.id && String(hay || '').toLowerCase().includes(String(entry.id).toLowerCase())) return true;
      // ② 描述兜底：必须够长才允许文本匹配
      const desc = String(entry.description || '').toLowerCase();
      if (desc.length >= MIN_DESC_LEN && low.includes(desc)) return true;
      return false;
    };

    const items = (session && session.items) || [];
    for (const e of (log.ledger || [])) {
      const hay = `${e.title || ''} ${e.detail || ''}`;
      for (const it of items) if (matchOne(hay, it)) executed.add(it.id);
    }
    // 审计链里出现过的也算（HOST_TAP_P / HOST_TAP_I）
    for (const a of (log.audit || [])) {
      const pl = a.payload || {};
      const hay = `${pl.title || ''} ${pl.detail || ''} ${JSON.stringify(pl.payload || {})}`;
      for (const it of items) if (matchOne(hay, it)) executed.add(it.id);
    }

    const details = [];
    const counts = { completed: 0, skipped: 0, dangling: 0 };

    for (const it of (session && session.items) || []) {
      const hasLog = executed.has(it.id);
      const skipReason = skipNotes[it.id] || null;
      const selfClaim = claimed[it.id] === 'completed';

      let status;
      if (hasLog) {
        status = 'completed';
      } else if (skipReason && String(skipReason).trim()) {
        // 红线3：跳过必须有理由
        status = 'skipped';
      } else {
        // 红线1：口头声明不算数
        status = 'dangling';
      }
      counts[status] = (counts[status] || 0) + 1;
      details.push({
        id: it.id,
        source: it.source,
        category: it.category,
        description: it.description,
        status,
        skipReason,
        claimedByVerifier: selfClaim,   // 记录但不作数
        hasExecLog: hasLog,
        note: (status === 'dangling' && selfClaim)
          ? '验证器口头声称已完成，但执行日志无对应记录 —— 判漏检'
          : undefined,
      });
    }

    // 额外执行（日志里有、契约外）
    const tracked = new Set(((session && session.items) || []).map((i) => i.id));
    let untracked = 0;
    for (const e of (log.ledger || [])) {
      const d = String(e.detail || '');
      if (d.includes('[契约]') && !tracked.has(String(d).match(/id=([^;]+)/)?.[1] || '')) {
        untracked += 1;
      }
    }

    let verdict = 'PASS';
    if (counts.dangling > 0) verdict = 'REJECT';
    else if (counts.skipped > 0) verdict = 'PASS_WITH_WARNINGS';

    const totalCount = (session && session.items ? session.items.length : 0);

    // ── 空契约：区分两种截然不同的情形（2026-10-21 修正）────────────
    //   A. **调用方压根没起会话**（session 为 null / 未跑追问）
    //      → 判 REJECT。无契约就放行 = 监督形同虚设，这是防造假的底线。
    //      实测踩过：null session 走正常路径返回 PASS，门禁因此放行。
    //   B. **起了会话但一个契约都没有**（用户还没声明测试点）
    //      → 判 NOT_APPLICABLE，**不拦**。这是「尚未进入监督流程」，
    //        不是「有契约却没做」。若也 REJECT，默认开启后会把所有
    //        刚加载插件、还没跑追问的流程全部拦死 —— 比默认关闭更糟。
    if (!session || totalCount === 0) {
      const noSession = !session;
      details.push({
        id: '-', source: '-', category: '-',
        description: noSession ? '(未启动监督会话)' : '(尚未声明测试点契约)',
        status: noSession ? 'dangling' : 'not_applicable',
        skipReason: null,
        claimedByVerifier: false, hasExecLog: false,
        note: noSession
          ? '无监督会话 → 保守拒绝（无契约不得放行）'
          : '尚未声明契约 → 不适用，本轮不做门禁',
      });
      if (noSession) counts.dangling = (counts.dangling || 0) + 1;
      verdict = noSession ? 'REJECT' : 'NOT_APPLICABLE';
    }

    return {
      total: totalCount,
      completed: counts.completed || 0,
      skipped: counts.skipped || 0,
      dangling: counts.dangling || 0,
      untracked,
      verdict,
      details,
      logAvailable: !!(log.available),
      logReason: log.reason || null,
    };
  } catch (e) {
    return {
      total: 0, completed: 0, skipped: 0, dangling: 0, untracked: 0,
      verdict: 'REJECT', details: [], error: String(e && e.message || e),
    };
  }
}

// ════════════════════════════════════════════════════════════════
// 阶段三：门禁 + 报告注入
// ════════════════════════════════════════════════════════════════

/**
 * 生成监督对账台账区块。
 * 数据全部来自对账结果与执行日志，**验证器无法手写覆盖**（红线2）。
 */
function renderAuditBlock(session, recon) {
  const r = recon || { total: 0, completed: 0, skipped: 0, dangling: 0, untracked: 0, verdict: 'PASS', details: [] };
  const initial = session ? session.initialCount : 0;
  const added = session ? session.items.length - session.initialCount : 0;

  // 追问扩充按类别统计
  const perCat = {};
  for (const it of (session ? session.items : [])) {
    if (it.source !== 'questioning') continue;
    const nm = (CAT_MAP[it.category] || {}).name || it.category;
    perCat[nm] = (perCat[nm] || 0) + 1;
  }
  const catStr = Object.keys(perCat).map((k) => `${k} ${perCat[k]}`).join(' / ') || '无';

  const lines = [];
  lines.push('## 监督对账台账（由插件生成，不可篡改）');
  lines.push(`- 初始契约数：${initial}`);
  lines.push(`- 追问扩充数：+${added}（${catStr}）`);
  lines.push(`- 最终应测契约：${r.total}`);
  lines.push(`- 实际完成：${r.completed}`);
  lines.push(`- 合规跳过：${r.skipped}`);
  lines.push(`- 额外执行（契约外）：${r.untracked}`);
  lines.push(`- 漏检：${r.dangling}`);
  for (const d of (r.details || []).filter((x) => x.status === 'dangling')) {
    lines.push(`  - [dangling] ${(CAT_MAP[d.category] || {}).name || d.category} · ${d.description}`
      + (d.claimedByVerifier ? ' —— 声称测过但无日志' : ' —— 无执行日志'));
  }
  for (const d of (r.details || []).filter((x) => x.status === 'skipped')) {
    lines.push(`  - [skipped] ${d.description} —— 原因：${d.skipReason}`);
  }
  lines.push(`- 审计结论：${r.verdict === 'REJECT' ? '⚠️ REJECT' : r.verdict}`);
  return lines.join('\n');
}

/**
 * 门禁：决定能否放行落盘。
 * @returns {{allow:boolean, verdict:string, banner:string|null, block:string}}
 */
function gate(session, recon) {
  try {
    // ⚠ recon 缺失 → 保守拒绝。默认值不能是 PASS：
    //   「拿不到对账结果」不等于「一切正常」（2026-10-21 修正）。
    if (!recon) {
      return {
        allow: false, mustReject: true, verdict: 'REJECT',
        banner: '⚠️ 缺少对账结果，保守拒绝落盘',
        block: '## 监督对账台账（生成失败）\n- 未获得对账结果，门禁按保守策略拒绝',
        error: 'missing_recon',
      };
    }
    const r = recon;
    const block = renderAuditBlock(session, r);
    const banner = r.verdict === 'REJECT'
      ? '⚠️ 监督审计未通过：存在漏检项，报告不得落盘'
      : null;
    return {
      allow: r.verdict !== 'REJECT',
      mustReject: r.verdict === 'REJECT',
      verdict: r.verdict,
      banner,
      block,
    };
  } catch (e) {
    // 红线5：门禁自身出错时**保守拒绝**，但不抛错
    return {
      allow: false, mustReject: true, verdict: 'REJECT',
      banner: '⚠️ 监督对账异常，保守拒绝',
      block: '## 监督对账台账（生成失败）\n- 对账过程异常：' + String(e && e.message || e),
      error: String(e && e.message || e),
    };
  }
}

/**
 * 注入报告：把监督区块拼到宿主报告里。
 * 关键：**区块由插件生成并 prepend**，宿主/验证器无法绕过。
 */
function injectReport(reportText, session, recon) {
  try {
    const g = gate(session, recon);
    const base = String(reportText || '');
    const head = g.banner ? `${g.banner}\n\n` : '';
    return {
      ok: true,
      text: `${head}${g.block}\n\n---\n\n${base}`,
      gate: g,
    };
  } catch (e) {
    return { ok: false, reason: 'inject_error', original: reportText,
             error: String(e && e.message || e) };
  }
}

// ── 导出 ──────────────────────────────────────────────────────
module.exports = {
  CATEGORIES,
  CAT_MAP,
  DEFAULT_LIMITS,
  createQuestioning,
  nextQuestion,
  submitAnswer,
  addContract,
  sealQuestioning,
  readExecutionLog,
  reconcile,
  renderAuditBlock,
  gate,
  injectReport,
};
