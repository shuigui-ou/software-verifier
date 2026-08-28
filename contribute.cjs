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
 *   node contribute.cjs --make [--grant id,id] [--decline id,id]  打包已授权的新坑（先按用户答复标记授权/拒绝）
 *   node contribute.cjs --status        查看 已共享 / 已授权待提交 / 未授权 计数
 *   node contribute.cjs --merge <文件>  合并他人 bundle 进本地 playbook
 *   注：打包出的 bundle 需使用者手动发回维护者，脚本不自动发送。
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
  fs.mkdirSync(CONTRIB_DIR, { recursive: true });
  const bundle = {
    skill: 'software-verifier',
    schema: 1,
    generatedAt: new Date().toISOString(),
    from: (process.env.CONTRIB_FROM || os.hostname() || 'anon'),
    pitfalls: pend.map(p => Object.assign({}, p, { shared: true }))
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

function merge(file) {
  let bundle;
  try { bundle = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { console.error('[contribute] 无法读取 bundle: ' + e.message); process.exit(2); }
  const pits = loadPitfalls();
  const byId = new Map(pits.map(p => [p.id, p]));
  let added = 0, updated = 0;
  for (const p of (bundle.pitfalls || [])) {
    if (byId.has(p.id)) {
      const e = byId.get(p.id);
      e.hits = Math.max(e.hits || 0, p.hits || 0);
      e.apps = Array.from(new Set([].concat(e.apps || [], p.apps || [])));
      if (p.fix && (!e.fix || p.fix.length > e.fix.length)) e.fix = p.fix;
      e.shared = true;
      e.lastSeen = p.lastSeen || e.lastSeen;
      updated++;
    } else {
      pits.push(Object.assign({}, p, { shared: true }));
      added++;
    }
  }
  savePitfalls(pits);
  fs.mkdirSync(EV, { recursive: true });
  fs.appendFileSync(LEARN, JSON.stringify({ ts: new Date().toISOString(), type: 'merge', from: bundle.from || '?', added, updated, total: pits.length }) + '\n');
  const ev = require('./evolve.cjs');
  ev.writeEvolutionMd(pits);
  console.log('[contribute] 合并完成：新增 ' + added + '，更新 ' + updated + '，playbook 现共 ' + pits.length + ' 条。');
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
  let mode = null, file = null, grant = [], decline = [];
  const splitIds = (s) => String(s).split(/[ ,]+/).filter(Boolean);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--make') mode = 'make';
    else if (args[i] === '--status') mode = 'status';
    else if (args[i] === '--merge') { mode = 'merge'; file = args[++i]; }
    else if (args[i] === '--grant') { mode = 'make'; grant = splitIds(args[++i]); }
    else if (args[i] === '--decline') { mode = 'make'; decline = splitIds(args[++i]); }
  }
  if (!mode) { console.error('用法: node contribute.cjs --make [--grant id,id] [--decline id,id] | --status | --merge <bundle.json>'); process.exit(2); }
  if (mode === 'make') make({ grant, decline });
  else if (mode === 'status') status();
  else if (mode === 'merge') { if (!file) { console.error('缺少 bundle 文件'); process.exit(2); } merge(file); }
}

module.exports = { make, merge, status, pendingPits, setConsent };
