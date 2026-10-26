#!/usr/bin/env node
/**
 * software-verifier —— 通用「按说明书全量走查」验证引擎（驱动可插拔）
 *
 * 用本机无头 Edge（playwright-core）像真人一样打开软件、逐条点击/填表/触发功能、
 * 截图 + 抓页面错误 + 断言预期状态，最后产出 ✅/❌ 报告。
 *
 * 支持驱动（--driver）：
 *   browser     : 标准 Web 应用（默认，无需额外依赖）
 *   electron    : Electron 桌面应用（需 playwright 完整包 + --app <main.js>）
 *   miniprogram : 微信小程序（需 miniprogram-automator + 微信开发者工具 + --app <projectPath>）
 *   appium      : 原生移动 App（需 webdriverio + Appium server + --platform android|ios）
 *
 * 用法：
 *   node verify.cjs --spec <spec.json> --url http://localhost:3000 [--driver browser]
 *                   [--ui-only] [--also F04,F16] [--only F01,F02] [--exclude F01] [--ai on]
 *                   [--ablate[=k]] [--ablate-out <dir>]
 *                   [--app <path>] [--platform android|ios] [--caps <caps.json>]
 *
 * spec 结构见 SKILL.md。引擎与具体软件解耦：换软件只需换 spec；换运行环境只需换 --driver。
 */
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');

const SKILL_DIR = __dirname;

// ---------- P1 测试可用性：导出纯函数供单测（require 时不跑 CLI 主流程） ----------
// 被 require 时（require.main !== module），仅导出下面的纯函数并提前返回，
// 避免无 --spec 时 JSON.parse(readFileSync(null)) 抛错 / process.exit，且跳过 driver/evo 等重依赖。
function collectClaimsAndSkipNotes(spec, selected, opt) {
  const claimed = {};
  const skipNotes = {};
  const selIds = new Set(selected.map(f => f.id));
  for (const f of selected) claimed[f.name || f.description] = 'completed';
  for (const f of (spec.features || [])) {
    if (selIds.has(f.id)) continue;
    let reason;
    if (opt.only.length && !opt.only.includes(f.id)) reason = '不在 --only 列表';
    else if (opt.exclude.length && opt.exclude.includes(f.id)) reason = '被 --exclude 排除';
    else if (opt.uiOnly && f.type === 'ai') reason = 'ai 类型被 --ui-only 排除';
    else reason = '不在 --only 列表';
    skipNotes[f.name || f.description] = reason;
  }
  return { claimed, skipNotes };
}
function warnSameNameFeatures(spec, logFn) {
  const seen = new Set();
  for (const f of (spec.features || [])) {
    const nm = f.name || f.description;
    if (seen.has(nm)) logFn('⚠ 同名 feature 检测到: ' + nm + ' —— skipNotes/claimed 键会碰撞，readExecutionLog 执行日志也会互相覆盖（建议强制 name 唯一或改键格式，见 P1 spec）');
    seen.add(nm);
  }
}
// P1：防偷懒监督器模块加载失败原因（fail-open 的「可观测化」载体）。
// ⚠ 2026-10-23 上移到此处（评审16 行为断言抓出 TDZ 崩溃）：
//   原本声明在下方 require 之后，而 writePartialResult 定义在本行之前。
//   单测直接 require 本文件并调用该纯函数时，变量处于 TDZ（let 未初始化）
//   → 'Cannot access before initialization' → 该函数**整体抛错**，
//   连带 partialWriteError 等所有留痕分支全部失效（实测 23 条断言连带失败）。
//   即：为了修「守卫没写在 FATAL 路径」而把守卫写进来，却因声明顺序把整个函数打瘫——
//   守卫写在错误的位置，等于没有守卫。故声明必须早于所有使用点。
let SUPERVISOR_LOAD_ERR = null;
function writePartialResult(OUT, result, sup, Sup, opt, err) {
  try {
    // ⚠ 2026-10-23 修复（靶子站端到端 Run4 实测暴露的第三个接线缺口）：
    //   原实现整段包在 `if (Sup && sup && sup.__enabled)` 里 —— 而监督器会话是在**初始导航之后**
    //   才 start 的（Sup.start 在 verify.cjs:409，初始导航在 :366）。
    //   于是「初始导航就 FATAL」这一最需要留证据的场景（入口 URL 不可达/DNS 失败），
    //   会话根本还不存在 → 守卫为假 → **整轮结果一个字都不落盘**，用例3 的验收目标直接落空。
    //   实测：--url http://localhost:1 时 out 目录里连 result.json 都没有（ENOENT）。
    //   修法：partial 落盘不再依赖会话。监督对账是**增强**（有会话才做），不是**前置条件**。
    //   没有会话时如实标注 supervisorPresent:false，让读者知道「这轮没有对账」而不是「对账通过」。
    try { fs.mkdirSync(OUT, { recursive: true }); } catch (_) {}
    result.partial = true;
    result.abortedAt = (err && err.message) || String(err);
    result.endedAt = new Date().toISOString();
    const hasSup = !!(Sup && sup && sup.__enabled);
    result.supervisorPresent = hasSup;
    // ⚠ 2026-10-23 补（评审16 行为断言抓出）：加载失败留痕原先只写在主流程（:573），
    //   而「模块加载失败」最需要留痕的场景恰恰是 FATAL —— FATAL 走 writePartialResult，
    //   完全绕过主流程的写入点 → result.json 里 supervisorLoadError 恒为 undefined，
    //   「监督器没接上」这一事实彻底不留痕（实测：隔离副本里改名 evolution-supervisor.cjs
    //   后真跑 CLI，supervisorLoadError=undefined）。
    //   守卫写在用不上的地方 = 守卫不存在。故 partial 路径必须自己写。
    if (SUPERVISOR_LOAD_ERR) {
      result.supervisorLoadError = SUPERVISOR_LOAD_ERR;
      console.error('[verify] ⚠ 防偷懒监督器未接入：evolution-supervisor.cjs 加载失败（' + SUPERVISOR_LOAD_ERR + '）—— 本轮无监督对账/门禁');
    }
    if (hasSup) {
      // 与主流程同一顺序纪律：先落盘提供执行证据，再对账（finalize 要读 result.json）
      try {
        result.features = result.features || [];
        fs.writeFileSync(OUT + '/result.json', JSON.stringify(result, null, 2));
      } catch (_) {}
      try { result.supervisor = Sup.finalize(sup, { claimed: result.claimed || {}, skipNotes: result.skipNotes || {}, strict: !!opt.strict, resultPath: OUT + '/result.json' }); } catch (fe) { result.supervisorError = (fe && fe.message) || String(fe); }
    }
    // ⚠ 2026-10-23 加固（评审15 指出「不能静默丢」）：本行是 FATAL 场景下**唯一的证据出口**，
    //   若它失败只 console.error，等于整轮结果彻底蒸发且磁盘无痕。
    //   故兜底再写一个 result.partial-fallback.json（哪怕磁盘也满，至少尝试一次 + 控制台明确告警）。
    try {
      fs.writeFileSync(OUT + '/result.json', JSON.stringify(result, null, 2));
    } catch (we) {
      const msg = (we && we.message) || String(we);
      result.partialWriteError = msg;
      console.error('[verify] partial 落盘失败（FATAL 原始错误已保留在 result.abortedAt，未被覆盖）:', msg);
      try {
        fs.writeFileSync(OUT + '/result.partial-fallback.json', JSON.stringify(result, null, 2));
        console.error('[verify] 已降级落盘 result.partial-fallback.json（partialWriteError=' + msg + '）');
      } catch (we2) {
        console.error('[verify] 兜底落盘亦失败，本轮结果无法留痕:', (we2 && we2.message) || we2);
      }
    }
  } catch (we) { console.error('[verify] partial 落盘失败（原 FATAL 错误已保留在 result.abortedAt，未被覆盖）:', (we && we.message) || we); }
}
if (require.main !== module) {
  module.exports = { collectClaimsAndSkipNotes, warnSameNameFeatures, writePartialResult, runQuestioningLoop, makeStdinIo };
  return;
}

// 自动定位 playwright-core（源码内零硬编码路径）：
//   env PW_CORE → require.resolve → 与当前 node 同级 / WorkBuddy 托管各版本 / 全局 npm → 明确报错
function resolvePwCore() {
  if (process.env.PW_CORE) return process.env.PW_CORE;
  for (const base of [SKILL_DIR, process.cwd(), path.dirname(process.execPath)].filter(Boolean)) {
    try { const p = require.resolve('playwright-core', { paths: [base] }); if (p) return p; } catch (e) {}
  }
  const cands = [path.join(path.dirname(process.execPath), 'node_modules', 'playwright-core')];
  try {
    const binRoot = path.join(os.homedir(), '.workbuddy', 'binaries', 'node', 'versions');
    for (const v of fs.readdirSync(binRoot)) cands.push(path.join(binRoot, v, 'node_modules', 'playwright-core'));
  } catch (e) {}
  try {
    const out = require('child_process').execSync('npm root -g', { encoding: 'utf8' }).trim().split(/\r?\n/);
    for (const gr of out) cands.push(path.join(gr, 'playwright-core'));
  } catch (e) {}
  for (const c of cands) { try { if (c && fs.existsSync(c)) return c; } catch (e) {} }
  throw new Error(
    '[software-verifier] 未找到 playwright-core。请任选其一：\n' +
    '  (a) 设环境变量 PW_CORE=<node_modules/playwright-core 的绝对路径>\n' +
    '  (b) 在 skill 目录安装依赖：npm i playwright-core'
  );
}

// ---------- 参数解析 ----------
const args = process.argv.slice(2);
const opt = {
  spec: null, url: null, out: null, uiOnly: false, also: [], only: [], exclude: [],
  ablate: 0, ablationOut: null, ai: 'off',
  driver: 'browser', app: null, platform: 'android', caps: null,
  appiumUrl: 'localhost', appiumPort: 4723, port: 9420, heal: true, evolve: false,
  skill: null, strictEnv: false, strict: false, allowApi: false, question: false, noQuestion: false,
};
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--spec') opt.spec = args[++i];
  else if (a === '--skill') opt.skill = args[++i];
  else if (a === '--url') opt.url = args[++i];
  else if (a === '--out') opt.out = args[++i];
  else if (a === '--ui-only') opt.uiOnly = true;
  else if (a === '--also') opt.also = args[++i].split(',').map(s => s.trim());
  else if (a === '--only') opt.only = args[++i].split(',').map(s => s.trim());
  // v1.4.6：受控消融（Controlled Ablation）——「去掉 A 后 BCD 怎样、去掉 B 后 ACD 怎样」
  //   --exclude <ids>     负选择：在正选择（--only / --ui-only / --also）之后做减法
  //   --ablate[=k]        留一法消融：基线 1 次 + 每次去掉 k 个因子（默认 k=1）；k>=全部功能点数时无意义
  //   --ablate-out <dir>  消融产物目录（默认 <out>/ablation）
  else if (a.indexOf('--ablate=') === 0) opt.ablate = parseInt(a.split('=')[1], 10) || 1;
  else if (a === '--ablate-out') opt.ablationOut = args[++i];
  else if (a === '--ablate') { const nx = args[i + 1]; if (nx && nx.charAt(0) !== '-') { opt.ablate = parseInt(nx, 10); i++; } else opt.ablate = 1; }
  else if (a === '--exclude') opt.exclude = args[++i].split(',').map(s => s.trim()).filter(Boolean);
  else if (a === '--ai') opt.ai = args[++i];
  else if (a === '--driver') opt.driver = args[++i];
  else if (a === '--app') opt.app = args[++i];
  else if (a === '--platform') opt.platform = args[++i];
  else if (a === '--caps') opt.caps = args[++i];
  else if (a === '--appium-url') opt.appiumUrl = args[++i];
  else if (a === '--appium-port') opt.appiumPort = parseInt(args[++i], 10);
  else if (a === '--port') opt.port = parseInt(args[++i], 10);
  else if (a === '--no-heal') opt.heal = false;
  else if (a === '--evolve') opt.evolve = args[++i] === 'on';
  else if (a === '--strict-env') opt.strictEnv = true;
  // ⚠ 2026-10-23 修复（靶子站端到端 Run2-strict 实测暴露的第 5 个接线缺口）：
  //   此前**从未解析 --strict**，opt.strict 恒 undefined → finalize 收到的 strict 恒 false
  //   → reconcile-core gate 的 strict 分支（:552-554「合规跳过也升级为 FAIL」）**永远不触发**。
  //   实测：Run2 与 Run2-strict 的 result.json 逐字段相同（都是 PASS_WITH_WARNINGS / blocked=false）。
  //   后果：spec §4.2 步8 写死的「strict 下 skipped>0 升级 FAIL」在真实 CLI 上不可达、无法端到端验收；
  //   且它与 --strict-env 是两个不同开关，别混：--strict 管监督对账门禁，--strict-env 管错误归因（环境噪声）。
  //   ⚠ 语义提示：--strict 会在有合规跳过时判 FAIL（blocked=true），属**故意收紧**，
  //   与 --strict-env 一样会改变判定，不要以为它只是"多打点日志"。
  else if (a === '--strict') opt.strict = true;
  // v1.9.0：--question 交互式追问模式（人工环，CLI 专属）。
  //   自动模式契约 = spec 功能点（initial，基线不变）；--question 让操作者在跑之前按 6 类测试点
  //   逐类补充测试点，补充项以 questioning 来源入监督会话 → 与 initial 同等对账
  //   （无执行日志且无跳过理由 → dangling → REJECT）。
  //   ⚠ 与「spec 覆盖建议」严格分离：追问答案是人给的（入契约），覆盖建议是机器给的（不入契约）。
  //   ⚠ 禁止经 MCP 暴露：MCP server 的 stdin 是 JSON-RPC 协议通道，子进程读 stdin 会啃协议流。
  else if (a === '--question') opt.question = true;
  // v1.10.0：--no-question 硬关（永不问；已存补充点仍静默自动注入）
  else if (a === '--no-question') opt.noQuestion = true;
  else if (a === '--allow-api') opt.allowApi = true;
}
// --skill：零代码验收其他 skill——自动定位其目录下的 spec 并跑完整验证
function resolveSkillSpec(dir) {
  const cands = ['verify-spec.json', 'spec.json', 'verify_report/spec.json', 'specs/verify-spec.json'];
  for (const c of cands) {
    const p = path.join(dir, c);
    if (fs.existsSync(p)) return p;
  }
  return null;
}
if (!opt.spec && opt.skill) {
  const found = resolveSkillSpec(opt.skill);
  if (!found) {
    console.error('[verify] --skill 目录下未找到 verify-spec.json/spec.json：' + opt.skill);
    process.exit(2);
  }
  opt.spec = found;
  console.error('[verify] 自动定位 skill spec：' + found);
}

if (!opt.spec || !opt.url) {
  console.error('用法: node verify.cjs --spec <spec.json> --url <baseUrl> [--skill <skill目录> 自动定位 spec] [--driver browser|electron|miniprogram|appium] [--out <dir>] [--evolve on] [--strict-env（把环境噪声也计入 FAIL）] [--question（强制按 6 类重问，答案纳入对账）] [--no-question（硬关追问，不弹确认）] [--allow-api（显式开启 api/openapi 网络步骤与断言）] [--exclude <功能ID,...>] [--ablate[=k]（受控消融：基线+去因子）] [--ablate-out <dir>]');
  process.exit(2);
}

const spec = JSON.parse(fs.readFileSync(opt.spec, 'utf8'));
const BASE = opt.url.replace(/\/$/, '');
const OUT = opt.out || (path.dirname(opt.spec) + '/verify_report');
fs.mkdirSync(OUT, { recursive: true });
const SHOTS = OUT + '/shots';
fs.mkdirSync(SHOTS, { recursive: true });

// ---------- v1.4.6 受控消融调度器 ----------
// 每个组合跑**独立子进程**并写独立 --out，避免共享浏览器会话/登录态把各组的结论串味。
// 产物：<out>/ablation/{ablation.json,ABLATE-报告.md,ABLATE-报告.html}
const { spawnSync } = require('child_process');
const ABLATION_PARENT = opt.ablate > 0;
const RAW_ARGS = process.argv.slice(2);
function ablateCombos(ids, k) {
  const out = [];
  if (!(k > 0) || k >= ids.length) return [];
  (function rec(start, cur) {
    if (cur.length === k) { out.push(cur.slice()); return; }
    for (let i = start; i < ids.length; i++) { cur.push(ids[i]); rec(i + 1, cur); cur.pop(); }
  })(0, []);
  return out;
}
function ablateChildArgs(excludeIds, outDir) {
  const out = [];
  for (let i = 0; i < RAW_ARGS.length; i++) {
    const a = RAW_ARGS[i];
    if (a === '--ablate' || a.indexOf('--ablate=') === 0) continue;                        // 调度标记，不传给子层（防递归）
    if (a === '--ablate-out') { i++; continue; }                                            // 连同取值一起跳过
    if (a === '--exclude') { i++; out.push('--exclude', excludeIds.join(',')); continue; }
    if (a.indexOf('--exclude=') === 0) { out.push('--exclude=' + excludeIds.join(',')); continue; }
    if (a === '--out') { i++; out.push('--out', outDir); continue; }
    if (a.indexOf('--out=') === 0) { out.push('--out=' + outDir); continue; }
    out.push(a);
  }
  // 消融子层必须**无条件注入** --exclude：父进程自身的 --exclude 只是被改写，不代表本组要排除谁。
  // （曾漏此注入 → 5 组去因子运行实际全是排除空集，Δ 矩阵全行相同、翻转恒 0，报告却照样生成）
  if (excludeIds && excludeIds.length) {
    if (out.indexOf('--exclude') < 0 && !out.some(x => x.indexOf('--exclude=') === 0)) out.push('--exclude', excludeIds.join(','));
  }
  if (out.indexOf('--out') < 0 && !out.some(x => x.indexOf('--out=') === 0)) out.push('--out', outDir);
  return out;
}
function runAblation(specObj) {
  const Abl = require(SKILL_DIR + '/reporters/ablation.cjs');
  const abOut = path.resolve(opt.ablationOut || (OUT + '/ablation'));
  fs.mkdirSync(abOut, { recursive: true });
  const ids = (specObj.features || []).map(f => f.id);
  const combos = [[]].concat(ablateCombos(ids, opt.ablate));
  if (combos.length < 2) { console.error('[verify] --ablate：功能点仅 ' + ids.length + ' 个，无法做消融（至少需 2 个）'); process.exitCode = 2; return; }
  console.log('=== 受控消融（k=' + opt.ablate + '）：基线 1 次 + 去因子 ' + (combos.length - 1) + ' 组 ===');
  const runs = [];
  for (const c of combos) {
    const tag = c.length ? ('minus_' + c.join('_')) : 'baseline';
    const dir = abOut + '/' + tag;
    const childArgs = ablateChildArgs(c, dir);
    console.log('  > [' + tag + '] 排除 ' + (c.length ? c.join(',') : '（无，即基线）') + ' → ' + dir);
    const r = spawnSync(process.execPath, [SKILL_DIR + '/verify.cjs'].concat(childArgs),
      { stdio: 'inherit', env: Object.assign({}, process.env, { SV_ABLATION_TAG: tag }) });
    const rj = dir + '/result.json';
    if (r.status !== 0 && !fs.existsSync(rj)) console.error('     ! 子进程 exit=' + r.status + ' 且无 result.json，本组跳过');
    if (fs.existsSync(rj)) { try { runs.push(JSON.parse(fs.readFileSync(rj, 'utf8'))); } catch (e) { console.error('     ! result.json 解析失败：' + (e && e.message)); } }
  }
  if (!runs.length) { console.error('[verify] --ablate：无任何一组产出 result.json，不生成消融报告'); process.exitCode = 2; return; }
  // 护栏：Δ 矩阵必须有信息量。若没有任何一组真正排除了功能点，报告会是「各行相同、翻转恒 0」的假结论，
  // 与其产出看似正常的空报告，不如直接失败（宁可报错，不可静默失真）。
  if (!runs.some(x => x.exclude && x.exclude.length)) {
    console.error('[verify] --ablate：没有任何一组真正排除了功能点（各组 exclude 均为空）——Δ 矩阵将无信息量，已中止、不产出报告。');
    process.exitCode = 2; return;
  }
  const d = Abl.build(runs, specObj);
  fs.writeFileSync(abOut + '/ablation.json', JSON.stringify(d, null, 2));
  fs.writeFileSync(abOut + '/ABLATE-报告.md', Abl.renderMarkdown(d));
  fs.writeFileSync(abOut + '/ABLATE-报告.html', Abl.renderHtml(d));
  const s = d.summary;
  console.log('');
  console.log('========== 消融汇总: 基线 ' + s.baseline.pass + '/' + s.baseline.total + ' 通过 · 翻转 ' + s.flipCount + ' 处' +
    (s.suspectCount ? '（含假消融嫌疑 ' + s.suspectCount + '）' : '') + ' ==========');
  for (const f of d.flips) console.log('   * 去掉 ' + f.excluded + ' -> ' + f.feature + ' ' + f.direction + (f.suspect ? '   [!]假消融嫌疑' : ''));
  if (!d.flips.length) console.log('   . 未观察到翻转：各因子独立（去掉任一均不改变其余功能点状态）');
  console.log('消融报告已写入: ' + abOut);
  // 退出码跟随基线结果：消融不改写「通过与否」的判定，只补充因子贡献信息
  const base = runs.filter(x => !(x.exclude && x.exclude.length))[0] || runs[0];
  if (base && base.summary) process.exitCode = base.summary.fail > 0 ? 1 : 0;
}
if (ABLATION_PARENT) runAblation(spec);

const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------- 自进化知识库 ----------
const { runEvolution, loadPitfalls, matchPitfall, anonymize } = require(SKILL_DIR + '/evolve.cjs');
const PITFALLS = loadPitfalls();
// v1.4.3：错误归因（宿主 / 环境 / 工具）——来自第三方靶子验证的真实教训：
// 环境噪声（如第三方 CDN 全局缺失）曾把无关功能点染成 FAIL，且报告里三者混作一团。
const { classifyError, bucketize } = require(SKILL_DIR + '/drivers/error-classify.cjs');
// v1.4.4：归因需要"被测站点入口"上下文才能判同源/跨源与"入口 URL 是否可用"。
// targetUrl = 站点根；navUrl = 本次实际导航的 URL（入口 URL 本身 4xx ⇒ spec/--url 配置问题 ⇒ tool）。
const CLS_CTX = { targetUrl: BASE + '/', navUrl: BASE + '/' };
const hintFor = (text) => { const p = matchPitfall(anonymize(text || ''), PITFALLS); return p ? ' 💡 已知坑[' + p.id + ']: ' + p.fix : ''; };

// ---------- agent-evolution 共享进化引擎接入（turnkey 适配器，全程 fail-open） ----------
// 引擎未就绪 / require 失败 / 初始化异常 → evo 为 null，所有调用安全 no-op，不影响验证主流程。
let evo = null;
try { evo = require(SKILL_DIR + '/evolution-host.cjs'); evo.init({ autoStart: false }); }
catch (_e) { /* 引擎未就绪则完全旁路 */ }
const evoTap = (e, ctx) => { try { if (evo) evo.tapError(e, ctx); } catch (_e) {} };
// G/P/I 落差采集（与 evoTap 同构：全部 fail-open，引擎未就绪则静默旁路）
const evoGap = (title, detail, ctx) => { try { if (evo) evo.tapExpectation(title, detail, ctx || {}); } catch (_e) {} };
const evoPlan = (title, detail, ctx) => { try { if (evo) evo.tapPlan(title, detail, ctx || {}); } catch (_e) {} };
const evoHanging = (title, detail, ctx) => { try { if (evo) evo.tapHanging(title, detail, ctx || {}); } catch (_e) {} };
const evoRun = async () => { try { if (evo) await evo.runCycle(); } catch (_e) {} };
// 行为闭环：读取侧（引擎复发记忆 + pre_action 已知经验）与执行器（启动前自愈预检）
const evoSelfHeal = require(SKILL_DIR + '/preflight.cjs');
const evoRecurring = () => { try { return evo ? evo.recurringErrors({ minHits: 1 }) : []; } catch (_e) { return []; } };
const evoAdvisory = (action) => { try { const g = evo ? evo.preActionGate({ action }) : null; return (g && g.inject && g.inject.text) ? g.inject.text : ''; } catch (_e) { return ''; } };

// ---------- 驱动加载 ----------
function loadDriver(name) {
  const pwCore = resolvePwCore();
  if (name === 'browser' || name === 'electron') {
    const { makeDomDriver } = require(SKILL_DIR + '/drivers/dom.js');
    return makeDomDriver(name, pwCore);
  }
  if (name === 'miniprogram') {
    const { createMiniprogramDriver } = require(SKILL_DIR + '/drivers/miniprogram.js');
    return createMiniprogramDriver(pwCore);
  }
  if (name === 'appium') {
    const { createAppiumDriver } = require(SKILL_DIR + '/drivers/appium.js');
    return createAppiumDriver(pwCore);
  }
  throw new Error('未知驱动: ' + name + '（支持 browser|electron|miniprogram|appium）');
}

// ---------- 步骤执行（驱动无关，委托 engine.cjs） ----------
const { runStep: _runStep, runAssert: _runAssert } = require(SKILL_DIR + '/engine.cjs');
const visKey = (name) => {
  const app = (spec.app || spec.name || 'app');
  return path.join(SKILL_DIR, 'evolution', 'visual-baselines', (app + '_' + name).replace(/[^\w一-龥]/g, '_').slice(0, 80) + '.json');
};
const CTX = { BASE, SHOTS, SKILL_DIR, visualBase: visKey, toolIssues: [], allowApi: !!opt.allowApi || !!(spec && spec.allowApi) };
async function runStep(drv, step) { return _runStep(drv, step, CTX); }
async function runAssert(drv, a) { return _runAssert(drv, a, CTX); }

// ---------- v1.9.0：交互式追问（--question）----------
// 设计口径（与用户确认的方案 A+C，2026-10-24）：
//   · **保留「spec 即初始契约」基线**：--question 只做加法，绝不改写 initial；
//   · 追问答案来自**人**（stdin）→ 入契约、受对账（无执行日志且无理由 → dangling）；
//   · 机器猜测**不入契约**（会把「猜的」变成对账义务、制造假 FAIL 污染 verdict），
//     机器只出 6 类覆盖建议（result.specCoverage）——建议与契约严格分离；
//   · stdin 结束（EOF）/ 读不到 → 该类按「明确说无」处理，与人工回车同义；
//   · 任何异常 → 记 result.questioning.error 后按「无补充」继续，绝不中断验证主流程。
// io 可注入（单测用假 io 驱动**真实** Sup.nextQuestion/answer/seal，不碰真 stdin）。
async function runQuestioningLoop(sup, Sup, logFn, io, ctx) {
  const out = {
    rounds: 0, added: 0, finished: false, seal: null, detail: [], error: null,
    mode: null, gate: null, jit: [], prefs: null, optedOut: null,
  };
  const _io = io || makeStdinIo();
  const c = ctx || {};
  const force = !!c.force;
  const noQuestion = !!c.noQuestion;
  const specPath = c.specPath || null;
  const spec = c.spec || null;
  let Prefs = null;
  let Core = null;
  try { Prefs = require(path.join(__dirname, 'question-prefs.cjs')); } catch (_) { Prefs = null; }
  try { Core = require(path.join(__dirname, 'plugins', 'anti-lazy-supervisor', 'reconcile-core.cjs')); } catch (_) { Core = null; }
  let prefs = { optedOutStart: false, optedOutHard: false, supplements: {}, declinedCats: [] };
  let dirty = false;
  try {
    if (Prefs && specPath) prefs = Prefs.load(specPath);
    if (!prefs.supplements || typeof prefs.supplements !== 'object') prefs.supplements = {};
    if (!Array.isArray(prefs.declinedCats)) prefs.declinedCats = [];

    // ① 静默注入已存补充点（不问；含 --no-question 亦执行 = 「已知意见自动执行」）
    for (const catK of Object.keys(prefs.supplements)) {
      const pts = prefs.supplements[catK];
      if (Array.isArray(pts) && pts.length) {
        const r = Sup.answer(sup, catK, pts) || {};
        out.added += (r.accepted || 0);
      }
    }

    const canPrompt = force || !!c.isTTY;
    if (noQuestion) {
      out.mode = 'off';
    } else if (!canPrompt) {
      out.mode = 'auto_apply_only';
    } else if (prefs.optedOutHard && !force) {
      out.mode = 'suppressed_hard';
    } else {
      // ② 开头 gate（--question 强制则跳过 gate，直接全问）
      let proceed = true;
      if (!force && !prefs.optedOutStart) {
        _io.print({ promptText: `
【追问 · 开场】是否要为本次验证补充测试点（6 类：输入边界/状态转换/并发竞态/异常恢复/性能超时/安全注入）？
  直接回车 = 不需要（以后本项目不再开头打扰）：` });
        const g = await _io.readLine();
        const gs = (g == null ? '' : String(g)).trim();
        out.gate = gs;
        if (gs === '' || /^(n|no|不|否|不需要|不用|跳过|skip)/i.test(gs)) {
          prefs.optedOutStart = true; dirty = true; proceed = false; out.mode = 'gate_declined';
        }
      }
      if (force) {
        prefs.optedOutStart = false;
        prefs.optedOutHard = false;
        dirty = true;
        if (out.mode === null) out.mode = 'forced';
      }
      // ③ 6 类逐类（跳过已拒类与已存补充点类；已存补充点在 ① 注入）
      if (proceed && (force || !prefs.optedOutStart)) {
        const cats = (Core && Core.CATEGORIES) || [];
        let gaveThisPass = 0;
        for (const cat of cats) {
          const catK = cat.key;
          if (!force && prefs.declinedCats.indexOf(catK) >= 0) continue;
          if (!force && prefs.supplements[catK] && prefs.supplements[catK].length) continue;
          _io.print({ categoryName: cat.name, round: 1, asked: cat.probes });
          const line = await _io.readLine();
          const answers = (line == null ? '' : String(line)).split(/[;；|]/).map(function (s) { return s.trim(); }).filter(Boolean);
          const r = Sup.answer(sup, catK, answers) || {};
          out.rounds += 1;
          out.added += (r.accepted || 0);
          out.detail.push({ category: catK, categoryName: cat.name, round: 1, answers: answers, accepted: r.accepted || 0 });
          if (logFn) logFn('   追问[' + cat.name + ']：' + (answers.length ? '补充 ' + answers.join('；') + '（accepted ' + (r.accepted || 0) + '）' : '无补充'));
          if (answers.length) {
            prefs.supplements[catK] = answers; gaveThisPass += answers.length; dirty = true;
          } else if (!force && prefs.declinedCats.indexOf(catK) < 0) {
            prefs.declinedCats.push(catK); dirty = true;
          }
        }
        if (!force && gaveThisPass === 0 && cats.length > 0 && prefs.declinedCats.length >= cats.length) {
          prefs.optedOutStart = true; dirty = true;
        }
        if (out.mode === null) out.mode = 'engaged';
      }
      // ④ JIT：未表态且 spec 关键词命中 → 只问那类一次；拒 → 全局硬关（察觉意愿）
      if (!prefs.optedOutHard || force) {
        let specCov = [];
        if (Core && typeof Core.suggestCoverage === 'function' && spec && Array.isArray(spec.features)) {
          const descs = spec.features.map(function (f) {
            return [f && f.name, f && f.description, f && f.group].filter(Boolean).join(' ');
          });
          specCov = Core.suggestCoverage(descs);
        }
        for (const cc of specCov) {
          if (!cc || !cc.covered) continue;
          if (prefs.supplements[cc.key] && prefs.supplements[cc.key].length) continue;
          if (prefs.declinedCats.indexOf(cc.key) >= 0) continue;
          _io.print({ promptText: `
【追问 · 新需求 · ` + (cc.name || cc.key) + `】spec 里出现了「` + (cc.name || cc.key) + `」相关功能，但你还没表态。
  要补充这类测试点吗？逐条列出（；分隔）；直接回车 = 以后不再问：` });
          const line = await _io.readLine();
          const answers = (line == null ? '' : String(line)).split(/[;；|]/).map(function (s) { return s.trim(); }).filter(Boolean);
          if (!answers.length) {
            prefs.optedOutHard = true; dirty = true;
            out.jit.push({ category: cc.key, refused: true });
            if (logFn) logFn('   JIT追问[' + (cc.name || cc.key) + ']：用户拒绝 → 全局不再追问');
            break;
          }
          const r = Sup.answer(sup, cc.key, answers) || {};
          out.rounds += 1; out.added += (r.accepted || 0);
          prefs.supplements[cc.key] = answers; dirty = true;
          out.jit.push({ category: cc.key, refused: false, accepted: r.accepted || 0 });
          if (logFn) logFn('   JIT追问[' + (cc.name || cc.key) + ']：补充 ' + answers.join('；'));
        }
      }
    }
    if (out.mode === null) out.mode = out.jit.length ? 'jit_only' : 'silent';
    // ⑤ 收敛 + 落盘（仅在有变更时写，避免非交互 CI 每跑一次写文件）
    const s = Sup.seal(sup) || {};
    out.seal = { written: s.written || 0, hostOk: !!s.hostOk, reason: s.reason || null };
    out.finished = !Sup.nextQuestion(sup);
    out.optedOut = { start: !!prefs.optedOutStart, hard: !!prefs.optedOutHard };
    out.prefs = { supplements: Object.keys(prefs.supplements), declinedCats: prefs.declinedCats.slice() };
    if (Prefs && specPath && dirty) {
      try { Prefs.save(specPath, prefs); } catch (_) { }
    }
  } catch (e) {
    out.error = (e && e.message) || String(e);
  }
  return out;
}
// 默认 io：真 stdin（readline）。input 可注入（单测传内存流）。
// 非 TTY（管道/重定向）设 30s 防挂死；TTY（真人在场）不设超时——交互模式本来就要等人。
function makeStdinIo(input) {
  const inp = input || process.stdin;
  const print = function (q) {
    try {
      if (q && typeof q.promptText === 'string') { process.stdout.write(q.promptText); return; }
      process.stdout.write('\n【追问 · ' + ((q && q.categoryName) || '') + ' · 第' + ((q && q.round) || 0) + '轮】当前验证计划是否覆盖：'
        + ((q && q.asked) || []).join('、') + '？\n  逐条列出具体测试点（；分隔），确无请直接回车：');
    } catch (_) {}
  };
  let rl = null;
  let closed = false; // stdin 关闭后 readline 的 close 不会再触发第二次 → 必须记标志，否则后续 readLine 只能干等超时
  const readLine = function () {
    return new Promise(function (resolve) {
      let timer = null;
      if (closed) { resolve(null); return; }
      try {
        if (!rl) {
          rl = require('readline').createInterface({ input: inp, terminal: false });
          rl.on('close', function () { closed = true; }); // 只在创建时注册一次（防监听器累积）
        }
        let settled = false;
        function onLine(l) { done(l); }
        function onClose() { done(null); }
        function cleanup() {
          if (timer) { clearTimeout(timer); timer = null; }
          rl.removeListener('line', onLine);
          rl.removeListener('close', onClose);
        }
        function done(v) { if (settled) return; settled = true; cleanup(); resolve(v); }
        rl.on('line', onLine);
        rl.on('close', onClose);
        if (!inp.isTTY) { timer = setTimeout(function () { done(null); }, 30000); if (timer.unref) timer.unref(); }
      } catch (e) { resolve(null); }
    });
  };
  return { print: print, readLine: readLine };
}

// ---------- 主流程 ----------
// P1：防偷懒监督器接线（fail-open：加载失败不影响主流程）
let Sup = null;
// ⚠ SUPERVISOR_LOAD_ERR 的声明已上移到 writePartialResult 之前（见文件头注释：
//   下游 FATAL 路径要用它，而 let 声明晚于函数定义会在 require 后直接调用时触发 TDZ 崩溃）。
// ⚠ 2026-10-23 修复（此前是 P1 接线在真实运行中从未生效的根因）：
//   原写法 require('./evolution-supervisor') 省略了扩展名，而 Node 的相对 require 只尝试
//   .js/.json/.node，**不尝试 .cjs** → 永远 MODULE_NOT_FOUND → 被 catch 吞成 Sup=null →
//   整条防偷懒监督器接线静默失效（fail-open 生效，但 fail-open 不该掩盖"接线根本没接上"）。
//   为什么之前没发现：① 逻辑层 45/45 单测直接 require 带 .cjs 的完整路径，绕过了这行；
//   ② 只有真实 CLI 端到端跑才会执行这行。逻辑层全绿 ≠ 接线真的接上了。
//   同类写法已全仓审计：仅此一处（对比 evolution-host.cjs 用的是带 .cjs 的 SKILL_DIR 绝对拼接，可加载）。
//   守卫：加载失败不再静默 —— 落到 result.supervisorLoadError，控制台显式告警，
//   否则「忘了加扩展名」这类错误会再次以"看起来正常"的方式藏住。
try { Sup = require('./evolution-supervisor.cjs'); } catch (_e) { Sup = null; SUPERVISOR_LOAD_ERR = (_e && _e.message) || String(_e); }
(async () => {
  // v1.4.6：--ablate 时本进程仅作消融调度器，验证由分派出的独立子进程完成
  if (ABLATION_PARENT) { console.log('[verify] --ablate：本进程作为消融调度器，主流程不重复执行'); return; }
  let result = { name: spec.name || spec.app || '未知软件', baseUrl: BASE, driver: opt.driver, startedAt: new Date().toISOString(), features: [], claimed: {}, skipNotes: {} };
  let drv;
  let sup = null; // P1：防偷懒监督器会话（fail-open；声明在 try 外以便 catch 也能访问）
  const errors = []; // 全局错误（最终汇总）
  try {
    drv = loadDriver(opt.driver);
    drv.setHeal(opt.heal);

    // ---------- 进化闭环（读取侧 + 行为改变）：启动前自愈预检 ----------
    // 从引擎"学到的复发记忆"判定该动作是否有"端口占用"类复发风险（**证据驱动**：只有本机学到过才动作；
    // 坑库仅用于提示）→ 若有，则 launch 前先探测端口，占用就改用空闲端口（把反复出现的 EADDRINUSE 变成不再发生）。
    try {
      const adv = evoAdvisory('driver.launch');
      if (adv) log('🧠 进化经验（launch 动作）：' + adv);
      const risks = evoRecurring();
      if (evoSelfHeal.portRisk({ risks })) {
        const pf = await evoSelfHeal.ensureFreePort(opt.port);
        if (pf.moved) {
          log('🛡 预检自愈：端口 ' + pf.original + ' 被占用 → 自动改用 ' + pf.port + '（知识库判定为复发风险，已避免 EADDRINUSE）');
          opt.port = pf.port;
        }
      }
    } catch (_e) { /* 预检失败不影响主流程 */ }

    await drv.launch({ appPath: opt.app, platform: opt.platform, caps: opt.caps, appiumUrl: opt.appiumUrl, appiumPort: opt.appiumPort, port: opt.port });
    log('=== software-verifier [' + opt.driver + ']: ' + spec.name + ' @ ' + BASE + ' ===');

    // ---------- 进化闭环（网络类）：导航前等待目标可达 + 导航重试 ----------
    // 与端口预检同构：读侧判定"是否有网络类复发记忆"，命中则把"目标还没起来"变成"等一下就好了"。
    let netRisky = false;
    try {
      const nr = evoSelfHeal.networkRisk({ risks: evoRecurring() });
      netRisky = !!(nr && nr.risky);
      if (netRisky) {
        const wr = await evoSelfHeal.waitReachable(BASE + '/', { retries: 6, delayMs: 700, timeoutMs: 2000 });
        log(wr.reachable
          ? '🛡 预检自愈：目标 ' + BASE + ' 等待 ' + wr.waitedMs + 'ms 后可达（第 ' + wr.attempts + ' 次探测 · 知识库判定为网络类复发风险，已避免 ECONNREFUSED）'
          : '⚠ 预检自愈：目标 ' + BASE + ' 探测 ' + wr.attempts + ' 次仍不可达（' + (wr.error || '') + '），仍按原流程尝试导航');
      }
    } catch (_e) { /* 网络预检失败不影响主流程 */ }

    // 启动即导航到被测地址（命中网络风险时带重试）
    const gotoAttempts = netRisky ? 3 : 1;
    let gotoOk = false, gotoErr = null;
    for (let i = 0; i < gotoAttempts; i++) {
      try { await drv.goto(BASE + '/'); gotoOk = true; if (i > 0) log('🛡 导航重试成功（第 ' + (i + 1) + ' 次）'); break; }
      catch (e) { gotoErr = e; if (i < gotoAttempts - 1) await drv.wait(800); }
    }
    if (!gotoOk) throw (gotoErr || new Error('导航失败: ' + BASE));
    await drv.wait(1000);

    if (spec.setup) for (const s of spec.setup) { const r = await runStep(drv, s); if (!r.ok) log('  setup 步骤失败: ' + (r.err || '')); }

    // v1.4.4：导航/前置阶段（launch → goto → setup）采集到的错误此前**没有任何消费者**——
    // 首个功能点开头的 drv.clearFeatureErrors() 会把它们直接丢掉。
    // 后果：入口 URL 本身 404/500 这类问题在任何功能点里都看不到，归因规则"入口 URL ⇒ tool"形同死代码。
    // 现在显式收成 preErrors：计入 totalErrors / errorBuckets / 报告，但不归到任何功能点（不翻转功能点判定）。
    const preErrors = (drv.featureErrors || []).slice();
    if (preErrors.length) {
      for (const e of preErrors) errors.push(e);
      drv.clearFeatureErrors();
      const c0 = classifyError(preErrors[0], CLS_CTX);
      log('⚠ 导航/前置阶段采集到 ' + preErrors.length + ' 条错误（不计入任何功能点判定，但进入归因与报告）'
        + ' · 首条归因=' + c0.label + (c0.layer ? '/' + c0.layer : '') + ' :: ' + String(preErrors[0]).slice(0, 120));
    }

    let selected = spec.features;
    if (opt.only.length) selected = spec.features.filter(f => opt.only.includes(f.id));
    else if (opt.uiOnly) selected = spec.features.filter(f => f.type !== 'ai' || opt.also.includes(f.id));
    if (opt.also.length && !opt.only.length) {
      const extra = spec.features.filter(f => opt.also.includes(f.id) && !selected.includes(f));
      selected = selected.concat(extra);
    }
    if (opt.ai === 'on') selected = spec.features;
    // v1.4.6：--exclude 负选择——在正选择之后做减法（--only A,B --exclude A 等价于只跑 B）
    if (opt.exclude.length) {
      const known = spec.features.map(f => f.id);
      const mis = opt.exclude.filter(id => known.indexOf(id) < 0);
      if (mis.length) log('   ! --exclude 指定了不存在的功能点: ' + mis.join(',') + '（已忽略）');
      const ex = opt.exclude.filter(id => known.indexOf(id) >= 0);
      selected = selected.filter(f => ex.indexOf(f.id) < 0);
      if (!selected.length) log('   ! 排除后无功能点可验证（--exclude ' + ex.join(',') + '）');
    }

    log('将验证 ' + selected.length + ' / ' + spec.features.length + ' 个功能点\n');

    // P1：防偷懒监督器接线（fail-open）
    try {
      if (Sup) {
        sup = Sup.start({
          initial: spec.features.map(f => f.name || f.description),
          host: (typeof evo !== 'undefined' ? evo : null),
          enable: opt.supervisor !== false,
        });
      }
    } catch (_e) { sup = null; }
    // v1.10.0：交互式追问默认开（TTY 才问；--question 强制、--no-question 硬关）
    //   口径：已知补充点静默自动注入；开头 gate 可一次拒（软拒，JIT 仍可问）；
    //   JIT 命中 spec 已有维度才问一次；JIT 拒绝 → 全局硬关（察觉意愿）。
    if (Sup && sup && sup.__enabled) {
      try {
        result.questioning = await runQuestioningLoop(sup, Sup, log, null, {
          specPath: opt.spec,
          spec: spec,
          force: !!opt.question,
          noQuestion: !!opt.noQuestion,
          isTTY: !!(process.stdin && process.stdin.isTTY),
        });
        const qd = result.questioning || {};
        if (qd.error) log('⚠ 追问循环异常（' + qd.error + '）—— 按「无补充」继续，不影响主流程');
        else if (qd.mode === 'off') log('🗣 追问已硬关（--no-question）：不弹确认；已存补充点自动注入' + (qd.added ? ' ' + qd.added + ' 项' : ''));
        else if (qd.mode === 'auto_apply_only') log('🗣 非交互环境：跳过追问确认（已存补充点自动注入 ' + (qd.added || 0) + ' 项）');
        else if (qd.mode === 'suppressed_hard') log('🗣 追问已按历史拒绝全局静默（不再打扰；--question 可覆盖）');
        else if (qd.added) log('🗣 追问：补充 ' + qd.added + ' 项契约（纳入对账：无执行日志且无跳过理由 → dangling → REJECT）');
        else log('🗣 追问：本次无补充（契约仍为 spec 功能点）');
      } catch (qe) {
        result.questioning = { error: (qe && qe.message) || String(qe) };
        log('⚠ 追问循环异常（' + result.questioning.error + '）—— 按「无补充」继续');
      }
    }
    // v1.9.0：6 类覆盖建议——机器不猜契约（猜的入契约 = 制造假 FAIL），只指出 spec 盲区；
    //   建议进 result.specCoverage 与报告建议段，不入 session、不影响 verdict。
    try {
      if (Sup && sup && sup.__enabled && typeof Sup.coverage === 'function') {
        result.specCoverage = Sup.coverage(sup);
      }
    } catch (_ce) { result.specCoverage = { enabled: false, reason: (_ce && _ce.message) || String(_ce) }; }
    // P1：收集 skipNotes（被过滤 feature）+ claimed（selected feature），键用 feature name（与 initial 的 description 对齐）
    //     —— 抽成纯函数 collectClaimsAndSkipNotes（导出供单测，行为逐字节一致）
    {
      const collected = collectClaimsAndSkipNotes(spec, selected, opt);
      result.claimed = collected.claimed;
      result.skipNotes = collected.skipNotes;
    }
    // P1：同名 feature 警告（不阻塞；readExecutionLog 按 name 匹配，同名会碰撞）—— 抽成纯函数 warnSameNameFeatures
    warnSameNameFeatures(spec, log);

    const allHeals = [];
    const envNoise = [];  // v1.4.3：环境噪声（与宿主无关的外部因素），单独记录、完整展示，不计入 FAIL
    const nonFunctional = [];  // v1.4.4：非功能性请求（favicon / source-map），与功能结论无关，无论如何不计入 FAIL
    // v1.4.3：截图失败不再静默。旧行为把失败改写成 { ok: true } 且 warn 无人消费，
    // 报告照写"截图"、消费者以为有证据而 PNG 其实不存在。截图是**证据材料**而非功能声明，
    // 故不翻转功能点判定，但必须进 result.toolIssues 并在报告「工具自身问题」段明示。
    const shot = async (name, tag) => {
      const r = await drv.screenshot(SHOTS + '/' + name).catch(e => ({ ok: false, err: (e && e.message) || '未知原因' }));
      if (r.ok) return true;
      CTX.toolIssues.push({ kind: 'screenshot', msg: tag + ' 未采集（' + name + '）：' + (r.err || '未知原因'), at: new Date().toISOString() });
      return false;
    };
    // I 类触发：把整次验证当作一条长任务线程（超期未收尾 → 内核 emit I + 落 I 镜像）。正常收尾则闭合，不产 I。
    const evoThread = (evo && evo.openThread) ? evo.openThread('软件验证全程', spec.name || '', { taskId: 'verify' }) : null;
    for (const f of selected) {
      drv.clearFeatureErrors();
      drv.clearHeals();
      await drv.preFeatureCleanup();
      const frec = { id: f.id, name: f.name, type: f.type, group: f.group || '', steps: [], asserts: [], pass: true, errors: [] };
      const featureErrors = []; // 本 feature 错误（来自驱动）
      log('▶ [' + f.id + '] ' + f.name + ' (' + f.type + ')');
      try {
        if (f.setup) for (const s of f.setup) { const r = await runStep(drv, s); frec.steps.push({ do: s.do, ...r }); }

        for (const s of (f.steps || [])) {
          const r = await runStep(drv, s);
          frec.steps.push({ do: s.do, text: s.text || s.sel || '', ...r });
          if (!r.ok) { frec.pass = false; frec.errors.push('步骤 ' + s.do + ' 失败: ' + (r.err || r.detail || '')); log('   ✗ 步骤 ' + s.do + ': ' + (r.err || r.detail || '')); evoTap(new Error('步骤 ' + s.do + ' 失败: ' + (r.err || r.detail || '')), { taskId: 'verify' }); evoPlan('声明步骤未达预期: ' + (s.do || ''), (r.err || r.detail || ''), { taskId: 'verify' }); }
          if (s.screenshot) await shot(s.screenshot, '步骤截图(' + f.id + ')');
        }
        const shotName = (f.id + '_' + f.name).replace(/[^\w一-龥]/g, '_') + '.png';
        frec.screenshot = (await shot(shotName, '功能截图(' + f.id + ')')) ? 'shots/' + shotName : null;

        for (const a of (f.asserts || [])) {
          const ar = await runAssert(drv, a);
          frec.asserts.push({ desc: a.desc || a.sel || a.eval || a.includes || '', ...ar });
          if (!ar.pass) { frec.pass = false; frec.errors.push('断言失败: ' + ar.detail + hintFor(ar.detail)); evoTap(new Error('断言失败: ' + ar.detail), { taskId: 'verify' }); evoGap('断言未满足（期望落差）: ' + (a.desc || ar.detail), ar.detail, { taskId: 'verify' }); }
          log('   ' + (ar.pass ? '✓' : '✗') + ' ' + (a.desc || ar.detail));
        }
        // v1.4.3：驱动错误先归因再决定是否计入功能点判定。
        //   宿主 → 计入 FAIL（原行为）
        //   环境 → 记录进 envNoise，不计入 FAIL（不污染无关功能点），但**完整出现在报告里**
        //   工具 → 计入 FAIL（验证器自身能力边界，需 spec 作者知晓）
        // 无论哪类都进 result.totalErrors，绝不静默丢弃。--strict-env 可把环境噪声也计入 FAIL。
        // v1.4.4：新增 noise（非功能性请求：favicon / source-map，浏览器自发起或开发期产物），
        //   无论如何都不计入 FAIL；并把归因层级（http 状态层 / net 传输层）一并写进记录，便于消费者复核。
        const drvErrs = (drv.featureErrors || []).slice();
        for (const e of drvErrs) {
          errors.push(e);
          const c = classifyError(e, CLS_CTX);
          evoTap(new Error(e), { taskId: 'verify', source: 'driver' });
          if (c.category === 'noise') { nonFunctional.push({ feature: f.id, msg: e, reason: c.reason, layer: c.layer, url: c.url }); continue; }
          if (c.category === 'env' && !opt.strictEnv) { envNoise.push({ feature: f.id, msg: e, reason: c.reason, layer: c.layer, url: c.url }); continue; }
          frec.pass = false;
          frec.errors.push('[' + c.label + (c.layer ? '/' + c.layer : '') + '] ' + e + hintFor(e));
        }
      } catch (e) {
        const em = (e && e.message || String(e));
        frec.pass = false; frec.errors.push('异常: ' + em + hintFor(em));
        log('   ✗ 异常: ' + em);
        evoTap(e, { taskId: 'verify', source: 'feature' });
        const shotE = 'ERR_' + f.id + '.png';
        frec.screenshot = (await shot(shotE, '异常截图(' + f.id + ')')) ? 'shots/' + shotE : null;
      }
      frec.heals = drv.heals.slice();
      allHeals.push(...frec.heals);
      log('   → ' + (frec.pass ? 'PASS' : 'FAIL') + (frec.errors.length ? '  (' + frec.errors.length + ' 处)' : '') + (frec.heals.length ? '  ♻自愈' + frec.heals.length : '') + '\n');
      result.features.push(frec);
    }

    // v1.4.6：消融对照需要知道「这次跑了谁、没跑谁」。被排除的点在此次根本不存在，
    // 其状态在消融矩阵里记 null（显示为 —），既不判为一致、也不判为翻转。
    result.tag = process.env.SV_ABLATION_TAG || 'single';
    result.exclude = opt.exclude.slice();
    result.endedAt = new Date().toISOString();
    result.totalErrors = errors;
    result.healTotal = allHeals.length;
    result.heals = allHeals;
    const passN = result.features.filter(f => f.pass).length;
    result.summary = { total: result.features.length, pass: passN, fail: result.features.length - passN };
    // v1.4.3：错误归因与工具自检落盘（机器可读），并在控制台显式回显——不再让消费者自己猜"这条该找谁"。
    result.toolIssues = CTX.toolIssues.slice();
    result.envNoise = envNoise;
    result.envNoiseCounted = !!opt.strictEnv;
    result.nonFunctional = nonFunctional;
    result.preErrors = preErrors;
    result.classifyContext = { targetUrl: CLS_CTX.targetUrl, navUrl: CLS_CTX.navUrl };
    result.errorBuckets = bucketize(errors, CLS_CTX);
    log('\n========== 汇总: ' + passN + '/' + result.features.length + ' 通过 ==========');
    {
      const c = result.errorBuckets.counts;
      if (errors.length) log('🔎 错误归因（两层判定）：🐞 宿主 ' + c.host + ' · 🌐 环境噪声 ' + c.env + ' · 🧰 工具 ' + c.tool + ' · 🚫 非功能性 ' + c.noise + (opt.strictEnv ? '（--strict-env：环境噪声已计入 FAIL）' : '（环境噪声/非功能性不计入 FAIL，完整列在报告「错误归因」段）'));
      if (envNoise.length && !opt.strictEnv) log('   ↳ 环境噪声明细：' + envNoise.slice(0, 3).map(x => '[' + x.feature + '] ' + String(x.msg).slice(0, 90)).join(' | '));
      if (nonFunctional.length) log('   ↳ 非功能性请求明细：' + nonFunctional.slice(0, 3).map(x => '[' + x.feature + '] ' + String(x.msg).slice(0, 90)).join(' | '));
      if (result.toolIssues.length) log('⚠ 工具自检：' + result.toolIssues.length + ' 项验证器自身降级（' + result.toolIssues.map(t => t.kind).join('/') + '）→ 见报告「工具自身问题」段（属"验证器的话"，非被测软件缺陷）');
    }
    if (result.healTotal) log('♻ 本次自愈 ' + result.healTotal + ' 处失效选择器（见报告「自愈记录」）');

    // P1：防偷懒监督器对账（fail-open）
    // ⚠ 2026-10-23 修复执行顺序（靶子站端到端实测暴露的第二个接线缺口）：
    //   对账的执行证据主源就是宿主写的 result.json（reconcile-core.cjs:267 readExecutionLog ①）。
    //   原顺序是「先 finalize 对账、再写 result.json」—— 对账时文件还不存在 → execLog.results 为空
    //   → 每个契约 hasExecLog=false → 全部判 dangling → verdict=REJECT。
    //   症状与「验证器偷懒/漏检」一模一样，根因却是「证据还没写出来」，两者必须能区分。
    //   新顺序：① 先落盘一次（提供证据）② 对账（显式传 resultPath，不靠猜路径）③ 回填 supervisor 后二次落盘。
    //   代价：result.json 写两次（几十 KB 级，耗时可忽略）；收益：对账拿的是真实执行证据而非猜测。
    try {
      if (SUPERVISOR_LOAD_ERR) {
        // 加载失败必须留痕：否则「监督器没接上」在报告里与「监督器判定通过」长得一样，无法区分
        result.supervisorLoadError = SUPERVISOR_LOAD_ERR;
        log('⚠ 防偷懒监督器未接入：evolution-supervisor.cjs 加载失败（' + SUPERVISOR_LOAD_ERR + '）—— 本轮无监督对账/门禁');
      }
      if (Sup && sup && sup.__enabled) {
        try { fs.mkdirSync(OUT, { recursive: true }); } catch (_) {}
        fs.writeFileSync(OUT + '/result.json', JSON.stringify(result, null, 2));
        result.supervisor = Sup.finalize(sup, {
          claimed: result.claimed || {},
          skipNotes: result.skipNotes || {},
          strict: !!opt.strict,
          resultPath: OUT + '/result.json',
        });
        // ⚠ 2026-10-23 新增（评审15 指出）：二次落盘失败必须留痕，不能静默。
        //   失败时磁盘上留下的是**第一次**写的 result.json（不含 supervisor 字段），
        //   消费方按 `result.supervisor.verdict==='PASS'` 验收会读到 undefined → 判「Run1 失败」，
        //   但根因是**写盘失败**、不是接线失败 —— 归因会错，且现场无从分辨。
        //   故：把 supervisor 结论转成字符串单独落盘 + 落 supervisorWriteError 字段，
        //   让「对账已产出但没落进 result.json」成为**可观测事实**，而不是静默降级。
        try {
          fs.writeFileSync(OUT + '/result.json', JSON.stringify(result, null, 2));
        } catch (we) {
          const msg = (we && we.message) || String(we);
          result.supervisorWriteError = msg;
          const su = result.supervisor || {};
          try {
            fs.writeFileSync(OUT + '/result.supervisor.json', JSON.stringify({
              warning: 'supervisor 已产出但回填 result.json 失败；本文件是唯一留存的对账结论',
              writeError: msg,
              supervisor: su,
            }, null, 2));
          } catch (_) {}
          log('⚠ supervisor 结论回填 result.json 失败（' + msg + '）→ 已单独落盘 result.supervisor.json（verdict=' + String(su.verdict) + '）');
        }
      }
    } catch (_e) {
      // ⚠ 同上：这里以前也是静默吞。finalize 抛错时必须留痕，
      //   否则「对账没跑成」与「对账跑成了没发现问题」在报告里完全一样。
      result.supervisorError = (_e && _e.message) || String(_e);
      log('⚠ 防偷懒监督对账失败（' + result.supervisorError + '）—— 本轮无监督门禁结论');
    }

    fs.writeFileSync(OUT + '/result.json', JSON.stringify(result, null, 2));
    writeMarkdown(result, OUT + '/VERIFY-报告.md');
    writeHtml(result, OUT + '/VERIFY-报告.html');
    log('报告已写入: ' + OUT);
    // CI 友好（v1.4.2）：有未通过功能点则退出码为 1。此前主流程从不设置退出码，
    // 导致「有 FAIL 仍 exit=0」，流水线/脚本无法用退出码判定验证成败。
    process.exitCode = result.summary.fail > 0 ? 1 : 0;
    // 自进化默认静默：接入共享进化引擎前，不再无审计地自动落盘 pitfalls/learnings。
    // 需要旧行为时显式 --evolve on（仍可手动: node evolve.cjs --result <result.json>）。
    if (opt.evolve) runEvolution(OUT + '/result.json');
    // 共享进化引擎：把本轮采集到的错误信号跑一轮八步链路（tap 已在各报错点完成），落盘 learnings + 审计。
    await evoRun();
    // I 类收尾：正常收尾则闭合长任务线程（不产 I 信号）；若整轮超时未到此处，线程超期 → 内核 emit I。
    if (evoThread && evoThread.ok && evo.closeThread) { try { evo.closeThread(evoThread.threadId || evoThread.ledgerId); } catch (_e) {} }
    // 进化闭环（显性化）：把引擎状态回显出来，避免"学到的经验没人看"。
    try {
      const st = evo ? evo.status() : null;
      if (st && st.tier) log('🧠 进化：tier=' + st.tier + ' · 已捕获错误信号 ' + (st.errorSignals || 0) + ' 条 · 审计链 ' + (st.auditVerify ? '完整' : '异常'));
    } catch (_e) { /* ignore */ }
    // 复发哨兵：检测"已落地但仍在复发"的候选（loop 自检——land 了却没止住 → 判候选无效并回写否决）
    try {
      const sen = evo ? evo.recurrenceSentinel({ minRecur: 1 }) : null;
      if (sen && sen.stale && sen.stale.length) {
        log('⚠ 复发哨兵：' + sen.stale.length + ' 个指纹在"落地后仍复发" → 判定候选无效' + (sen.vetoed ? '（已否决 ' + sen.vetoed + ' 个）' : ''));
        for (const s of sen.stale.slice(0, 5)) log('   • ' + s.fingerprint + ' v' + (s.version || '?') + ' 已落地 ' + (s.landCount || 1) + ' 次、首次落地后仍复发 ' + s.recursAfter + ' 次：' + String(s.title || '').slice(0, 70));
      }
    } catch (_e) { /* ignore */ }
    // 读侧闭环：把 G/P/I 落差 + 外部解法 读回报告（避免只写不读——写进去的经验必须被读出来改变输出）
    try {
      const adv = evo ? await evo.advisory() : null;
      if (adv && adv.ok) {
        result.evolutionAdvisory = adv;
        fs.writeFileSync(OUT + '/result.json', JSON.stringify(result, null, 2));
        writeMarkdown(result, OUT + '/VERIFY-报告.md');
        writeHtml(result, OUT + '/VERIFY-报告.html');
        const lines = [];
        if (adv.open && (adv.open.expectation || adv.open.plan || adv.open.thread)) lines.push('⚠ 未收尾落差：期望落差(G) ' + (adv.open.expectation || 0) + ' / 计划偏离(P) ' + (adv.open.plan || 0) + ' / 长任务(I) ' + (adv.open.thread || 0));
        if (adv.gaps && (adv.gaps.G || adv.gaps.P || adv.gaps.I)) lines.push('📊 已记录落差信号：G ' + (adv.gaps.G || 0) + ' / P ' + (adv.gaps.P || 0) + ' / I ' + (adv.gaps.I || 0));
        if (adv.solutions && adv.solutions.length) lines.push('💡 外部解法命中 ' + adv.solutions.length + ' 条（已落地知识面，下次优先匹配）');
        if (lines.length) { log('🧠 进化提示（读侧闭环）：'); for (const ln of lines) log('   • ' + ln); }
      }
    } catch (_e) { /* ignore */ }
    log('💡 若本次有新踩坑想回馈社区：node contribute.cjs --make（打包后发回维护者合并）');
  } catch (e) {
    log('FATAL ' + (e && e.stack || e));
    evoTap(e, { taskId: 'verify', source: 'fatal' });
    // P1：FATAL 也尽量落盘 partial + 对账（不掩盖原错误）—— 抽成纯函数 writePartialResult（导出供单测，行为逐字节一致）
    writePartialResult(OUT, result, sup, Sup, opt, e);
  } finally {
    if (drv) await drv.close().catch(() => {});
  }
})();

// ---------- 报告生成 ----------
function writeMarkdown(r, file) {
  let md = `# 功能验证报告：${r.name}\n\n`;
  md += `- 目标：${r.baseUrl}\n- 驱动：${r.driver}\n- 时间：${r.startedAt}\n- 结果：**${r.summary.pass}/${r.summary.total} 通过**\n\n`;
  md += `## 汇总\n\n| 状态 | ID | 功能 | 类型 | 关键断言 |\n|---|---|---|---|---|\n`;
  for (const f of r.features) {
    const icon = f.pass ? '✅' : '❌';
    const key = (f.asserts || []).map(a => a.desc || '').filter(Boolean).slice(0, 2).join('；') || '-';
    md += `| ${icon} | ${f.id} | ${f.name} | ${f.type} | ${key} |\n`;
  }
  md += `\n## 失败明细\n\n`;
  const fails = r.features.filter(f => !f.pass);
  if (!fails.length) md += '无。\n';
  for (const f of fails) {
    md += `### ❌ ${f.id} ${f.name}\n`;
    for (const e of f.errors) md += `- ${e}\n`;
    if (f.screenshot) md += `\n![截图](./${f.screenshot})\n`;
    md += `\n`;
  }
  if (r.errorBuckets) {
    const c = r.errorBuckets.counts;
    md += '\n## 错误归因（宿主 / 环境 / 工具 / 非功能性）\n\n';
    md += '把采集到的错误按"该找谁"分开——此前混作一团，消费者无法判断是站点问题、网络问题还是验证器问题。\n\n';
    md += '**v1.4.4 拆两层**：\n';
    md += '- **HTTP 状态层**（服务端确实应答了 4xx/5xx）→ 默认判宿主；第三方源应答降环境；入口 URL 本身 4xx 判工具。\n';
    md += '  v1.4.3 曾把这一层与网络层合并成"环境噪声"，导致**同源 404/500 被洗白**（默认不计 FAIL）。\n';
    md += '- **网络传输层**（没拿到应答：`net::ERR_*`）→ 按来源判：同源判宿主（自有资源连不上），跨源判环境。\n\n';
    md += '| 类别 | 条数 | 计入 FAIL | 说明 |\n|---|---|---|---|\n';
    md += '| 🐞 宿主缺陷 | ' + c.host + ' | 是 | 被测软件自身问题（含同源 4xx/5xx 与自有资源连不上），站点/应用维护者需处理 |\n';
    md += '| 🌐 环境噪声 | ' + c.env + ' | ' + (r.envNoiseCounted ? '是（--strict-env）' : '否') + ' | 第三方源不可达/第三方源应答错误，与宿主逻辑无关 |\n';
    md += '| 🧰 工具自身 | ' + c.tool + ' | 是 | 验证器能力边界或降级，属"验证器的话" |\n';
    md += '| 🚫 非功能性 | ' + (c.noise || 0) + ' | 否 | 浏览器自发起或开发期产物（favicon / source-map），与功能结论无关 |\n';
    for (const pair of [['host', '🐞 宿主缺陷'], ['env', '🌐 环境噪声'], ['tool', '🧰 工具自身'], ['noise', '🚫 非功能性请求']]) {
      const arr = r.errorBuckets[pair[0]] || [];
      md += '\n### ' + pair[1] + '（' + arr.length + '）\n\n';
      if (!arr.length) { md += '无。\n'; continue; }
      for (const x of arr.slice(0, 30)) md += '- [' + pair[1].slice(2, 4) + (x.layer ? '/' + x.layer : '') + '] ' + x.msg + '\n  - 归因理由：' + x.reason + '\n';
    }
  }
  if (r.preErrors && r.preErrors.length) {
    md += '\n## ⚠ 导航/前置阶段错误（不计入任何功能点判定）\n\n';
    md += '这些发生在进入功能点之前（打开入口 URL / setup），此前被首个功能点的清理直接丢弃；现显式列出：\n\n';
    for (const e of r.preErrors.slice(0, 20)) { const cc = classifyError(e, r.classifyContext || CLS_CTX); md += '- [' + cc.label + (cc.layer ? '/' + cc.layer : '') + '] ' + e + '\n  - 归因理由：' + cc.reason + '\n'; }
  }
  if (r.toolIssues && r.toolIssues.length) {
    md += '\n## ⚠ 工具自身问题（验证器自检 · 非被测软件缺陷）\n\n';
    md += '这些是验证器自己的降级或能力边界，**不代表被测软件有问题**，但会影响证据完整性：\n\n';
    for (const t of r.toolIssues) md += '- (' + t.kind + ') ' + t.msg + '\n';
  }
  if (r.totalErrors && r.totalErrors.length) {
    md += `## 页面级错误日志\n\n`;
    for (const e of r.totalErrors.slice(0, 50).map(x => { const cc = classifyError(x, r.classifyContext || CLS_CTX); return '[宿主/环境/工具/非功能性 → ' + cc.label + (cc.layer ? '/' + cc.layer : '') + '] ' + x; })) md += `- ${e}\n`;
  }
  if (r.heals && r.heals.length) {
    md += `\n## 自愈记录（选择器失效后自动找回等价元素 · 仅修复测试定位，不改软件）\n\n`;
    for (const h of r.heals) md += `- \`${h.sel}\` → 策略 \`${h.strategy || '?'}\` ${h.ok ? '✅ 已恢复' : '❌ 未找到等价元素'}${h.text ? '（' + h.text + '）' : ''}\n`;
  }
  const a = r.evolutionAdvisory;
  if (a && ((a.gaps && (a.gaps.G || a.gaps.P || a.gaps.I)) || (a.open && (a.open.expectation || a.open.plan || a.open.thread)) || (a.solutions && a.solutions.length))) {
    md += `\n## 进化提示（agent-evolution 读侧闭环）\n\n`;
    if (a.open && (a.open.expectation || a.open.plan || a.open.thread)) md += `- ⚠ 未收尾落差：期望落差(G) ${a.open.expectation || 0} / 计划偏离(P) ${a.open.plan || 0} / 长任务(I) ${a.open.thread || 0}（报告生成前请显式对齐用户预期要点、比对声明步骤与实际轨迹、收尾长任务）\n`;
    if (a.gaps && (a.gaps.G || a.gaps.P || a.gaps.I)) md += `- 📊 本轮已记录落差信号：G ${a.gaps.G || 0} / P ${a.gaps.P || 0} / I ${a.gaps.I || 0}\n`;
    if (a.solutions && a.solutions.length) { md += `- 💡 外部解法命中 ${a.solutions.length} 条（已落地知识面）：\n`; for (const s of a.solutions.slice(0, 5)) md += `  - ${s.title}：${s.content}\n`; }
  }
  // ── 不偷懒监督器门禁（v1.5.0）─────────────────────────────
  // 由 plugins/anti-lazy-supervisor 提供「追问-对账-门禁」闭环：
  //   拿契约对照真实执行日志，口头声明不算数；有漏检则在报告顶部加警告并拒落盘。
  // 设计约束（与既有 tap* 一致）：
  //   · 插件缺失 → 完全降级，宿主行为与改动前**逐字节相同**
  //   · 插件自身抛错 → 只记 toolIssues，绝不中断验证
  //   · 未启用（默认）→ 不注入、不拦截
  // v1.9.0：spec 覆盖建议（6 类盲区 · 启发式 · 只建议不入契约 · 不影响 verdict）
  if (r.specCoverage && r.specCoverage.enabled && Array.isArray(r.specCoverage.categories)) {
    const gaps = r.specCoverage.categories.filter(function (c) { return !c.covered; });
    md += '\n## spec 覆盖建议（6 类测试点盲区 · 启发式 · 不影响判定）\n\n';
    md += '对契约描述做关键词启发式检查，指出 spec 可能没覆盖的测试点类别。**这只是给 spec 作者的建议**：不进入契约、不参与对账、不影响 verdict；关键词匹配可能误判，请人工复核。\n\n';
    md += '| 类别 | 覆盖情况 | 建议补充的探测点 |\n|---|---|---|\n';
    for (const c of r.specCoverage.categories) {
      md += '| ' + c.name + ' | ' + (c.covered ? '✅ 已覆盖' : '⚠ 未见覆盖') + ' | ' + (c.probes || []).join('、') + ' |\n';
    }
    md += '\n' + (gaps.length ? ('共 ' + gaps.length + ' 类未见覆盖：' + gaps.map(function (g) { return g.name; }).join('、') + '。可补充进 spec 后重跑。') : '6 类均见覆盖（启发式结论，仍建议人工过一遍）。') + '\n';
  }
  // v1.9.0：交互式追问记录（--question）
  if (r.questioning && (r.questioning.rounds || r.questioning.mode)) {
    md += '\n## 交互式追问记录（--question）\n\n';
    md += '- 追问轮数：' + r.questioning.rounds + ' · 补充契约：' + (r.questioning.added || 0) + ' 项\n';
    md += '- 追问补充的契约与 spec 初始契约**同等对账**：无执行日志且无跳过理由 → dangling → REJECT\n';
    for (const d of (r.questioning.detail || [])) {
      md += '- [' + d.categoryName + '·第' + d.round + '轮] ' + ((d.answers && d.answers.length) ? d.answers.join('；') : '（明确无补充）') + '\n';
    }
    if (r.questioning.mode) md += '- 运行模式：' + r.questioning.mode + String.fromCharCode(10);
    if (r.questioning.optedOut) md += '- 意见记忆：开头软拒=' + r.questioning.optedOut.start + ' · 全局硬关=' + r.questioning.optedOut.hard + String.fromCharCode(10);
    const sl = r.questioning.seal;
    if (sl && sl.written > 0) md += '- 已写入宿主 tapPlan：' + sl.written + ' 条\n';
    else if (sl && sl.reason) md += '- 未写入 tapPlan（' + sl.reason + '）——契约仍在会话内，对账不受影响\n';
  }
  const sup = r && r.supervisor;
  if (sup && sup.enabled && sup.block) {
    if (sup.banner) md = String(sup.banner) + '\n\n' + md;
    md += '\n' + String(sup.block) + '\n';
  }
  if (sup && sup.enabled && sup.blocked && r.toolIssues && Array.isArray(r.toolIssues)) {
    r.toolIssues.push({ kind: 'supervisor-gate', msg: String(sup.banner || '监督审计未通过：存在漏检项，报告已标记') });
  }
  fs.writeFileSync(file, md);
}

function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function writeHtml(r, file) {
  let rows = '';
  for (const f of r.features) {
    const cls = f.pass ? 'pass' : 'fail';
    const icon = f.pass ? '✅' : '❌';
    const key = (f.asserts || []).map(a => a.desc || '').filter(Boolean).slice(0, 3).join('；') || '-';
    const errs = f.errors.length ? `<div class="err">${f.errors.map(e => esc(e)).join('<br>')}</div>` : '';
    const shot = f.screenshot ? `<a href="./${f.screenshot}">截图</a>` : '';
    rows += `<tr class="${cls}"><td>${icon}</td><td>${esc(f.id)}</td><td>${esc(f.name)}</td><td>${esc(f.type)}</td><td>${esc(key)}</td><td>${shot}${errs}</td></tr>`;
  }
  let bucketHtml = '';
  if (r.errorBuckets) {
    const c = r.errorBuckets.counts;
    const itemize = arr => arr.slice(0, 20).map(x => '<li>' + esc(x.msg) + '<span class="why">（' + esc(x.reason) + '）</span></li>').join('');
    bucketHtml = '<div class="buckets"><b>🔎 错误归因（两层判定）：🐞 宿主 ' + c.host + ' · 🌐 环境噪声 ' + c.env + ' · 🧰 工具 ' + c.tool + ' · 🚫 非功能性 ' + (c.noise || 0) + '</b>'
      + '<div class="bg host"><b>🐞 宿主缺陷 ' + c.host + ' 条 · 计入 FAIL</b><ul>' + (c.host ? itemize(r.errorBuckets.host) : '<li>无</li>') + '</ul></div>'
      + '<div class="bg env"><b>🌐 环境噪声 ' + c.env + ' 条 · ' + (r.envNoiseCounted ? '已计入 FAIL（--strict-env）' : '不计入 FAIL（完整列出，不静默丢弃）') + '</b><ul>' + (c.env ? itemize(r.errorBuckets.env) : '<li>无</li>') + '</ul></div>'
      + '<div class="bg tool"><b>🧰 工具自身 ' + c.tool + ' 条 · 属"验证器的话"</b><ul>' + (c.tool ? itemize(r.errorBuckets.tool) : '<li>无</li>') + '</ul></div>'
      + '<div class="bg noise"><b>🚫 非功能性 ' + (c.noise || 0) + ' 条 · 不计入 FAIL（favicon / source-map 等浏览器自发起请求）</b><ul>' + (c.noise ? itemize(r.errorBuckets.noise) : '<li>无</li>') + '</ul></div></div>';
  }
  let toolHtml = '';
  if (r.toolIssues && r.toolIssues.length) {
    toolHtml = '<div class="heal"><b>⚠ 工具自检：' + r.toolIssues.length + ' 项验证器自身降级（非被测软件缺陷）</b><ul>' + r.toolIssues.map(t => '<li><code>' + esc(t.kind) + '</code> ' + esc(t.msg) + '</li>').join('') + '</ul></div>';
  }
  let advHtml = '';
  { const a = r.evolutionAdvisory; if (a && ((a.gaps && (a.gaps.G || a.gaps.P || a.gaps.I)) || (a.open && (a.open.expectation || a.open.plan || a.open.thread)) || (a.solutions && a.solutions.length))) { const items = []; if (a.open && (a.open.expectation || a.open.plan || a.open.thread)) items.push('未收尾落差：期望落差(G) ' + (a.open.expectation || 0) + ' / 计划偏离(P) ' + (a.open.plan || 0) + ' / 长任务(I) ' + (a.open.thread || 0)); if (a.gaps && (a.gaps.G || a.gaps.P || a.gaps.I)) items.push('本轮已记录落差信号：G ' + (a.gaps.G || 0) + ' / P ' + (a.gaps.P || 0) + ' / I ' + (a.gaps.I || 0)); if (a.solutions && a.solutions.length) items.push('外部解法命中 ' + a.solutions.length + ' 条（已落地知识面）'); advHtml = '<div class="heal"><b>🧠 进化提示（读侧闭环）</b><ul>' + items.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul></div>'; } }
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>验证报告 ${esc(r.name)}</title>
<style>
body{font-family:-apple-system,Segoe UI,Roboto,'Microsoft YaHei',sans-serif;background:#f6f7f9;color:#1c1e21;margin:0;padding:24px}
h1{font-size:20px;margin:0 0 4px}
.meta{color:#666;font-size:13px;margin-bottom:16px}
.summary{display:inline-block;background:#fff;border:1px solid #e3e6ea;border-radius:10px;padding:10px 16px;font-size:14px;margin-bottom:16px}
table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #e3e6ea;border-radius:10px;overflow:hidden}
th,td{text-align:left;padding:9px 11px;border-bottom:1px solid #eef0f2;font-size:13px;vertical-align:top}
th{background:#f0f2f5;font-weight:600}
tr.pass td:first-child{color:#1a7f37}
tr.fail{background:#fff5f5}
tr.fail td:first-child{color:#c0392b}
.err{color:#c0392b;font-size:12px;margin-top:4px}
.heal{background:#fff;border:1px solid #e3e6ea;border-radius:10px;padding:12px 16px;margin-top:16px;font-size:13px}
.heal code{background:#f0f2f5;padding:1px 5px;border-radius:4px;font-size:12px}
a{color:#2f6fed}
.buckets{background:#fff;border:1px solid #e3e6ea;border-radius:10px;padding:12px 16px;margin-top:16px;font-size:13px}
.bg{border-left:4px solid #ccc;padding:6px 10px;margin-top:8px;background:#fafbfc;border-radius:6px}
.bg.host{border-left-color:#c0392b}
.bg.env{border-left-color:#d68910}
.bg.tool{border-left-color:#2f6fed}
.bg.noise{border-left-color:#8e8e93}
.bg ul{margin:6px 0 0 18px;padding:0}
.why{color:#777;font-size:11px}
</style></head><body>
<h1>功能验证报告：${esc(r.name)}</h1>
<div class="meta">目标 ${esc(r.baseUrl)} · 驱动 ${esc(r.driver)} · ${esc(r.startedAt)}</div>
<div class="summary"><b>${r.summary.pass}/${r.summary.total}</b> 通过 · 失败 ${r.summary.fail}</div>
<table><thead><tr><th>状态</th><th>ID</th><th>功能</th><th>类型</th><th>关键断言</th><th>截图/错误</th></tr></thead><tbody>${rows}</tbody></table>
${r.heals && r.heals.length ? `<div class="heal"><b>♻ 自愈 ${r.heals.length} 处</b>：选择器失效后自动用稳定信号找回等价元素（仅修正测试定位，不改被测软件）。<ul>${r.heals.map(h => `<li><code>${esc(h.sel)}</code> → <code>${esc(h.strategy || '?')}</code> ${h.ok ? '✅' : '❌'}${h.text ? '（' + esc(h.text) + '）' : ''}</li>`).join('')}</ul></div>` : ''}
${bucketHtml}${toolHtml}${advHtml}</body></html>`;
  fs.writeFileSync(file, html);
}
