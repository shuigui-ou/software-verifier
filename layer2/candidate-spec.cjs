'use strict';
/**
 * layer2/candidate-spec.cjs —— T5 Layer 2 候选 spec 置信度分级与人审闸门
 * （software-verifier v1.6，物理隔离于 drivers/ 与 evolution/，与 evolution-candidate-gen.cjs 不混）
 *
 * 职责（spec T5 v2）：
 *  - gradeCandidateSpec：对引用发现数组做「最弱层级赢」置信度分级（high / medium-heuristic / medium-incomplete-evidence）。
 *  - computeHumanReviewRequired：§3 三条件 OR 阈值（ignored / 非 high / 非确定性生成源 → 必审）。
 *  - buildCandidateSpec：产出候选 spec 记录，桥接 finding.candidateSpecReserved（explore.cjs 预留字段）。
 *  - applyCandidateSpec：经 review.cjs 的 transition 应用，绝不绕过 T4 闸门；
 *      ① ignored 一律不自动（硬闸门）② medium-* 不自动 ③ model:* high 必审 ④ 确定性 high 过闸门，失败回落人审。
 *
 * 复用：review.cjs（evidenceHasSubstance / reproPathSubstantive / transition）—— 纯模块，无 playwright 依赖。
 */

const crypto = require('crypto');
const path = require('path');
const { evidenceHasSubstance, reproPathSubstantive } = require(path.join(__dirname, '..', 'review.cjs'));

// ---------------------------------------------------------------------------
// reason 枚举（集中定义，实现不得游离；spec §4.1）
// ---------------------------------------------------------------------------
const REASONS = {
  GATE_FAILED: 'gate-failed',                 // 确定性 high + confirmed 时 T4 证据闸门抛 evidence-incomplete
  BAD_GENERATOR: 'bad-generator',             // generator 非法前缀，transition 抛 judgment-source-missing（防御分支）
  HEURISTIC_GROUNDING: 'heuristic-grounding', // candidateConfidence = medium-heuristic
  EVIDENCE_GAP: 'evidence-gap',               // candidateConfidence = medium-incomplete-evidence
  AUTO_IGNORE_NOT_ALLOWED: 'auto-ignore-not-allowed', // proposedStatus = ignored（硬闸门拦截）
  MODEL_HIGH_REQUIRES_REVIEW: 'model-high-requires-review', // high 但 generator = model:*（概率性生成必审）
};
const ALL_REASONS = Object.values(REASONS);

// 置信层级序（强→弱）：high(3) > medium-heuristic(2) > medium-incomplete-evidence(1)
const TIER = { high: 3, 'medium-heuristic': 2, 'medium-incomplete-evidence': 1 };

const GENERATOR_RE = /^(oracle:|rule:|model:|human:)/;
const DETERMINISTIC_RE = /^(rule:|oracle:)/;

/** 生成来源是否确定性（rule:/oracle: 为确定性逻辑，可免人审；model:/human:/其他 概率性或非预期 → 必审） */
function isDeterministicGenerator(g) {
  return typeof g === 'string' && DETERMINISTIC_RE.test(g);
}

// ---------------------------------------------------------------------------
// 置信度分级（spec §2）
// ---------------------------------------------------------------------------
/**
 * 对引用发现数组做「最弱层级赢」分级。
 * @param {object[]} referencedFindings 每条含 confidence / evidence / reproPath
 * @param {string} [proposedStatus] 仅用于占位兼容，分级不看它
 * @returns {{candidateConfidence:string, basis:object}}
 */
function gradeCandidateSpec(referencedFindings, proposedStatus) {
  if (!Array.isArray(referencedFindings) || referencedFindings.length === 0) {
    throw new Error('[gradeCandidateSpec] empty-references: 候选 spec 必须引用至少一条发现');
  }
  let weakest = 3;
  for (const f of referencedFindings) {
    const t = TIER[f && f.confidence];
    if (t === undefined) weakest = 1; // 未知 confidence 视为最弱
    else weakest = Math.min(weakest, t);
  }
  const candidateConfidence = weakest === 3 ? 'high' : weakest === 2 ? 'medium-heuristic' : 'medium-incomplete-evidence';
  const findingConfidences = referencedFindings.map((f) => (f && f.confidence));
  const evidenceSubstantive = referencedFindings.every((f) =>
    evidenceHasSubstance(f && f.evidence) || reproPathSubstantive(f && f.reproPath));
  let reason;
  if (candidateConfidence === 'medium-heuristic') reason = 'heuristic-grounding';
  else if (candidateConfidence === 'medium-incomplete-evidence') reason = 'evidence-gap';
  else reason = 'all-high';
  return {
    candidateConfidence,
    basis: { findingConfidences, weakest: candidateConfidence, evidenceSubstantive, reason },
  };
}

// ---------------------------------------------------------------------------
// 人审阈值（spec §3，三条件 OR）
// ---------------------------------------------------------------------------
/**
 * 计算 humanReviewRequired。
 *  = proposedStatus==='ignored' || candidateConfidence!=='high' || 非确定性生成源
 * @param {string} proposedStatus
 * @param {string} candidateConfidence
 * @param {string} generator
 * @returns {boolean}
 */
function computeHumanReviewRequired(proposedStatus, candidateConfidence, generator) {
  return (
    proposedStatus === 'ignored' ||
    candidateConfidence !== 'high' ||
    !isDeterministicGenerator(generator)
  );
}

// ---------------------------------------------------------------------------
// id 派生（spec §1：幂等依赖 T2 finding.id 跨运行稳定）
// ---------------------------------------------------------------------------
function makeId(references, proposedStatus, generator) {
  const seed = JSON.stringify({
    references: Array.isArray(references) ? references.slice().sort() : [],
    proposedStatus,
    generator,
  });
  return 'cs-' + crypto.createHash('sha1').update(seed).digest('hex').slice(0, 12);
}

// ---------------------------------------------------------------------------
// 构造候选 spec（spec §1）
// ---------------------------------------------------------------------------
/**
 * 产出一条候选 spec 记录，并桥接引用 finding 的 candidateSpecReserved。
 * @param {{references:string[], referencedFindings?:object[], proposedStatus:string, generator:string, findingsById?:object}} input
 * @returns {object} 候选 spec
 */
function buildCandidateSpec(input) {
  if (!input || !Array.isArray(input.references) || input.references.length === 0) {
    throw new Error('[buildCandidateSpec] references 必须非空数组');
  }
  if (input.proposedStatus !== 'confirmed' && input.proposedStatus !== 'ignored') {
    throw new Error('[buildCandidateSpec] proposedStatus 必须为 confirmed 或 ignored');
  }
  if (typeof input.generator !== 'string' || !GENERATOR_RE.test(input.generator)) {
    throw new Error('[buildCandidateSpec] generator 必须 ∈ {oracle:*,rule:*,model:*,human:*}');
  }

  const refs = (input.referencedFindings && input.referencedFindings.length)
    ? input.referencedFindings
    : (input.findingsById ? input.references.map((id) => input.findingsById[id]).filter(Boolean) : []);
  if (refs.length === 0) {
    throw new Error('[buildCandidateSpec] 必须提供 referencedFindings 或可通过 findingsById 解析');
  }

  const { candidateConfidence, basis } = gradeCandidateSpec(refs, input.proposedStatus);
  const humanReviewRequired = computeHumanReviewRequired(input.proposedStatus, candidateConfidence, input.generator);

  // proposedStatusBasis：为什么主张 confirmed 而非 ignored（可追溯，spec §1）
  let proposedStatusBasis;
  if (input.proposedStatus === 'ignored') proposedStatusBasis = 'auto-ignore 被禁，须人审确认误报依据';
  else if (candidateConfidence !== 'high') proposedStatusBasis = 'medium 置信：人审决定 confirmed/ignored';
  else if (!isDeterministicGenerator(input.generator)) proposedStatusBasis = 'model/human 生成 high：概率性，需人确认结论';
  else proposedStatusBasis = 'rule/oracle 生成 high + 全部引用发现 high + 证据可复核 → 自动 confirmed 候选';

  const id = makeId(input.references, input.proposedStatus, input.generator);

  // 桥接 reserved：把引用 finding 的 candidateSpecReserved 改写为本 spec.id（explore.cjs 预留字段）
  if (input.findingsById) {
    for (const fid of input.references) {
      const f = input.findingsById[fid];
      if (f && f.candidateSpecReserved !== undefined) f.candidateSpecReserved = id;
    }
  }

  return {
    id,
    references: input.references.slice(),
    proposedStatus: input.proposedStatus,
    candidateConfidence,
    humanReviewRequired,
    generator: input.generator,
    generatedAt: new Date().toISOString(),
    basis: Object.assign({}, basis, { proposedStatusBasis }),
    linkedFindings: input.references.slice(),
  };
}

// ---------------------------------------------------------------------------
// 应用候选 spec（spec §4：经 review.transition，绝不绕过 T4 闸门）
// ---------------------------------------------------------------------------
/**
 * 把候选 spec 应用到 findingsById（经 review.transition）。
 * 流程优先级（spec §4.2）：
 *  ① proposedStatus==='ignored' → 硬闸门，一律 needsHumanReview(AUTO_IGNORE_NOT_ALLOWED)
 *  ② candidateConfidence!=='high' → needsHumanReview(HEURISTIC_GROUNDING | EVIDENCE_GAP)
 *  ③ 非确定性生成源（model:/human:/其他）→ needsHumanReview(MODEL_HIGH_REQUIRES_REVIEW)
 *  ④ 确定性 high → transition confirmed；失败 catch → needsHumanReview(GATE_FAILED | BAD_GENERATOR)
 * @param {object} spec 由 buildCandidateSpec 产出（或结构兼容对象）
 * @param {object} findingsById { findingId: finding }
 * @param {object} review review.cjs 模块（需含 transition）
 * @returns {{applied:object[], needsHumanReview:object[], errors:object[]}}
 */
function applyCandidateSpec(spec, findingsById, review) {
  const applied = [];
  const needsHumanReview = [];
  const errors = [];
  const refIds = Array.isArray(spec && spec.references) ? spec.references : [];
  const reviewTransition = review && typeof review.transition === 'function' ? review.transition : null;

  for (const fid of refIds) {
    const f = findingsById && findingsById[fid];
    if (!f) { errors.push({ fid, reason: 'finding-missing' }); continue; }

    // ① 硬闸门：ignored 一律不自动应用（覆盖一切 confidence/generator）
    if (spec.proposedStatus === 'ignored') {
      needsHumanReview.push({ fid, specId: spec.id, reason: REASONS.AUTO_IGNORE_NOT_ALLOWED });
      continue;
    }

    // ② confirmed 路径：非 high → 必审
    if (spec.candidateConfidence !== 'high') {
      const reason = spec.candidateConfidence === 'medium-heuristic'
        ? REASONS.HEURISTIC_GROUNDING : REASONS.EVIDENCE_GAP;
      needsHumanReview.push({ fid, specId: spec.id, reason });
      continue;
    }

    // ③ high 但非确定性生成源（model:/human:/其他）→ 必审
    if (!isDeterministicGenerator(spec.generator)) {
      needsHumanReview.push({ fid, specId: spec.id, reason: REASONS.MODEL_HIGH_REQUIRES_REVIEW });
      continue;
    }

    // ④ 确定性 high → 过 T4 证据闸门
    if (!reviewTransition) {
      needsHumanReview.push({ fid, specId: spec.id, reason: REASONS.BAD_GENERATOR });
      continue;
    }
    try {
      reviewTransition(f, 'confirmed', spec.generator);
      applied.push({ fid, status: 'confirmed', via: spec.generator });
    } catch (e) {
      const reason = /judgment-source-missing/.test(e && e.message || '')
        ? REASONS.BAD_GENERATOR : REASONS.GATE_FAILED;
      needsHumanReview.push({ fid, specId: spec.id, reason }); // 不静默丢、不降级
    }
  }

  return { applied, needsHumanReview, errors };
}

// ---------------------------------------------------------------------------
// 导出
// ---------------------------------------------------------------------------
module.exports = {
  REASONS,
  ALL_REASONS,
  TIER,
  GENERATOR_RE,
  isDeterministicGenerator,
  gradeCandidateSpec,
  computeHumanReviewRequired,
  makeId,
  buildCandidateSpec,
  applyCandidateSpec,
};
