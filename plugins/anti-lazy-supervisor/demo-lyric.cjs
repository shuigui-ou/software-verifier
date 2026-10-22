'use strict';
/**
 * lyric-studio 真机监督演示
 * ============================================================================
 * 目的：用**真实 spec**（34 个功能点）跑一遍追问-对账-门禁，
 * 看它到底会问出什么、能抓出什么 —— 而不是看玩具样例。
 *
 * 关键：先看该项目的报告实际情况（43✅/0❌ 但内核记了 6 个落差），
 * 用监督器对账一遍，看这些落差会不会被判成 dangling。
 * ============================================================================
 */

const path = require('path');
const fs = require('fs');

const SKILL = process.argv[2] || 'C:/Users/199720.PC2775/.workbuddy/skills/software-verifier';
const SPEC = process.argv[3] || 'C:/Users/199720.PC2775/WorkBuddy/2026-08-29-14-39-38/lyric-studio/verify-spec.json';

// v1.5.1 的核心在 plugins/ 里，从新版本目录加载
const SUP = 'C:/Users/199720.PC2775/WorkBuddy/2026-08-28-09-28-30/skillhub_verify/software-verifier';
const C = require(path.join(SUP, 'plugins', 'anti-lazy-supervisor', 'reconcile-core.cjs'));

function line(ch) { return ch.repeat(72); }

const spec = JSON.parse(fs.readFileSync(SPEC, 'utf8'));
const features = spec.features || [];
const initial = features.map((f) => f.name || f.title).filter(Boolean);

console.log(line('='));
console.log('lyric-studio · 真机监督演示（追问 → 对账 → 门禁）');
console.log(line('='));
console.log(`spec     : ${SPEC.split('/').slice(-2).join('/')}`);
console.log(`初始契约 : ${initial.length} 个功能点（来自真实 spec）`);
console.log(`用户实际跑的验证器：${SKILL}`);
console.log();

// ── 阶段一：追问 ──────────────────────────────────────────────
console.log(line('-'));
console.log('阶段一 · 追问扩容（按 6 类测试点类型）');
console.log(line('-'));

const session = C.createQuestioning({ initial });

// 模拟「一个只测了 happy path 的验证器」的典型回答：
// 大多数类型说「没有」，但在被追问到安全/并发时会漏出真实缺口。
const TYPICAL_GAPS = {
  input: ['歌词超长文本粘贴不截断', '拼音含多音字时标注不错位'],
  concurrency: ['快速连续切换韵脚/平仄不产生脏状态', '两个浏览器标签同时编辑同���歌不互相覆盖'],
  security: ['上传的歌词内容在导出文件中不泄露他人隐私字段',
             '存档接口未鉴权时他人可读取我的词稿'],
  error: ['保存失败时界面明确提示而非静默失败', '导出中断后可重试不产生半截文件'],
  performance: ['200 行以上歌词的滚动与渲染不卡顿'],
  state: ['从编辑态切到弹窗态再返回，编辑内容不丢失'],
};

let q, round = 0, asked = 0;
const answered = [];
while ((q = C.nextQuestion(session)) && round < 60) {
  round++;
  asked++;
  // 典型验证器：第一次答不全，被追问一轮才补出缺口
  const gaps = (round % 2 === 1) ? [] : (TYPICAL_GAPS[q.category] || []);
  if (gaps.length) answered.push({ cat: q.categoryName, items: gaps });
  const r = C.submitAnswer(session, q.category, gaps);
  if (gaps.length) {
    console.log(`【${q.categoryName}】追问后补出 ${r.accepted} 项：`);
    for (const g of gaps) console.log('     + ' + g);
  }
}

const added = session.items.filter((i) => i.source === 'questioning');
console.log();
console.log(`追问 ${round} 轮（其中 ${answered.length} 类被追问出真实缺口）`);
console.log(`契约 ${initial.length} → ${session.items.length}（+${added.length}）`);

// ── 阶段二：对账 ──────────────────────────────────────────────
console.log();
console.log(line('-'));
console.log('阶段二 · 硬对账（对照真实执行日志）');
console.log(line('-'));

// 从项目实际数据目录读内核账本（那里有真实的 G/I 落差记录）
const candidates = [
  path.join(SKILL, '.evolution'),
  path.join(path.dirname(SKILL), '.evolution'),
  'C:/Users/199720.PC2775/WorkBuddy/2026-08-29-14-39-38/lyric-studio/.evolution',
];
let dataDir = null, found = [];
for (const d of candidates) {
  if (fs.existsSync(path.join(d, 'ledger', 'ledger.jsonl'))) { dataDir = d; found = fs.readdirSync(path.join(d, 'ledger')); }
}
if (!dataDir) {
  // 没有就造一个「只完成了初始功能点，追问出的缺口一个没做」的日志
  const tmp = path.join(require('os').tmpdir(), 'lyric-demo-evo');
  fs.mkdirSync(path.join(tmp, 'ledger'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'audit'), { recursive: true });
  const entries = session.items.slice(0, initial.length).map((it, i) => ({
    id: 'LG-' + i, ledger: 'plan', title: '[契约] ' + it.description,
    detail: 'id=' + it.id, status: 'open',
  }));
  fs.writeFileSync(path.join(tmp, 'ledger', 'ledger.jsonl'),
    entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  fs.writeFileSync(path.join(tmp, 'audit', 'audit.jsonl'), '');
  dataDir = tmp;
  console.log('（未找到项目内核数据，用「初始功能点已执行、追问缺口未执行」构造日志）');
  console.log('   如需对账真实数据，请先跑一次带 --evolve 的验证。');
} else {
  console.log('读取项目内核数据：' + dataDir);
}
console.log();

// ★ 传入真实的 result.json（执行证据主源）
const REAL_RESULT = 'C:/Users/199720.PC2775/WorkBuddy/2026-08-29-14-39-38/lyric-studio/verify_report/result.json';
const execLog = C.readExecutionLog(dataDir, REAL_RESULT);
console.log('result.json 功能点证据：' + execLog.results.length + ' 条（来源：' + (execLog.resultPath||'未找到') + '）');

console.log();

// 验证器典型行为：口头声称全测过了
const claimed = {};
for (const it of session.items) claimed[it.id] = 'completed';

const recon = C.reconcile(session, execLog, { claimed });

console.log('对账结果：');
console.log('  应测契约：' + recon.total);
console.log('  实际完成：' + recon.completed);
console.log('  合规跳过：' + recon.skipped);
console.log('  漏　检 ：' + recon.dangling);
console.log('  判定　　：' + recon.verdict);
console.log();

const dang = recon.details.filter((d) => d.status === 'dangling');
if (dang.length) {
  console.log(`漏检明细（${dang.length} 项）：`);
  for (const d of dang) {
    const cat = (C.CAT_MAP[d.category] || {}).name || d.category;
    const src = d.source === 'questioning' ? '追问补出' : '初始声明';
    const lie = d.claimedByVerifier ? '  ← 声称测过（无日志）' : '';
    console.log(`  · [${cat}] ${d.description}`);
    console.log(`      来源：${src}${lie}`);
  }
  console.log();
}

// ── 阶段三：门禁 + 报告注入 ───────────────────────────────────
console.log(line('-'));
console.log('阶段三 · 门禁与报告注入');
console.log(line('-'));

const hostReport = [
  '# lyric-studio 功能验证报告',
  '',
  '## 验证范围',
  `${initial.length} 个功能点`,
  '',
  '## 结论',
  `✅ ${recon.completed}/${recon.total} 测试通过，验证器认为功能正常。`,
].join('\n');

const injected = C.injectReport(hostReport, session, recon);
console.log('门禁判定：' + injected.gate.verdict);
console.log('允许落盘：' + (injected.gate.allow ? '✅ 允许' : '⛔ 拒绝'));
console.log();
console.log('═══ 若接入 v1.5.1，报告会长这样（节选监督区块）═══');
console.log();
console.log(injected.gate.block);
console.log();
console.log('─── 与旧报告的差别 ───');
console.log('旧报告：只说「43 项全通过」，没有任何关于「没测什么」的交代。');
console.log('新报告：写明哪些没测、为什么判定为漏检、其中哪些验证器声称测过。');