'use strict';
// T6 sampling-audit 验收：G1~G5（mock 级；沙箱无真机数据，真机采样 N/A）
const assert = require('assert');
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const mod = require('./sampling-audit.cjs');

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

// ---------- G1. 可复现抽样 + 快照 ----------
check('G1. 同快照同种子两次抽样一致', () => {
  const findings = [];
  for (let i = 1; i <= 12; i++) findings.push({ id: 'f' + i, reviewStatus: 'confirmed', judgmentSource: 'rule:spec-gen' });
  const snap = mod.snapshotInputSet(findings, ['rule:spec-gen', 'oracle:*', 'model:*'], 1000);
  assert.strictEqual(snap.ids.length, 12);
  assert.deepStrictEqual(snap.ids, ['f1', 'f10', 'f11', 'f12', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9']); // 字符串排序为字典序，确定即可复现
  const s1 = mod.sampleFindings(snap.ids, 0.5, 7);
  const s2 = mod.sampleFindings(snap.ids, 0.5, 7);
  deepEqual(s1, s2);
  assert.strictEqual(s1.length, 6);
});

check('G1. 输入顺序无关（先排序）', () => {
  const a = [];
  for (let i = 1; i <= 12; i++) a.push({ id: 'f' + i, reviewStatus: 'confirmed', judgmentSource: 'rule:spec-gen' });
  const b = a.slice().reverse();
  const sa = mod.snapshotInputSet(a, ['rule:spec-gen'], 1).ids;
  const sb = mod.snapshotInputSet(b, ['rule:spec-gen'], 1).ids;
  deepEqual(sa, sb);
  deepEqual(mod.sampleFindings(sa, 0.5, 7), mod.sampleFindings(sb, 0.5, 7));
});

check('G1. 快照与实时态解耦（confirmed→pending 重开后不污染旧快照）', () => {
  const findings = [];
  for (let i = 1; i <= 12; i++) findings.push({ id: 'f' + i, reviewStatus: 'confirmed', judgmentSource: 'rule:spec-gen' });
  const snap1 = mod.snapshotInputSet(findings, ['rule:spec-gen', 'oracle:*', 'model:*'], 1000);
  const s1 = mod.sampleFindings(snap1.ids, 0.5, 7);
  // 把 f1 重开为 pending，重做快照
  const live2 = findings.map((f) => (f.id === 'f1' ? { ...f, reviewStatus: 'pending' } : f));
  const snap2 = mod.snapshotInputSet(live2, ['rule:spec-gen', 'oracle:*', 'model:*'], 2000);
  assert.strictEqual(snap2.ids.indexOf('f1'), -1); // 新快照已排除
  const s2 = mod.sampleFindings(snap2.ids, 0.5, 7);
  assert.strictEqual(s2.indexOf('f1'), -1); // 旧快照抽出的 s1 不受影响（基于 id 列表，不读实时态）
  assert.notDeepStrictEqual(s1, s2);
});

check('G1. 快照冻结内容（底层文件变动不影响已快照聚合）', () => {
  const findings = [];
  for (let i = 1; i <= 12; i++) findings.push({ id: 'f' + i, reviewStatus: 'confirmed', judgmentSource: 'rule:spec-gen', confidence: 'high', evidence: { log: 'x' } });
  const snap = mod.snapshotInputSet(findings, ['rule:spec-gen', 'oracle:*', 'model:*'], 1000);
  const labels = {};
  snap.ids.forEach((id) => (labels[id] = 'correct'));
  const before = mod.computeCorrectRate(snap.ids, labels);
  // 模拟底层文件变动：原 findings 内容改掉（confirmed→pending，confidence 改低）
  findings[0].reviewStatus = 'pending';
  findings[0].confidence = 'low';
  findings[0].evidence = null;
  // 快照 captures 仍冻结当时内容（缺口 1：不是空快照）
  assert.strictEqual(snap.captures['f1'].reviewStatus, 'confirmed');
  assert.strictEqual(snap.captures['f1'].confidence, 'high');
  // 用快照重新聚合（不重新 loadFindings）→ 结果与 before 一致
  const after = mod.computeCorrectRate(snap.ids, labels);
  assert.deepStrictEqual(after, before);
});

// ---------- G2. 正确率聚合 + 最小样本量 ----------
check('G2. n=10 只算除法、标 insufficient-sample（不驱动调参）', () => {
  const samples = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
  const labels = { a: 'correct', b: 'correct', c: 'correct', d: 'correct', e: 'correct', f: 'correct', g: 'correct', h: 'correct', i: 'wrong', j: 'wrong' };
  const r = mod.computeCorrectRate(samples, labels);
  assert.strictEqual(r.n, 10);
  assert.strictEqual(r.correct, 8);
  assert.ok(Math.abs(r.labeledCorrectRate - 0.8) < 1e-9);
  assert.strictEqual(r.insufficient, true);
  assert.strictEqual(r.tunable, false);
  assert.strictEqual(r.ci, null);
});

check('G2. n=40 输出可调参正确率 + Wilson CI', () => {
  const samples = [];
  for (let i = 0; i < 40; i++) samples.push('x' + i);
  const labels = {};
  samples.forEach((id) => (labels[id] = 'correct'));
  const r = mod.computeCorrectRate(samples, labels);
  assert.strictEqual(r.n, 40);
  assert.ok(Math.abs(r.labeledCorrectRate - 1) < 1e-9);
  assert.strictEqual(r.insufficient, false);
  assert.strictEqual(r.tunable, true);
  assert.ok(r.ci && r.ci.lower > 0 && r.ci.lower <= 1 && r.ci.upper === 1);
  // 一致率 0.8（32/40）也应可算出 CI 且 tunable
  const labels2 = {};
  samples.forEach((id, idx) => (labels2[id] = idx < 32 ? 'correct' : 'wrong'));
  const r2 = mod.computeCorrectRate(samples, labels2);
  assert.ok(Math.abs(r2.labeledCorrectRate - 0.8) < 1e-9);
  assert.strictEqual(r2.tunable, true);
  assert.ok(r2.ci.lower <= r2.labeledCorrectRate && r2.labeledCorrectRate <= r2.ci.upper);
});

// ---------- G3. 趋势与建议（统计显著 + 分段）----------
check('G3. 段内 CI 重叠下降 = 噪声，不触发建议', () => {
  const series = [
    { at: 1, t5ConditionVersion: 't5@v1', rate: 0.9, n: 40, ci: { lower: 0.78, upper: 0.97 } },
    { at: 2, t5ConditionVersion: 't5@v1', rate: 0.8, n: 40, ci: { lower: 0.66, upper: 0.89 } },
  ];
  const out = mod.suggestReview(series);
  assert.strictEqual(out.suggestions.length, 0);
  assert.strictEqual(out.modified, false);
});

check('G3. 段内 CI 不重叠下降 = 显著，触发建议', () => {
  const series = [
    { at: 1, t5ConditionVersion: 't5@v1', rate: 0.95, n: 100, ci: { lower: 0.89, upper: 0.98 } },
    { at: 2, t5ConditionVersion: 't5@v1', rate: 0.7, n: 100, ci: { lower: 0.6, upper: 0.79 } },
  ];
  const out = mod.suggestReview(series);
  assert.strictEqual(out.suggestions.length, 1);
  assert.strictEqual(out.suggestions[0].reason, 'ci-nonoverlap-decline');
});

check('G3. 跨 t5ConditionVersion 即便暴跌也不跨段比较（不触发）', () => {
  const series = [
    { at: 1, t5ConditionVersion: 't5@v1', rate: 0.95, n: 100, ci: { lower: 0.89, upper: 0.98 } },
    { at: 2, t5ConditionVersion: 't5@v2', rate: 0.1, n: 100, ci: { lower: 0.05, upper: 0.18 } },
  ];
  const out = mod.suggestReview(series);
  assert.strictEqual(out.suggestions.length, 0); // comparable:false → 不触发
});

check('G3. n<30 下降判为 insufficient-sample，不触发建议', () => {
  const series = [
    { at: 1, t5ConditionVersion: 't5@v1', rate: 0.95, n: 10, ci: null },
    { at: 2, t5ConditionVersion: 't5@v1', rate: 0.7, n: 10, ci: null },
  ];
  const out = mod.suggestReview(series);
  assert.strictEqual(out.suggestions.length, 0);
});

check('G3. 连续轻微重叠但点估计持续走低 → creeping-decline 人工介入', () => {
  const series = [
    { at: 1, t5ConditionVersion: 't5@v1', rate: 0.85, n: 40, ci: { lower: 0.72, upper: 0.93 } },
    { at: 2, t5ConditionVersion: 't5@v1', rate: 0.8, n: 40, ci: { lower: 0.67, upper: 0.89 } },
    { at: 3, t5ConditionVersion: 't5@v1', rate: 0.75, n: 40, ci: { lower: 0.62, upper: 0.84 } },
  ];
  const out = mod.suggestReview(series);
  assert.strictEqual(out.suggestions.length, 1);
  assert.strictEqual(out.suggestions[0].reason, 'creeping-decline-human-review');
});

// ---------- G4. 独立性（静态 + 运行时 + 只读路径）----------
check('G4. 静态+运行时：绝不依赖 review.cjs（含 ./ ../ 变体）/ transition / applyCandidateSpec', () => {
  const src = fs.readFileSync(__filename.replace(/\.test\.cjs$/, '.cjs'), 'utf8');
  // 静态：任何 require(...review...) 形式零命中（含 ./ ../ 变体；注释里的「不 require review.cjs」无 require( 不匹配）
  assert.strictEqual(/require\(['"][^'"]*review/.test(src), false, '源码不得 require 任何 review 相关模块');
  assert.strictEqual(src.indexOf('transition'), -1, '源码不得引用 transition');
  assert.strictEqual(src.indexOf('applyCandidateSpec'), -1, '源码不得引用 applyCandidateSpec');
  // 运行时双保险：require.cache 中不得出现 review.cjs
  const cached = Object.keys(require.cache).some((k) => /review\.cjs/.test(k));
  assert.strictEqual(cached, false, 'require.cache 不得加载 review.cjs');
});

check('G4. 运行时：导出对象不含 transition / applyCandidateSpec', () => {
  assert.strictEqual(typeof mod.transition, 'undefined');
  assert.strictEqual(typeof mod.applyCandidateSpec, 'undefined');
});

check('G4. 只读落盘路径：loadFindings 不改文件', () => {
  const tmp = path.join(require('os').tmpdir(), 'sv_t6_lf_' + Date.now() + '.json');
  const payload = JSON.stringify([{ id: 'z1', reviewStatus: 'confirmed', judgmentSource: 'oracle:*' }]);
  fs.writeFileSync(tmp, payload);
  const before = crypto.createHash('sha1').update(fs.readFileSync(tmp, 'utf8')).digest('hex');
  const got = mod.loadFindings(tmp);
  const after = crypto.createHash('sha1').update(fs.readFileSync(tmp, 'utf8')).digest('hex');
  assert.strictEqual(before, after, 'loadFindings 不得修改落盘文件');
  assert.strictEqual(got.length, 1);
  assert.strictEqual(got[0].id, 'z1');
  fs.unlinkSync(tmp);
});

// ---------- G5. 标注一致性门槛 ----------
check('G5. 双标注高一致 → usable:true', () => {
  const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
  const A = {};
  const B = {};
  ids.forEach((id) => {
    A[id] = 'correct';
    B[id] = 'correct';
  });
  const r = mod.labelConsistency(A, B);
  assert.strictEqual(r.agreement, 1);
  assert.strictEqual(r.kappa, 1);
  assert.strictEqual(r.metric, 'cohen-kappa');
  assert.strictEqual(r.usable, true);
});

check('G5. 原始一致率中等但 kappa 低 → usable:false（偏斜场景下 raw 会误判）', () => {
  const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
  const A = {};
  const B = {};
  ids.forEach((id, idx) => {
    A[id] = idx < 5 ? 'correct' : 'wrong';
    // B 与 A 仅部分重合：idx 0,1,2,8,9 标正确，其余标错误 → 原始一致率约 0.6，但 kappa 低
    B[id] = (idx === 0 || idx === 1 || idx === 2 || idx === 8 || idx === 9) ? 'correct' : 'wrong';
  });
  const r = mod.labelConsistency(A, B);
  assert.ok(r.agreement >= 0.5 && r.agreement <= 0.7, '原始一致率中等，易误判为可用');
  assert.ok(r.kappa < 0.6, 'Cohen kappa 低 → 真实一致差');
  assert.strictEqual(r.metric, 'cohen-kappa');
  assert.strictEqual(r.usable, false);
});

console.log('\nT6 sampling-audit: ' + pass + ' PASS / ' + fail + ' FAIL');
process.exit(fail === 0 ? 0 : 1);
