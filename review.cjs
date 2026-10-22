'use strict';
/**
 * review.cjs —— T4 「AI 判断可审计基础设施」（software-verifier v1.5，v2 重定位）
 *
 * 重定位（spec §0）：T4 不是「人审基础设施」，而是「AI 判断可审计基础设施」。
 *  - `confirmed` 的合法性来自「证据链完整、可被独立复核」，不来自人签字。
 *  - 人审若发生，只是 `judgmentSource` 的来源之一（human:*），不是合法性来源。
 *  - 状态机管的是「判断的可追溯性」，不是「管人」。
 *
 * 职责（spec §1/§2/§3）：
 *  - ensureReviewFields：补齐每条发现的 T4 字段默认（不依赖调用方）。
 *  - validateSchema：类型 / 枚举校验，非法抛 Error。
 *  - transition：三态状态机，按 §2 显式转移表执行；**进 confirmed 须过证据闸门**。
 *  - writeback：第 3 层引用幂等回写（linkedSpecRefs 数组化 / 去重追加 / 互不覆盖 / 不污染审计）。
 *  - processFindings：批量补齐 + E3 防御性审计（只报数打标记、不改状态）。
 *
 * 不改动 T2 explore.cjs / reporters / verify.cjs / mcp-server.cjs 主流程。
 *
 * 审计语义（spec §2 ⚠️）：T4 不保留 append-only 历史；重开（ignored→pending）即清空
 * judgmentSource / judgedAt，历史不追溯。
 */

const VALID_STATUSES = ['pending', 'confirmed', 'ignored'];

// 状态转移表（spec §2）：from -> 允许到达集合（显式列出，其余一律拒绝）
//  - confirmed -> pending 不在集合内（非法，防覆盖审计）。
const TRANSITIONS = {
  pending: ['pending', 'confirmed', 'ignored'],
  confirmed: ['confirmed', 'ignored'],        // 不含 'pending'
  ignored: ['pending', 'confirmed', 'ignored'],
};

// judgmentSource 取值约束（spec §3 补洞2）：进 confirmed 时必须非空且属四者之一。
// 非 confirmed 时允许为 null（pending/ignored 不要求来源）。
const JUDGMENT_SOURCE_RE = /^(oracle:|rule:|model:|human:)/;

// ---------------------------------------------------------------------------
// 证据完整闸门辅助（spec §2 修订后闸门：三条同时满足才能进 confirmed）
// ---------------------------------------------------------------------------
/**
 * evidence 是否含「实质内容」。
 * 通用判定（适配 T2 真实 evidence 形状：message/stack/status/text/rootEmpty/target/errText/
 * attribute 等），而非固定字段名；等价于「证据链可复核」的底线：
 * 任一字段为「非空字符串 / 非 null 数字 / true 布尔 / 非空数组 / 非空嵌套对象」即算有实质。
 * 空壳 {a:'', b:null} 或 {} 一律 false。
 * @param {*} ev
 * @returns {boolean}
 */
function evidenceHasSubstance(ev) {
  if (!ev || typeof ev !== 'object' || Array.isArray(ev)) return false;
  for (const k of Object.keys(ev)) {
    const v = ev[k];
    if (v === null || v === undefined) continue;
    if (typeof v === 'string' && v.length > 0) return true;
    if (typeof v === 'number' && !Number.isNaN(v)) return true;
    if (typeof v === 'boolean' && v === true) return true;
    if (Array.isArray(v) && v.length > 0) return true;
    if (typeof v === 'object' && Object.keys(v).length > 0) return true;
  }
  return false;
}

/**
 * reproPath 是否「非空数组」（非空数组 = 可复现路径，本身即可独立复核）。
 * @param {*} rp
 * @returns {boolean}
 */
function reproPathSubstantive(rp) {
  return Array.isArray(rp) && rp.length > 0;
}

/**
 * 纯检查（不修改 f）：进 confirmed 的三条件是否全部满足。
 *  - 1. confidence === 'high'
 *  - 2. evidenceHasSubstance(evidence) || reproPathSubstantive(reproPath)
 *  - 3. src 非空 string 且匹配 JUDGMENT_SOURCE_RE
 * @param {object} f
 * @param {string|null|undefined} src 来源标识（优先 by，回落 f.judgmentSource）
 * @returns {{ok:boolean, reason:string}}
 */
function checkConfirmGate(f, src) {
  if (f.confidence !== 'high') return { ok: false, reason: 'confidence!==high' };
  if (!evidenceHasSubstance(f.evidence) && !reproPathSubstantive(f.reproPath)) {
    return { ok: false, reason: 'evidence-empty' };
  }
  if (typeof src !== 'string' || !JUDGMENT_SOURCE_RE.test(src)) {
    return { ok: false, reason: 'judgment-source-missing' };
  }
  return { ok: true, reason: '' };
}

/**
 * 应用证据闸门（就地修改 f.judgmentSource / f.judgedAt），不满足抛错。
 * 错误名：confidence/evidence 类 → 'evidence-incomplete'；来源类 → 'judgment-source-missing'。
 * @param {object} f
 * @param {string|null|undefined} by
 */
function applyConfirmGate(f, by) {
  const src = by != null ? by : f.judgmentSource;
  const r = checkConfirmGate(f, src);
  if (!r.ok) {
    if (r.reason === 'judgment-source-missing') {
      throw new Error(
        'judgment-source-missing: confirmed 要求 judgmentSource 非空且 ∈ {oracle:*,rule:*,model:*,human:*}，实际 ' +
        JSON.stringify(src)
      );
    }
    throw new Error(
      'evidence-incomplete: confirmed 要求 confidence==="high" 且 证据链含实质内容' +
      '（evidence 至少一个字段有实质 / reproPath 非空数组），实际 confidence=' +
      JSON.stringify(f.confidence) + ' evidence=' + JSON.stringify(f.evidence) +
      ' reproPath=' + JSON.stringify(f.reproPath)
    );
  }
  f.judgmentSource = src;
  f.judgedAt = new Date().toISOString();
}

// ---------------------------------------------------------------------------
// 1. ensureReviewFields —— 补齐默认字段
// ---------------------------------------------------------------------------
/**
 * 补齐 T4 字段到 f（就地修改并返回 f）。
 *  - reviewStatus 非三值之一 → 'pending'。
 *  - judgmentSource 缺省 / null → null（追溯必需，但 pending 可暂空）。
 *  - judgedAt 缺省 / null → null。
 *  - linkedSpecRefs 非数组 → []。
 * @param {object} f
 * @returns {object} f
 */
function ensureReviewFields(f) {
  if (!f || typeof f !== 'object' || Array.isArray(f)) {
    throw new Error('[ensureReviewFields] f 必须为对象');
  }
  if (!VALID_STATUSES.includes(f.reviewStatus)) {
    f.reviewStatus = 'pending';
  }
  if (f.judgmentSource === undefined || f.judgmentSource === null) {
    f.judgmentSource = null;
  }
  if (f.judgedAt === undefined || f.judgedAt === null) {
    f.judgedAt = null;
  }
  if (!Array.isArray(f.linkedSpecRefs)) {
    f.linkedSpecRefs = [];
  }
  return f;
}

// ---------------------------------------------------------------------------
// 2. validateSchema —— 类型 / 枚举校验
// ---------------------------------------------------------------------------
/**
 * 校验 T4 字段的类型与枚举约束；非法抛 Error，合法返回 true。
 * 约束（spec §1）：
 *  - reviewStatus ∈ {pending,confirmed,ignored}
 *  - linkedSpecRefs 必须是数组
 *  - judgmentSource 为 string | null（进 confirmed 时的前缀约束由闸门单独强制）
 *  - judgedAt 为 string | null
 * @param {object} f
 * @returns {true}
 */
function validateSchema(f) {
  if (!f || typeof f !== 'object' || Array.isArray(f)) {
    throw new Error('[validateSchema] f 必须为对象');
  }
  if (!VALID_STATUSES.includes(f.reviewStatus)) {
    throw new Error('[validateSchema] reviewStatus 非法: ' + JSON.stringify(f.reviewStatus));
  }
  if (!Array.isArray(f.linkedSpecRefs)) {
    throw new Error('[validateSchema] linkedSpecRefs 必须为数组，实际: ' + JSON.stringify(f.linkedSpecRefs));
  }
  if (!(typeof f.judgmentSource === 'string' || f.judgmentSource === null)) {
    throw new Error('[validateSchema] judgmentSource 必须为 string|null，实际: ' + JSON.stringify(f.judgmentSource));
  }
  if (!(typeof f.judgedAt === 'string' || f.judgedAt === null)) {
    throw new Error('[validateSchema] judgedAt 必须为 string|null，实际: ' + JSON.stringify(f.judgedAt));
  }
  return true;
}

// ---------------------------------------------------------------------------
// 3. transition —— 三态状态机（管判断可追溯性，非管人）
// ---------------------------------------------------------------------------
/**
 * 按状态转移表执行状态转移（就地修改并返回 f）。
 * 规则（spec §2）：
 *  - to === from（自环）：直接 return f，不更新审计（幂等）。
 *  - to 不在 from 的允许集合：抛 Error(`illegal transition ${from} -> ${to}`)，f 状态不变。
 *  - to === 'confirmed'：先过证据闸门（applyConfirmGate，不满足抛错且状态不变）。
 *  - 合法非自环非 confirmed：f.reviewStatus = to；
 *      · 若 from==='ignored' && to==='pending'（重开）→ 清空审计（judgmentSource=null, judgedAt=null）；
 *      · 否则（by 有值）→ judgmentSource = by；judgedAt = now（刷新审计）。
 * @param {object} f 应已含合法 reviewStatus（建议先 ensureReviewFields）
 * @param {string} to 目标状态
 * @param {string} [by] 判断来源标识（重开清空时可为空；进 confirmed 须为合法 judgmentSource）
 * @returns {object} f
 */
function transition(f, to, by) {
  const from = f.reviewStatus;
  if (from === to) {
    // 自环：幂等，不更新审计
    return f;
  }
  const allowed = TRANSITIONS[from];
  if (!allowed || !allowed.includes(to)) {
    throw new Error('illegal transition ' + from + ' -> ' + to);
  }

  if (to === 'confirmed') {
    // 闸门在改状态前执行：不满足则抛错、reviewStatus 不变
    applyConfirmGate(f, by);
    f.reviewStatus = 'confirmed';
    return f;
  }

  // 非 confirmed 转移
  f.reviewStatus = to;
  if (from === 'ignored' && to === 'pending') {
    // 重开复核：清空审计回未审态（spec §2 重开语义）
    f.judgmentSource = null;
    f.judgedAt = null;
  } else if (by != null) {
    // 刷新审计：记录判断来源
    f.judgmentSource = by;
    f.judgedAt = new Date().toISOString();
  }
  return f;
}

// ---------------------------------------------------------------------------
// 4. writeback —— 第 3 层引用幂等回写
// ---------------------------------------------------------------------------
/**
 * spec 引用某条发现后的回写（就地修改并返回 f）。
 * 规则（spec §3）：
 *  - 归一化 linkedSpecRefs 为数组；若不含 specRef 则 push（去重追加）。
 *  - 若 declaredStatus 有值：尝试 transition(f, declaredStatus, by)；若抛错（非法转移或闸门不满足）
 *    则静默跳过，不覆盖现有 reviewStatus / judgmentSource。
 *  - 若 declaredStatus 无值：仅追加 linkedSpecRefs，不碰 reviewStatus / judgmentSource（人不审不动）。
 * @param {object} f
 * @param {string} specRef 引用该发现的 spec 路径或 spec#片段
 * @param {string|null|undefined} declaredStatus spec 声明的人审结论（可选）
 * @param {string} [by='rule:spec'] 判断来源标识；默认 rule:spec（spec 声明即规则判断）
 * @returns {object} f
 */
function writeback(f, specRef, declaredStatus, by) {
  if (by === undefined) by = 'rule:spec';

  // 归一化为数组 + 去重追加
  if (!Array.isArray(f.linkedSpecRefs)) f.linkedSpecRefs = [];
  if (f.linkedSpecRefs.indexOf(specRef) === -1) {
    f.linkedSpecRefs.push(specRef);
  }

  if (declaredStatus != null) {
    try {
      transition(f, declaredStatus, by);
    } catch (_e) {
      // 非法转移或闸门不满足：静默跳过，不覆盖现有 reviewStatus / judgmentSource
    }
  }
  // declaredStatus 无值：仅追加 linkedSpecRefs，不碰 reviewStatus / judgmentSource
  return f;
}

// ---------------------------------------------------------------------------
// 5. processFindings —— 批量补齐 + E3 防御性审计
// ---------------------------------------------------------------------------
/**
 * 对 findings 数组每条调 ensureReviewFields，并对已 confirmed 的发现做防御性审计。
 * E3 语义（spec §4 补洞1）：只报数 + 打标记，**不改状态**（与状态转移表不冲突）。
 *  - 已 confirmed 但不满足闸门 → 打 evidenceAuditFlag=true、计入 deficientIds；
 *  - 返回 { findings, metrics }，metrics.confirmedEvidenceCompleteness 即「是否给幻觉盖章」的可观测指标。
 * @param {object[]} findings
 * @returns {{findings:object[], metrics:object}}
 */
function processFindings(findings) {
  if (!Array.isArray(findings)) {
    throw new Error('[processFindings] findings 必须为数组');
  }
  const out = findings.map((f) => ensureReviewFields(f));
  let confirmedCount = 0;
  let completeCount = 0;
  const deficientIds = [];

  for (const f of out) {
    if (f.reviewStatus === 'confirmed') {
      confirmedCount++;
      const r = checkConfirmGate(f, f.judgmentSource);
      if (r.ok) {
        completeCount++;
      } else {
        // 仅打标记，不降级（避免绕过状态机）
        f.evidenceAuditFlag = true;
        deficientIds.push(f.id != null ? f.id : 'no-id');
      }
    }
  }

  const metrics = {
    confirmedCount,
    confirmedComplete: completeCount,
    confirmedEvidenceCompleteness: confirmedCount ? completeCount / confirmedCount : 1,
    deficientIds,
  };
  return { findings: out, metrics };
}

// ---------------------------------------------------------------------------
// 对外导出
// ---------------------------------------------------------------------------
module.exports = {
  VALID_STATUSES,
  TRANSITIONS,
  JUDGMENT_SOURCE_RE,
  evidenceHasSubstance,
  reproPathSubstantive,
  checkConfirmGate,
  applyConfirmGate,
  ensureReviewFields,
  validateSchema,
  transition,
  writeback,
  processFindings,
};
