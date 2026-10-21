'use strict';
/**
 * test/layer1.test.cjs —— Layer 1 三条硬验收用例（spec §5）
 *
 * 真浏览器在本沙箱 N/A（无 GUI），故全部用 mock 证据 + 纯函数驱动
 * oracle 分类 / 覆盖率 / 护栏逻辑，不依赖真实 playwright 启动。
 *
 * 硬用例：
 *  A. precondition-unknown：空状态命中但前置条件无法判定 →
 *     confidence=medium-incomplete-evidence 且 falsePositiveNote=precondition-unknown，
 *     且未作为确定缺陷误报（不静默 skip）。
 *  B. anchorSource 缺失 → coverage 显式 'not-computable'（字符串，非回退自发现数值）。
 *  C. businessPass=false 护栏：构造把 businessPass 翻转为 true 的输入须被拒绝/抛错，
 *     正常产出的所有记录 businessPass===false。
 */

const assert = require('assert');
const path = require('path');
const { buildFinding, computeCoverage, selectAnchorSource, assertNoBusinessPass } =
  require(path.join(__dirname, '..', 'explore.cjs'));

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

// ---------------------------------------------------------------------------
console.log('\n=== Layer 1 硬验收用例 ===\n');

// ---- A. precondition-unknown ----
check('A. precondition-unknown → medium-incomplete-evidence + precondition-unknown，且非 high/非静默 skip', () => {
  const rec = buildFinding({
    oracle: 'empty-state',
    evidence: { selector: '.data-list', text: '暂无数据' },
    precondition: 'unknown',           // 前置条件无法判定
    reproPath: ['/', 'click:.data-list'],
  });

  assert.strictEqual(rec.confidence, 'medium-incomplete-evidence',
    'confidence 须为 medium-incomplete-evidence，实际=' + rec.confidence);
  assert.strictEqual(rec.falsePositiveNote, 'precondition-unknown',
    'falsePositiveNote 须为 precondition-unknown，实际=' + rec.falsePositiveNote);
  // 未作为确定缺陷误报：不得 high
  assert.notStrictEqual(rec.confidence, 'high', '不得误报为 high 确定缺陷');
  // 不静默 skip：记录仍被产出（suspect 永远 true，且 oracle 正确写入）
  assert.strictEqual(rec.suspect, true, '记录须产出（suspect 永远 true），不得静默丢弃');
  assert.strictEqual(rec.oracle, 'empty-state');
  // 护栏校验
  assertNoBusinessPass(rec);
});

// 对照：前置条件 met（合法空态嫌疑）→ 应为 medium-heuristic，证明 A 的 unknown 分支是真实分流而非一律降级
check('A. 对照：precondition=met → medium-heuristic（证明 unknown 是真分流）', () => {
  const rec = buildFinding({
    oracle: 'empty-state',
    evidence: { selector: '.data-list', text: '暂无数据', loginWall: false, sessionMissing: false },
    precondition: 'met',
    reproPath: ['/', 'click:.data-list'],
  });
  assert.strictEqual(rec.confidence, 'medium-heuristic');
  assert.strictEqual(rec.falsePositiveNote, '');
});

// 对照：前置条件 not-met（登录墙）→ precondition-not-met
check('A. 对照：precondition=not-met → precondition-not-met', () => {
  const rec = buildFinding({
    oracle: 'empty-state',
    evidence: { selector: '.data-list', text: '暂无数据', loginWall: true },
    precondition: 'not-met',
    reproPath: ['/', 'click:.data-list'],
  });
  assert.strictEqual(rec.falsePositiveNote, 'precondition-not-met');
});

// ---- B. anchorSource 缺失 → not-computable ----
check('B. 无 entrypoints/无 sitemap/菜单解析不出 → coverage === "not-computable"', () => {
  const src = selectAnchorSource({ manual: [], sitemap: [], navmenu: [] });
  assert.strictEqual(src, null, 'anchorSource 应为 null（三类锚点均缺失）');

  const cov = computeCoverage({ entrypoints: [], reached: [], anchorSource: null });
  assert.strictEqual(cov, 'not-computable',
    'coverage 须为字符串 "not-computable"，实际=' + JSON.stringify(cov));

  // 即便探索器自发现了一堆节点，也绝不回退：分母仍取声明集（为空）→ not-computable
  const cov2 = computeCoverage({ entrypoints: undefined, reached: ['/a', '/b', '/c'], anchorSource: null });
  assert.strictEqual(cov2, 'not-computable', '不得回退到自发现集合（数值）');
});

// 对照：有 manual 锚点 → 可计算数值
check('B. 对照：有 manual 锚点 → coverage 为数值（0~1）', () => {
  const src = selectAnchorSource({ manual: ['/p1', '/p2'] });
  assert.strictEqual(src, 'manual');
  const cov = computeCoverage({ entrypoints: ['/p1', '/p2'], reached: ['/p1'], anchorSource: 'manual' });
  assert.strictEqual(typeof cov, 'number', '有锚点时应返回数值');
  assert.strictEqual(cov, 0.5);
});

// ---- C. businessPass=false 护栏 ----
check('C. 构造 businessPass=true 的输入 → 被拒绝/抛错', () => {
  let threw = false;
  try {
    buildFinding({ oracle: 'pageerror', evidence: { message: 'x is not defined' }, businessPass: true });
  } catch (e) {
    threw = true;
    assert.ok(/businessPass/.test(e.message), '错误应指明 businessPass 护栏');
  }
  assert.strictEqual(threw, true, 'businessPass 非 false 的输入必须被拒绝/抛错');

  // assertNoBusinessPass 直接校验：非法对象抛错
  let guardThrew = false;
  try { assertNoBusinessPass({ businessPass: 'yes' }); } catch (_e) { guardThrew = true; }
  assert.strictEqual(guardThrew, true);
});

check('C. 正常产出的所有记录 businessPass === false', () => {
  const cases = [
    buildFinding({ oracle: 'crash', evidence: { rootEmpty: true } }),
    buildFinding({ oracle: 'pageerror', evidence: { message: 'x is not defined' } }),
    buildFinding({ oracle: 'requestfailed', evidence: { text: 'requestfailed: net::ERR_NAME_NOT_RESOLVED | url=http://x', status: null } }),
    buildFinding({ oracle: 'timeout', evidence: { op: 'navigate', waitedMs: 16000 } }),
    buildFinding({ oracle: 'empty-state', evidence: { selector: '.l', text: '暂无数据' }, precondition: 'met' }),
    buildFinding({ oracle: 'dead-link', evidence: { source: '/', target: '/gone', status: 404 } }),
  ];
  for (const c of cases) {
    assert.strictEqual(c.businessPass, false, '记录 ' + c.id + ' 的 businessPass 必须为 false');
    // 二次护栏确认
    assertNoBusinessPass(c);
  }
});

// ---------------------------------------------------------------------------
console.log('\n=== 结果汇总 ===');
console.log(results.join('\n'));
console.log('\n通过: ' + passed + '  失败: ' + failed);
process.exit(failed === 0 ? 0 : 1);
