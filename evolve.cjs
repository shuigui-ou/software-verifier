#!/usr/bin/env node
/**
 * evolve.cjs —— software-verifier 自进化模块
 *
 * 设计目标：让这个 skill 在「被很多人用」之后变得越来越强。
 * 每次验证跑完，
 *   1) 读取 result.json，扫描失败功能与错误；
 *   2) 失败若命中 evolution/pitfalls.json 里的「已知坑」→ 累加命中次数，并在报告错误上附带解法提示；
 *   3) 失败若没命中任何已知坑 → 生成一条新坑（按错误特征去重），写入 playbook，供日后续跑直接复用；
 *   4) 把本次运行（含命中/新增情况）追加到 learnings.jsonl（原始学习流）；
 *   5) 重新生成 evolution.md（人类可读的「踩坑 Playbook」，按命中次数排序）。
 *
 * 调用方式：
 *   - verify.cjs 跑完报告后自动调用 runEvolution(OUT + '/result.json')
 *   - 也可单独跑：node evolve.cjs --result <result.json>
 *
 * 知识沉淀位置（用户级 skill，随本机所有项目/用户累积）：
 *   <skill>/evolution/pitfalls.json   可复用解法 playbook（核心资产）
 *   <skill>/evolution/learnings.jsonl 每次运行原始记录
 *   <skill>/evolution/evolution.md    人类可读 Playbook
 */
'use strict';
const fs = require('fs');
const path = require('path');
const SKILL_DIR = __dirname;
const EV_DIR = path.join(SKILL_DIR, 'evolution');
const PITFALLS = path.join(EV_DIR, 'pitfalls.json');
const LEARNINGS = path.join(EV_DIR, 'learnings.jsonl');
const EVOL_MD = path.join(EV_DIR, 'evolution.md');

function loadPitfalls() {
  try { return JSON.parse(fs.readFileSync(PITFALLS, 'utf8')); } catch (e) { return []; }
}
function savePitfalls(arr) {
  fs.mkdirSync(EV_DIR, { recursive: true });
  fs.writeFileSync(PITFALLS, JSON.stringify(arr, null, 2));
}
function matchPitfall(text, pitfalls) {
  if (!text) return null;
  // 安全：用字面量子串匹配（大小写不敏感），绝不对 patterns 执行 new RegExp —— 避免恶意 bundle 注入 / ReDoS。
  // 大小写不敏感：同类报错只要核心词相同（如 Not Clickable / not clickable）即可命中，不再因大小写漏配。
  text = String(text).toLowerCase();
  let best = null;
  for (const p of pitfalls) {
    for (const pat of (p.patterns || [])) {
      if (typeof pat === 'string' && pat && text.includes(pat.toLowerCase())) {
        if (!best || (p.hits || 0) > (best.hits || 0)) best = p;
        break;
      }
    }
  }
  return best;
}
function guessCategory(err) {
  const t = err || '';
  if (/not visible|hidden|intercepts|pointer events/.test(t)) return '显隐/容器';
  if (/Timeout|waiting for|stable|not found/.test(t)) return '行动性超时';
  if (/nth|selector|data-act/.test(t)) return '选择器精度';
  if (/eval|assert|联动|填充/.test(t)) return '断言语义';
  return '未知';
}
function esc(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
// 同义归一表：把同类报错的不同措辞映射到同一组关键词，扩大自动坑的泛化面。
// 例：框架 A 报 "element is not clickable"、框架 B 报 "intercepts pointer events"，都含下表关键词 → 命中同一坑。
const SYN_KEYS = [
  'clickable', 'intercepts', 'intercept',        // 点击被拦截
  'timeout', 'timed out', 'waiting for', 'stable', // 行动性/等待超时
  'visible', 'hidden', 'invisible',              // 显隐/容器
  'selector', 'nth', 'strict', 'resolved to',     // 选择器精度
  'assert', 'expected', 'eval',                   // 断言语义
  'iframe', 'frame', 'shadow', 'detached',        // 结构/上下文
  'animation', 'animate', 'flaky', 'flake'        // 不稳定
];
// 从脱敏错误里抽核心 pattern：优先取命中同义词表的词（泛化好，不依赖前缀），兜底取前 36 字符（保留历史行为）。
// 全部 esc 防正则注入（includes 不执行正则，但保持与历史一致）。
function extractPatterns(ae) {
  const lower = String(ae || '').toLowerCase();
  const pats = new Set();
  for (const k of SYN_KEYS) if (lower.includes(k)) pats.add(k);
  pats.add((ae || '').slice(0, 36)); // 兜底前缀
  return [...pats].filter(Boolean).map(esc);
}

/**
 * anonymize —— 抽坑即脱敏（回流安全的根基）
 * 坑库只存「失败模式」，绝不存原始数据。写入 pitfalls.json 前剥离：
 *   - URL（http/https）
 *   - 文件路径（Win C:\… / Unix /home/… / node_modules/…）
 *   - 引号串（选择器/值，常含项目结构）
 *   - 被测软件名（调用方传入的 r.name）
 * 匹配时也对入站错误脱敏，保证「两端一致」仍能命中。
 * 原始 app 名仅留在本地 learnings.jsonl（不外传），用于本机跨项目诊断。
 */
function anonymize(text, appName) {
  if (!text) return '';
  let s = String(text);
  s = s.replace(/https?:\/\/[^\s'"]+/gi, '<url>');
  s = s.replace(/\b(?:[A-Za-z]:)?[\\/][^'"\s]{0,160}/g, '<path>');
  s = s.replace(/["'][^"']{3,}["']/g, '<str>');
  if (appName) s = s.split(appName).join('<app>');
  s = s.replace(/\s{2,}/g, ' ').trim();
  return s;
}

function runEvolution(resultPath) {
  try {
    const r = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
    const pitfalls = loadPitfalls();
    const fails = (r.features || []).filter(f => !f.pass);
    const matched = [];
    const newOnes = [];

    for (const f of fails) {
      for (const e of (f.errors || [])) {
        const ae = anonymize(e, r.name); // 入站错误先脱敏再匹配/入库
        const m = matchPitfall(ae, pitfalls);
        if (m) matched.push({ feature: f.id, error: e, pitfall: m.id });
        else {
          const sig = ae.slice(0, 90) || ('<脱敏错误:' + guessCategory(e) + '>');
          if (!newOnes.find(x => x.symptom === sig)) {
            newOnes.push({
              id: 'auto_' + Date.now().toString(36) + '_' + newOnes.length,
              category: guessCategory(e),
              symptom: sig,
              consent: 'granted', // 已脱敏、无原始数据，默认可回传（仍可用 --decline 拒）
              patterns: extractPatterns(ae),
              fix: '（待人工补充解法）— 首次出现，请在 evolution/pitfalls.json 补充可复用解法。',
              apps: ['<anon>'], // 脱敏：不含真实项目名
              hits: 1,
              firstSeen: new Date().toISOString().slice(0, 10),
              lastSeen: new Date().toISOString().slice(0, 10)
            });
          }
        }
      }
    }

    // 合并新坑
    if (newOnes.length) { pitfalls.push(...newOnes); savePitfalls(pitfalls); }
    // 累加已知坑命中
    for (const m of matched) {
      const p = pitfalls.find(x => x.id === m.pitfall);
      if (p) {
        p.hits = (p.hits || 0) + 1;
        p.lastSeen = new Date().toISOString().slice(0, 10);
        if (r.name && !p.apps.includes(r.name)) p.apps.push(r.name);
      }
    }
    if (matched.length) savePitfalls(pitfalls);

    // 原始学习流
    const rec = {
      ts: new Date().toISOString(),
      app: r.name,
      total: r.summary && r.summary.total,
      pass: r.summary && r.summary.pass,
      fail: r.summary && r.summary.fail,
      failureIds: fails.map(f => f.id),
      matched: matched.map(m => m.pitfall),
      newPitfalls: newOnes.map(n => n.id),
      healTotal: r.healTotal || 0,
      heals: (r.heals || []).map(h => ({ sel: h.sel, strategy: h.strategy, ok: h.ok }))
    };
    fs.mkdirSync(EV_DIR, { recursive: true });
    fs.appendFileSync(LEARNINGS, JSON.stringify(rec) + '\n');

    // 记录本次新坑，供 agent 在出报告后询问用户「是否允许回流」（绝不自动发送）
    const lastRun = {
      ts: new Date().toISOString(),
      app: r.name,
      newPits: newOnes.map(n => ({ id: n.id, category: n.category, symptom: n.symptom, fix: n.fix, consent: n.consent })),
      matched: matched.map(m => m.pitfall),
      healTotal: r.healTotal || 0
    };
    fs.writeFileSync(path.join(EV_DIR, 'last-evolution.json'), JSON.stringify(lastRun, null, 2));

    writeEvolutionMd(pitfalls);
    let msg = '[evolve] 本次失败 ' + fails.length + ' 项，命中已知坑 ' + matched.length + '，新增未知坑 ' + newOnes.length + '；playbook 现共 ' + pitfalls.length + ' 条。';
    if (r.healTotal) msg += '  自愈 ' + r.healTotal + ' 处选择器。';
    console.log(msg);
    return { matched, newOnes };
  } catch (e) {
    console.log('[evolve] 跳过: ' + (e && e.message || e));
    return null;
  }
}

function writeEvolutionMd(pitfalls) {
  const sorted = [...pitfalls].sort((a, b) => (b.hits || 0) - (a.hits || 0));
  let md = '# software-verifier · 踩坑 Playbook（自进化知识库）\n\n';
  md += '> 本文件由 evolve 模块在每次验证跑完后自动维护。越用越强：每条都来自真实验证失败，附带可复用的解法。\n\n';
  md += '共 **' + pitfalls.length + '** 条 · 按命中次数排序。\n\n';
  for (const p of sorted) {
    md += '## [' + (p.hits || 0) + ' 次] ' + (p.category || '') + ' · `' + (p.id || '') + '`\n';
    md += '- 症状：' + (p.symptom || '') + '\n';
    md += '- 解法：' + (p.fix || '') + '\n';
    md += '- 触发模式：' + (p.patterns || []).join(' | ') + '\n';
    md += '- 出现于：' + (p.apps || []).join('、') + ' · 末次 ' + (p.lastSeen || '') + '\n\n';
  }
  fs.writeFileSync(EVOL_MD, md);
}

// 单独运行时
if (require.main === module) {
  const args = process.argv.slice(2);
  let rp = null, regen = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--result') rp = args[++i];
    else if (args[i] === '--regen') regen = true;
  }
  if (regen) { writeEvolutionMd(loadPitfalls()); console.log('[evolve] 已重算 Playbook。'); return; }
  if (!rp) { console.error('用法: node evolve.cjs --result <result.json> | --regen'); process.exit(2); }
  runEvolution(rp);
}

module.exports = { runEvolution, loadPitfalls, matchPitfall, writeEvolutionMd, anonymize, extractPatterns, SYN_KEYS };
