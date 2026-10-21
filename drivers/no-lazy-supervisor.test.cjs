'use strict';
/**
 * no-lazy-supervisor.test.cjs —— 插件验收（消费者视角）
 * ============================================================================
 * 验收标准只有三条，且全部机器判定：
 *   1. **不干扰宿主**：任何输入（含畸形输入）都不抛错、不破坏宿主状态
 *   2. **真进内核**：检出的偷懒能落到宿主的 plan/thread 账本与审计链
 *   3. **不误伤**：认真作答、诚实澄清**不得**被拦
 *
 * 运行：node drivers/no-lazy-supervisor.test.cjs
 * ============================================================================
 */

const assert = require('assert');
const path = require('path');

let PASS = 0;
let FAIL = 0;
function check(name, fn) {
  try {
    fn();
    PASS++;
    console.log('  [PASS] ' + name);
  } catch (e) {
    FAIL++;
    console.log('  [FAIL] ' + name + '  — ' + e.message);
  }
}

const ROOT = path.dirname(__dirname);
const host = require(path.join(ROOT, 'evolution-host.cjs'));
const sup = require(path.join(ROOT, 'drivers', 'no-lazy-supervisor.cjs'));

console.log('='.repeat(66));
console.log('不偷懒监督器 · 验收测试');
console.log('='.repeat(66));

// ── 验收 1：不干扰宿主（最高优先级）───────────────────────────
console.log('\n[验收1] 不干扰宿主：畸形输入不得抛错');
check('reply 为 null → 返回错误而非抛异常', () => {
  const r = sup.watchTurn({ reply: null });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'empty_reply');
});
check('无参数调用不抛异常', () => {
  const r = sup.watchTurn();
  assert.strictEqual(typeof r, 'object');
});
check('prevReply 为数字不抛异常（畸形输入降级）', () => {
  const r = sup.watchTurn({ reply: '正常回复内容，长度足够。', prevReply: 12345 });
  // 断言的是「没抛异常且返回结构完整」，不是某个不存在的键
  assert.strictEqual(typeof r, 'object');
  assert.strictEqual(typeof r.ok, 'boolean');
  assert.ok(Array.isArray(r.flagged));
});
check('contract 为非数组不抛异常', () => {
  const r = sup.watchTurn({ reply: 'abc', contract: 'not-an-array' });
  assert.strictEqual(r.ok, true);
});
check('宿主未 init 时安全降级（本地记录不上报）', () => {
  const r = sup.analyze({ reply: '稍后我会发给你完整报告。' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.flagged.length > 0, true);
  // analyze 不应产生任何上报
  assert.strictEqual(r.report.reported.length, 0);
});
check('configure 传垃圾参数不崩', () => {
  const r = sup.configure(null);
  assert.strictEqual(r.ok, true);
  sup.configure({ repetitionThreshold: 0.6, enableFiller: false, autoReport: false });
});

// ── 验收 2：检出能力（有机械判据的四类）─────────────────────
console.log('\n[验收2] 四类偷懒检出');
check('B 契约未完成 → 检出', () => {
  const r = sup.analyze({ reply: '好的，我来帮你分析这个问题。', contract: ['问题分析', '修改方案', '完整代码'] });
  assert.strictEqual(r.flagged.some((f) => f.type === 'contract'), true);
});
check('B 契约齐全 → 不误报', () => {
  const r = sup.analyze({
    reply: '问题分析：x 可能为 None。修改方案：加 if 判断。完整代码：如下 def f(): return 1',
    contract: ['问题分析', '修改方案', '完整代码'],
  });
  assert.strictEqual(r.flagged.length, 0, '误报了: ' + JSON.stringify(r.flagged));
});
check('C 承诺未兑现 → 检出（不被「提到动作词」骗过）', () => {
  // 关键回归：「稍后我会把完整的分析报告发给你」含「分析」，
  // 但本轮一字未干 —— 不能因为出现动作词就判通过
  const r = sup.analyze({ reply: '稍后我会把完整的分析报告发给你。' });
  assert.strictEqual(r.flagged.some((f) => f.type === 'promise'), true);
});
check('C 承诺 + 真实产出 → 不误报', () => {
  const r = sup.analyze({
    reply: '稍后补充完整版。先给结论：1. 配置路径写死导致启动失败；'
         + '2. 日志无分级难以定位；3. 连接池上限过小。',
  });
  assert.strictEqual(r.flagged.some((f) => f.type === 'promise'), false);
});
check('D 趋同化 → 检出', () => {
  const prev = '这是一个复杂的问题，需要根据具体情况来看。一般来说要分几个方面考虑。';
  const r = sup.analyze({ reply: prev, prevReply: prev });
  assert.strictEqual(r.flagged.some((f) => f.type === 'repetition'), true);
});
check('D 实质推进 → 不误报', () => {
  const prev = '这是一个复杂的问题，需要根据具体情况来看。一般来说要分几个方面考虑。';
  const r = sup.analyze({
    reply: '先看第一步：配置缺失会导致启动失败，需要检查路径变量与环境变量。',
    prevReply: prev,
  });
  assert.strictEqual(r.flagged.some((f) => f.type === 'repetition'), false);
});

// ── 验收 3：不误伤（诚实澄清是最容易被误伤的一类）────────────
console.log('\n[验收3] 不误伤：诚实澄清 ≠ 免责搪塞');
check('诚实澄清不得被拦（E 类开启时也不拦）', () => {
  sup.configure({ enableFiller: true });
  const r = sup.analyze({ reply: '请把代码贴出来，目前消息中没有看到代码。' });
  assert.strictEqual(r.flagged.some((f) => f.type === 'filler'), false,
    '把诚实澄清误判成搪塞了');
  sup.configure({ enableFiller: false });
});
check('E 类默认关闭（未开启时不判搪塞）', () => {
  sup.configure({ enableFiller: false });
  const r = sup.analyze({ reply: '一般来说要视情况而定。通常建议如下。' });
  assert.strictEqual(r.flagged.some((f) => f.type === 'filler'), false);
});
check('E 类开启后真搪塞被拦', () => {
  sup.configure({ enableFiller: true });
  const r = sup.analyze({ reply: '一般来说要视情况而定。通常建议如下。' });
  assert.strictEqual(r.flagged.some((f) => f.type === 'filler'), true);
  sup.configure({ enableFiller: false });
});

// ── 验收 4：真进宿主内核（不是只返回结果）────────────────────
console.log('\n[验收4] 真进宿主内核：账本 + 审计链');
check('init 后 ready', () => {
  host.init({});
  assert.strictEqual(host.ready(), true);
  // ⚠ 必须恢复 autoReport=true —— 验收1 的 configure 把它置成了 false 且没还原，
  // 导致本段全部拿到 reported=[]（实测踩过：看起来像「上报坏了」，实则是测试污染）。
  sup.configure({ autoReport: true, enableFiller: false });
});
check('契约未完成 → 进 plan 账本（P 类）', () => {
  const r = sup.watchTurn({
    reply: '好的，我来帮你分析这个问题。',
    contract: ['问题分析', '修改方案', '完整代码'],
    taskId: 'nlz-test-contract',
  });
  assert.strictEqual(r.flagged.length > 0, true);
  const rep = r.report.reported.find((x) => x.type === 'contract');
  assert.ok(rep && rep.ok === true, '未上报成功: ' + JSON.stringify(rep));
  assert.ok(rep.ledgerId, '未拿到 ledgerId');
  assert.ok(rep.signalId, '未拿到 signalId');
});
check('承诺未兑现 → 进 thread 账本（I 类）', () => {
  const r = sup.watchTurn({
    reply: '稍后我会把完整的分析报告发给你。',
    taskId: 'nlz-test-promise',
  });
  const rep = r.report.reported.find((x) => x.type === 'promise');
  assert.ok(rep && rep.ok === true, '未上报成功: ' + JSON.stringify(rep));
  assert.ok(rep.ledgerId, 'I 类未拿到 ledgerId');
});
check('认真作答 → 不产生任何上报（非干扰）', () => {
  const before = r_countLedger();
  sup.watchTurn({
    reply: '问题分析：x 为 None。修改方案：加 if 判断。完整代码：如下 def f(): return 1',
    contract: ['问题分析', '修改方案', '完整代码'],
    taskId: 'nlz-test-clean',
  });
  assert.strictEqual(r_countLedger(), before, '认真作答也写账本了 —— 污染宿主');
});

function r_countLedger() {
  try {
    const fs = require('fs');
    const p = path.join(ROOT, '.evolution', 'ledger', 'ledger.jsonl');
    if (!fs.existsSync(p)) return 0;
    return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).length;
  } catch (_) {
    return -1;
  }
}

// ── 验收 5：性能 ─────────────────────────────────────────────
console.log('\n[验收5] 性能：单次 < 5ms');
check('1000 次判定', () => {
  sup.configure({ autoReport: false });
  const t0 = Date.now();
  for (let i = 0; i < 1000; i++) {
    sup.analyze({ reply: '这是一段用于性能测试的普通回复内容，长度足够触发检查逻辑。', prevReply: '上一轮的内容完全不同' });
  }
  const per = (Date.now() - t0) / 1000;
  assert.ok(per < 5, '平均 ' + per.toFixed(4) + 'ms 超过 5ms');
  console.log('       平均 ' + per.toFixed(4) + 'ms/次');
  sup.configure({ autoReport: true, enableFiller: false });   // 还原，避免污染宿主默认行为
});

console.log('\n' + '='.repeat(66));
console.log('通过 ' + PASS + ' 项，失败 ' + FAIL + ' 项');
console.log('='.repeat(66));
process.exit(FAIL ? 1 : 0);
