'use strict';
/**
 * demo-e2e.cjs —— 端到端演示：追问 → 对账 → 报告注入 完整链路
 *
 * 演示一个真实场景：
 *   验证器声明了 4 项初始计划，追问后扩充到 8 项；
 *   实际只执行了 5 项，其中 1 项口头声称测过但日志无记录（造假）；
 *   1 项有合规跳过理由；最终判定 REJECT，报告被拦。
 *
 * 运行：node plugins/anti-lazy-supervisor/demo-e2e.cjs
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

const C = require('./reconcile-core.cjs');
const ROOT = path.resolve(__dirname, '..', '..');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'als-e2e-'));

function line(ch) { return ch.repeat(70); }

console.log(line('='));
console.log('anti-lazy-supervisor · 端到端演示');
console.log(line('='));
console.log('场景：一个只测了 happy path 的验证器，声称"全部完成"');
console.log();

// ═══ 阶段一：追问扩容 ═══
console.log(line('-'));
console.log('阶段一 · 追问扩容（Questioning）');
console.log(line('-'));

const session = C.createQuestioning({
  initial: ['登录正常流程', '登出正常流程', '密码校验通过'],
});

console.log('验证器初始声明：' + session.items.length + ' 项');
console.log('  ' + session.items.map((i) => i.description).join(' / '));
console.log();

let q, round = 0;
while ((q = C.nextQuestion(session)) && round < 40) {
  round++;
  console.log(`【第${round}轮】${q.categoryName}（还剩 ${q.roundsLeft} 次机会）`);
  console.log('  问：' + q.prompt.replace(/\n\s*/g, ' '));

  // 模拟验证器回答：只在并发/安全/异常上给出新点，其余"没有"
  const answers = {
    concurrency: ['并发调用同一账号的幂等性', '重复提交订单的去重'],
    security: ['特殊字符注入', '越权访问他人订单'],
    error: ['第三方接口超时后的降级'],
  }[q.category] || [];

  const r = C.submitAnswer(session, q.category, answers);
  if (answers.length) {
    console.log('  答：' + answers.join(' / ') + `  → 新增 ${r.accepted} 项`);
  } else {
    const st = session.byCat[q.category];
    console.log(`  答：无  → 连续无新增 ${st.noNewStreak}/2${st.done ? '，该类型收敛' : ''}`);
  }
}
console.log();
console.log(`追问结束：共 ${round} 轮，最终契约 ${session.items.length} 项`
  + `（初始 ${session.initialCount} + 追问 ${session.items.length - session.initialCount}）`);

// ═══ 阶段二：硬对账 ═══
console.log();
console.log(line('-'));
console.log('阶段二 · 硬对账（Reconciliation）');
console.log(line('-'));

const total = session.items.length;
const doneIdx = [0, 1, 2, 3, 4];              // 前 5 项有真实执行日志
const ledgerEntries = doneIdx.map((i, k) => ({
  id: 'LG-demo-' + k,
  ledger: 'plan',
  title: '[契约] ' + session.items[i].description,
  detail: `id=${session.items[i].id}; 已执行并通过`,
  status: 'open',
}));

fs.mkdirSync(path.join(TMP, 'ledger'), { recursive: true });
fs.writeFileSync(path.join(TMP, 'ledger', 'ledger.jsonl'),
  ledgerEntries.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf-8');

console.log(`执行日志：写入 ${doneIdx.length} 条（共 ${total} 项契约）`);
console.log();

// 验证器口头声称：全部测了 + 给一项跳过理由
const claimed = {};
for (const it of session.items) claimed[it.id] = 'completed';
const skipId = session.items[doneIdx.length].id;
const skipNotes = {};
skipNotes[skipId] = '第三方支付沙箱不可用';

console.log('验证器口头声称：「全部 ' + total + ' 项均已测试通过」');
console.log('验证器提交跳过理由 1 条：' + skipId);
console.log();

const execLog = C.readExecutionLog(TMP);
const recon = C.reconcile(session, execLog, { claimed, skipNotes });

console.log('对账结果：');
console.log('  应测契约：' + recon.total);
console.log('  实际完成：' + recon.completed);
console.log('  合规跳过：' + recon.skipped);
console.log('  漏  检 ：' + recon.dangling);
console.log('  判定    ：' + recon.verdict);
console.log();
console.log('  漏检明细：');
for (const d of recon.details.filter((x) => x.status === 'dangling')) {
  const tag = d.claimedByVerifier ? '  ← 声称测过（造假）' : '';
  console.log(`    · ${d.description}${tag}`);
}
console.log();

// ═══ 阶段三：门禁 + 报告注入 ═══
console.log(line('-'));
console.log('阶段三 · 门禁与报告注入（Gating & Report Injection）');
console.log(line('-'));

const hostReport = [
  '# software-verifier 验证报告',
  '',
  '## 验证范围',
  '登录 / 登出 / 密码校验',
  '',
  '## 结论',
  '✅ 全部测试通过，验证器认为功能正常。',
].join('\n');

const injected = C.injectReport(hostReport, session, recon);

console.log('门禁判定：' + injected.gate.verdict);
console.log('是否允许落盘：' + (injected.gate.allow ? '✅ 允许' : '⛔ 拒绝'));
console.log();
console.log('═══ 最终报告（验证器视角，实际会被拦下）═══');
console.log();
console.log(injected.text);
console.log();

// ═══ 反面验证：全部补齐后应放行 ═══
console.log(line('-'));
console.log('反面验证 · 把漏检补齐后门禁应放行');
console.log(line('-'));

const allLog = session.items.map((it, i) => ({
  id: 'LG-fix-' + i, ledger: 'plan',
  title: '[契约] ' + it.description, detail: 'id=' + it.id,
}));
fs.writeFileSync(path.join(TMP, 'ledger', 'ledger.jsonl'),
  allLog.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf-8');

const recon2 = C.reconcile(session, C.readExecutionLog(TMP), {});
console.log('补齐执行日志后：完成 ' + recon2.completed + ' / 漏检 ' + recon2.dangling
  + ' → ' + recon2.verdict);
console.log('是否允许落盘：' + (C.gate(session, recon2).allow ? '✅ 允许' : '⛔ 拒绝'));
console.log();
console.log('→ 说明门禁是**按实际证据**放行的，不是把结论写死成"拒绝"。');

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
console.log();
console.log(line('='));
console.log('演示结束');
console.log(line('='));
