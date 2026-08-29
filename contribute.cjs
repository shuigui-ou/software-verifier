#!/usr/bin/env node
/**
 * contribute.cjs —— software-verifier 贡献回流模块
 *
 * 目标：让「分布式使用的每个人」踩到的坑能汇总回共享 playbook，
 *       实现「人越多，skill 越强」。服务器无关，现在即可用。
 *
 * 闭环：
 *   用户A 跑 verify → evolve 沉淀新坑(auto_*) → contribute --make 打包成 bundle
 *     → 把 bundle 发回维护者（提 PR / 丢共享目录 / 贴表单）
 *   维护者 contribute --merge <bundle> → 合并进发布版 pitfalls.json → 重算 Playbook
 *     → 重新分发（上架市场 / 发新版 zip）
 *
 * 回流授权（opt-in，绝不自动发送）：
 *   新坑默认 consent=pending。只有经用户同意(consent=granted)的坑才会被 --make 打包；
 *   拒绝(consent=declined)或尚未授权的坑只留本地，永远不会进 bundle。
 *
 * 用法：
 *   node contribute.cjs --share                       一键回传：自动打包所有待回传坑（已脱敏）+ 生成 bundle（推荐）
 *   node contribute.cjs --make [--grant id,id] [--decline id,id]  兼容旧流程：先授权/拒，再打包
 *   node contribute.cjs --status        查看 已共享 / 已授权待提交 / 未授权 计数
 *   node contribute.cjs --merge <文件>  合并他人 bundle 进本地 playbook
 *   注：抽坑即脱敏（evolve.cjs 写入时已剥离 URL/路径/项目名），bundle 不含原始数据；仍手动发回，脚本不自动发送。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const SKILL = __dirname;
const EV = path.join(SKILL, 'evolution');
const PIT = path.join(EV, 'pitfalls.json');
const LEARN = path.join(EV, 'learnings.jsonl');
const CONTRIB_DIR = path.join(EV, 'contrib');
const LEDGER = path.join(EV, 'contrib-ledger.json');

function loadPitfalls() { try { return JSON.parse(fs.readFileSync(PIT, 'utf8')); } catch (e) { return []; } }
function savePitfalls(a) { fs.mkdirSync(EV, { recursive: true }); fs.writeFileSync(PIT, JSON.stringify(a, null, 2)); }
function loadLedger() { try { return JSON.parse(fs.readFileSync(LEDGER, 'utf8')); } catch (e) { return { shared: [] }; } }
function saveLedger(l) { fs.mkdirSync(CONTRIB_DIR, { recursive: true }); fs.writeFileSync(LEDGER, JSON.stringify(l, null, 2)); }

/* ───────────────────────────────────────────────────────────────────────────
 * 回流安全过滤（sanitize）
 * 外部 bundle 是「不可信输入」：merge 前必须逐字段校验，失败即整体拒绝(fail-closed)。
 * 目标：杜绝原型污染、ReDoS、字段投毒、畸形 id/超长串/路径注入污染共享 playbook。
 * ─────────────────────────────────────────────────────────────────────────── */
const ALLOWED_PIT_KEYS = new Set(['id', 'category', 'symptom', 'patterns', 'fix', 'apps', 'hits', 'shared', 'consent', 'firstSeen', 'lastSeen', 'examples']);
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const ID_RE = /^[A-Za-z0-9_]{2,64}$/;
const MAX_SYMPTOM = 200, MAX_FIX = 1200, MAX_PATTERN = 80, MAX_PATTERNS = 8;
const MAX_APP = 60, MAX_APPS = 30, MAX_FROM = 60, MAX_PITS = 200, MAX_HITS = 1000000;

function stripCtl(s) { return String(s).replace(/[\x00-\x1F\x7F]/g, ''); }

// 校验单条坑；返回 { ok, pit, errors }。errors 中含「禁止/非法」为硬错误(拒绝)，
// 仅「未知字段已忽略」为软警告(仍接受)。
function sanitizePit(p) {
  const errors = [];
  if (!p || typeof p !== 'object' || Array.isArray(p)) return { ok: false, errors: ['坑不是对象'] };
  for (const k of Object.keys(p)) {
    if (FORBIDDEN_KEYS.has(k)) errors.push('禁止的键: ' + k);
    else if (!ALLOWED_PIT_KEYS.has(k)) errors.push('未知字段已忽略: ' + k);
  }
  if (errors.some(e => e.startsWith('禁止'))) return { ok: false, errors };

  const out = {};
  const id = p.id;
  if (typeof id !== 'string' || !ID_RE.test(id) || FORBIDDEN_KEYS.has(id)) {
    errors.push('id 非法: ' + JSON.stringify(id));
    return { ok: false, errors };
  }
  out.id = id;
  out.category = (typeof p.category === 'string' && p.category.trim()) ? p.category.trim().slice(0, 24) : '未知';
  if (typeof p.symptom === 'string' && p.symptom.trim()) out.symptom = stripCtl(p.symptom).trim().slice(0, MAX_SYMPTOM);
  if (typeof p.fix === 'string' && p.fix.trim()) out.fix = stripCtl(p.fix).trim().slice(0, MAX_FIX);
  if (Array.isArray(p.patterns)) {
    const pats = [];
    for (const pat of p.patterns.slice(0, MAX_PATTERNS)) {
      if (typeof pat === 'string' && pat.trim()) {
        const lit = stripCtl(pat).trim().slice(0, MAX_PATTERN);
        if (lit) pats.push(lit); // 字面量安全：下游只做 includes 匹配，不执行正则
      }
    }
    out.patterns = pats;
  } else out.patterns = [];
  if (Array.isArray(p.apps)) {
    const apps = [];
    for (const a of p.apps.slice(0, MAX_APPS)) {
      if (typeof a === 'string' && a.trim()) {
        const t = stripCtl(a).trim().replace(/[\\/]/g, '').slice(0, MAX_APP); // 去路径分隔，防注入
        if (t) apps.push(t);
      }
    }
    out.apps = apps;
  } else out.apps = [];
  let hits = 1;
  if (typeof p.hits === 'number' && isFinite(p.hits)) hits = Math.max(0, Math.min(MAX_HITS, Math.trunc(p.hits)));
  out.hits = hits;
  out.shared = false; // merge 时才置 true；忽略外部传入的 shared/consent（不信任）
  if (typeof p.firstSeen === 'string' && /^[\d-]{0,20}$/.test(p.firstSeen)) out.firstSeen = p.firstSeen;
  if (typeof p.lastSeen === 'string' && /^[\d-]{0,20}$/.test(p.lastSeen)) out.lastSeen = p.lastSeen;
  return { ok: true, pit: out, errors };
}

// 校验整包；返回 { ok, from, pits, errors }。ok=false 时 merge 必须整体中止。
function sanitizeBundle(b) {
  const errors = [];
  if (!b || typeof b !== 'object' || Array.isArray(b)) return { ok: false, from: 'anon', pits: [], errors: ['bundle 不是对象'] };
  if (b.skill !== 'software-verifier') errors.push('skill 不匹配: ' + JSON.stringify(b.skill));
  if (b.schema !== 1) errors.push('schema 不支持: ' + JSON.stringify(b.schema));
  const from = (typeof b.from === 'string' && b.from.trim()) ? stripCtl(b.from).trim().replace(/[\\/]/g, '').slice(0, MAX_FROM) : 'anon';
  const pitsRaw = Array.isArray(b.pitfalls) ? b.pitfalls : [];
  if (!Array.isArray(b.pitfalls)) errors.push('pitfalls 缺失或非数组');
  else if (b.pitfalls.length > MAX_PITS) errors.push('pitfalls 过多(' + b.pitfalls.length + '>=' + MAX_PITS + ')');
  const pits = [];
  for (let i = 0; i < pitsRaw.length && i < MAX_PITS; i++) {
    const r = sanitizePit(pitsRaw[i]);
    if (!r.ok) errors.push('第' + (i + 1) + '条坑被拒: ' + r.errors.join('; '));
    else { if (r.errors.length) errors.push('第' + (i + 1) + '条坑(已忽略未知字段): ' + r.errors.join('; ')); pits.push(r.pit); }
  }
  const hard = errors.filter(e => /(禁止|非法|缺失|不支持|过多|不匹配)/.test(e));
  return { ok: hard.length === 0 && pitsRaw.length > 0, from, pits, errors };
}

function pendingPits(pits, ledger) {
  // 只打包「已授权回流(consent=granted) 且 尚未共享」的坑
  return pits.filter(p => !p.shared && !ledger.shared.includes(p.id) && p.consent === 'granted');
}

function setConsent(ids, value) {
  const pits = loadPitfalls();
  const set = new Set(ids);
  let n = 0;
  for (const p of pits) if (set.has(p.id)) { p.consent = value; n++; }
  if (n) savePitfalls(pits);
  return n;
}

function make(opts) {
  opts = opts || {};
  if (opts.grant && opts.grant.length) {
    const n = setConsent(opts.grant, 'granted');
    console.log('[contribute] 已授权回流 ' + n + ' 条（标记为 consent=granted）。');
  }
  if (opts.decline && opts.decline.length) {
    const n = setConsent(opts.decline, 'declined');
    console.log('[contribute] 已拒绝回流 ' + n + ' 条（仅留本地，不会打包）。');
  }
  const pits = loadPitfalls();
  const ledger = loadLedger();
  const pend = pendingPits(pits, ledger);
  const noConsent = pits.filter(p => !p.shared && !ledger.shared.includes(p.id) && p.consent !== 'granted').length;
  if (!pend.length) {
    console.log('[contribute] 没有「已授权且待提交」的新坑。' + (noConsent ? '（另有 ' + noConsent + ' 条未授权，需先 --grant <id> 经用户同意）' : ''));
    return;
  }
  // 防御：本地坑也过一遍安全过滤，跳过任何不合规项（理论上本地坑应已合规）
  const clean = [];
  for (const p of pend) {
    const r = sanitizePit(p);
    if (r.ok) clean.push(r.pit);
    else console.log('[contribute] 跳过一条本地不合规坑(' + (p.id || '?') + '): ' + r.errors.join('; '));
  }
  if (!clean.length) { console.log('[contribute] 待提交坑经安全过滤后无合规项，未打包。'); return; }
  fs.mkdirSync(CONTRIB_DIR, { recursive: true });
  const bundle = {
    skill: 'software-verifier',
    schema: 1,
    generatedAt: new Date().toISOString(),
    from: (process.env.CONTRIB_FROM || os.hostname() || 'anon'),
    pitfalls: clean.map(p => Object.assign({}, p, { shared: true }))
  };
  const f = path.join(CONTRIB_DIR, 'contribution-' + Date.now().toString(36) + '.json');
  fs.writeFileSync(f, JSON.stringify(bundle, null, 2));
  // 本地标记为已共享，避免重复打包
  const ids = new Set(pend.map(p => p.id));
  pits.forEach(p => { if (ids.has(p.id)) p.shared = true; });
  savePitfalls(pits);
  ledger.shared.push(...pend.map(p => p.id));
  saveLedger(ledger);
  console.log('[contribute] 已打包 ' + pend.length + ' 条已授权新坑 → ' + f);
  console.log('[contribute] 该文件需你手动发回维护者（提 PR / 丢共享目录 / 贴表单），脚本不会自动发送。维护者执行：');
  console.log('           node contribute.cjs --merge "' + f + '"');
}

function merge(file, opts) {
  opts = opts || {};
  let bundle;
  try { bundle = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { console.error('[contribute] 无法读取 bundle: ' + e.message); process.exit(2); }

  // 安全过滤：不可信输入，先校验再合并
  const s = sanitizeBundle(bundle);
  if (opts.check) {
    console.log('[contribute] 预检(' + file + ')：');
    console.log('  skill=' + bundle.skill + ' schema=' + bundle.schema + ' from=' + s.from);
    console.log('  将接受 ' + s.pits.length + ' 条坑，以下为全部校验信息：');
    for (const e of s.errors) console.log('   - ' + e);
    console.log('  结论：' + (s.ok ? '可安全合并' : '存在硬错误，合并将被拒绝(不写入)'));
    return;
  }
  if (!s.ok) {
    console.error('[contribute] 拒绝合并：bundle 含不安全/非法内容，未写入任何数据。');
    for (const e of s.errors) if (/(禁止|非法|缺失|不支持|过多|不匹配)/.test(e)) console.error('   ✗ ' + e);
    console.error('[contribute] 请让贡献者修正后重新发回，或用 --merge --check 查看详情。');
    process.exit(2);
  }

  const pits = loadPitfalls();
  const byId = new Map(pits.map(p => [p.id, p]));
  let added = 0, updated = 0;
  for (const np of s.pits) {
    if (byId.has(np.id)) {
      const e = byId.get(np.id);
      e.hits = Math.max(e.hits || 0, np.hits || 0);
      e.apps = Array.from(new Set([].concat(e.apps || [], np.apps || [])));
      if (np.fix && (!e.fix || np.fix.length > e.fix.length)) e.fix = np.fix;
      e.shared = true;
      e.lastSeen = np.lastSeen || e.lastSeen;
      updated++;
    } else {
      // 显式字段拷贝（仅白名单键），杜绝原型污染 / 未知字段潜入共享 playbook
      const fresh = {};
      for (const k of ALLOWED_PIT_KEYS) if (np[k] !== undefined) fresh[k] = np[k];
      fresh.shared = true;
      pits.push(fresh);
      added++;
    }
  }
  savePitfalls(pits);
  fs.mkdirSync(EV, { recursive: true });
  fs.appendFileSync(LEARN, JSON.stringify({ ts: new Date().toISOString(), type: 'merge', from: s.from, added, updated, total: pits.length }) + '\n');
  const ev = require('./evolve.cjs');
  ev.writeEvolutionMd(pits);
  console.log('[contribute] 合并完成（已通过安全过滤）：新增 ' + added + '，更新 ' + updated + '，playbook 现共 ' + pits.length + ' 条。');
}

/**
 * share —— 一键回传（脱敏版）
 * 自动打包所有「未共享且未拒绝(consent != declined)」的坑（已抽坑即脱敏，无原始数据）。
 * 最终再强制把 apps 置为 ['<anon>']，确保 bundle 不含任何真实项目名。
 * 仍手动发回（脚本不代发，规避静默外联），符合回流安全准则。
 */
function share(opts) {
  opts = opts || {};
  const pits = loadPitfalls();
  const ledger = loadLedger();
  const pend = pits.filter(p => !p.shared && !ledger.shared.includes(p.id) && p.consent !== 'declined');
  if (!pend.length) {
    console.log('[contribute] 没有待回传的新坑（都已被你拒绝或已共享）。');
    return;
  }
  const clean = [];
  for (const p of pend) {
    const r = sanitizePit(p);
    if (r.ok) clean.push(r.pit);
    else console.log('[contribute] 跳过一条本地不合规坑(' + (p.id || '?') + '): ' + r.errors.join('; '));
  }
  if (!clean.length) { console.log('[contribute] 待回传坑经安全过滤后无合规项，未打包。'); return; }
  // 最终脱敏闸：外部 bundle 一律不携带真实项目名
  for (const p of clean) p.apps = ['<anon>'];
  fs.mkdirSync(CONTRIB_DIR, { recursive: true });
  const bundle = {
    skill: 'software-verifier',
    schema: 1,
    generatedAt: new Date().toISOString(),
    from: (process.env.CONTRIB_FROM || 'community'),
    anonymized: true,
    pitfalls: clean.map(p => Object.assign({}, p, { shared: true }))
  };
  const f = path.join(CONTRIB_DIR, 'contribution-' + Date.now().toString(36) + '.json');
  fs.writeFileSync(f, JSON.stringify(bundle, null, 2));
  const ids = new Set(pend.map(p => p.id));
  pits.forEach(p => { if (ids.has(p.id)) p.shared = true; });
  savePitfalls(pits);
  ledger.shared.push(...pend.map(p => p.id));
  saveLedger(ledger);
  console.log('[contribute] 已生成脱敏回传包 ' + pend.length + ' 条 → ' + f);
  console.log('[contribute] 内容已自动脱敏（无 URL / 路径 / 项目名 / 原始错误），可安全发回。');
  console.log('[contribute] 手动发回（脚本不代发）：提 PR / 丢共享目录 / 发给维护者，然后维护者执行：');
  console.log('           node contribute.cjs --merge "' + f + '"');
}

function status() {
  const pits = loadPitfalls();
  const ledger = loadLedger();
  const shared = pits.filter(p => p.shared).length;
  const granted = pendingPits(pits, ledger).length;
  const noConsent = pits.filter(p => !p.shared && !ledger.shared.includes(p.id) && p.consent !== 'granted').length;
  console.log('[contribute] 共 ' + pits.length + ' 条坑：已共享 ' + shared + '，已授权待提交 ' + granted + '，未授权(留本地) ' + noConsent + '。');
}

if (require.main === module) {
  const args = process.argv.slice(2);
  let mode = null, file = null, grant = [], decline = [], check = false;
  const splitIds = (s) => String(s).split(/[ ,]+/).filter(Boolean);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--share') mode = 'share';
    else if (args[i] === '--make') mode = 'make';
    else if (args[i] === '--status') mode = 'status';
    else if (args[i] === '--merge') mode = 'merge';
    else if (args[i] === '--check') check = true;
    else if (args[i] === '--grant') { mode = 'make'; grant = splitIds(args[++i]); }
    else if (args[i] === '--decline') { mode = 'make'; decline = splitIds(args[++i]); }
    else if (!args[i].startsWith('--') && mode === 'merge' && !file) file = args[i]; // 位置参数作为 bundle 文件
  }
  if (!mode) { console.error('用法: node contribute.cjs --share(一键回传脱敏包) | --make [--grant id,id] [--decline id,id] | --status | --merge <bundle.json> [--check]'); process.exit(2); }
  if (mode === 'share') share({ grant, decline });
  else if (mode === 'make') make({ grant, decline });
  else if (mode === 'status') status();
  else if (mode === 'merge') { if (!file) { console.error('缺少 bundle 文件'); process.exit(2); } merge(file, { check }); }
}

module.exports = { make, merge, status, pendingPits, setConsent, sanitizePit, sanitizeBundle };
