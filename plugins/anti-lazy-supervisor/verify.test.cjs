'use strict';
/**
 * 验收测试 · 覆盖方案「五、验收标准」全部 7 条
 * 运行：node plugins/anti-lazy-supervisor/verify.test.cjs
 *
 * 纪律（红线5）：**失败优先怀疑本插件自身，不要先假定宿主有问题**。
 */
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.resolve(__dirname, '..', '..');
const C = require('./reconcile-core.cjs');

let PASS = 0, FAIL = 0;
const results = [];
function check(name, fn) {
  try { fn(); PASS++; results.push(['PASS', name]); }
  catch (e) { FAIL++; results.push(['FAIL', name + ' — ' + e.message]); }
}

// ── 临时 dataDir，避免污染宿主 .evolution ──────────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'als-verify-'));
// 每次改证据前先清场：否则上一条用例留下的 result.json 会串到下一条
// （v1.11.0 起执行证据只认 result.json，不清场会让"无证据"的用例意外通过）。
function clearEvidence() {
  try { fs.rmSync(path.join(TMP, 'result.json'), { force: true }); } catch (_) {}
}
function writeLedger(entries) {
  clearEvidence();
  fs.mkdirSync(path.join(TMP, 'ledger'), { recursive: true });
  fs.writeFileSync(path.join(TMP, 'ledger', 'ledger.jsonl'),
    entries.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf-8');
}
/** 写「功能点真的跑过」的唯一证据源（= 宿主 verify.cjs 落盘的 result.json）。 */
function writeResult(names) {
  clearEvidence();
  fs.mkdirSync(path.join(TMP, 'ledger'), { recursive: true });
  fs.writeFileSync(path.join(TMP, 'ledger', 'ledger.jsonl'), '', 'utf-8');
  fs.writeFileSync(path.join(TMP, 'result.json'), JSON.stringify({
    features: (names || []).map((n, i) => ({ id: 'F' + i, name: n, pass: true, errors: [] })),
  }), 'utf-8');
}
function writeAudit(entries) {
  fs.mkdirSync(path.join(TMP, 'audit'), { recursive: true });
  fs.writeFileSync(path.join(TMP, 'audit', 'audit.jsonl'),
    entries.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf-8');
}

/** 造一个"只测了 happy path"的假验证器会话 */
function fakeSession(initial) {
  const s = C.createQuestioning({ initial: initial || ['登录正常流程', '正常登出'] });
  let q, guard = 0;
  while ((q = C.nextQuestion(s)) && guard++ < 40) {
    const answers = (q.category === 'concurrency') ? ['并发调用超时防御']
                  : (q.category === 'security') ? ['特殊字符注入']
                  : (q.category === 'error') ? ['异常重试']
                  : [];
    C.submitAnswer(s, q.category, answers);
  }
  return s;
}

console.log('='.repeat(70));
console.log('anti-lazy-supervisor · 验收测试（方案 7 条标准）');
console.log('='.repeat(70));

// ═══ 验收 1：追问闭环 ═══════════════════════════════════════════
console.log('\n[验收1] 追问闭环：只测 happy path 的假验证器必须被逼出 ≥3 个新测试点');
check('1.1 追问逼出 ≥3 个新测试点', () => {
  const s = fakeSession();
  const added = s.items.filter((i) => i.source === 'questioning');
  assert.ok(added.length >= 3, `只逼出 ${added.length} 个`);
});
check('1.2 新测试点按类型分类（concurrency/security/error）', () => {
  const s = fakeSession();
  const cats = new Set(s.items.filter((i) => i.source === 'questioning').map((i) => i.category));
  assert.ok(cats.has('concurrency'), '缺 concurrency');
  assert.ok(cats.has('security'), '缺 security');
});
check('1.3 追问收敛（连续 2 轮无新增即停，不死循环）', () => {
  const s = fakeSession();
  assert.strictEqual(s.finished, true, '追问未收敛');
  for (const c of C.CATEGORIES) {
    assert.ok(s.byCat[c.key].rounds <= 3, `${c.key} 超过 3 轮：${s.byCat[c.key].rounds}`);
  }
});
check('1.4 初始与追问新增可区分（source 字段）', () => {
  const s = fakeSession();
  assert.strictEqual(s.items.filter((i) => i.source === 'initial').length, 2);
  assert.ok(s.items.filter((i) => i.source === 'questioning').length > 0);
});
check('1.5 每轮问答都有记录（transcript）', () => {
  const s = fakeSession();
  assert.ok(s.transcript.length >= s.items.length, 'transcript 少于契约数');
  assert.ok(s.transcript.some((t) => t.source === 'questioning'));
});

// ═══ 验收 2：对账抓漏检 ═════════════════════════════════════════
console.log('\n[验收2] 对账抓漏检：声明 10 项、执行 7 项 → 必须揪出 3 项 dangling');
check('2.1 准确识别 dangling 数量（方案示例：10 契约 / 7 执行 → 3 漏检）', () => {
  const s = fakeSession();
  // 凑够 10 项（方案验收 2 的原始场景）。
  // 追问收敛后要走**显式追加**入口——反复调 submitAnswer 会被 finished 拒掉。
  for (let i = 0; i < 10; i++) {
    if (s.items.length >= 10) break;
    C.addContract(s, '额外测试点' + i, 'input');
  }
  assert.strictEqual(s.items.length, 10, '未凑够 10 项');

  const execCount = 7;                        // 只执行 7 项
  // 执行证据必须来自 result.json 的功能点结果；账本里的 `[契约]` plan 条目是
  // seal 阶段自己写的**计划**，不能充当执行证据（D2，2026-10-26）。
  writeResult(s.items.slice(0, execCount).map((it) => it.description));

  const r = C.reconcile(s, C.readExecutionLog(TMP), {});
  assert.strictEqual(r.completed, 7, '应有 7 项完成');
  assert.strictEqual(r.dangling, 3, `应 3 项漏检，实得 ${r.dangling}`);
  assert.strictEqual(r.total, 10);
});
check('2.2 skipped 必须有理由，无理由不得算 skipped', () => {
  const s = fakeSession(['A', 'B']);
  writeResult([s.items[0].description]);
  const exec = C.readExecutionLog(TMP);

  // 让除最后一项外全部带合法理由，只留最后一项测「无理由」
  const base = {};
  for (let i = 1; i < s.items.length - 1; i++) base[s.items[i].id] = '外部 API 依赖不可用';
  const lastId = s.items[s.items.length - 1].id;

  // 无理由的跳过 → dangling
  const r1 = C.reconcile(s, exec, { skipNotes: Object.assign({}, base) });
  assert.strictEqual(r1.dangling, 1, '无理由的跳过未被判漏检');
  assert.ok(r1.details.find((d) => d.id === lastId && d.status === 'dangling'),
    '漏检的不是最后一项');

  // 补上理由 → skipped，verdict 转PASS_WITH_WARNINGS
  const withReason = Object.assign({}, base, { [lastId]: '外部 API 依赖不可用' });
  const r2 = C.reconcile(s, exec, { skipNotes: withReason });
  assert.strictEqual(r2.dangling, 0);
  assert.ok(r2.skipped >= 1);
  assert.strictEqual(r2.verdict, 'PASS_WITH_WARNINGS');
});

// ═══ 验收 3：抓造假 ═════════════════════════════════════════════
console.log('\n[验收3] 抓造假：口头说"测了"但日志无记录 → 必须判 dangling');
check('3.1 口头声明 completed 不算数', () => {
  const s = fakeSession(['项A', '项B', '项C']);
  // 日志里什么都没有
  writeLedger([]);
  const exec = C.readExecutionLog(TMP);
  // 验证器声称全部完成
  const claimed = {};
  for (const it of s.items) claimed[it.id] = 'completed';
  const r = C.reconcile(s, exec, { claimed });
  assert.strictEqual(r.dangling, s.items.length, '口头声明被采信了');
  assert.strictEqual(r.completed, 0);
});
check('3.2 造假项带说明（claimedByVerifier=true）', () => {
  const s = fakeSession(['项A']);
  writeLedger([]);
  const exec = C.readExecutionLog(TMP);
  const r = C.reconcile(s, exec, { claimed: { [s.items[0].id]: 'completed' } });
  const d = r.details[0];
  assert.strictEqual(d.claimedByVerifier, true);
  assert.ok(d.note && d.note.includes('无对应记录'), '缺造假说明');
});
check('3.3 部分造假：只有有日志的算 completed', () => {
  const s = fakeSession(['项A', '项B', '项C']);
  // 只执行第 2 项（证据写进 result.json，不再用账本计划条目）
  writeResult([s.items[1].description]);
  const exec = C.readExecutionLog(TMP);
  const r = C.reconcile(s, exec, {});
  assert.strictEqual(r.completed, 1, '应为 1 项完成');
  // 动态：总数 - 1
  assert.strictEqual(r.dangling, s.items.length - 1,
    `应 ${s.items.length - 1} 项漏检，实得 ${r.dangling}`);
  assert.strictEqual(r.verdict, 'REJECT');
});

// ═══ 验收 4：报告注入 ═══════════════════════════════════════════
console.log('\n[验收4] 报告注入：区块由插件生成，数据与 ledger 一致');
check('4.1 注入区块存在且含关键字段', () => {
  const s = fakeSession(['项A', '项B']);
  writeResult([s.items[0].description]);
  const r = C.reconcile(s, C.readExecutionLog(TMP), {});
  const out = C.injectReport('# 验证报告\n正文内容', s, r);
  assert.strictEqual(out.ok, true);
  assert.ok(out.text.includes('监督对账台账'), '缺区块标题');
  // ⚠ 契约数**必须动态取**——初版硬编码 2，但追问会新增项，
  //   测试凭空 FAIL 而插件其实是对的（2026-10-21 踩过）。
  assert.ok(out.text.includes('最终应测契约：' + s.items.length),
    '契约数与实际不符: ' + s.items.length);
  assert.ok(out.text.includes('漏检：' + r.dangling), '漏检数不符');
  assert.ok(out.text.includes('验证报告'), '原报告丢失');
});
check('4.2 区块数据与对账结果一致（不可篡改）', () => {
  const s = fakeSession(['项A', '项B', '项C']);
  writeResult([s.items[0].description]);
  const r = C.reconcile(s, C.readExecutionLog(TMP), {});
  const block = C.renderAuditBlock(s, r);
  assert.ok(block.includes(`实际完成：${r.completed}`), 'completed 数字不一致');
  assert.ok(block.includes(`漏检：${r.dangling}`), 'dangling 数字不一致');
});
check('4.3 区块 prepend 在宿主报告之前（无法绕过）', () => {
  const s = fakeSession(['项A', '项B']);
  writeLedger([]);
  const r = C.reconcile(s, C.readExecutionLog(TMP), {});
  const out = C.injectReport('宿主报告正文', s, r);
  const idxBlock = out.text.indexOf('监督对账台账');
  const idxHost = out.text.indexOf('宿主报告正文');
  assert.ok(idxBlock >= 0 && idxBlock < idxHost, '区块未在宿主报告之前');
});

// ═══ 验收 5：门禁拦截 ═══════════════════════════════════════════
console.log('\n[验收5] 门禁：有 dangling → REJECT + 顶部警告');
check('5.1 有 dangling → allow=false', () => {
  const s = fakeSession(['项A', '项B']);
  writeLedger([]);
  const r = C.reconcile(s, C.readExecutionLog(TMP), {});
  const g = C.gate(s, r);
  assert.strictEqual(g.verdict, 'REJECT');
  assert.strictEqual(g.allow, false);
});
check('5.2 REJECT 时报告顶部有警告标记', () => {
  const s = fakeSession(['项A', '项B']);
  writeLedger([]);
  const r = C.reconcile(s, C.readExecutionLog(TMP), {});
  const out = C.injectReport('报告', s, r);
  assert.ok(out.text.startsWith('⚠️ 监督审计未通过'), '顶部无警告');
});
check('5.3 全部 completed → PASS + 放行', () => {
  const s = fakeSession(['项A', '项B']);
  writeResult(s.items.map((it) => it.description));
  const r = C.reconcile(s, C.readExecutionLog(TMP), {});
  assert.strictEqual(r.dangling, 0);
  assert.strictEqual(r.verdict, 'PASS');
  assert.strictEqual(C.gate(s, r).allow, true);
});
check('5.4 仅 skipped → PASS_WITH_WARNINGS + 放行', () => {
  const s = fakeSession(['项A', '项B']);
  // 只执行第 1 项（result.json 为证），**其余全部**给跳过理由（否则会出现 dangling → REJECT）
  writeResult([s.items[0].description]);
  const notes = {};
  for (let i = 1; i < s.items.length; i++) notes[s.items[i].id] = '依赖不可用';
  const r = C.reconcile(s, C.readExecutionLog(TMP), { skipNotes: notes });
  assert.strictEqual(r.dangling, 0, '不该有漏检: ' + JSON.stringify(r.details.filter(d=>d.status==='dangling')));
  assert.strictEqual(r.verdict, 'PASS_WITH_WARNINGS');
  assert.strictEqual(C.gate(s, r).allow, true);
});

// ═══ 验收 6：不干扰宿主 ═════════════════════════════════════════
console.log('\n[验收6] 不干扰宿主：插件异常不中断流程');
check('6.1 对账遇空 session 不抛错', () => {
  const r = C.reconcile(null, null, {});
  assert.strictEqual(typeof r, 'object');
  assert.strictEqual(r.verdict, 'REJECT');
});
check('6.2 readExecutionLog 指向不存在目录不抛错', () => {
  // 必须先清场：guessResultPath 会从 dataDir 逐级向上找三层，
  // 前面用例写在 TMP/result.json 的证据会被这条用例"顺手捡到"，
  // 导致 available=true —— 那是夹具串味，不是被测函数的问题。
  clearEvidence();
  const r = C.readExecutionLog(path.join(TMP, '不存在的目录'));
  assert.strictEqual(r.available, false);
  assert.ok(r.reason);
});
check('6.3 畸形 ledger 行（非法 JSON）被跳过而非崩溃', () => {
  fs.mkdirSync(path.join(TMP, 'ledger'), { recursive: true });
  fs.writeFileSync(path.join(TMP, 'ledger', 'ledger.jsonl'),
    '{"valid":1}\n这不是JSON\n{"also":"valid"}\n', 'utf-8');
  const r = C.readExecutionLog(TMP);
  assert.strictEqual(r.ledger.length, 2, '畸形行未被跳过');
});
check('6.4 门禁自身异常时保守拒绝但不抛错', () => {
  const g = C.gate(null, null);
  assert.strictEqual(typeof g.allow, 'boolean');
  assert.strictEqual(g.allow, false, '异常时未保守拒绝');
});
check('6.5 submitAnswer 传错类型不抛错', () => {
  const s = C.createQuestioning({ initial: ['A'] });
  assert.doesNotThrow(() => C.submitAnswer(s, '不存在的类别', ['x']));
  assert.doesNotThrow(() => C.submitAnswer(s, 'input', null));
  assert.doesNotThrow(() => C.submitAnswer(null, 'input', ['x']));
});

// ═══ 验收 7：零依赖 ═════════════════════════════════════════════
console.log('\n[验收7] 零依赖：只用 Node 内置模块');
check('7.1 仅 require fs / path（无第三方）', () => {
  const src = fs.readFileSync(path.join(__dirname, 'reconcile-core.cjs'), 'utf-8');
  const reqs = [...src.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]);
  const builtin = new Set(['fs', 'path', 'os', 'util', 'crypto', 'events']);
  for (const r of reqs) {
    assert.ok(builtin.has(r), `发现第三方依赖：${r}`);
  }
});
check('7.2 无 package.json 依赖声明被修改', () => {
  const pj = path.join(ROOT, 'package.json');
  if (!fs.existsSync(pj)) return;   // 宿主本来就没有 → 无从污染
  const pkg = JSON.parse(fs.readFileSync(pj, 'utf-8'));
  assert.ok(!pkg.dependencies || Object.keys(pkg.dependencies).length === 0,
    '宿主 package.json 被加了依赖');
});

// ═══ 补充：默认开启语义 ══════════════════════════════════════
// 三条是「默认开启」的安全基础，缺一不可。
// 背景：2026-10-21 用户质疑「不开启还有什么意义」，据此把默认从关闭改为开启。
console.log('\n[补充] 默认开启：没声明契约不介入 / 声明了必须对账');

check('未起会话（session=null）→ REJECT（不放行）', () => {
  const r = C.reconcile(null, { ledger: [], audit: [] }, {});
  assert.strictEqual(r.verdict, 'REJECT');
});
check('起了会话但没声明契约 → NOT_APPLICABLE（不拦）', () => {
  const s = C.createQuestioning({ initial: [] });
  const r = C.reconcile(s, { ledger: [], audit: [] }, {});
  assert.strictEqual(r.verdict, 'NOT_APPLICABLE');
  assert.strictEqual(C.gate(s, r).allow, true, '未声明契约不该拦');
});
check('声明了契约但没执行 → REJECT（监督的价值所在）', () => {
  const s = C.createQuestioning({ initial: ['并发登录幂等性', '特殊字符注入'] });
  const r = C.reconcile(s, { ledger: [], audit: [] }, {});
  assert.strictEqual(r.verdict, 'REJECT');
  assert.strictEqual(r.dangling, 2);
  assert.strictEqual(C.gate(s, r).allow, false);
});

// ═══ 补充：执行证据数据源 ════════════════════════════════════
// 回归钉死 2026-10-21 踩过的坑：只读 ledger → 在真实项目上把 34 个
// **确实测过**的功能点全判 dangling（假阳性 100%）。真证据在 result.json。
console.log('\n[补充] 执行证据源：result.json 为主，ledger 为辅');

check('readExecutionLog 能从 result.json 读出功能点', () => {
  const tmpd = fs.mkdtempSync(path.join(os.tmpdir(), 'als-res-'));
  fs.mkdirSync(path.join(tmpd, 'verify_report'), { recursive: true });
  fs.writeFileSync(path.join(tmpd, 'verify_report', 'result.json'), JSON.stringify({
    features: [
      { id: 'F01', name: '登录正常流程', pass: true, errors: [] },
      { id: 'F02', name: '导出功能', pass: true, errors: [] },
    ],
  }), 'utf-8');
  fs.mkdirSync(path.join(tmpd, 'ledger'), { recursive: true });
  // ledger 里只有落差，没有功能点执行记录
  fs.writeFileSync(path.join(tmpd, 'ledger', 'ledger.jsonl'),
    JSON.stringify({ ledger: 'error', title: 'x', detail: 'y' }) + '\n', 'utf-8');
  const log = C.readExecutionLog(tmpd);
  assert.ok(log.results.length === 2, '应读出 2 条功能点证据，实际 ' + log.results.length);
  assert.ok(log.ledger.length === 1, 'ledger 应仍可读');
  fs.rmSync(tmpd, { recursive: true, force: true });
});

check('result.json 里的功能点能把契约判为 completed（关键：假阳性防线）', () => {
  const tmpd = fs.mkdtempSync(path.join(os.tmpdir(), 'als-res2-'));
  fs.mkdirSync(path.join(tmpd, 'verify_report'), { recursive: true });
  fs.writeFileSync(path.join(tmpd, 'verify_report', 'result.json'), JSON.stringify({
    features: [{ id: 'F01', name: '登录正常流程', pass: true, errors: [] }],
  }), 'utf-8');
  fs.mkdirSync(path.join(tmpd, 'ledger'), { recursive: true });
  fs.writeFileSync(path.join(tmpd, 'ledger', 'ledger.jsonl'),
    JSON.stringify({ ledger: 'expectation', title: '某落差', detail: '' }) + '\n', 'utf-8');

  const s = C.createQuestioning({ initial: ['登录正常流程'] });
  const r = C.reconcile(s, C.readExecutionLog(tmpd), {});
  assert.ok(r.completed === 1, 'result.json 里的功能点应判 completed，实际 completed=' + r.completed);
  assert.ok(r.dangling === 0, '不应误判漏检');
  fs.rmSync(tmpd, { recursive: true, force: true });
});

check('只有 ledger 无 result.json → evidenceKind=gaps_only，且**不得**判任何契约完成（v1.11.0 语义）', () => {
  // v1.11.0 语义收紧：账本里只有落差/计划记录，不能证明功能点跑过 →
  // 契约一律落 dangling。旧断言只检查了 evidenceKind 标注，没检查判定结果，
  // 于是 D2（计划条目自我认证）可以长期藏在全绿下面。
  const tmpd = fs.mkdtempSync(path.join(os.tmpdir(), 'als-res3-'));
  fs.mkdirSync(path.join(tmpd, 'ledger'), { recursive: true });
  fs.writeFileSync(path.join(tmpd, 'ledger', 'ledger.jsonl'),
    JSON.stringify({ ledger: 'error', title: 'x', detail: 'y' }) + '\n', 'utf-8');
  const log = C.readExecutionLog(tmpd);
  assert.ok(log.results.length === 0, '无 result.json 时 results 应为空，实际 ' + log.results.length);
  assert.ok(log.evidenceKind === 'gaps_only',
    '只有 ledger 时应标记为 gaps_only（不能当作跑过），实际: ' + log.evidenceKind);
  const s = C.createQuestioning({ initial: ['登录正常流程'] });
  const r = C.reconcile(s, log, {});
  assert.strictEqual(r.completed, 0, '只有账本落差却判了 completed —— 红线失效');
  assert.strictEqual(r.verdict, 'REJECT');
  fs.rmSync(tmpd, { recursive: true, force: true });
});

check('D2 回归：只有 [契约] plan 条目 → 契约不得判完成（计划不是执行）', () => {
  // 钉死 2026-10-26 真机暴露的缺陷：sealQuestioning 用 host.tapPlan 给每条契约写
  // `[契约] …`（ledger=plan / status=open / closed_at=null / detail 带 id=contract_xxx），
  // reconcile 第②源曾把这些计划条目当执行证据 → 任何契约自动 completed、REJECT 不可达。
  const s = C.createQuestioning({ initial: ['功能甲'] });
  const c1 = s.items[0];
  C.addContract(s, '从未执行过的测试点乙', 'input');
  fs.mkdirSync(path.join(TMP, 'ledger'), { recursive: true });
  fs.writeFileSync(path.join(TMP, 'ledger', 'ledger.jsonl'), JSON.stringify({
    id: 'LG-1', ledger: 'plan',
    title: '[契约] ' + c1.category + ' · ' + c1.description,
    detail: 'source=' + c1.source + ';id=' + c1.id,
    opened_at: new Date().toISOString(), closed_at: null, status: 'open', outcome: null,
  }) + '\n', 'utf-8');
  clearEvidence();
  const r = C.reconcile(s, C.readExecutionLog(TMP), {});
  assert.strictEqual(r.completed, 0, '计划条目被当成执行证据了（D2 复发）');
  assert.strictEqual(r.dangling, 2);
  assert.strictEqual(r.verdict, 'REJECT');
  assert.ok(r.details.every((d) => d.hasExecLog === false), 'hasExecLog 不该为 true');
});

check('D2 回归：有 result.json 时，账本里的计划条目不会让未执行项蒙混过关', () => {
  const s = C.createQuestioning({ initial: ['真的跑过的功能'] });
  C.addContract(s, '只登记没执行的功能', 'input');
  writeResult(['真的跑过的功能']);
  fs.writeFileSync(path.join(TMP, 'ledger', 'ledger.jsonl'),
    s.items.map((it) => JSON.stringify({ id: 'L-' + it.id, ledger: 'plan',
      title: '[契约] ' + it.category + ' · ' + it.description,
      detail: 'source=' + it.source + ';id=' + it.id, closed_at: null, status: 'open',
    })).join('\n') + '\n', 'utf-8');
  const r = C.reconcile(s, C.readExecutionLog(TMP), {});
  assert.strictEqual(r.completed, 1, '只有真跑过的那 1 项算完成');
  assert.strictEqual(r.dangling, 1, '只登记没执行的那项必须 dangling');
  assert.strictEqual(r.verdict, 'REJECT');
  assert.ok(r.corroboration >= 1, '账本应被记为辅证（corroboration）而非证据');
});

// ── 输出 ────────────────────────────────────────────────────────
console.log('\n' + '='.repeat(70));
for (const [st, name] of results) {
  if (st === 'FAIL') console.log('  [FAIL] ' + name);
}
console.log(`通过 ${PASS} 项，失败 ${FAIL} 项`);
console.log('='.repeat(70));

// 清理临时目录
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}

process.exit(FAIL ? 1 : 0);
