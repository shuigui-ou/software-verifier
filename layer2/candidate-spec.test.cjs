'use strict';
/**
 * layer2/candidate-spec.test.cjs —— T5 硬验收用例（spec §4/§5，v2：砍自动 ignored + rule/model 区分 + reason 枚举）
 *
 * 全部用 mock + 纯函数驱动（复用 explore.cjs buildFinding 构造输入，复用 review.cjs transition 做接口断言），
 * 不依赖真实浏览器。沿用 test/review.test.cjs 的 check('X. …') 标注风格。
 *
 * 覆盖：G1（落盘 schema）/ G2~G5（分级）/ G6（rule:high 自动 confirmed）/ G7（high 闸门失败回落人审）
 *       / G8（medium-heuristic 不自动）/ G9（medium-incomplete 不自动）/ G10（ignored 一律不自动）
 *       / G11（幂等）/ G12（model:high 必审）/ G13（reason 枚举集中）
 */

const assert = require('assert');
const path = require('path');
const { buildFinding } = require(path.join(__dirname, '..', 'explore.cjs'));
const { ensureReviewFields, transition } = require(path.join(__dirname, '..', 'review.cjs'));
const cs = require(path.join(__dirname, 'candidate-spec.cjs'));
const REASONS = cs.REASONS;

let passed = 0;
let failed = 0;
const results = [];

function check(name, fn) {
  try {
    fn();
    passed++;
    results.push('PASS  ' + name);
    console.log('  ✅ PASS  ' + name);
  } catch (e) {
    failed++;
    results.push('FAIL  ' + name + ' :: ' + e.message);
    console.log('  ❌ FAIL  ' + name + ' :: ' + e.message);
  }
}

// ---- 发现构造辅助 ----
function mkFinding(over) {
  return ensureReviewFields(buildFinding(over));
}
function highF() {
  // crash + rootEmpty → confidence=high，evidence 含实质
  return mkFinding({ oracle: 'crash', evidence: { rootEmpty: true } });
}
function highShell() {
  // confidence=high（buildFinding 已定），但 evidence 空壳 → 闸门会失败
  const f = mkFinding({ oracle: 'crash', evidence: { rootEmpty: true } });
  f.evidence = {};
  return f;
}
function heurF() {
  // timeout 无 lazyLoad → medium-heuristic
  return mkFinding({ oracle: 'timeout' });
}
function incompF() {
  // requestfailed 无 status/net → medium-incomplete-evidence
  return mkFinding({ oracle: 'requestfailed', evidence: {} });
}
function byId(arr) {
  const m = {};
  for (const f of arr) m[f.id] = f;
  return m;
}

// ---------------------------------------------------------------------------
console.log('\n=== T5 Layer 2 候选 spec 置信度分级与人审闸门 硬验收用例 ===\n');

// ---- G1. 落盘 schema ----
check('G1. 落盘 schema → 字段齐全(含 proposedStatusBasis) & candidateSpecReserved 桥接 & 同输入幂等同 id', () => {
  const f1 = highF(), f2 = highF();
  // buildFinding 的 id 对相同内容确定性相同，这里显式赋予不同 id 以模拟两条独立发现
  f1.id = 'fid-1'; f2.id = 'fid-2';
  const findingsById = byId([f1, f2]);
  const spec = cs.buildCandidateSpec({
    references: [f1.id, f2.id], referencedFindings: [f1, f2],
    proposedStatus: 'confirmed', generator: 'rule:spec-gen', findingsById,
  });
  assert.strictEqual(spec.candidateConfidence, 'high', 'candidateConfidence 须 high');
  assert.strictEqual(spec.humanReviewRequired, false, '确定性 high 免人审');
  assert.strictEqual(spec.references.length, 2);
  assert.ok(spec.basis && Array.isArray(spec.basis.findingConfidences), 'basis.findingConfidences 须为数组');
  assert.ok('proposedStatusBasis' in spec.basis, 'basis 须含 proposedStatusBasis');
  // 桥接 reserved
  assert.strictEqual(f1.candidateSpecReserved, spec.id, 'f1.candidateSpecReserved 须桥接为本 spec.id');
  assert.strictEqual(f2.candidateSpecReserved, spec.id, 'f2.candidateSpecReserved 须桥接为本 spec.id');
  // 幂等
  const spec2 = cs.buildCandidateSpec({
    references: [f1.id, f2.id], referencedFindings: [f1, f2],
    proposedStatus: 'confirmed', generator: 'rule:spec-gen', findingsById,
  });
  assert.strictEqual(spec2.id, spec.id, '同输入须同 id（幂等）');
});

// ---- G2. 分级·全 high ----
check('G2. 分级·全 high → high / weakest=high', () => {
  const fs = [highF(), highF(), highF()];
  const { candidateConfidence, basis } = cs.gradeCandidateSpec(fs, 'confirmed');
  assert.strictEqual(candidateConfidence, 'high');
  assert.strictEqual(basis.weakest, 'high');
});

// ---- G3. 分级·含 heuristic ----
check('G3. 分级·含 heuristic → medium-heuristic / reason heuristic-grounding', () => {
  const fs = [highF(), highF(), heurF()];
  const { candidateConfidence, basis } = cs.gradeCandidateSpec(fs, 'confirmed');
  assert.strictEqual(candidateConfidence, 'medium-heuristic');
  assert.ok(/heuristic-grounding/.test(basis.reason), 'reason 须含 heuristic-grounding，实际=' + basis.reason);
});

// ---- G4. 分级·含 incomplete ----
check('G4. 分级·含 incomplete → medium-incomplete-evidence / reason evidence-gap', () => {
  const fs = [highF(), incompF()];
  const { candidateConfidence, basis } = cs.gradeCandidateSpec(fs, 'confirmed');
  assert.strictEqual(candidateConfidence, 'medium-incomplete-evidence');
  assert.ok(/evidence-gap/.test(basis.reason), 'reason 须含 evidence-gap，实际=' + basis.reason);
});

// ---- G5. 分级·最弱赢 ----
check('G5. 分级·最弱赢 → high+incomplete 判 medium-incomplete-evidence（不被 high 盖）', () => {
  const fs = [highF(), incompF()];
  const { candidateConfidence } = cs.gradeCandidateSpec(fs, 'confirmed');
  assert.strictEqual(candidateConfidence, 'medium-incomplete-evidence');
});

// ---- G6. 接口·rule:high 自动 confirmed ----
check('G6. 接口·rule:high 自动 confirmed → 过闸门 applied & judgmentSource=rule:spec-gen & 不在 needsHumanReview', () => {
  const f = highF();
  const findingsById = byId([f]);
  const spec = cs.buildCandidateSpec({
    references: [f.id], referencedFindings: [f],
    proposedStatus: 'confirmed', generator: 'rule:spec-gen', findingsById,
  });
  const r = cs.applyCandidateSpec(spec, findingsById, { transition });
  assert.strictEqual(f.reviewStatus, 'confirmed', 'finding 须被置 confirmed');
  assert.strictEqual(f.judgmentSource, 'rule:spec-gen', 'judgmentSource 须为 rule:spec-gen');
  assert.strictEqual(r.applied.length, 1, 'applied 须含 1 条');
  assert.strictEqual(r.needsHumanReview.length, 0, '确定性 high 不得进 needsHumanReview');
});

// ---- G7. 接口·high 但闸门失败回落人审 ----
check('G7. 接口·high 闸门失败 → 保持 pending + needsHumanReview(gate-failed) 不丢不降级', () => {
  const f = highShell();
  const findingsById = byId([f]);
  const spec = cs.buildCandidateSpec({
    references: [f.id], referencedFindings: [f],
    proposedStatus: 'confirmed', generator: 'rule:spec-gen', findingsById,
  });
  const r = cs.applyCandidateSpec(spec, findingsById, { transition });
  assert.strictEqual(f.reviewStatus, 'pending', '闸门失败不得改状态（仍 pending）');
  assert.strictEqual(r.needsHumanReview.length, 1, '须进 needsHumanReview');
  assert.strictEqual(r.needsHumanReview[0].reason, REASONS.GATE_FAILED, 'reason 须为 gate-failed');
});

// ---- G8. 接口·medium-heuristic 不自动 confirmed ----
check('G8. 接口·medium-heuristic 不自动 confirmed → needsHumanReview(heuristic-grounding)', () => {
  const f = heurF();
  const findingsById = byId([f]);
  const spec = cs.buildCandidateSpec({
    references: [f.id], referencedFindings: [f],
    proposedStatus: 'confirmed', generator: 'rule:spec-gen', findingsById,
  });
  const r = cs.applyCandidateSpec(spec, findingsById, { transition });
  assert.strictEqual(f.reviewStatus, 'pending', 'medium 不得自动');
  assert.strictEqual(r.needsHumanReview[0].reason, REASONS.HEURISTIC_GROUNDING);
});

// ---- G9. 接口·medium-incomplete 不自动 confirmed ----
check('G9. 接口·medium-incomplete 不自动 confirmed → needsHumanReview(evidence-gap)', () => {
  const f = incompF();
  const findingsById = byId([f]);
  const spec = cs.buildCandidateSpec({
    references: [f.id], referencedFindings: [f],
    proposedStatus: 'confirmed', generator: 'rule:spec-gen', findingsById,
  });
  const r = cs.applyCandidateSpec(spec, findingsById, { transition });
  assert.strictEqual(f.reviewStatus, 'pending', 'medium 不得自动');
  assert.strictEqual(r.needsHumanReview[0].reason, REASONS.EVIDENCE_GAP);
});

// ---- G10. 接口·ignored 一律不自动（任意 confidence/generator） ----
check('G10. 接口·ignored 一律不自动 → 保持 pending + needsHumanReview(auto-ignore-not-allowed)', () => {
  // high + ignored
  const f1 = highF();
  const id1 = byId([f1]);
  const s1 = cs.buildCandidateSpec({
    references: [f1.id], referencedFindings: [f1],
    proposedStatus: 'ignored', generator: 'rule:spec-gen', findingsById: id1,
  });
  const r1 = cs.applyCandidateSpec(s1, id1, { transition });
  assert.strictEqual(f1.reviewStatus, 'pending', 'high+ignored 不得自动');
  assert.strictEqual(r1.needsHumanReview.length, 1);
  assert.strictEqual(r1.needsHumanReview[0].reason, REASONS.AUTO_IGNORE_NOT_ALLOWED);
  // medium + ignored
  const f2 = incompF();
  const id2 = byId([f2]);
  const s2 = cs.buildCandidateSpec({
    references: [f2.id], referencedFindings: [f2],
    proposedStatus: 'ignored', generator: 'rule:spec-gen', findingsById: id2,
  });
  const r2 = cs.applyCandidateSpec(s2, id2, { transition });
  assert.strictEqual(f2.reviewStatus, 'pending', 'medium+ignored 不得自动');
  assert.strictEqual(r2.needsHumanReview[0].reason, REASONS.AUTO_IGNORE_NOT_ALLOWED);
});

// ---- G11. 接口·幂等 ----
check('G11. 接口·幂等 → 重复 apply 自环不重复刷审计', () => {
  const f = highF();
  const findingsById = byId([f]);
  const spec = cs.buildCandidateSpec({
    references: [f.id], referencedFindings: [f],
    proposedStatus: 'confirmed', generator: 'rule:spec-gen', findingsById,
  });
  cs.applyCandidateSpec(spec, findingsById, { transition });
  const js1 = f.judgmentSource, ja1 = f.judgedAt;
  cs.applyCandidateSpec(spec, findingsById, { transition }); // 第二次自环
  assert.strictEqual(f.reviewStatus, 'confirmed', '仍 confirmed');
  assert.strictEqual(f.judgmentSource, js1, '自环不刷新 judgmentSource');
  assert.strictEqual(f.judgedAt, ja1, '自环不刷新 judgedAt');
});

// ---- G12. 接口·model:high 必审 ----
check('G12. 接口·model:high 必审 → humanReviewRequired=true & needsHumanReview(model-high-requires-review)', () => {
  const f = highF();
  const findingsById = byId([f]);
  const spec = cs.buildCandidateSpec({
    references: [f.id], referencedFindings: [f],
    proposedStatus: 'confirmed', generator: 'model:gpt', findingsById,
  });
  assert.strictEqual(spec.humanReviewRequired, true, 'model 生成 high 必审');
  const r = cs.applyCandidateSpec(spec, findingsById, { transition });
  assert.strictEqual(f.reviewStatus, 'pending', 'model 生成 high 不得自动 confirmed');
  assert.strictEqual(r.needsHumanReview.length, 1);
  assert.strictEqual(r.needsHumanReview[0].reason, REASONS.MODEL_HIGH_REQUIRES_REVIEW);
});

// ---- G13. 接口·reason 枚举集中 ----
check('G13. 接口·reason 枚举集中 → 全部产出 reason ∈ REASONS 且 REASONS 恰 6 值', () => {
  const collected = [];
  function run(f, prop, gen) {
    const findingsById = byId([f]);
    const spec = cs.buildCandidateSpec({
      references: [f.id], referencedFindings: [f],
      proposedStatus: prop, generator: gen, findingsById,
    });
    const r = cs.applyCandidateSpec(spec, findingsById, { transition });
    for (const x of r.needsHumanReview) collected.push(x.reason);
  }
  run(highF(), 'confirmed', 'rule:spec-gen');        // applied，无 reason
  run(highShell(), 'confirmed', 'rule:spec-gen');    // gate-failed
  run(heurF(), 'confirmed', 'rule:spec-gen');        // heuristic-grounding
  run(incompF(), 'confirmed', 'rule:spec-gen');      // evidence-gap
  run(highF(), 'ignored', 'rule:spec-gen');          // auto-ignore-not-allowed
  run(highF(), 'confirmed', 'model:gpt');            // model-high-requires-review
  // bad-generator：确定性 generator 但 review.transition 抛 judgment-source-missing（防御分支单测）
  const f = highF();
  const findingsById = byId([f]);
  const badSpec = {
    id: 'x', references: [f.id], proposedStatus: 'confirmed',
    candidateConfidence: 'high', humanReviewRequired: false, generator: 'rule:spec-gen',
  };
  const mockReview = { transition() { throw new Error('judgment-source-missing: x'); } };
  const rb = cs.applyCandidateSpec(badSpec, findingsById, mockReview);
  collected.push(rb.needsHumanReview[0].reason);

  for (const reason of collected) {
    assert.ok(cs.ALL_REASONS.includes(reason), 'reason 须 ∈ REASONS，实际=' + reason);
  }
  assert.deepStrictEqual(
    cs.ALL_REASONS,
    [REASONS.GATE_FAILED, REASONS.BAD_GENERATOR, REASONS.HEURISTIC_GROUNDING,
     REASONS.EVIDENCE_GAP, REASONS.AUTO_IGNORE_NOT_ALLOWED, REASONS.MODEL_HIGH_REQUIRES_REVIEW],
    'REASONS 须恰为 6 个集中枚举值'
  );
});

// ---------------------------------------------------------------------------
console.log('\n=== 结果汇总 ===');
console.log(results.join('\n'));
console.log('\n通过: ' + passed + '  失败: ' + failed);
process.exit(failed === 0 ? 0 : 1);
