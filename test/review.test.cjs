'use strict';
/**
 * test/review.test.cjs —— T4 硬验收用例（spec §4，v2 重定位：AI 判断可审计基础设施）
 *
 * 全部用 mock + 纯函数驱动（复用 buildFinding 构造输入），不依赖真实浏览器。
 * 沿用 T2 test/layer1.test.cjs 的 check('X. …') 标注风格，确保可追溯。
 *
 * 覆盖：A / B / C / D1 / D2 + 对照1（confirmed→ignored 刷新审计）/ 对照2（ignored→pending 清空审计）
 *       + E1（confidence≠high 进 confirmed 被拒）/ E2（high 但证据空壳被拒）/
 *         E2b（high 但 evidence 空壳对象被拒）/ E3（confirmed 证据完整率，只报数不改状态）/
 *         E4（judgmentSource 缺失/非法进 confirmed 被拒）
 */

const assert = require('assert');
const path = require('path');
const { buildFinding } = require(path.join(__dirname, '..', 'explore.cjs'));
const {
  ensureReviewFields, validateSchema, transition, writeback, processFindings,
} = require(path.join(__dirname, '..', 'review.cjs'));

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

// 高可信发现（满足闸门）：crash + rootEmpty → confidence=high，evidence 含实质
function highFinding(extra) {
  return Object.assign(
    buildFinding({ oracle: 'crash', evidence: { rootEmpty: true } }),
    extra || {}
  );
}

// ---------------------------------------------------------------------------
console.log('\n=== T4 AI 判断可审计基础设施 硬验收用例 ===\n');

// ---- A. 落盘 schema（字段改名 + 占位移除） ----
check('A. 落盘 schema → reviewStatus=pending & linkedSpecRefs=[] & validateSchema 不抛 & 无 reviewReserved/旧字段', () => {
  const f = ensureReviewFields(highFinding());
  assert.strictEqual(f.reviewStatus, 'pending', '默认 reviewStatus 须为 pending');
  assert.ok(Array.isArray(f.linkedSpecRefs), 'linkedSpecRefs 须为数组');
  assert.strictEqual(f.linkedSpecRefs.length, 0, '默认 linkedSpecRefs 须为空数组 []');
  assert.strictEqual(f.judgmentSource, null, '默认 judgmentSource 须为 null');
  assert.strictEqual(f.judgedAt, null, '默认 judgedAt 须为 null');
  // 字段改名生效：不得残留旧名
  assert.ok(!('reviewedBy' in f), '不得残留旧字段 reviewedBy');
  assert.ok(!('reviewedAt' in f), '不得残留旧字段 reviewedAt');
  // schema 校验通过
  assert.strictEqual(validateSchema(f), true, 'validateSchema 不得抛错');
  // 占位已移除：T2 输出不得再含 reviewReserved
  assert.ok(!('reviewReserved' in f), 'T2 输出不得含 reviewReserved 占位字段');
});

// ---- B. 状态机非法转移（confirmed → pending 被拒） ----
check('B. 状态机非法转移 → confirmed→pending 抛错且状态不变', () => {
  const f = ensureReviewFields(highFinding());
  transition(f, 'confirmed', 'human:alice'); // pending → confirmed 合法
  assert.strictEqual(f.reviewStatus, 'confirmed', '前置：已置为 confirmed');

  let threw = false;
  try {
    transition(f, 'pending', 'human:bob');
  } catch (e) {
    threw = true;
    assert.ok(/illegal transition/.test(e.message), '错误应指明 illegal transition，实际=' + e.message);
  }
  assert.strictEqual(threw, true, 'confirmed→pending 必须抛错');
  assert.strictEqual(f.reviewStatus, 'confirmed', '非法转移后状态须保持不变（仍为 confirmed）');
});

// ---- C. 合法转移落审计（pending → confirmed，合法性来自证据闸门） ----
check('C. 合法转移落审计 → judgmentSource/judgedAt 非空且 ISO 合法（confirmed 来自证据闸门）', () => {
  const f = ensureReviewFields(highFinding());
  assert.strictEqual(f.reviewStatus, 'pending', '前置：起始 pending');
  transition(f, 'confirmed', 'human:alice'); // 满足闸门（high + evidence 实质 + 合法源）

  assert.strictEqual(f.judgmentSource, 'human:alice', 'judgmentSource 须为 human:alice');
  assert.strictEqual(typeof f.judgedAt, 'string', 'judgedAt 须为字符串');
  assert.ok(f.judgedAt && f.judgedAt.length > 0, 'judgedAt 须非空');
  assert.ok(!isNaN(Date.parse(f.judgedAt)), 'judgedAt 须为合法 ISO 时间戳，实际=' + f.judgedAt);
});

// ---- D1. 第 3 层回写幂等（同 spec） ----
check('D1. 同 spec 幂等 → linkedSpecRefs 去重长度1 & 已有 judgmentSource 不被覆盖', () => {
  const f = ensureReviewFields(highFinding());
  f.judgmentSource = 'human:reviewer'; // 预先手动设判断来源

  writeback(f, 'rule:specA#frag', null, 'rule:specA');
  writeback(f, 'rule:specA#frag', null, 'rule:specA');
  writeback(f, 'rule:specA#frag', null, 'rule:specA');

  assert.strictEqual(f.linkedSpecRefs.length, 1, '同 specRef 重复追加须去重（长度 1）');
  assert.strictEqual(f.linkedSpecRefs[0], 'rule:specA#frag');
  assert.strictEqual(f.judgmentSource, 'human:reviewer', '不声明状态时 judgmentSource 不被覆盖');
  assert.strictEqual(f.reviewStatus, 'pending', '不声明状态时 reviewStatus 仍 pending（人不审不动）');
});

// ---- D2. 第 3 层回写幂等（跨 spec 不覆盖） ----
check('D2. 跨 spec 不覆盖 → linkedSpecRefs 含两者 & judgmentSource 仍为 rule:specA', () => {
  const f2 = ensureReviewFields(highFinding());
  transition(f2, 'confirmed', 'rule:specA');                 // 规则确认，judgmentSource='rule:specA'
  writeback(f2, 'rule:specA#frag', 'confirmed', 'rule:specA'); // specA 声明 confirmed → 自环不刷新
  assert.deepStrictEqual(f2.linkedSpecRefs, ['rule:specA#frag'], '第一步：linkedSpecRefs 仅含 rule:specA#frag');

  writeback(f2, 'rule:specB#frag', null, 'rule:specB');       // specB 仅引用不声明
  assert.strictEqual(f2.linkedSpecRefs.length, 2, '跨 spec 追加后长度应为 2');
  assert.ok(f2.linkedSpecRefs.includes('rule:specA#frag'), '须仍含 rule:specA#frag');
  assert.ok(f2.linkedSpecRefs.includes('rule:specB#frag'), '须含 rule:specB#frag');
  assert.strictEqual(f2.judgmentSource, 'rule:specA', 'specB 不声明状态时 judgmentSource 不被覆盖');
});

// ---- 对照1：confirmed → ignored 合法且刷新审计（不被旧值污染） ----
check('对照1. confirmed→ignored 刷新审计 → judgmentSource 被新值覆盖', () => {
  const f3 = ensureReviewFields(highFinding());
  transition(f3, 'confirmed', 'human:alice');             // judgmentSource='human:alice'
  assert.strictEqual(f3.judgmentSource, 'human:alice', '前置：confirmed 后 judgmentSource=human:alice');
  transition(f3, 'ignored', 'human:bob');                 // 改判误报
  assert.strictEqual(f3.reviewStatus, 'ignored', '状态须变为 ignored');
  assert.strictEqual(f3.judgmentSource, 'human:bob', 'judgmentSource 须被新值 human:bob 覆盖，不被旧值污染');
  assert.ok(!isNaN(Date.parse(f3.judgedAt)), 'judgedAt 须刷新为合法 ISO');
});

// ---- 对照2：ignored → pending 合法且清空审计 ----
check('对照2. ignored→pending 清空审计 → judgmentSource/judgedAt 回 null', () => {
  const f4 = ensureReviewFields(highFinding());
  transition(f4, 'ignored', 'human:alice');               // judgmentSource='human:alice'
  assert.strictEqual(f4.judgmentSource, 'human:alice', '前置：ignored 后 judgmentSource=human:alice');
  transition(f4, 'pending');                              // 重开复核（无 by）
  assert.strictEqual(f4.reviewStatus, 'pending', '状态须变为 pending');
  assert.strictEqual(f4.judgmentSource, null, '重开须清空 judgmentSource（回 null）');
  assert.strictEqual(f4.judgedAt, null, '重开须清空 judgedAt（回 null）');
});

// ---- E1. 闸门：confidence ≠ high 进 confirmed 被拒 ----
check('E1. 闸门 → confidence=medium-incomplete-evidence 进 confirmed 被拒（evidence-incomplete）', () => {
  const f = ensureReviewFields({
    id: 'e1', confidence: 'medium-incomplete-evidence',
    evidence: { rootEmpty: true }, reproPath: ['a', 'b'], judgmentSource: 'human:x',
  });
  let threw = false;
  try {
    transition(f, 'confirmed', 'human:x');
  } catch (e) {
    threw = true;
    assert.ok(/evidence-incomplete/.test(e.message), '应抛 evidence-incomplete，实际=' + e.message);
  }
  assert.strictEqual(threw, true, 'medium-incomplete-evidence 进 confirmed 必须被拒');
  assert.strictEqual(f.reviewStatus, 'pending', '被拒后状态不变（仍 pending）');
});

// ---- E2. 闸门：high 但证据全空（evidence={} 且 reproPath=[]）被拒 ----
check('E2. 闸门 → confidence=high 但 evidence 全空 + reproPath 空 进 confirmed 被拒', () => {
  const f = ensureReviewFields({
    id: 'e2', confidence: 'high',
    evidence: {}, reproPath: [], judgmentSource: 'human:x',
  });
  let threw = false;
  try {
    transition(f, 'confirmed', 'human:x');
  } catch (e) {
    threw = true;
    assert.ok(/evidence-incomplete/.test(e.message), '应抛 evidence-incomplete，实际=' + e.message);
  }
  assert.strictEqual(threw, true, '证据全空进 confirmed 必须被拒');
});

// ---- E2b. 闸门：high 但 evidence 是空壳对象（字段都在但全空/空）被拒 ----
check('E2b. 闸门 → confidence=high 但 evidence 空壳{log/screenshot/request 类全空} 进 confirmed 被拒', () => {
  const f = ensureReviewFields({
    id: 'e2b', confidence: 'high',
    // 形似有字段，实则全部空 / null → 无实质内容
    evidence: { message: '', stack: null, status: null, screenshot: null, request: {} },
    reproPath: [], judgmentSource: 'human:x',
  });
  let threw = false;
  try {
    transition(f, 'confirmed', 'human:x');
  } catch (e) {
    threw = true;
    assert.ok(/evidence-incomplete/.test(e.message), '应抛 evidence-incomplete，实际=' + e.message);
  }
  assert.strictEqual(threw, true, '空壳 evidence 进 confirmed 必须被拒（不得混进 confirmed）');
});

// ---- E3. confirmed 证据完整率：只报数打标记，不降级（与状态机不冲突） ----
check('E3. processFindings 审计 → confirmedEvidenceCompleteness 可观测 & 缺陷打 evidenceAuditFlag & 不降级', () => {
  const good = ensureReviewFields({
    id: 'good', confidence: 'high', evidence: { rootEmpty: true }, reproPath: ['a'], judgmentSource: 'oracle:dom',
  });
  good.reviewStatus = 'confirmed'; // 满足闸门（证据齐全）

  const bad = ensureReviewFields({
    id: 'bad', confidence: 'medium-heuristic', evidence: { timeoutMs: 16000 }, reproPath: [], judgmentSource: 'model:foo',
  });
  bad.reviewStatus = 'confirmed'; // legacy / 绕过闸门：已被置 confirmed 但证据不足

  const { findings, metrics } = processFindings([good, bad]);

  assert.strictEqual(metrics.confirmedCount, 2, 'confirmedCount 须为 2');
  assert.strictEqual(metrics.confirmedComplete, 1, 'confirmedComplete 须为 1');
  assert.strictEqual(metrics.confirmedEvidenceCompleteness, 0.5, '完整率须为 0.5（即「是否给幻觉盖章」指标）');
  assert.deepStrictEqual(metrics.deficientIds, ['bad'], 'deficientIds 须含 bad');

  const badOut = findings.find((x) => x.id === 'bad');
  const goodOut = findings.find((x) => x.id === 'good');
  assert.strictEqual(badOut.evidenceAuditFlag, true, '缺陷 confirmed 须打 evidenceAuditFlag=true');
  assert.strictEqual(badOut.reviewStatus, 'confirmed', 'E3 不得自动降级（状态仍 confirmed，交由人工/状态机处理）');
  assert.ok(!('evidenceAuditFlag' in goodOut) || goodOut.evidenceAuditFlag !== true, '完整 confirmed 不打标记');
});

// ---- E4. 闸门：judgmentSource 缺失 / 非法 进 confirmed 被拒 ----
check('E4. 闸门 → judgmentSource 缺失或非法（非 oracle:/rule:/model:/human:）进 confirmed 被拒', () => {
  // 4a. 缺失（by 与 f.judgmentSource 都为空）
  const fNull = ensureReviewFields({
    id: 'e4a', confidence: 'high', evidence: { rootEmpty: true }, reproPath: ['a'], judgmentSource: null,
  });
  let threwNull = false;
  try { transition(fNull, 'confirmed'); } catch (e) {
    threwNull = true;
    assert.ok(/judgment-source-missing/.test(e.message), '应抛 judgment-source-missing，实际=' + e.message);
  }
  assert.strictEqual(threwNull, true, 'judgmentSource 缺失进 confirmed 必须被拒');
  assert.strictEqual(fNull.reviewStatus, 'pending', '被拒后状态不变');

  // 4b. 非法前缀（'spec' 不在四类中）
  const fBad = ensureReviewFields({
    id: 'e4b', confidence: 'high', evidence: { rootEmpty: true }, reproPath: ['a'], judgmentSource: null,
  });
  let threwBad = false;
  try { transition(fBad, 'confirmed', 'spec'); } catch (e) {
    threwBad = true;
    assert.ok(/judgment-source-missing/.test(e.message), '应抛 judgment-source-missing，实际=' + e.message);
  }
  assert.strictEqual(threwBad, true, 'judgmentSource=spec 非法前缀进 confirmed 必须被拒');
});

// ---------------------------------------------------------------------------
console.log('\n=== 结果汇总 ===');
console.log(results.join('\n'));
console.log('\n通过: ' + passed + '  失败: ' + failed);
process.exit(failed === 0 ? 0 : 1);
