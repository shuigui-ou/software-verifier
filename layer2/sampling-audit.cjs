'use strict';
// T6 sampling correctness audit —— 回顾性质量观测，非准入闸门。
// 物理隔离于 drivers/、evolution/；不 require review.cjs，只读 layer1-findings.json。
// 设计要点（v2 硬门槛）：
//  - 只交付「标注下正确率」，不声称真实正确率；标注偏差已知不消除。
//  - 最小样本量门槛 + Wilson 95% 置信区间；n<30 标 insufficient-sample，不驱动调参。
//  - 趋势带 t5ConditionVersion，跨条件版本分段，不跨段比较；下降须 CI 不重叠才显著。

const fs = require('fs');
const path = require('path');

const MIN_SAMPLE_SIZE = 30;
const LABEL_AGREEMENT_MIN = 0.8; // 原始一致率：仅作参考，不用于 usable 判定（偏斜场景会被抬高）
const KAPPA_MIN = 0.6; // Cohen's kappa 可用门槛：usable 以 kappa 为准
const Z_95 = 1.96;

// ---- 种子 PRNG（mulberry32），保证抽样可复现、顺序无关 ----
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashSeed(seed) {
  if (typeof seed === 'number') return seed >>> 0;
  const s = String(seed);
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// ---- 输入集合快照（补充 1）：与 T4 实时态解耦 ----
// 关键：快照必须冻结「聚合所需的全部内容字段」，而非只冻结 id 列表——
// 否则期间 confirmed→ignored→pending 重开后，用实时文件重新取字段会破坏可复现（缺口 1）。
// findings: [{id, reviewStatus, judgmentSource, confidence, evidence, proposedStatus, ...}]
function snapshotInputSet(findings, judgmentSources, nowMs) {
  const sources = Array.isArray(judgmentSources) ? judgmentSources : [judgmentSources];
  const filtered = (findings || []).filter(
    (f) => f && f.reviewStatus === 'confirmed' && sources.indexOf(f.judgmentSource) !== -1
  );
  const ids = filtered.map((f) => f.id).sort();
  const sourceMap = {};
  const captures = {};
  filtered.forEach((f) => {
    sourceMap[f.id] = f.judgmentSource;
    captures[f.id] = {
      reviewStatus: f.reviewStatus,
      judgmentSource: f.judgmentSource,
      confidence: f.confidence != null ? f.confidence : null,
      evidence: f.evidence != null ? f.evidence : null,
      proposedStatus: f.proposedStatus != null ? f.proposedStatus : null,
    };
  });
  return { ids, sourceMap, captures, snapshotAt: nowMs || Date.now(), count: ids.length };
}

// ---- 可复现抽样：基于快照 id 列表 ----
function sampleFindings(ids, ratio, seed) {
  const base = Array.isArray(ids) ? ids.slice().sort() : [];
  const n = base.length;
  if (n === 0) return [];
  const k = Math.max(1, Math.min(n, Math.round((ratio || 0) * n)));
  const rng = mulberry32(hashSeed(seed));
  const arr = base.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr.slice(0, k);
}

// ---- 只读落盘（补充 2）：不经 review.cjs ----
function loadFindings(jsonPath) {
  const raw = fs.readFileSync(jsonPath, 'utf8'); // 只读，不写回
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : (parsed.findings || []);
}

// ---- Wilson 95% 置信区间 ----
function wilsonInterval(k, n, z) {
  if (n <= 0) return { lower: 0, upper: 0 };
  const zz = z == null ? Z_95 : z;
  const phat = k / n;
  const denom = 1 + (zz * zz) / n;
  const center = (phat + (zz * zz) / (2 * n)) / denom;
  const margin = (zz / denom) * Math.sqrt((phat * (1 - phat)) / n + (zz * zz) / (4 * n * n));
  return { lower: Math.max(0, center - margin), upper: Math.min(1, center + margin) };
}

// ---- 正确率聚合 + 最小样本量门槛 ----
// samples: [id,...]; labels: {id: 'correct'|'wrong'}
function computeCorrectRate(samples, labels) {
  const n = Array.isArray(samples) ? samples.length : 0;
  let correct = 0;
  if (n > 0 && labels) {
    for (const id of samples) {
      if (labels[id] === 'correct') correct++;
    }
  }
  // 注意：labeledCorrectRate 是「标注下正确率」，不是「真实正确率」（约束 1 立场）。
  const labeledCorrectRate = n === 0 ? 0 : correct / n;
  if (n < MIN_SAMPLE_SIZE) {
    return { n, correct, labeledCorrectRate, insufficient: true, tunable: false, ci: null };
  }
  return { n, correct, labeledCorrectRate, insufficient: false, tunable: true, ci: wilsonInterval(correct, n) };
}

// ---- 标注一致性（硬门槛 1 落地）：双标注一致率 + Cohen's kappa ----
// labelsA/labelsB: {id: 'correct'|'wrong'}（id 对齐）
function labelConsistency(labelsA, labelsB) {
  const ids = Object.keys(labelsA || {});
  if (ids.length === 0) return { agreement: 0, kappa: 0, usable: false };
  let agree = 0;
  let aCorrect = 0;
  let bCorrect = 0;
  for (const id of ids) {
    const a = labelsA[id];
    const b = labelsB ? labelsB[id] : undefined;
    if (a === b) agree++;
    if (a === 'correct') aCorrect++;
    if (b === 'correct') bCorrect++;
  }
  const n = ids.length;
  const po = agree / n; // 原始一致率：仅参考
  const pe = (aCorrect / n) * (bCorrect / n) + ((n - aCorrect) / n) * ((n - bCorrect) / n);
  const kappa = pe === 1 ? 1 : (po - pe) / (1 - pe); // Cohen's kappa：扣随机一致
  // usable 以 kappa 为准（偏斜场景下原始一致率会被抬高，kappa 才可信）
  return { agreement: po, kappa, usable: kappa >= KAPPA_MIN, metric: 'cohen-kappa' };
}

// ---- 趋势分段（硬门槛 3）：按 t5ConditionVersion 分段 ----
// series: [{at, t5ConditionVersion, rate, n, ci}]
function segmentByCondition(series) {
  const sorted = (series || []).slice().sort((a, b) => (a.at || 0) - (b.at || 0));
  const segs = [];
  let cur = null;
  for (const pt of sorted) {
    if (!cur || cur.version !== pt.t5ConditionVersion) {
      cur = { version: pt.t5ConditionVersion, points: [] };
      segs.push(cur);
    }
    cur.points.push(pt);
  }
  return segs.map((s) => s.points);
}

// ---- 统计显著下降（硬门槛 2）----
// prev/curr: {rate, n, ci, t5ConditionVersion}
function isSignificantDecline(prev, curr) {
  if (!prev || !curr) return { comparable: false, significant: false, reason: 'missing' };
  if (prev.t5ConditionVersion !== curr.t5ConditionVersion) {
    return { comparable: false, significant: false, reason: 'condition-version-changed' };
  }
  if (!prev.ci || !curr.ci || prev.n < MIN_SAMPLE_SIZE || curr.n < MIN_SAMPLE_SIZE) {
    return { comparable: true, significant: false, reason: 'insufficient-sample' };
  }
  const noOverlap = curr.ci.upper < prev.ci.lower;
  const significant = noOverlap && curr.rate < prev.rate;
  return { comparable: true, significant, reason: significant ? 'ci-nonoverlap-decline' : 'noise' };
}

// ---- 建议复核（不修改任何状态）----
// 保守判定：CI 不重叠才判显著（宁漏报不误报）。但连续多轮「点估计持续走低却未显著」
// 属 creeping decline，需人工介入——不能因「不显著」就当一切正常（缺口 3）。
function suggestReview(series) {
  const segments = segmentByCondition(series);
  const suggestions = [];
  for (const seg of segments) {
    let creeping = 0;
    for (let i = 1; i < seg.length; i++) {
      const prev = seg[i - 1];
      const curr = seg[i];
      const r = isSignificantDecline(prev, curr);
      if (r.comparable && r.significant) {
        suggestions.push({
          at: curr.at,
          fromVersion: prev.t5ConditionVersion,
          toVersion: curr.t5ConditionVersion,
          reason: r.reason,
        });
        creeping = 0;
      } else if (r.comparable && !r.significant && curr.rate < prev.rate) {
        // 点估计下降但未达显著（CI 重叠 / n 不足）→ 累计 creeping
        creeping += 1;
        if (creeping >= 2) {
          suggestions.push({
            at: curr.at,
            fromVersion: prev.t5ConditionVersion,
            toVersion: curr.t5ConditionVersion,
            reason: 'creeping-decline-human-review',
          });
          creeping = 0;
        }
      } else {
        creeping = 0;
      }
    }
  }
  return { suggestions, modified: false };
}

module.exports = {
  MIN_SAMPLE_SIZE,
  LABEL_AGREEMENT_MIN,
  KAPPA_MIN,
  Z_95,
  mulberry32,
  hashSeed,
  snapshotInputSet,
  sampleFindings,
  loadFindings,
  wilsonInterval,
  computeCorrectRate,
  labelConsistency,
  segmentByCondition,
  isSignificantDecline,
  suggestReview,
};
