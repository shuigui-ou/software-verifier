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
 * 用法：
 *   node contribute.cjs --make          打包本地未共享的新坑 → evolution/contrib/contribution-<ts>.json
 *   node contribute.cjs --status        查看 已共享/待提交 计数
 *   node contribute.cjs --merge <文件>  合并他人 bundle 进本地 playbook
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
  return pits.filter(p => !p.shared && !ledger.shared.includes(p.id));
}

function make() {
  const pits = loadPitfalls();
  const ledger = loadLedger();
  const pend = pendingPits(pits, ledger);
  if (!pend.length) { console.log('[contribute] 没有待提交的新坑，知识库已是最新共享态。'); return; }
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
  console.log('[contribute] 已打包 ' + pend.length + ' 条新坑 → ' + f);
  console.log('[contribute] 把该文件发回维护者（提 PR / 丢共享目录 / 贴表单）。维护者执行：');
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
  const pend = pendingPits(pits, ledger).length;
  console.log('[contribute] 共 ' + pits.length + ' 条坑：已共享 ' + shared + '，待提交 ' + pend + '。');
}

if (require.main === module) {
  const args = process.argv.slice(2);
  let mode = null, file = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--make') mode = 'make';
    else if (args[i] === '--status') mode = 'status';
    else if (args[i] === '--merge') { mode = 'merge'; file = args[++i]; }
  }
  if (!mode) { console.error('用法: node contribute.cjs --make | --status | --merge <bundle.json>'); process.exit(2); }
  if (mode === 'make') make();
  else if (mode === 'status') status();
  else if (mode === 'merge') { if (!file) { console.error('缺少 bundle 文件'); process.exit(2); } merge(file); }
}

module.exports = { make, merge, status, pendingPits };
