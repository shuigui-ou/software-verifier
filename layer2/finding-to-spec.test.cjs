'use strict';
// T7 finding-to-spec 验收：G1~G6、G8~G15 + G7a（G7b 记 N/A，不记 PASS）
// mock 级：沙箱无真机，翻译与对账全部用 mock findings + 唯一临时目录验证。
// 真实链路：G9 / G15 走**真模块**（T5 候选分级模块 + T4 状态机模块）验证接线，
// 独立于 mock 断言 —— 独立性纪律只约束 T7 模块**源码**，测试文件可以 require 真实模块（规格明确允许）。
// 真实模块一律**惰性 require**：G6 运行时独立性断言要求「跑完 G6 时这些模块尚未进 require.cache」，
// 故只能在 G9/G15（排在 G6 之后）才加载，否则会把 G6 的真断言变成恒假。
const assert = require('assert');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const mod = require('./finding-to-spec.cjs');

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    fn();
    pass++;
    console.log('  PASS  ' + name);
  } catch (e) {
    fail++;
    console.log('  FAIL  ' + name + '  -> ' + e.message);
  }
}
function deepEqual(a, b) {
  assert.deepStrictEqual(a, b);
}
function sha(p) {
  return crypto.createHash('sha1').update(fs.readFileSync(p, 'utf8')).digest('hex');
}

// 唯一临时目录：只创建、不删除（沙箱删除护栏）；零清理由操作系统回收
let dirSeq = 0;
function tmpDir(tag) {
  const d = path.join(os.tmpdir(), 'sv_t7_' + tag + '_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex') + '_' + (dirSeq++));
  fs.mkdirSync(d, { recursive: true });
  return d;
}

// mock findings 构造（字段形状对齐 explore.cjs buildFinding + review 字段）
function mkFinding(o) {
  return Object.assign({
    id: 'l1-mock',
    layer: 1,
    oracle: 'requestfailed',
    confidence: 'high',
    suspect: true,
    businessPass: false,
    reproPath: [],
    evidence: {},
    falsePositiveNote: '',
    candidateSpecReserved: null,
    reviewStatus: 'confirmed',
    judgmentSource: 'rule:spec-gen',
    judgedAt: '2026-08-28T00:00:00.000Z',
    linkedSpecRefs: [],
  }, o);
}

function writeFindings(dir, findings) {
  const p = path.join(dir, 'layer1-findings.json');
  fs.writeFileSync(p, JSON.stringify(findings, null, 2));
  return p;
}

// ---------------------------------------------------------------------------
// 真实链路惰性加载（G9 / G15 用；必须排在 G6 之后调用，否则 G6 运行时独立性断言会变恒假）
// ---------------------------------------------------------------------------
let realChainCache = null;
function realChain() {
  if (!realChainCache) {
    const parent = path.join(__dirname, '..');
    // eslint-disable-next-line global-require
    realChainCache = {
      buildFinding: require(path.join(parent, 'explore.cjs')).buildFinding,
      review: require(path.join(parent, 'review.cjs')),
      cs: require(path.join(__dirname, 'candidate-spec.cjs')),
    };
  }
  return realChainCache;
}

/**
 * 真实 confirmed finding fixture：用 Layer 1 真实构造器 + 状态机真实字段补齐，
 * 再走**真实状态机**进 confirmed（过证据闸门），确保 confidence=high / evidence 有实质。
 */
function mkRealConfirmedFinding(id, over) {
  const { buildFinding, review } = realChain();
  const f = review.ensureReviewFields(buildFinding(Object.assign({
    oracle: 'crash',
    evidence: { rootEmpty: true },
  }, over || {})));
  f.id = id;
  review.transition(f, 'confirmed', 'rule:spec-gen'); // 真实状态机：pending -> confirmed（过闸门）
  assert.strictEqual(f.reviewStatus, 'confirmed', '测试前提：finding 已真实进 confirmed');
  assert.strictEqual(f.confidence, 'high', '测试前提：confidence 须 high（高置信才可能过 applied 闸门）');
  return f;
}

function byId(list) {
  const m = {};
  list.forEach((f) => { m[f.id] = f; });
  return m;
}

/**
 * 推进时钟跨过至少 1ms（同步阻塞）。
 * 审计字段是毫秒精度 ISO 串，两次相邻的状态机调用可能落在同一毫秒内 →
 * 「审计被刷新」若用严格不等断言就是随机 flaky。推进时钟后该断言才是确定的真断言。
 */
function tickClock() {
  const target = Date.now() + 2;
  while (Date.now() < target) {
    // 忙等：Atomics.wait 阻塞当前线程，无需异步
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
  }
}

const T0 = 1756339200000; // 固定时钟起点，便于断言 updatedAt 刷新

// ---------- G1. requestfailed 可译翻译 ----------
check('G1. requestfailed（evidence.url 存在）→ status-2xx + regressionOnly + originFindingId 正确', () => {
  const f = mkFinding({ id: 'f-req-1', oracle: 'requestfailed', evidence: { url: 'https://x.test/api/orders', status: 500 } });
  assert.strictEqual(mod.classifyTranslatability(f), 'translatable');
  const spec = mod.translateFinding(f, { nowMs: T0 });
  assert.strictEqual(spec.translatable, undefined, '可译时不应带 translatable:false 标记');
  assert.strictEqual(spec.id, 'regr-f-req-1');
  assert.strictEqual(spec.origin, 'layer1-confirmed');
  assert.strictEqual(spec.originFindingId, 'f-req-1');
  assert.strictEqual(spec.oracle, 'requestfailed');
  assert.strictEqual(spec.assertionType, 'status-2xx');
  assert.strictEqual(spec.regressionOnly, true);
  assert.strictEqual(spec.translatability, 'translatable');
  assert.deepStrictEqual(spec.expected.status, '2xx');
  assert.ok(String(spec.expected.url).indexOf('api/orders') !== -1, 'expected.url 应来自 evidence.url');
  assert.ok(spec.target && String(spec.target).indexOf('api/orders') !== -1, 'target 应锚定到 url');
  assert.ok(typeof spec.notes === 'string' && spec.notes.length > 0);
});

check('G1. spec schema 字段齐全（§5 全字段）', () => {
  const f = mkFinding({ id: 'f-schema', oracle: 'requestfailed', evidence: { url: 'https://x.test/a' } });
  const s = mod.translateFinding(f, { nowMs: T0 });
  const required = ['id', 'origin', 'originFindingId', 'oracle', 'target', 'assertionType', 'expected',
    'reproPath', 'regressionOnly', 'translatability', 'notes', 'updatedAt', 'prevTranslations',
    'regressionLoopCount', 'loopExhausted', 'deprecated', 'deprecateReason', 'supersededBy'];
  required.forEach((k) => assert.ok(Object.prototype.hasOwnProperty.call(s, k), 'spec 缺字段 ' + k));
  assert.strictEqual(s.updatedAt, new Date(T0).toISOString());
});

// ---------- G2. dead-link / crash / pageerror 同类翻译 ----------
check('G2. dead-link（href 存在）→ href-200，无需 reproPath', () => {
  const f = mkFinding({ id: 'f-dead-1', oracle: 'dead-link', evidence: { href: 'https://x.test/gone', status: 404 } });
  assert.strictEqual(mod.classifyTranslatability(f), 'translatable');
  const s = mod.translateFinding(f, { nowMs: T0 });
  assert.strictEqual(s.assertionType, 'href-200');
  assert.strictEqual(s.regressionOnly, true);
  assert.deepStrictEqual(s.expected, { status: 200, href: 'https://x.test/gone' });
  assert.deepStrictEqual(s.reproPath, [], 'dead-link 不要求 reproPath');
});

check('G2. crash（rootEmpty）→ root-nonempty，无需 reproPath', () => {
  const f = mkFinding({ id: 'f-crash-1', oracle: 'crash', evidence: { rootEmpty: true } });
  assert.strictEqual(mod.classifyTranslatability(f), 'translatable');
  const s = mod.translateFinding(f, { nowMs: T0 });
  assert.strictEqual(s.assertionType, 'root-nonempty');
  assert.deepStrictEqual(s.expected, { rootNonempty: true });
  assert.strictEqual(s.regressionOnly, true);
});

check('G2. pageerror（有 reproPath）→ no-pageerror', () => {
  const f = mkFinding({ id: 'f-pe-1', oracle: 'pageerror', evidence: { message: 'TypeError: x is not a function' }, reproPath: ['https://x.test/', 'click:#pay'] });
  const s = mod.translateFinding(f, { nowMs: T0 });
  assert.strictEqual(s.assertionType, 'no-pageerror');
  assert.deepStrictEqual(s.expected, { noPageError: true });
  assert.deepStrictEqual(s.reproPath, ['https://x.test/', 'click:#pay']);
});

check('G2. pageerror 仅 target 非空亦可译（reproPath 或 target 其一即可）', () => {
  const f = mkFinding({ id: 'f-pe-2', oracle: 'pageerror', evidence: { message: 'boom' }, target: '#checkout' });
  assert.strictEqual(mod.classifyTranslatability(f), 'translatable');
  const s = mod.translateFinding(f, { nowMs: T0 });
  assert.strictEqual(s.assertionType, 'no-pageerror');
  assert.strictEqual(s.target, '#checkout');
});

// ---------- G3. conditional 前置不满足 → not-translatable ----------
check('G3. empty-state + precondition=not-met → not-translatable（reason=precondition-not-met）', () => {
  const f = mkFinding({ id: 'f-es-1', oracle: 'empty-state', precondition: 'not-met', evidence: { hasData: true, loginWall: true } });
  assert.strictEqual(mod.classifyTranslatability(f), 'not-translatable');
  const r = mod.translateFinding(f, { nowMs: T0 });
  assert.strictEqual(r.translatable, false);
  assert.strictEqual(r.reason, 'precondition-not-met');
  assert.strictEqual(r.translatability, 'not-translatable');
  assert.strictEqual(r.assertionType, undefined, '不可译不得造出断言');
});

// ---------- G4. 证据 prose-only → not-translatable ----------
check('G4. requestfailed 全结构化字段缺失（无 url/target/reproPath）→ not-translatable', () => {
  const f = mkFinding({ id: 'f-prose', oracle: 'requestfailed', evidence: { text: '某个请求失败了，疑似后端异常' } });
  assert.strictEqual(mod.classifyTranslatability(f), 'not-translatable');
  const r = mod.translateFinding(f, { nowMs: T0 });
  assert.strictEqual(r.translatable, false);
  assert.strictEqual(r.reason, 'no-structured-field');
});

check('G4. 不可译 spec 交给 emitRegressionSpec → 跳过落盘（不留残文件）', () => {
  const dir = tmpDir('g4');
  const f = mkFinding({ id: 'f-prose-2', oracle: 'requestfailed', evidence: { text: '只有散文证据' } });
  const r = mod.translateFinding(f, { nowMs: T0 });
  const out = mod.emitRegressionSpec(r, dir, { confirmedIds: ['f-prose-2'], nowMs: T0 });
  assert.strictEqual(out.written.length, 0);
  assert.strictEqual(out.skipped, 'no-structured-field');
  assert.deepStrictEqual(fs.readdirSync(dir), [], '不可译不得写 spec 文件');
});

// ---------- G5. 幂等 = 原地更新 ----------
check('G5. 同 finding 连跑两次 → 只一条 spec 文件 + updatedAt 刷新 + prevTranslations≥1', () => {
  const dir = tmpDir('g5');
  const f = mkFinding({ id: 'f-idem', oracle: 'requestfailed', evidence: { url: 'https://x.test/idem' } });
  const first = mod.emitRegressionSpec(mod.translateFinding(f, { nowMs: T0 }), dir, { confirmedIds: ['f-idem'], nowMs: T0 });
  assert.strictEqual(first.written.length, 1);
  const file = first.written[0];
  const v1 = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepStrictEqual(v1.prevTranslations, [], '首次落盘无历史版本');

  const second = mod.emitRegressionSpec(mod.translateFinding(f, { nowMs: T0 + 60000 }), dir, { confirmedIds: ['f-idem'], nowMs: T0 + 60000 });
  assert.strictEqual(second.written.length, 1);
  assert.strictEqual(second.written[0], file, '必须原地更新同一文件');
  assert.strictEqual(fs.readdirSync(dir).length, 1, '不得新建第二条 spec 文件');
  const v2 = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.notStrictEqual(v2.updatedAt, v1.updatedAt, 'updatedAt 必须刷新');
  assert.ok(v2.prevTranslations.length >= 1, '旧版本摘要必须进 prevTranslations');
  assert.strictEqual(v2.prevTranslations[0].assertionType, 'status-2xx');
});

check('G5. confirmed→ignored→confirmed 重跑：仍一条文件，历史链完整', () => {
  const dir = tmpDir('g5b');
  const f = mkFinding({ id: 'f-chain', oracle: 'requestfailed', evidence: { url: 'https://x.test/chain' } });
  mod.emitRegressionSpec(mod.translateFinding(f, { nowMs: T0 }), dir, { confirmedIds: ['f-chain'], nowMs: T0 });
  // finding 被判误报 → ignored：对账应标 deprecated
  mod.emitRegressionSpec(mod.translateFinding(f, { nowMs: T0 + 1000 }), dir, { confirmedIds: [], nowMs: T0 + 1000 });
  // 回到 confirmed → 恢复 + 追加历史
  mod.emitRegressionSpec(mod.translateFinding(f, { nowMs: T0 + 2000 }), dir, { confirmedIds: ['f-chain'], nowMs: T0 + 2000 });
  assert.strictEqual(fs.readdirSync(dir).length, 1, '全流程仍只一条 spec');
  const v = JSON.parse(fs.readFileSync(path.join(dir, 'regr-f-chain.json'), 'utf8'));
  assert.strictEqual(v.deprecated, false);
  assert.ok(v.prevTranslations.length >= 2, '每次原地更新都留历史摘要');
});

// ---------- G6. 独立性（静态 + 运行时 + 只读路径）----------
check('G6. 静态：源码零命中状态机模块 / 状态转移 / 候选应用 / 候选分级模块', () => {
  const src = fs.readFileSync(__filename.replace(/\.test\.cjs$/, '.cjs'), 'utf8');
  assert.strictEqual(/require\(['"][^'"]*review/.test(src), false, '源码不得 require 任何 review 相关模块');
  assert.strictEqual(/require\(['"][^'"]*candidate-spec/.test(src), false, '源码不得 require 候选分级模块');
  assert.strictEqual(src.indexOf('review.cjs'), -1, '源码不得引用 review.cjs');
  assert.strictEqual(src.indexOf('candidate-spec.cjs'), -1, '源码不得引用候选分级模块文件名');
  assert.strictEqual(src.indexOf('transition'), -1, '源码不得引用状态转移入口');
  assert.strictEqual(src.indexOf('applyCandidateSpec'), -1, '源码不得引用候选应用入口');
});

check('G6. 运行时：require.cache 未加载 review.cjs，导出对象不含转移/应用入口', () => {
  const cached = Object.keys(require.cache).some((k) => /review\.cjs/.test(k));
  assert.strictEqual(cached, false, 'require.cache 不得加载 review.cjs');
  assert.strictEqual(typeof mod.transition, 'undefined');
  assert.strictEqual(typeof mod.applyCandidateSpec, 'undefined');
  assert.strictEqual(typeof mod.TRANSITIONS, 'undefined');
  assert.strictEqual(typeof mod.evidenceHasSubstance, 'undefined');
  assert.strictEqual(typeof mod.reproPathSubstantive, 'undefined');
});

check('G6. 只读路径：loadConfirmed 只读落盘且只取 reviewStatus=confirmed', () => {
  const dir = tmpDir('g6');
  const p = writeFindings(dir, [
    mkFinding({ id: 'a1' }),
    mkFinding({ id: 'a2', reviewStatus: 'ignored' }),
    mkFinding({ id: 'a3', reviewStatus: 'pending' }),
    mkFinding({ id: 'a4' }),
  ]);
  const before = sha(p);
  const got = mod.loadConfirmed(p);
  const after = sha(p);
  assert.strictEqual(before, after, 'loadConfirmed 不得修改落盘文件');
  assert.deepStrictEqual(got.map((x) => x.id), ['a1', 'a4']);
});

check('G6. 对账只读 findings：不改 findings、不引入状态判定入口', () => {
  const dir = tmpDir('g6b');
  const findings = [mkFinding({ id: 'b1', oracle: 'requestfailed', evidence: { url: 'https://x.test/b1' } })];
  const fp = writeFindings(dir, findings);
  const l3 = tmpDir('g6b_l3');
  mod.emitRegressionSpec(mod.translateFinding(findings[0], { nowMs: T0 }), l3, { findingsPath: fp, nowMs: T0 });
  const before = sha(fp);
  // findings 变 ignored → 走 findingsPath 对账（证明真读落盘、不靠外部集合）
  fs.writeFileSync(fp, JSON.stringify([Object.assign({}, findings[0], { reviewStatus: 'ignored' })], null, 2));
  const changed = sha(fp);
  assert.notStrictEqual(before, changed, '测试前提：findings 已改为 ignored');
  mod.emitRegressionSpec(mod.translateFinding(findings[0], { nowMs: T0 + 1000 }), l3, { findingsPath: fp, nowMs: T0 + 1000 });
  const v = JSON.parse(fs.readFileSync(path.join(l3, 'regr-b1.json'), 'utf8'));
  assert.strictEqual(v.deprecated, true);
  assert.strictEqual(v.deprecateReason, 'finding-no-longer-confirmed');
  const after = sha(fp);
  assert.strictEqual(after, changed, '对账过程不得回写 findings');
});

// ---------- G7a. regression-only 契约（真机隔离见 G7b，N/A）----------
check('G7a. 产出 spec 必含 regressionOnly:true（六类全查）', () => {
  const cases = [
    { id: 'g7-1', oracle: 'requestfailed', evidence: { url: 'https://x.test/a' } },
    { id: 'g7-2', oracle: 'dead-link', evidence: { href: 'https://x.test/b' } },
    { id: 'g7-3', oracle: 'crash', evidence: { rootEmpty: true } },
    { id: 'g7-4', oracle: 'pageerror', evidence: { message: 'boom' }, reproPath: ['https://x.test/', 'click:#a'] },
    { id: 'g7-5', oracle: 'timeout', evidence: { thresholdMs: 15000 } },
    { id: 'g7-6', oracle: 'empty-state', precondition: 'met', evidence: { hasData: true } },
  ];
  cases.forEach((c) => {
    const s = mod.translateFinding(mkFinding(c), { nowMs: T0 });
    assert.strictEqual(s.regressionOnly, true, c.oracle + ' 缺 regressionOnly:true');
    assert.strictEqual(s.origin, 'layer1-confirmed');
  });
  assert.deepStrictEqual(mod.TRANSLATABLE_ORACLES.concat(mod.CONDITIONAL_ORACLES).sort(),
    ['crash', 'dead-link', 'empty-state', 'pageerror', 'requestfailed', 'timeout'], '六类必须逐类枚举');
});

// ---------- G8. 回流防循环 ----------
check('G8. 连续 3 次回归失败 → loopExhausted，第 4 次不再自动 reopen', () => {
  assert.strictEqual(mod.MAX_REGRESSION_LOOP, 3);
  const f = mkFinding({ id: 'g8-1', oracle: 'requestfailed', evidence: { url: 'https://x.test/g8' } });
  let spec = mod.translateFinding(f, { nowMs: T0 });
  let r1 = mod.noteRegressionFailure(spec);
  assert.strictEqual(r1.canReopen, true);
  assert.strictEqual(r1.count, 1);
  let r2 = mod.noteRegressionFailure(r1.spec);
  assert.strictEqual(r2.canReopen, true);
  assert.strictEqual(r2.count, 2);
  let r3 = mod.noteRegressionFailure(r2.spec);
  assert.strictEqual(r3.count, 3);
  assert.strictEqual(r3.spec.loopExhausted, true, '达上限必须 loopExhausted');
  assert.strictEqual(r3.canReopen, false, '达上限不再自动 reopen');
  assert.strictEqual(r3.requiresHumanReview, true);
  const r4 = mod.noteRegressionFailure(r3.spec);
  assert.strictEqual(r4.canReopen, false, '第 4 次不得 reopen');
  assert.strictEqual(r4.spec.regressionLoopCount, 4);
  // 耗尽状态不被重翻译冲掉
  const dir = tmpDir('g8');
  mod.emitRegressionSpec(r3.spec, dir, { confirmedIds: ['g8-1'], nowMs: T0 });
  mod.emitRegressionSpec(mod.translateFinding(f, { nowMs: T0 + 1000 }), dir, { confirmedIds: ['g8-1'], nowMs: T0 + 1000 });
  const v = JSON.parse(fs.readFileSync(path.join(dir, 'regr-g8-1.json'), 'utf8'));
  assert.strictEqual(v.loopExhausted, true, '重翻译不得抹掉 loopExhausted');
  assert.strictEqual(v.regressionLoopCount, 3, '重翻译不得抹掉回流计数');
});

// ---------- G9. 合法变更状态流转（走真实链路，禁止 mock 假装 T5 判了合法变更）----------
check('G9. 类型屏障 + 真实链路：legit-change 不得构造候选 → 直投 T5 仍撞 ignored 硬闸门 → 人审直改状态机 → finding 真离开 confirmed + 审计刷新 → spec 废弃不再回流', () => {
  const { review, cs } = realChain();
  // 1) 真实 confirmed + confidence=high + evidence 有实质（真实构造器 + 真实状态机进 confirmed）
  const f = mkRealConfirmedFinding('g9-real', { oracle: 'requestfailed', evidence: { url: 'https://x.test/g9', status: 500 } });
  assert.ok(review.evidenceHasSubstance(f.evidence), '测试前提：evidence 有实质');
  const judgedAtBefore = f.judgedAt;
  const sourceBefore = f.judgmentSource;
  assert.ok(judgedAtBefore, '测试前提：进 confirmed 时审计已写');

  const spec = mod.translateFinding(f, { nowMs: T0 });
  // 2) 类型屏障：legitimate-change 不得构造候选（防误喂 T5 撞 AUTO_IGNORE_NOT_ALLOWED 死循环）
  assert.throws(() => mod.buildReopenedCandidateInput(f, spec, 'legitimate-change'),
    /legitimate-change 不走候选链/, 'legit-change 从类型上禁止构造候选');

  // 3) 真实 T5 候选分级：单独构造一个 ignored 候选（不走 buildReopenedCandidateInput，因为它已禁止），证明闸门仍拦
  const input = { references: [f.id], proposedStatus: 'ignored', generator: 'human:legitimate-change', referencedFindings: [f] };
  const cand = cs.buildCandidateSpec(input);
  assert.strictEqual(cand.proposedStatus, 'ignored');
  assert.strictEqual(cand.candidateConfidence, 'high', '原 finding high → 分级 high');
  assert.strictEqual(cand.humanReviewRequired, true, 'ignored 一律必人审');

  // 4) 真实候选应用 → 必须撞硬闸门
  const findingsById = byId([f]);
  const r = cs.applyCandidateSpec(cand, findingsById, review);
  assert.strictEqual(r.applied.length, 0, 'ignored 绝不自动应用');
  assert.strictEqual(r.needsHumanReview.length, 1, '必须落人审队列');
  assert.strictEqual(r.needsHumanReview[0].fid, f.id);
  assert.strictEqual(r.needsHumanReview[0].reason, 'auto-ignore-not-allowed', '必须是硬闸门理由（不是置信/生成源理由）');
  assert.strictEqual(f.reviewStatus, 'confirmed', '撞闸门不得改状态');
  assert.strictEqual(f.judgmentSource, sourceBefore, '撞闸门不得动审计');

  // 5) 人审界面直改状态机（合法变更路径的真实动作）
  tickClock(); // 保证审计时间戳跨毫秒，避免同毫秒碰撞让「审计刷新」断言变 flaky
  review.transition(f, 'ignored', 'human:legitimate-change');
  assert.strictEqual(f.reviewStatus, 'ignored', '合法变更后 finding 必须真的离开 confirmed');
  assert.strictEqual(f.judgmentSource, 'human:legitimate-change', '审计来源须换成人审判定');
  assert.ok(f.judgedAt, 'judgedAt 非空');
  assert.notStrictEqual(f.judgedAt, judgedAtBefore, '审计必须刷新（信息没丢的证据）');
  assert.notStrictEqual(f.judgmentSource, sourceBefore, '审计来源必须变化');

  // 6) spec 标废弃 → 不再回流
  const dep = mod.markDeprecated(spec, 'legitimate-change');
  assert.strictEqual(dep.deprecated, true);
  assert.strictEqual(dep.deprecateReason, 'legitimate-change');
  assert.strictEqual(mod.noteRegressionFailure(dep).canReopen, false, '废弃后不再回流');
});

check('G9. 人审后动作产出指引（不投自动应用链）：合法变更 → 指引置 ignored；真复发 → 产出候选输入 + 回流计数递增', () => {
  const f = mkFinding({ id: 'g9-act', oracle: 'requestfailed', evidence: { url: 'https://x.test/g9act' } });
  const spec = mod.translateFinding(f, { nowMs: T0 });

  // 路径 B（合法变更）：只出指引，绝不代调用方改状态
  const g = mod.applyHumanOutcome(f, spec, 'legitimate-change');
  assert.strictEqual(g.path, 'legitimate-change');
  assert.strictEqual(g.nextAction, mod.HUMAN_ACTION_NEXT);
  assert.strictEqual(g.findingId, f.id);
  assert.strictEqual(g.targetStatus, 'ignored');
  assert.strictEqual(g.judgmentSource, 'human:legitimate-change');
  assert.strictEqual(g.spec.deprecated, true, '指引同时把 spec 标废弃');
  assert.strictEqual(g.spec.deprecateReason, 'legitimate-change');
  assert.strictEqual(g.canReopen, false);
  assert.strictEqual(f.reviewStatus, 'confirmed', 'T7 侧不得代改 finding 状态');
  assert.strictEqual(g.candidateInput, undefined, '合法变更不得产出候选应用输入');

  // 合法变更可附后继断言 + 废弃状态可落盘（幂等原地更新沿用既有逻辑）
  const g2 = mod.applyHumanOutcome(f, spec, 'legitimate-change', { supersededBy: 'regr-g9-act-v2' });
  assert.strictEqual(g2.spec.supersededBy, 'regr-g9-act-v2');
  const dir = tmpDir('g9');
  mod.emitRegressionSpec(g2.spec, dir, { confirmedIds: ['g9-act'], nowMs: T0 });
  const persisted = JSON.parse(fs.readFileSync(path.join(dir, 'regr-g9-act.json'), 'utf8'));
  assert.strictEqual(persisted.deprecated, true);
  assert.strictEqual(persisted.deprecateReason, 'legitimate-change');

  // 路径 A（真复发）：产出候选输入 + 回流计数递增
  const a = mod.applyHumanOutcome(f, spec, 'recurrence');
  assert.strictEqual(a.path, 'recurrence');
  assert.strictEqual(a.candidateInput.outcome, 'recurrence');
  assert.strictEqual(a.candidateInput.proposedStatus, 'confirmed');
  assert.strictEqual(a.candidateInput.generator, 'rule:regression-reopen');
  assert.strictEqual(a.spec.regressionLoopCount, 1, '真复发必须递增回流计数');
  assert.strictEqual(a.loopExhausted, false);

  // 未判定不得触发人审后动作（无判定就没有人审动作）
  assert.throws(() => mod.applyHumanOutcome(f, spec, null), /未判定/);
  assert.throws(() => mod.applyHumanOutcome(f, spec, 'xxx'), /非法/);
});

check('G9. deprecated 与 loopExhausted 互斥于回流动作（任一为真即不回流）', () => {
  const base = { id: 'regr-x', regressionLoopCount: 0, loopExhausted: false, deprecated: false };
  assert.strictEqual(mod.noteRegressionFailure(base).canReopen, true);
  assert.strictEqual(mod.noteRegressionFailure(Object.assign({}, base, { deprecated: true })).canReopen, false);
  assert.strictEqual(mod.noteRegressionFailure(Object.assign({}, base, { loopExhausted: true })).canReopen, false);
});

// ---------- G10. pageerror 无 reproPath/target ----------
check('G10. pageerror 仅 message、reproPath 与 target 均空 → not-translatable（pageerror-without-repro-path）', () => {
  const f = mkFinding({ id: 'g10-1', oracle: 'pageerror', evidence: { message: 'TypeError: undefined is not a function' } });
  assert.strictEqual(mod.classifyTranslatability(f), 'not-translatable');
  const r = mod.translateFinding(f, { nowMs: T0 });
  assert.strictEqual(r.translatable, false);
  assert.strictEqual(r.reason, 'pageerror-without-repro-path');
});

check('G10. 反例对照：补上 reproPath → 可译（no-pageerror）', () => {
  const f = mkFinding({ id: 'g10-2', oracle: 'pageerror', evidence: { message: 'TypeError: undefined is not a function' }, reproPath: ['https://x.test/', 'click:#submit'] });
  assert.strictEqual(mod.classifyTranslatability(f), 'translatable');
  const s = mod.translateFinding(f, { nowMs: T0 });
  assert.strictEqual(s.assertionType, 'no-pageerror');
  assert.strictEqual(s.regressionOnly, true);
});

// ---------- G11. empty-state precondition 三态 + 缺失 ----------
check('G11. precondition=met → conditional 可译（container-nonempty）', () => {
  const f = mkFinding({ id: 'g11-1', oracle: 'empty-state', precondition: 'met', evidence: { hasData: true } });
  assert.strictEqual(mod.classifyTranslatability(f), 'conditional');
  const s = mod.translateFinding(f, { nowMs: T0 });
  assert.strictEqual(s.translatability, 'conditional');
  assert.strictEqual(s.assertionType, 'container-nonempty');
  assert.strictEqual(s.regressionOnly, true);
});

check('G11. precondition=not-met / unknown / 字段缺失 → 三种 reason 各不相同', () => {
  const nm = mod.translateFinding(mkFinding({ id: 'g11-2', oracle: 'empty-state', precondition: 'not-met', evidence: { hasData: true } }), { nowMs: T0 });
  assert.strictEqual(nm.reason, 'precondition-not-met');
  const uk = mod.translateFinding(mkFinding({ id: 'g11-3', oracle: 'empty-state', precondition: 'unknown', evidence: { hasData: true } }), { nowMs: T0 });
  assert.strictEqual(uk.reason, 'precondition-unknown');
  const absent = mkFinding({ id: 'g11-4', oracle: 'empty-state', evidence: { hasData: true } });
  delete absent.precondition;
  const ab = mod.translateFinding(absent, { nowMs: T0 });
  assert.strictEqual(ab.reason, 'precondition-field-absent', '字段缺失绝不默认当 met');
  assert.strictEqual(mod.classifyTranslatability(absent), 'not-translatable');
  [nm, uk, ab].forEach((r) => assert.strictEqual(r.translatable, false, '非 met 一律不可译'));
});

check('G11. timeout 无阈值 → timeout-without-threshold；有阈值 → conditional 可译', () => {
  const noN = mod.translateFinding(mkFinding({ id: 'g11-5', oracle: 'timeout', evidence: { text: '等了很久' } }), { nowMs: T0 });
  assert.strictEqual(noN.reason, 'timeout-without-threshold');
  const withN = mod.translateFinding(mkFinding({ id: 'g11-6', oracle: 'timeout', evidence: { thresholdMs: 15000 } }), { nowMs: T0 });
  assert.strictEqual(withN.translatability, 'conditional');
  assert.strictEqual(withN.assertionType, 'completes-within-ms');
  assert.strictEqual(withN.expected.maxMs, 15000);
  // finding 级同名字段也认
  const onFinding = mod.translateFinding(mkFinding({ id: 'g11-7', oracle: 'timeout', timeoutMs: 8000 }), { nowMs: T0 });
  assert.strictEqual(onFinding.expected.maxMs, 8000);
});

// ---------- G12. reopened candidate 字段映射 ----------
check('G12. reopened candidate：references=[id] / proposedStatus=null（未判定不主张状态）/ generator=rule:regression-reopen', () => {
  const f = mkFinding({ id: 'g12-1', oracle: 'requestfailed', evidence: { url: 'https://x.test/g12' } });
  const spec = mod.translateFinding(f, { nowMs: T0 });
  const input = mod.buildReopenedCandidateInput(f, spec);
  deepEqual(input.references, ['g12-1']);
  // 未判定时 proposedStatus 必须是 null：填 confirmed 等于自动流程预设「这是真复发」，与「outcome 归人审」自相矛盾
  assert.strictEqual(input.proposedStatus, null, '未判定不主张任何状态（不预判 confirmed，也不预判 ignored）');
  assert.strictEqual(input.generator, 'rule:regression-reopen');
  assert.strictEqual(input.referencedFindings.length, 1);
  assert.strictEqual(input.referencedFindings[0], f, '引用的是落盘原 finding，不重新探测');
  assert.strictEqual(input.origin, 'regression-spec');
  assert.strictEqual(input.regressionSpecId, spec.id);
});

check('G12. generator 匹配 GENERATOR_RE 且落入确定性白名单（model:* 被拒）', () => {
  // 复刻 T5 侧两条前缀约束（本模块不引入 T5 分级模块，故在测试内联同一正则）
  const GENERATOR_RE = /^(oracle:|rule:|model:|human:)/;
  const DETERMINISTIC_RE = /^(rule:|oracle:)/;
  const f = mkFinding({ id: 'g12-2', oracle: 'requestfailed', evidence: { url: 'https://x.test/g12b' } });
  const input = mod.buildReopenedCandidateInput(f, mod.translateFinding(f, { nowMs: T0 }));
  assert.strictEqual(GENERATOR_RE.test(input.generator), true, '必须匹配 GENERATOR_RE');
  assert.strictEqual(DETERMINISTIC_RE.test(input.generator), true, '必须确定性（免人审豁免）');
  // 反例：model:* 前缀合法但非确定性 → 必被确定性白名单拒绝
  const bad = 'model:regression-reopen';
  assert.strictEqual(GENERATOR_RE.test(bad), true);
  assert.strictEqual(DETERMINISTIC_RE.test(bad), false, 'model:* 必被拒');
  assert.notStrictEqual(input.generator, bad, '本模块绝不用 model:*');
});

check('G12. 不手填 candidateConfidence / humanReviewRequired / basis', () => {
  const f = mkFinding({ id: 'g12-3', oracle: 'requestfailed', evidence: { url: 'https://x.test/g12c' } });
  const input = mod.buildReopenedCandidateInput(f, mod.translateFinding(f, { nowMs: T0 }));
  ['candidateConfidence', 'humanReviewRequired', 'basis', 'linkedFindings', 'id', 'generatedAt'].forEach((k) => {
    assert.strictEqual(Object.prototype.hasOwnProperty.call(input, k), false, 'T7 不得手填 ' + k);
  });
});

check('G12. outcome 三态：未判定不主张状态 / recurrence→confirmed+rule: / legitimate-change→buildReopenedCandidateInput 抛错（不走候选链）', () => {
  const f = mkFinding({ id: 'g12-oc', oracle: 'requestfailed', evidence: { url: 'https://x.test/g12oc' } });
  const spec = mod.translateFinding(f, { nowMs: T0 });

  // ① 自动流程（不传第三参）→ outcome=null，且绝不猜成 recurrence；状态一律留空（不主张）
  const undecided = mod.buildReopenedCandidateInput(f, spec);
  assert.strictEqual(undecided.outcome, null, '未判定必须是 null');
  assert.notStrictEqual(undecided.outcome, 'recurrence', 'T7 绝不自己猜真伪');
  assert.strictEqual(undecided.proposedStatus, null, '未判定不主张状态：既不预判 confirmed，也不预判 ignored');
  assert.strictEqual(undecided.generator, 'rule:regression-reopen', '回归失败是确定性事实，来源仍记 rule: 前缀');
  assert.strictEqual(mod.normalizeOutcome(undefined), null);
  assert.strictEqual(mod.normalizeOutcome(null), null);

  // ② 人审判定 recurrence
  const rec = mod.buildReopenedCandidateInput(f, spec, 'recurrence');
  assert.strictEqual(rec.outcome, 'recurrence');
  assert.strictEqual(rec.proposedStatus, 'confirmed');
  assert.strictEqual(rec.generator, 'rule:regression-reopen', '真复发走确定性前缀');

  // ③ 人审判定 legitimate-change：从类型上禁止构造候选（防误喂 T5 撞 AUTO_IGNORE_NOT_ALLOWED 死循环）
  assert.throws(() => mod.buildReopenedCandidateInput(f, spec, 'legitimate-change'),
    /legitimate-change 不走候选链/, 'legit-change 不走候选链：合法变更由人审界面直调 review.transition，本函数只产 recurrence/未判定 候选');
  // 未判定 / recurrence 两态都必须命中来源前缀约束
  const GENERATOR_RE = /^(oracle:|rule:|model:|human:)/;
  const DETERMINISTIC_RE = /^(rule:|oracle:)/;
  [undecided.generator, rec.generator].forEach((g) => {
    assert.strictEqual(GENERATOR_RE.test(g), true, 'generator 必须匹配前缀约束：' + g);
  });
  assert.strictEqual(DETERMINISTIC_RE.test(rec.generator), true, 'rule: 前缀确定性 → recurrence 可过闸门自动 applied');

  // ④ 非法 outcome 一律抛错，不许静默当 null
  ['', 'xxx', 'false', 'Recurrence', 'legitimate change', 0, 1, true, [], {}].forEach((bad) => {
    assert.throws(() => mod.buildReopenedCandidateInput(f, spec, bad),
      /非法/, '非法 outcome ' + JSON.stringify(bad) + ' 必须抛错而非静默当 null');
  });

  // ⑤ outcome 恒在「可构造」返回对象里（人审界面据此区分「疑似合法变更」与「普通误报」）
  //  注：legitimate-change 从类型上禁止构造候选（buildReopenedCandidateInput 抛错），本测试不产 legit 对象；
  //  其 outcome 只经 applyHumanOutcome 的人审指引对象携带（见 G9 路径 B 指引对象断言）。
  [undecided, rec].forEach((inp) => {
    assert.ok(Object.prototype.hasOwnProperty.call(inp, 'outcome'), '返回对象必须恒带 outcome 字段');
  });
  deepEqual(mod.HUMAN_OUTCOMES, ['recurrence', 'legitimate-change'], '判定值恰为二值，无第三种');
});

check('G12. loopExhausted 后不再生成 reopened candidate（生产侧能力）', () => {
  const f = mkFinding({ id: 'g12-4', oracle: 'requestfailed', evidence: { url: 'https://x.test/g12d' } });
  let spec = mod.translateFinding(f, { nowMs: T0 });
  let last = null;
  for (let i = 0; i < mod.MAX_REGRESSION_LOOP; i++) last = mod.noteRegressionFailure(spec), (spec = last.spec);
  assert.strictEqual(last.canReopen, false);
  assert.strictEqual(last.reason, 'regression-loop-exhausted');
  assert.strictEqual(last.spec.loopExhausted, true);
});

// ---------- G13. finding 状态同步 ----------
check('G13. confirmed→ignored 后重跑 emit → deprecated:true + deprecateReason 正确', () => {
  const dir = tmpDir('g13');
  const f = mkFinding({ id: 'g13-1', oracle: 'requestfailed', evidence: { url: 'https://x.test/g13' } });
  mod.emitRegressionSpec(mod.translateFinding(f, { nowMs: T0 }), dir, { confirmedIds: ['g13-1'], nowMs: T0 });
  const out = mod.emitRegressionSpec(mod.translateFinding(f, { nowMs: T0 + 1000 }), dir, { confirmedIds: [], nowMs: T0 + 1000 });
  deepEqual(out.deprecated, ['g13-1']);
  const v = JSON.parse(fs.readFileSync(path.join(dir, 'regr-g13-1.json'), 'utf8'));
  assert.strictEqual(v.deprecated, true);
  assert.strictEqual(v.deprecateReason, 'finding-no-longer-confirmed');
  assert.strictEqual(v.updatedAt, new Date(T0 + 1000).toISOString(), 'deprecated 必须刷新 updatedAt');
});

check('G13. 回到 confirmed → 恢复 deprecated:false + 清 reason + 刷新 updatedAt', () => {
  const dir = tmpDir('g13b');
  const f = mkFinding({ id: 'g13-2', oracle: 'requestfailed', evidence: { url: 'https://x.test/g13b' } });
  mod.emitRegressionSpec(mod.translateFinding(f, { nowMs: T0 }), dir, { confirmedIds: ['g13-2'], nowMs: T0 });
  mod.emitRegressionSpec(mod.translateFinding(f, { nowMs: T0 + 1000 }), dir, { confirmedIds: [], nowMs: T0 + 1000 });
  const beforeRestore = JSON.parse(fs.readFileSync(path.join(dir, 'regr-g13-2.json'), 'utf8'));
  assert.strictEqual(beforeRestore.deprecated, true);
  const out = mod.emitRegressionSpec(mod.translateFinding(f, { nowMs: T0 + 2000 }), dir, { confirmedIds: ['g13-2'], nowMs: T0 + 2000 });
  deepEqual(out.restored, ['g13-2']);
  const v = JSON.parse(fs.readFileSync(path.join(dir, 'regr-g13-2.json'), 'utf8'));
  assert.strictEqual(v.deprecated, false);
  assert.strictEqual(v.deprecateReason, null);
  assert.strictEqual(v.updatedAt, new Date(T0 + 2000).toISOString());
  assert.ok(v.prevTranslations.length >= 2, '恢复必须追加 prevTranslations');
  assert.strictEqual(fs.readdirSync(dir).length, 1);
});

check('G13. 对账只影响对应 finding，不误伤其他 spec', () => {
  const dir = tmpDir('g13c');
  const fa = mkFinding({ id: 'g13-a', oracle: 'requestfailed', evidence: { url: 'https://x.test/a' } });
  const fb = mkFinding({ id: 'g13-b', oracle: 'crash', evidence: { rootEmpty: true } });
  mod.emitRegressionSpec(mod.translateFinding(fa, { nowMs: T0 }), dir, { confirmedIds: ['g13-a', 'g13-b'], nowMs: T0 });
  mod.emitRegressionSpec(mod.translateFinding(fb, { nowMs: T0 }), dir, { confirmedIds: ['g13-a', 'g13-b'], nowMs: T0 });
  mod.emitRegressionSpec(mod.translateFinding(fa, { nowMs: T0 + 1000 }), dir, { confirmedIds: ['g13-b'], nowMs: T0 + 1000 });
  const va = JSON.parse(fs.readFileSync(path.join(dir, 'regr-g13-a.json'), 'utf8'));
  const vb = JSON.parse(fs.readFileSync(path.join(dir, 'regr-g13-b.json'), 'utf8'));
  assert.strictEqual(va.deprecated, true);
  assert.strictEqual(vb.deprecated, false, '仍在 confirmed 集合的 spec 不得被误标');
});

// ---------- G14. 合法变更废弃不被对账误恢复（锁恢复条件的限定范围）----------
check('G14. deprecateReason=legitimate-change 且 finding 仍在 confirmed 集合 → 仍废弃（不得被对账恢复）', () => {
  const dir = tmpDir('g14');
  const f = mkFinding({ id: 'g14-legit', oracle: 'requestfailed', evidence: { url: 'https://x.test/g14legit' } });
  // 人审判合法变更 → spec 标废弃
  const dep = mod.applyHumanOutcome(f, mod.translateFinding(f, { nowMs: T0 }), 'legitimate-change').spec;
  mod.emitRegressionSpec(dep, dir, { confirmedIds: ['g14-legit'], nowMs: T0 });
  // 关键前提：finding **仍在 confirmed 集合**（合法变更判的是「断言过期」不是「finding 误报」，
  // 所以 finding 依然留在 confirmed 里）→ 若恢复条件写成「在集合里就恢复」，合法变更会被静默复活。
  const out = mod.emitRegressionSpec(mod.translateFinding(f, { nowMs: T0 + 1000 }), dir,
    { confirmedIds: ['g14-legit'], nowMs: T0 + 1000 });
  deepEqual(out.restored, [], '合法变更废弃不得出现在恢复列表里');
  const v = JSON.parse(fs.readFileSync(path.join(dir, 'regr-g14-legit.json'), 'utf8'));
  assert.strictEqual(v.deprecated, true, '合法变更废弃必须仍为 true（未被对账恢复）');
  assert.strictEqual(v.deprecateReason, 'legitimate-change', '废弃原因不得被改写');
  assert.strictEqual(mod.noteRegressionFailure(v).canReopen, false, '仍不再回流');
});

check('G14. 反例对照：deprecateReason=finding-no-longer-confirmed 的 spec 在 confirmed 集合内 → 应被恢复', () => {
  const dir = tmpDir('g14b');
  const f = mkFinding({ id: 'g14-recon', oracle: 'requestfailed', evidence: { url: 'https://x.test/g14recon' } });
  mod.emitRegressionSpec(mod.translateFinding(f, { nowMs: T0 }), dir, { confirmedIds: ['g14-recon'], nowMs: T0 });
  // finding 掉出 confirmed → 对账标废弃
  mod.emitRegressionSpec(mod.translateFinding(f, { nowMs: T0 + 1000 }), dir, { confirmedIds: [], nowMs: T0 + 1000 });
  const dep = JSON.parse(fs.readFileSync(path.join(dir, 'regr-g14-recon.json'), 'utf8'));
  assert.strictEqual(dep.deprecated, true);
  assert.strictEqual(dep.deprecateReason, 'finding-no-longer-confirmed');
  // finding 回到 confirmed → 本条自标的废弃必须被恢复（否则恢复能力被写死成永假）
  const out = mod.emitRegressionSpec(mod.translateFinding(f, { nowMs: T0 + 2000 }), dir,
    { confirmedIds: ['g14-recon'], nowMs: T0 + 2000 });
  deepEqual(out.restored, ['g14-recon']);
  const v = JSON.parse(fs.readFileSync(path.join(dir, 'regr-g14-recon.json'), 'utf8'));
  assert.strictEqual(v.deprecated, false, '对账自标的废弃应被恢复');
  assert.strictEqual(v.deprecateReason, null);
});

// ---------- G15. recurrence 路径走真实 T5（**人审确认后**的路径，不是自动流程）----------
check('G15. 【人审确认后】真实链路 recurrence → 高置信过闸门进 applied(via=rule:regression-reopen)；同时自环不刷新审计', () => {
  const { review, cs } = realChain();
  const f = mkRealConfirmedFinding('g15-real', { oracle: 'requestfailed', evidence: { url: 'https://x.test/g15', status: 500 } });
  const spec = mod.translateFinding(f, { nowMs: T0 });
  const sourceBefore = f.judgmentSource;
  const judgedAtBefore = f.judgedAt;

  // 【人审确认后】路径 A：人审已判定 recurrence，才产出候选输入走真实 T5。
  // 注意：自动流程**不会**走到这里 —— 未判定时根本构造不出合法候选（状态校验当场抛错，见 G16），
  // 所以本条断言不代表「自动流程走过 T5」。
  const post = mod.applyHumanOutcome(f, spec, 'recurrence');
  assert.strictEqual(post.candidateInput.outcome, 'recurrence');
  assert.strictEqual(post.spec.regressionLoopCount, 1);

  // 真实 T5：分级 → 应用
  const cand = cs.buildCandidateSpec(post.candidateInput);
  assert.strictEqual(cand.proposedStatus, 'confirmed');
  assert.strictEqual(cand.candidateConfidence, 'high');
  assert.strictEqual(cand.humanReviewRequired, false, '确定性 high 免人审');
  const findingsById = byId([f]);
  const r = cs.applyCandidateSpec(cand, findingsById, review);
  assert.strictEqual(r.applied.length, 1, '真复发必须真的被应用');
  assert.strictEqual(r.applied[0].fid, f.id);
  assert.strictEqual(r.applied[0].status, 'confirmed');
  assert.strictEqual(r.applied[0].via, 'rule:regression-reopen', '应用来源须是 T7 产出的确定性来源');
  assert.strictEqual(r.needsHumanReview.length, 0);

  // 下面两条断言**不是 bug 断言**，而是规格已知边界（自环不留痕）的可执行证据：
  // 状态机自环「幂等、不更新审计」，故真复发走完 T5 后 findings 侧不产生任何复发痕迹，
  // 复发次数只活在 spec 的 regressionLoopCount 上。任何材料都不得声称「复发已被 findings 记录」。
  assert.strictEqual(f.reviewStatus, 'confirmed', '自环后状态仍是 confirmed（本来就在）');
  assert.strictEqual(f.judgmentSource, sourceBefore, '自环不刷新 judgmentSource —— 已知边界，非 bug');
  assert.strictEqual(f.judgedAt, judgedAtBefore, '自环不刷新 judgedAt —— 已知边界，非 bug');

  // 复发痕迹的唯一落点：spec 回流计数（并在达上限时强制人审）
  assert.strictEqual(post.spec.regressionLoopCount, 1);
  const dir = tmpDir('g15');
  mod.emitRegressionSpec(post.spec, dir, { confirmedIds: ['g15-real'], nowMs: T0 });
  const persisted = JSON.parse(fs.readFileSync(path.join(dir, 'regr-g15-real.json'), 'utf8'));
  assert.strictEqual(persisted.regressionLoopCount, 1, '复发次数记在 spec 上（对外表述纪律的唯一依据）');
});

check('G15. 【人审确认后】recurrence 达回流上限 → loopExhausted:true + 强制人审', () => {
  const f = mkFinding({ id: 'g15-loop', oracle: 'requestfailed', evidence: { url: 'https://x.test/g15loop' } });
  const base = mod.translateFinding(f, { nowMs: T0 });
  let spec = base;
  let last = null;
  for (let i = 0; i < mod.MAX_REGRESSION_LOOP - 1; i++) {
    last = mod.applyHumanOutcome(f, spec, 'recurrence');
    spec = last.spec;
    assert.strictEqual(last.loopExhausted, false, '未达上限不得提前耗尽（第 ' + (i + 1) + ' 次）');
  }
  last = mod.applyHumanOutcome(f, spec, 'recurrence');
  assert.strictEqual(last.spec.regressionLoopCount, mod.MAX_REGRESSION_LOOP);
  assert.strictEqual(last.loopExhausted, true, '达上限必须 loopExhausted');
  assert.strictEqual(last.canReopen, false);
  assert.strictEqual(last.requiresHumanReview, true, '达上限强制人审');
});

// ---------- G16. 未判定记录不进 T5、进 T7 待判定队列（补 A 分支修正）----------
check('G16.① 未判定（不传 outcome）→ outcome=null 且 proposedStatus=null（不主张状态，绝不预判 confirmed）', () => {
  const f = mkFinding({ id: 'g16-1', oracle: 'requestfailed', evidence: { url: 'https://x.test/g16' } });
  const spec = mod.translateFinding(f, { nowMs: T0 });
  const input = mod.buildReopenedCandidateInput(f, spec);
  assert.strictEqual(input.outcome, null, '未判定必须是 null');
  assert.strictEqual(input.proposedStatus, null,
    '未判定不主张任何状态：填 confirmed 等于自动流程预设「这是真复发」，与 outcome 归人审自相矛盾');
  deepEqual(input.references, ['g16-1']);
  // generator 仍记确定性来源：回归失败这件事本身是确定性事实
  assert.strictEqual(input.generator, 'rule:regression-reopen', 'generator 仍记录确定性来源（不含真伪判断）');
});

check('G16.② 真实候选构造器遇未判定输入 → 当场抛错（天然屏障：未判定记录进不了 T5）', () => {
  const { cs } = realChain();
  const f = mkFinding({ id: 'g16-2', oracle: 'requestfailed', evidence: { url: 'https://x.test/g16b' } });
  const spec = mod.translateFinding(f, { nowMs: T0 });
  const undecided = mod.buildReopenedCandidateInput(f, spec);
  // 真实模块校验：proposedStatus 非 confirmed/ignored 即抛（candidate-spec.cjs 的状态校验）
  assert.throws(() => cs.buildCandidateSpec(undecided), /proposedStatus/,
    '未判定记录不得被误投进 T5 —— 真实构造器必须抛错，而不是静默走 confirmed→confirmed 自环');
  // 对照：人审判定之后同一入口才放行（证明拦的是「未判定」而非「这条记录本身」）
  const judged = mod.buildReopenedCandidateInput(f, spec, 'recurrence');
  assert.strictEqual(cs.buildCandidateSpec(judged).proposedStatus, 'confirmed');
});

check('G16.③ 回归失败未判定 → 进 T7 待判定队列（needsOutcomeJudgement + pendingOutcomeCandidate 落盘且幂等不被抹掉）', () => {
  const dir = tmpDir('g16c');
  const f = mkFinding({ id: 'g16-3', oracle: 'requestfailed', evidence: { url: 'https://x.test/g16c' } });
  // 回归失败已发生（递增不等判定）→ 处于未判定状态
  const failed = mod.noteRegressionFailure(mod.translateFinding(f, { nowMs: T0 }));
  assert.strictEqual(failed.count, 1, '前提：已记一次回归失败');
  const marked = mod.markNeedsOutcomeJudgement(failed.spec, f);
  assert.strictEqual(marked.needsOutcomeJudgement, true, '必须标记为待判定');
  assert.ok(marked.pendingOutcomeCandidate, '必须附未判定候选输入');
  assert.strictEqual(marked.pendingOutcomeCandidate.outcome, null);
  assert.strictEqual(marked.pendingOutcomeCandidate.proposedStatus, null);

  // 落盘后读回
  const file = mod.emitRegressionSpec(marked, dir, { confirmedIds: ['g16-3'], nowMs: T0 }).written[0];
  const v1 = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(v1.needsOutcomeJudgement, true, '待判定标记必须落盘');
  assert.strictEqual(v1.pendingOutcomeCandidate.outcome, null, '待判定候选的 outcome 必须为 null');
  deepEqual(v1.pendingOutcomeCandidate.references, ['g16-3'], '待判定候选只引用原 finding');

  // 幂等更新（重翻译一次，spec 不带任何队列字段）→ 两个字段都不得被抹掉
  mod.emitRegressionSpec(mod.translateFinding(f, { nowMs: T0 + 1000 }), dir,
    { confirmedIds: ['g16-3'], nowMs: T0 + 1000 });
  const v2 = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(v2.needsOutcomeJudgement, true, '二次 emit 不得抹掉待判定标记（抹掉 = 人审界面上条目凭空消失）');
  assert.strictEqual(v2.pendingOutcomeCandidate.outcome, null, '二次 emit 不得抹掉待判定候选');
  deepEqual(v2.pendingOutcomeCandidate.references, ['g16-3']);
});

check('G16.④ applyHumanOutcome(f, spec, null) → 抛错并指向待判定队列（T7 不兜底代判真伪）', () => {
  const f = mkFinding({ id: 'g16-4', oracle: 'requestfailed', evidence: { url: 'https://x.test/g16d' } });
  const spec = mod.translateFinding(f, { nowMs: T0 });
  assert.throws(() => mod.applyHumanOutcome(f, spec, null), /未判定/);
  // 报错文案必须指向待判定队列（告诉调用方未判定记录去哪消费），而不是含糊的通用错误
  assert.throws(() => mod.applyHumanOutcome(f, spec, null), /needsOutcomeJudgement|待判定/,
    '报错须指向 T7 待判定队列（人审界面消费该队列）');
  // 反例：不允许「未判定就兜底填值」——那等于 T7 自己判真伪
  const failed = mod.noteRegressionFailure(spec);
  const marked = mod.markNeedsOutcomeJudgement(failed.spec, f);
  assert.throws(() => mod.applyHumanOutcome(f, marked, null), /未判定/,
    '待判定队列里的记录同样不得由 T7 兜底判真伪');
});

check('G16. 递增时机：失败即递增不等判定；人审判定后复用不重复递增（一次失败只记一次数）', () => {
  const f = mkFinding({ id: 'g16-5', oracle: 'requestfailed', evidence: { url: 'https://x.test/g16e' } });
  // 失败时已递增（noteRegressionFailure 负责）
  const failed = mod.noteRegressionFailure(mod.translateFinding(f, { nowMs: T0 }));
  assert.strictEqual(failed.count, 1);
  // 人审判定 recurrence 时复用该计数，不得再 +1
  const marked = mod.markNeedsOutcomeJudgement(failed.spec, f);
  const post = mod.applyHumanOutcome(f, marked, 'recurrence');
  assert.strictEqual(post.spec.regressionLoopCount, 1, '已记过一次的失败，人审判定时不得重复递增');
  assert.strictEqual(post.spec.needsOutcomeJudgement, false, '人审判定后条目出队');
  assert.strictEqual(post.spec.pendingOutcomeCandidate, null, '出队后不留待判定候选');
  // 对照：fresh spec 直接带判定进来（没走过失败计数）→ 补记一次，保持「一次失败记一次数」
  const fresh = mod.applyHumanOutcome(f, mod.translateFinding(f, { nowMs: T0 }), 'recurrence');
  assert.strictEqual(fresh.spec.regressionLoopCount, 1, '未走过失败计数时补记一次');
});

// ---------- G17. 待判定队列：枚举接口 + finding 离开 confirmed 时的队列处置 ----------
// 消费方在「人审界面 / 人审流程侧」，本轮只验「队列能被列出」+「僵尸条目被处置」，不验任何消费动作。

/** 造一个「已回归失败、尚未判定」的 spec（入队态），供 G17 各条复用 */
function mkPendingSpec(f, nowMs) {
  const failed = mod.noteRegressionFailure(mod.translateFinding(f, { nowMs }));
  assert.ok(failed.spec.regressionLoopCount > 0, '前提：已记一次回归失败');
  return mod.markNeedsOutcomeJudgement(failed.spec, f);
}

check('G17a. 枚举：3 个 spec（1 待判定 / 1 未入队 / 1 不可译不落盘）→ 只返回那一个且字段齐全', () => {
  const dir = tmpDir('g17a');
  // 对账集合必须给全部 id：只给自己的话，前一条已落盘的待判定 spec 会被判成「不再 confirmed」而废弃出队
  const ALL = ['g17-pend', 'g17-plain', 'g17-untrans'];
  // ① 待判定：回归失败 + 未判定 → needsOutcomeJudgement=true
  const fp = mkFinding({ id: 'g17-pend', oracle: 'requestfailed', evidence: { url: 'https://x.test/g17pend' } });
  mod.emitRegressionSpec(mkPendingSpec(fp, T0), dir, { confirmedIds: ALL, nowMs: T0 });
  // ② 未入队：从未回归失败 → needsOutcomeJudgement 非 true
  const fn = mkFinding({ id: 'g17-plain', oracle: 'crash', evidence: { rootEmpty: true } });
  mod.emitRegressionSpec(mod.translateFinding(fn, { nowMs: T0 }), dir, { confirmedIds: ALL, nowMs: T0 });
  // ③ 不可译：纯散文证据 → emitRegressionSpec 跳过、不落盘（故目录里只有 2 个 regr-*.json）
  const fu = mkFinding({ id: 'g17-untrans', oracle: 'requestfailed', evidence: { text: '只有散文证据' } });
  const skip = mod.emitRegressionSpec(mod.translateFinding(fu, { nowMs: T0 }), dir, { confirmedIds: ALL, nowMs: T0 });
  assert.strictEqual(skip.written.length, 0, '前提：不可译不落盘');
  assert.strictEqual(fs.readdirSync(dir).length, 2, '前提：目录里只有两个 spec 文件');

  const list = mod.listPendingOutcomeJudgements(dir);
  assert.strictEqual(list.length, 1, '只应返回待判定那一个');
  assert.strictEqual(list[0].id, 'regr-g17-pend');
  assert.strictEqual(list[0].originFindingId, 'g17-pend');
  assert.strictEqual(list[0].regressionLoopCount, 1);
  assert.strictEqual(list[0].updatedAt, new Date(T0).toISOString());
  assert.ok(Object.prototype.hasOwnProperty.call(list[0], 'outcome'), '摘要必须带 outcome（人审界面靠它区分疑似合法变更）');
  assert.ok(Object.prototype.hasOwnProperty.call(list[0], 'proposedStatus'), '摘要必须带 proposedStatus');
  assert.notStrictEqual(list[0].originFindingId, 'g17-plain', '未入队的 spec 不得出现在待判定列表里');
});

check('G17a. 边界：目录不存在 / 无待判定 → 返回空数组且不抛', () => {
  const missing = path.join(tmpDir('g17a'), 'no-such-layer3-dir');
  assert.strictEqual(fs.existsSync(missing), false, '前提：目录不存在');
  let got = null;
  try {
    got = mod.listPendingOutcomeJudgements(missing);
  } catch (e) {
    throw new Error('目录不存在时必须返回空数组而不是抛错：' + e.message);
  }
  deepEqual(got, [], '目录不存在 → 空数组');

  const dir = tmpDir('g17a_empty');
  deepEqual(mod.listPendingOutcomeJudgements(dir), [], '空目录 → 空数组');
  const fp = mkFinding({ id: 'g17a-none', oracle: 'crash', evidence: { rootEmpty: true } });
  mod.emitRegressionSpec(mod.translateFinding(fp, { nowMs: T0 }), dir, { confirmedIds: ['g17a-none'], nowMs: T0 });
  deepEqual(mod.listPendingOutcomeJudgements(dir), [], '有 spec 但无待判定 → 空数组');
});

check('G17a. 边界：单个文件 JSON 损坏 → 跳过该条继续（不抛、不影响其他条目）', () => {
  const dir = tmpDir('g17a_bad');
  const fb = mkFinding({ id: 'g17-bad', oracle: 'requestfailed', evidence: { url: 'https://x.test/g17bad' } });
  const fg = mkFinding({ id: 'g17-good', oracle: 'crash', evidence: { rootEmpty: true } });
  const ALL = ['g17-bad', 'g17-good'];
  mod.emitRegressionSpec(mkPendingSpec(fb, T0), dir, { confirmedIds: ALL, nowMs: T0 });
  mod.emitRegressionSpec(mkPendingSpec(fg, T0), dir, { confirmedIds: ALL, nowMs: T0 });
  // 破坏其中一个文件的 JSON（读一次即坏）
  const badFile = path.join(dir, 'regr-g17-bad.json');
  fs.writeFileSync(badFile, '{ this is not valid json');
  let got = null;
  try {
    got = mod.listPendingOutcomeJudgements(dir);
  } catch (e) {
    throw new Error('坏文件必须被跳过而不是让整个枚举抛错：' + e.message);
  }
  assert.strictEqual(got.length, 1, '坏文件跳过，其余条目照常返回');
  assert.strictEqual(got[0].originFindingId, 'g17-good');
});

check('G17a. 排序：按 regressionLoopCount 降序，同数按 id 字典序（输出稳定可测）', () => {
  const dir = tmpDir('g17a_sort');
  const ALL = ['g17s-a', 'g17s-c', 'g17s-b'];
  const mk = (id, times) => {
    const f = mkFinding({ id: id, oracle: 'crash', evidence: { rootEmpty: true } });
    let spec = mod.translateFinding(f, { nowMs: T0 });
    for (let i = 0; i < times; i++) spec = mod.noteRegressionFailure(spec).spec;
    return mod.emitRegressionSpec(mod.markNeedsOutcomeJudgement(spec, f), dir, { confirmedIds: ALL, nowMs: T0 });
  };
  mk('g17s-a', 1);
  mk('g17s-c', 3);
  mk('g17s-b', 3);
  const list = mod.listPendingOutcomeJudgements(dir);
  deepEqual(list.map((r) => r.id), ['regr-g17s-b', 'regr-g17s-c', 'regr-g17s-a'],
    '失败次数多的排前面；次数相同按 id 字典序');
  deepEqual(mod.listPendingOutcomeJudgements(dir).map((r) => r.id),
    list.map((r) => r.id), '重复调用输出顺序必须稳定');
});

check('G17b. 僵尸条目处置：待判定 spec 的 finding 离开 confirmed → 出队 + 标废弃，且文件仍在', () => {
  const dir = tmpDir('g17b');
  const f = mkFinding({ id: 'g17b-1', oracle: 'requestfailed', evidence: { url: 'https://x.test/g17b' } });
  const file = mod.emitRegressionSpec(mkPendingSpec(f, T0), dir, { confirmedIds: ['g17b-1'], nowMs: T0 }).written[0];
  const before = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(before.needsOutcomeJudgement, true, '前提：先入队');

  // finding 掉出 confirmed → 对账标废弃，且必须同次出队
  const out = mod.emitRegressionSpec(mod.translateFinding(f, { nowMs: T0 + 1000 }), dir,
    { confirmedIds: [], nowMs: T0 + 1000 });
  deepEqual(out.deprecated, ['g17b-1']);

  const v = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(v.deprecated, true, '必须标废弃');
  assert.strictEqual(v.deprecateReason, 'finding-no-longer-confirmed');
  assert.strictEqual(v.needsOutcomeJudgement, false, '僵尸条目必须出队（否则人审界面看到废弃 spec 上还挂着待判定）');
  assert.strictEqual(v.pendingOutcomeCandidate, null, '出队即清空待判定候选（与 applyHumanOutcome 同一口径）');
  assert.ok(fs.existsSync(file), 'spec 文件必须保留（历史链 prevTranslations 依赖它）');
  assert.ok(Array.isArray(v.prevTranslations) && v.prevTranslations.length >= 1, '历史链必须保留');
  // 枚举侧同步：僵尸条目不得再出现在人审列表里
  deepEqual(mod.listPendingOutcomeJudgements(dir), [], '出队后不得再被枚举出来');
});

check('G17c. 恢复不复活队列：finding 回 confirmed → 只恢复 deprecated，回流计数与待判定标记均不变', () => {
  const dir = tmpDir('g17c');
  const f = mkFinding({ id: 'g17c-1', oracle: 'requestfailed', evidence: { url: 'https://x.test/g17c' } });
  const file = mod.emitRegressionSpec(mkPendingSpec(f, T0), dir, { confirmedIds: ['g17c-1'], nowMs: T0 }).written[0];
  // 离开 confirmed → 出队 + 废弃
  mod.emitRegressionSpec(mod.translateFinding(f, { nowMs: T0 + 1000 }), dir, { confirmedIds: [], nowMs: T0 + 1000 });
  const dep = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(dep.deprecated, true);
  assert.strictEqual(dep.needsOutcomeJudgement, false);
  const countBefore = dep.regressionLoopCount;

  // 回到 confirmed → 恢复 deprecated，但失败事实不得消失/重现
  const out = mod.emitRegressionSpec(mod.translateFinding(f, { nowMs: T0 + 2000 }), dir,
    { confirmedIds: ['g17c-1'], nowMs: T0 + 2000 });
  deepEqual(out.restored, ['g17c-1']);

  const v = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(v.deprecated, false, '对账自标的废弃必须被恢复');
  assert.strictEqual(v.deprecateReason, null);
  assert.strictEqual(v.regressionLoopCount, countBefore, '回流计数保持原值，不得被恢复动作清零');
  assert.strictEqual(v.needsOutcomeJudgement, false, '不得重新入队');
  assert.strictEqual(v.pendingOutcomeCandidate, null);
  deepEqual(mod.listPendingOutcomeJudgements(dir), [], '恢复后不得凭空多出待判定条目');
});

check('G17d. 消费接口自洽：枚举出的条目 outcome 恒为 null、proposedStatus 恒为 null', () => {
  const dir = tmpDir('g17d');
  // 混合落盘：多条待判定 + 非 regr-*.json 干扰文件
  ['g17d-a', 'g17d-b'].forEach((id, i) => {
    const f = mkFinding({ id: id, oracle: 'crash', evidence: { rootEmpty: true } });
    mod.emitRegressionSpec(mkPendingSpec(f, T0 + i * 1000), dir,
      { confirmedIds: ['g17d-a', 'g17d-b'], nowMs: T0 + i * 1000 });
  });
  fs.writeFileSync(path.join(dir, 'notes.txt'), '不是本模块产出的文件，不该被认成条目');

  const list = mod.listPendingOutcomeJudgements(dir);
  assert.strictEqual(list.length, 2, '只认 needsOutcomeJudgement===true 的 regr-*.json');
  list.forEach((r) => {
    assert.strictEqual(r.outcome, null, '枚举出的必然是未判定态：' + r.id);
    assert.strictEqual(r.proposedStatus, null, '未判定不得主张状态：' + r.id);
  });

  // 人审判定后条目出队 → 枚举侧立刻看不到它（枚举 = 队列的唯一入口，出队即消失）
  const f = mkFinding({ id: 'g17d-a', oracle: 'crash', evidence: { rootEmpty: true } });
  const file = path.join(dir, 'regr-g17d-a.json');
  const judged = mod.applyHumanOutcome(f, JSON.parse(fs.readFileSync(file, 'utf8')), 'recurrence').spec;
  fs.writeFileSync(file, JSON.stringify(judged, null, 2));
  const after = mod.listPendingOutcomeJudgements(dir);
  assert.deepEqual(after.map((r) => r.id), ['regr-g17d-b'], '已判定条目必须出队');
});

// ---------- G18. 出队前的待判定快照进版本链（真实数据丢失的修复验收）----------
// 背景：finding 离开 confirmed 时，对账会把待判定条目**出队**（标记置 false + 待判定候选置 null）。
// 若版本摘要只存 8 个字段，出队**前**的内容（候选引用了哪条 finding、原 outcome、原 proposedStatus）
// 就永久丢失、无法回溯 —— 这是真实数据丢失。故版本摘要必须收录一切会被出队清空的字段。

check('G18a. 出队前快照进版本链：出队后当前值为 false/null，但版本链最后一条仍留有出队前的待判定内容', () => {
  const dir = tmpDir('g18a');
  const f = mkFinding({ id: 'g18a-1', oracle: 'requestfailed', evidence: { url: 'https://x.test/g18a' } });
  // ① 入队：已回归失败（计数 1）+ 未判定 → 标记为待判定 + 挂未判定候选（outcome=null、只引用本 finding）
  const marked = mkPendingSpec(f, T0);
  assert.strictEqual(marked.needsOutcomeJudgement, true, '前提：已入队');
  assert.strictEqual(marked.pendingOutcomeCandidate.outcome, null, '前提：候选是未判定态');
  assert.deepStrictEqual(marked.pendingOutcomeCandidate.references, ['g18a-1']);
  const file = mod.emitRegressionSpec(marked, dir, { confirmedIds: ['g18a-1'], nowMs: T0 }).written[0];

  // ② finding 离开 confirmed → 对账标废弃 + 同次出队
  const out = mod.emitRegressionSpec(mod.translateFinding(f, { nowMs: T0 + 1000 }), dir,
    { confirmedIds: [], nowMs: T0 + 1000 });
  assert.deepStrictEqual(out.deprecated, ['g18a-1'], '前提：已触发出队路径');

  // ③ 当前态已出队（G17b 的既有口径，本次不改动）
  const v = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(v.needsOutcomeJudgement, false, '出队后待判定标记必须为 false');
  assert.strictEqual(v.pendingOutcomeCandidate, null, '出队后待判定候选必须为 null');
  assert.strictEqual(v.deprecated, true);
  assert.ok(Array.isArray(v.prevTranslations) && v.prevTranslations.length >= 1, '前提：版本链非空');

  // ④ 本条的核心：出队**前**的内容进了版本链，可回溯（字段名以实现为准）
  const snap = v.prevTranslations[v.prevTranslations.length - 1];
  assert.strictEqual(snap.needsOutcomeJudgement, true,
    '出队前的待判定标记必须留在版本链里，否则「这条 spec 曾等人审判定」这个事实永久丢失');
  assert.ok(snap.pendingOutcomeCandidate, '出队前的待判定候选必须留在版本链里，否则候选内容永久丢失');
  assert.strictEqual(snap.pendingOutcomeCandidate.outcome, null, '回溯出的候选须是未判定态');
  assert.strictEqual(snap.pendingOutcomeCandidate.proposedStatus, null, '未判定不得主张状态');
  assert.deepStrictEqual(snap.pendingOutcomeCandidate.references, ['g18a-1'],
    '回溯须能看出候选引用了哪条 finding（出队后当前态已无此信息）');
  assert.strictEqual(snap.pendingOutcomeCandidate.regressionSpecId, 'regr-g18a-1');
  assert.strictEqual(snap.deprecated, false, '摘要须记出队前的真实状态（那时尚未废弃）');
  assert.strictEqual(snap.regressionLoopCount, 1, '出队前已记一次回归失败，不得被摘要抹掉');
});

check('G18b. 快照不被后续改动污染：出队后再 emit（finding 回 confirmed 触发恢复），出队前那条的 references 仍是原始值', () => {
  const dir = tmpDir('g18b');
  const f = mkFinding({ id: 'g18b-1', oracle: 'requestfailed', evidence: { url: 'https://x.test/g18b' } });
  const marked = mkPendingSpec(f, T0);
  const file = mod.emitRegressionSpec(marked, dir, { confirmedIds: ['g18b-1'], nowMs: T0 }).written[0];
  // 出队
  mod.emitRegressionSpec(mod.translateFinding(f, { nowMs: T0 + 1000 }), dir, { confirmedIds: [], nowMs: T0 + 1000 });
  const dep = JSON.parse(fs.readFileSync(file, 'utf8'));
  const idx = dep.prevTranslations.length - 1; // 出队前那一条的下标
  assert.strictEqual(dep.prevTranslations[idx].needsOutcomeJudgement, true, '前提：出队前那条在链上');
  assert.deepStrictEqual(dep.prevTranslations[idx].pendingOutcomeCandidate.references, ['g18b-1']);

  // 出队后再 emit 一次，带别的变更：finding 回 confirmed → 对账恢复（追加快照 + 刷新 updatedAt）
  const out = mod.emitRegressionSpec(mod.translateFinding(f, { nowMs: T0 + 2000 }), dir,
    { confirmedIds: ['g18b-1'], nowMs: T0 + 2000 });
  assert.deepStrictEqual(out.restored, ['g18b-1'], '前提：本次走的是恢复分支（确实带了别的变更）');
  const v = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(v.deprecated, false);
  assert.ok(v.prevTranslations.length > dep.prevTranslations.length, '后续 emit 只能往版本链追加，不得重写历史');

  // 更早那条快照必须逐字不变 —— 历史快照不得被后续变更污染
  const older = v.prevTranslations[idx];
  assert.strictEqual(older.needsOutcomeJudgement, true, '出队前那条的待判定标记不得被后续变更改写');
  assert.strictEqual(older.pendingOutcomeCandidate.outcome, null);
  assert.strictEqual(older.pendingOutcomeCandidate.proposedStatus, null);
  assert.deepStrictEqual(older.pendingOutcomeCandidate.references, ['g18b-1'],
    '出队前那条快照的 references 必须仍是原始值（不是同一引用被改）');
  assert.strictEqual(older.pendingOutcomeCandidate.regressionSpecId, 'regr-g18b-1');
  // 反例锁定：版本链逐版记录「出链那一刻的状态」而非始终同一份。
  //   · 待判定两项：出队早已完成 → 该版快照是 false/null（不得再带回已出队的待判定内容）。
  //   · deprecated：该版出链时废弃动作尚未被恢复 → 记 true；恢复后当前态才转为 false（见上面 v.deprecated）。
  //   两者不同才说明快照是逐版快照，不是同一份对象被反复覆写。
  const newest = v.prevTranslations[v.prevTranslations.length - 1];
  assert.strictEqual(newest.needsOutcomeJudgement, false, '恢复后的快照不得再带回待判定标记');
  assert.strictEqual(newest.pendingOutcomeCandidate, null, '恢复后的快照不得再带回已出队的候选内容');
  assert.strictEqual(newest.deprecated, true, '该版出链时恢复动作尚未发生，须记废弃态');
  assert.strictEqual(newest.deprecateReason, 'finding-no-longer-confirmed');
  assert.notStrictEqual(newest, older, '版本链两版必须是不同对象（不是同一引用被覆写）');
});

check('G18c. 旧格式兼容：历史条目缺这两个字段的 spec 文件，枚举与重跑都不抛、旧条目不被追溯改写', () => {
  const dir = tmpDir('g18c');
  const f = mkFinding({ id: 'g18c-1', oracle: 'requestfailed', evidence: { url: 'https://x.test/g18c' } });
  const file = mod.emitRegressionSpec(mkPendingSpec(f, T0), dir, { confirmedIds: ['g18c-1'], nowMs: T0 }).written[0];
  // 再 emit 一次产生一条历史
  mod.emitRegressionSpec(mkPendingSpec(f, T0 + 1000), dir, { confirmedIds: ['g18c-1'], nowMs: T0 + 1000 });
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(onDisk.prevTranslations.length, 1, '前提：已有一条历史');
  assert.strictEqual(onDisk.needsOutcomeJudgement, true, '前提：当前仍是入队态');
  assert.deepStrictEqual(onDisk.pendingOutcomeCandidate.references, ['g18c-1']);

  // 手工回退成旧格式：历史条目里没有这两个字段（模拟本次修复之前落盘的 spec 文件，无需迁移脚本）
  delete onDisk.prevTranslations[0].needsOutcomeJudgement;
  delete onDisk.prevTranslations[0].pendingOutcomeCandidate;
  fs.writeFileSync(file, JSON.stringify(onDisk, null, 2));

  // ① 枚举不抛：旧条目读回是 undefined，属可接受的历史格式差异
  const list = mod.listPendingOutcomeJudgements(dir);
  assert.strictEqual(list.length, 1, '入队态 spec 仍应被枚举出来');
  assert.strictEqual(list[0].originFindingId, 'g18c-1');
  assert.strictEqual(list[0].outcome, null);
  assert.strictEqual(list[0].proposedStatus, null);

  // ② 重跑 emit 不抛、不破坏入队态；旧条目原样保留，新追加的条目按新格式带齐两项
  const out = mod.emitRegressionSpec(mkPendingSpec(f, T0 + 2000), dir, { confirmedIds: ['g18c-1'], nowMs: T0 + 2000 });
  assert.strictEqual(out.written.length, 1);
  const v = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(v.needsOutcomeJudgement, true, '重跑不得破坏入队态');
  assert.deepStrictEqual(v.pendingOutcomeCandidate.references, ['g18c-1']);
  assert.strictEqual(v.prevTranslations.length, 2, '旧条目保留 + 追加一条');
  assert.strictEqual(v.prevTranslations[0].needsOutcomeJudgement, undefined, '旧格式条目不追溯补字段（不需要迁移脚本）');
  assert.strictEqual(v.prevTranslations[0].pendingOutcomeCandidate, undefined);
  assert.strictEqual(v.prevTranslations[1].needsOutcomeJudgement, true, '新追加条目按新格式带齐两项');
  assert.deepStrictEqual(v.prevTranslations[1].pendingOutcomeCandidate.references, ['g18c-1']);

  // ③ 出队路径也不受旧格式影响：对账照常出队、照常追加快照，旧条目始终不追溯改写
  const depOut = mod.emitRegressionSpec(mkPendingSpec(f, T0 + 3000), dir, { confirmedIds: [], nowMs: T0 + 3000 });
  assert.deepStrictEqual(depOut.deprecated, ['g18c-1']);
  const dv = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(dv.needsOutcomeJudgement, false, '出队口径不变');
  assert.strictEqual(dv.pendingOutcomeCandidate, null);
  assert.strictEqual(dv.prevTranslations[0].needsOutcomeJudgement, undefined);
  assert.strictEqual(dv.prevTranslations[0].pendingOutcomeCandidate, undefined);
  assert.ok(fs.existsSync(file), 'spec 文件必须保留');
  assert.strictEqual(mod.listPendingOutcomeJudgements(dir).length, 0, '出队后枚举侧同步为空');
});

// ---------- G7b. 显式 N/A（禁止记 PASS）----------
// ---------- G18e. 内存层：快照拷贝语义（不经 JSON 落盘） ----------
// G18a/b/c 走落盘路径，而落盘必经 JSON 序列化，读回时引用天然断开——
// 因此**落盘层断言无法区分「做了拷贝」与「没做拷贝」**。本条绕过落盘、
// 直接验内存语义，防止把拷贝改成 `const snap = p` 也照样全绿。
check('G18e. 内存层：快照与原对象引用隔离（改快照不污染原对象、原对象 push 不污染快照）', () => {
  const live = {
    outcome: null,
    proposedStatus: null,
    references: ['f-1'],
    regressionSpecId: 'regr-x',
  };
  const snap = mod.snapshotPendingCandidate(live);
  // 顶层非同引用
  assert.notStrictEqual(snap, live, '快照不得与原对象同一引用');
  // 数组非同引用
  assert.notStrictEqual(snap.references, live.references, '数组字段必须 slice 出新引用');
  // 双向污染反证：改快照不污染活对象
  snap.references.push('injected-by-mutating-snapshot');
  snap.proposedStatus = 'MUTATED';
  assert.deepStrictEqual(live.references, ['f-1'], '改快照不得让活对象的 references 变长');
  assert.strictEqual(live.proposedStatus, null, '改快照不得写回活对象的标量字段');
  // 反向：活对象 push 不污染快照
  live.references.push('f-2');
  assert.deepStrictEqual(snap.references, ['f-1', 'injected-by-mutating-snapshot'],
    '活对象后续 push 不得反过来改写已入链的快照');
  // 嵌套对象隔离：referencedFindings 里的 finding 是活对象引用，
  // review.transition 会原地改 finding（review.cjs:218 f.reviewStatus = to）；快照必须断引用，否则历史被活对象污染
  const live2 = {
    outcome: null,
    proposedStatus: null,
    references: ['f-nested-1'],
    referencedFindings: [{ id: 'f-nested-1', reviewStatus: 'confirmed', judgmentSource: 'rule:regression-reopen' }],
  };
  const snap2 = mod.snapshotPendingCandidate(live2);
  assert.notStrictEqual(snap2.referencedFindings, live2.referencedFindings, 'referencedFindings 数组必须 slice 出新引用');
  assert.notStrictEqual(snap2.referencedFindings[0], live2.referencedFindings[0],
    'referencedFindings 内 finding 对象必须逐元素浅拷贝、断引用（否则快照会被活对象原地改写污染）');
  // 模拟 review.transition 对活 finding 原地改写
  live2.referencedFindings[0].reviewStatus = 'ignored';
  live2.referencedFindings[0].judgmentSource = 'human:legitimate-change';
  assert.strictEqual(snap2.referencedFindings[0].reviewStatus, 'confirmed',
    '活 finding 被 transition 原地改写为 ignored，快照里的历史 finding 不得被污染');
  assert.strictEqual(snap2.referencedFindings[0].judgmentSource, 'rule:regression-reopen',
    '快照历史 judgmentSource 不得被活对象改写');
  // 反向：改快照里的 finding 不得污染活对象
  snap2.referencedFindings[0].reviewStatus = 'MUTATED';
  assert.strictEqual(live2.referencedFindings[0].reviewStatus, 'ignored', '改快照不得写回活对象');
  // 边界：非对象一律归 null
  assert.strictEqual(mod.snapshotPendingCandidate(null), null);
  assert.strictEqual(mod.snapshotPendingCandidate(undefined), null);
  assert.strictEqual(mod.snapshotPendingCandidate(['a']), null, '数组本身不是候选对象');
});

// ---------- G19. 未判定记录的闭环完整性（入队 → 落盘 → 出队 → 版本链留快照）----------
// 覆盖 spec §6 G19：整条链路可追溯，且出队后队列侧看不到它、但版本链最后一条能还原出队前内容。
// 反例对照（防空断言）：同目录再放一条**未出队**的 spec（finding 仍在 confirmed），
//   它必须**仍被** listPendingOutcomeJudgements 返回 —— 只有两条对照同时成立，才能证明
//   枚举是真按 needsOutcomeJudgement 过滤，而不是恒返回空（出队后照样空）或恒返回全部（出队后还在）。
check('G19. 未判定闭环：入队→落盘→出队（finding 离开 confirmed）→版本链留快照；出队后不在队列但可回溯', () => {
  const dir = tmpDir('g19');
  const idLeave = 'g19-leave'; // 出队的那条
  const idStay = 'g19-stay';   // 反例对照：不出队的那条

  // ---- ① 入队：已回归失败（计数 1）+ 未判定 → 标记待判定 + 挂未判定候选 ----
  const fLeave = mkFinding({ id: idLeave, oracle: 'requestfailed', evidence: { url: 'https://x.test/g19leave' } });
  const failed = mod.noteRegressionFailure(mod.translateFinding(fLeave, { nowMs: T0 }));
  assert.strictEqual(failed.count, 1, '前提：已记一次回归失败（入队判据）');
  const marked = mod.markNeedsOutcomeJudgement(failed.spec, fLeave);
  assert.strictEqual(marked.needsOutcomeJudgement, true, '入队：待判定标记必须为 true');
  assert.ok(marked.pendingOutcomeCandidate, '入队：必须挂上待判定候选');

  // ---- ② 落盘：读回仍是入队态，且此时枚举侧能看到它 ----
  const file = mod.emitRegressionSpec(marked, dir, { confirmedIds: [idLeave], nowMs: T0 }).written[0];
  const v1 = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(v1.needsOutcomeJudgement, true, '落盘：待判定标记必须落盘为 true');
  assert.ok(v1.pendingOutcomeCandidate, '落盘：待判定候选必须落盘');
  const queuedBefore = mod.listPendingOutcomeJudgements(dir).map((r) => r.originFindingId);
  assert.strictEqual(queuedBefore.indexOf(idLeave) !== -1, true, '落盘：入队的条目必须出现在队列里');

  // ---- ③ 出队：finding 离开 confirmed → 对账标废弃 + 同次出队（文件仍保留）----
  const out = mod.emitRegressionSpec(mod.translateFinding(fLeave, { nowMs: T0 + 1000 }), dir,
    { confirmedIds: [], nowMs: T0 + 1000 });
  assert.deepStrictEqual(out.deprecated, [idLeave], '出队：必须走对账废弃路径');
  const v2 = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(v2.needsOutcomeJudgement, false, '出队后待判定标记必须为 false');
  assert.strictEqual(v2.pendingOutcomeCandidate, null, '出队后待判定候选必须清空');
  assert.strictEqual(v2.deprecated, true, '出队必须伴随标废弃');
  assert.strictEqual(fs.existsSync(file), true, '出队不得删文件（版本链依赖它）');

  // ---- ④ 出队后不在队列 ----
  const queuedAfterLeave = mod.listPendingOutcomeJudgements(dir).map((r) => r.originFindingId);
  assert.strictEqual(queuedAfterLeave.indexOf(idLeave), -1, '出队后队列不得再返回它');

  // ---- ⑤ 版本链最后一条能还原出队前内容 ----
  assert.ok(Array.isArray(v2.prevTranslations) && v2.prevTranslations.length >= 1, '版本链必须非空');
  const snap = v2.prevTranslations[v2.prevTranslations.length - 1];
  assert.strictEqual(snap.needsOutcomeJudgement, true, '回溯：出队前的待判定标记必须可还原');
  assert.ok(snap.pendingOutcomeCandidate, '回溯：出队前的待判定候选必须可还原');
  assert.deepStrictEqual(snap.pendingOutcomeCandidate.references, [idLeave],
    '回溯：必须还原出候选引用的是哪条 finding（出队后当前态已无此信息）');
  assert.strictEqual(snap.pendingOutcomeCandidate.outcome, null, '回溯：候选须是未判定态');

  // ---- 反例对照：同目录另一条**未出队**的 spec（finding 仍在 confirmed）→ 仍必须被枚举出来 ----
  // 若没有这一条，④ 恒成立即可通过（队列恒空、或恒只看到一条）→ 反例保证枚举真按标记过滤。
  const fStay = mkFinding({ id: idStay, oracle: 'crash', evidence: { rootEmpty: true } });
  mod.emitRegressionSpec(mkPendingSpec(fStay, T0), dir, { confirmedIds: [idStay], nowMs: T0 + 2000 });
  const queuedFinal = mod.listPendingOutcomeJudgements(dir).map((r) => r.originFindingId);
  assert.strictEqual(queuedFinal.length, 1, '同目录只应剩下未出队的那一条在队列里');
  assert.strictEqual(queuedFinal[0], idStay, '未出队的条目必须仍在队列里（出队才该消失）');
  assert.strictEqual(queuedFinal.indexOf(idLeave), -1, '出队的那条必须不在队列里');
});

console.log('');
console.log('  N/A   G7b. Layer 3 acceptance-run 跳过 regressionOnly spec 的真机隔离');
console.log('        已 grep verify.cjs：regression / runMode / regressionOnly / acceptance-run / regression-run 全部 0 命中；');
console.log('        Layer 3 无 run-mode，无法验证回归 spec 不污染业务验收 → 本轮记 N/A（非 PASS），等 Layer 3 加模式后补验。');
console.log('');

console.log('T7 finding-to-spec: ' + pass + ' PASS / ' + fail + ' FAIL（G7b 记 N/A，不计入）');
if (fail !== 0) throw new Error('T7 验收失败 ' + fail + ' 项');