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
  matchPitfall.lastPattern = '';
  if (!text) return null;
  // 安全：用字面量子串匹配（大小写不敏感），绝不对 patterns 执行 new RegExp —— 避免恶意 bundle 注入 / ReDoS。
  // 大小写不敏感：同类报错只要核心词相同（如 Not Clickable / not clickable）即可命中，不再因大小写漏配。
  // 归因优先级（v1.2.7 修）：**最长命中 pattern 优先**，并列时比 hits。
  //   旧行为只按 hits 取最大 → 泛 pattern 条目会击败专门为它写的种子，给 agent 递【错误】的解法。实测误归因 3/20：
  //     'locator resolved to hidden <div>'（真实=显隐）→ 被 'resolved to' 归到 seed-strict-mode-multiple
  //     'locator resolved to 0 elements'（真实=0 元素）→ 同上，抢走了专为此写的 seed-zero-elements
  //   具体度更强的 pattern（如 'strict mode violation' 21 字 > 'resolved to' 11 字）才应胜出。
  // 只改打分、不改契约：无任何 pattern 命中仍返回 null；仅一条命中时结果与旧实现完全一致。
  const t = String(text).toLowerCase();
  let best = null, bestLen = -1, bestHits = -1;
  for (const p of pitfalls) {
    let longest = -1;
    for (const pat of (p.patterns || [])) {
      if (typeof pat !== 'string' || !pat) continue;
      const s = pat.toLowerCase();
      if (t.includes(s) && s.length > longest) longest = s.length;
    }
    if (longest < 0) continue;
    const hits = p.hits || 0;
    if (longest > bestLen || (longest === bestLen && hits > bestHits)) {
      best = p; bestLen = longest; bestHits = hits;
    }
  }
  if (best) {
    let wp = '';
    for (const pat of (best.patterns || [])) {
      const s = String(pat || '').toLowerCase();
      if (s && t.includes(s) && s.length === bestLen) { wp = String(pat); break; }
    }
    matchPitfall.lastPattern = wp;
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
// 抓坑即推断默认解法：新坑出生即带可用提示，避免"待人工补充解法"废提示。
// 【声明式分支表 v1.2.7】inferFix 与领域闸（evolution-candidate-gen.cjs）共用这一个来源：
//   - keywords：推断召回用（宽，宁多勿漏）
//   - gate：    闸门精度用（窄，宁缺勿滥）。**省略时 = keywords**。
//     为什么不直接用 keywords 当闸：部分 keywords 措辞过泛（裸 "reading '" 对宿主侧
//     `Cannot read properties of undefined (reading 'map')` 同样成立；'class' 会命中
//     `Class constructor ... cannot be invoked without 'new'`），直接当闸会让宿主工具链
//     错误漏进 DOM 解法（实测踩坑：错解法入库比不学更糟）。
//   ⇒ **往表里加一个分支 = 推断能力与闸同步扩展**（不写 gate 时），两处不再各自硬编码漂移。
// 契约：按序匹配（keywords 任一子串命中即返回该分支 fix）；全不命中才兜底"待补充"。
// 只写解法文本到 pitfalls.json，不动被测软件。
const FIX_BRANCHES = [
  { keywords: ['cannot read properties of null'], gate: ['cannot read properties of null'],
    fix: 'eval 拿到 null 元素仍访问属性。先 !!document.querySelector(sel) 判空再读 .width/.textContent 等；元素未挂载时先等待再断言。' },
  // gate: [] = 此分支不打开闸（"X is not defined" 宿主/页面两侧同形，引擎侧宁可不学）；
  // 宿主 runEvolution 路径不经闸，仍按 keywords 推断。
  { keywords: ['is not defined', 'referenceerror'], gate: [],
    fix: 'eval 引用了页面作用域不存在的变量（组件内部状态）。validate 的 eval 不应读取框架内部变量名（常未挂到 window）。改为用稳定 DOM 信号（data-testid/text/role/classList）表达断言。' },
  { keywords: ['intercepts', 'not clickable', 'pointer events'], gate: ['intercepts', 'pointer events', 'clickable'],
    fix: '点击被遮罩拦截。先关闭/等待遮罩（loading/弹窗/tooltip）消失再点击；顽固遮罩用 exec 在页面内 el.click() 绕过行动性检查。' },
  { keywords: ['iframe', 'shadow', 'detached'], gate: ['iframe', 'shadow', 'detached'],
    fix: '元素在 iframe / shadow DOM / 已 detached。需切到对应 frame 上下文或穿透 shadow root 再定位。' },
  { keywords: ['classlist', 'class'], gate: ['classlist', 'classname'],
    fix: '类名/显隐断言失败。类名若是 CSS Module 哈希（如 _abc123）会随机变化→用 data-testid 或稳定业务 class；确认元素是否被 v-if 条件渲染移除（getElementById 返回 null）；显隐优先用 :visible / aria-hidden。' },
  { keywords: ['queryselectorall', 'length'], gate: ['queryselectorall', 'queryselector'],
    fix: '列表项数量不符。确认数据是否已加载完（分页/懒加载/动画），必要时等待后再数；区分「恰好 N」与「至少 N」；数量变化属预期时改用 >= 阈值。' },
  { keywords: ['textcontent', 'includes', 'indexof'], gate: ['textcontent'],
    fix: '文本断言未命中。可能异步渲染→先 waitSel/轮询；含不可见字符或大小写差异→断言 trim()+toLowerCase()；先断言元素存在再比文本。' },
  // 可见性/显隐：纯 DOM 域词（宿主工具链错误不会说 "is not visible"），但 inferFix 原先无分支
  // —— 当初硬编码闸靠 'visible'/'hidden' 放行它去走「已知坑」检查。移到表里：既恢复闸放行，
  // 又真正补全 inferFix（原先这类错误只能拿占位解法）。gate 省略 → 与 keywords 同宽。
  { keywords: ['hidden', 'visible', 'invisible', 'not visible'], gate: ['hidden', 'visible', 'invisible'],
    fix: '显隐/可见性断言失败。元素可能被 v-if / 条件渲染移除或尚未挂载→断言前先等待其出现；优先用 :visible / aria-hidden 判定而非读取尺寸；父级 display:none / overflow:hidden / 动画中也会使元素不可见（先展开容器/切 tab 再点）。' },
  { keywords: ['clicktext'], gate: ['clicktext'],
    fix: 'clickText 未找到可点击文本。文本可能在 overlay / 动画后出现、或被截断；改用 clickSel + 稳定选择器；确认元素可点击（未被 pointer-events:none 遮罩拦截，见 seed-overlay-intercept）。' },
  { keywords: ['timeout', 'waiting for', 'stable', 'not found', '超时', 'waitsel', 'waitSel', '命中 0 个'],
    gate: ['waiting for', 'timeout', 'timed out', 'stable', '超时', 'waitsel', '命中 0 个'],
    fix: '元素未出现或等待超时。调大 waitSel 超时阈值；元素可能异步渲染/动画后才挂载，先等待再断言；确认是否在 overlay/iframe/shadow DOM 内（需切上下文或穿透）。' },
  { keywords: ['步骤 ai 失败', 'ai 失败'], gate: ['步骤 ai 失败', 'ai 失败'],
    fix: 'AI 步骤失败。检查 LLM token 是否过期/超额；网络抖动重试；确认输入上下文是否过长触发截断。' },
];
const FIX_PLACEHOLDER = '（待人工补充解法）— 首次出现，请在 evolution/pitfalls.json 补充可复用解法。';
function inferFix(category, ae, patterns) {
  const t = String(ae || '').toLowerCase();
  for (const b of FIX_BRANCHES) {
    for (const k of b.keywords) {
      if (t.includes(String(k).toLowerCase())) return b.fix;
    }
  }
  return FIX_PLACEHOLDER;
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
// 同签名归并（v1.2.6 自维护核心）：同一组 SYN_KEYS 视为同一失败模式家族，
// 跨运行自动合并进已有坑（累加 hits + 并入变体模式），不再新建噪坑。
// 这样库永远自洁净，不需要人工去重。
function synSigOf(patterns) {
  const s = new Set();
  for (const k of SYN_KEYS) {
    if ((patterns || []).some(p => String(p).toLowerCase().includes(k))) s.add(k);
  }
  return [...s].sort().join('|');
}
function findMergeTarget(pitfalls, newOnes, ae) {
  const sig = synSigOf(extractPatterns(ae));
  if (!sig) return null;
  for (const p of [...pitfalls, ...newOnes]) {
    if (synSigOf(p.patterns) === sig) return p;
  }
  return null;
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
          // 同签名归并：已有同 SYN_KEYS 家族的坑 → 并入（累加 hits + 扩大模式），不新建噪坑。
          const target = findMergeTarget(pitfalls, newOnes, ae);
          if (target) {
            target.hits = (target.hits || 0) + 1;
            target.lastSeen = new Date().toISOString().slice(0, 10);
            const pats = extractPatterns(ae);
            for (const p of pats) if (!(target.patterns || []).includes(p)) target.patterns.push(p);
            if (!target.symptom || target.symptom.startsWith('<脱敏错误')) target.symptom = sig;
          } else if (!newOnes.find(x => x.symptom === sig)) {
            newOnes.push({
              id: 'auto_' + Date.now().toString(36) + '_' + newOnes.length,
              category: guessCategory(e),
              symptom: sig,
              consent: 'granted', // 已脱敏、无原始数据，默认可回传（仍可用 --decline 拒）
              patterns: extractPatterns(ae),
              // inferFix 必须吃【原文 e】，不能吃脱敏 ae：anonymize 的引号规则 (/["'][^"']{3,}["']/)
              // 会跨引号吞掉一整段，连带吃掉 inferFix 赖以匹配的关键词。
              // 实测：eval(document.getElementById('a').classList.contains('on')) = false
              //   → 脱敏成 getElementById('a<str>on')) = false，'classlist' 分支永不命中
              //   → 可推断的解法退化成「（待人工补充解法）」。这正是"新坑带空解法入库"的根因。
              // 安全性：inferFix 每个分支 return 的都是常量文案，只按关键词选择、不拼接入参，
              //   故传原文不会把被测应用数据带进 fix 字段（fix 会被 contribute 外发）。
              // patterns 仍取 ae：它是要外发的共享语料，必须保持脱敏。
              fix: inferFix(guessCategory(e), e, extractPatterns(ae)),
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

module.exports = { runEvolution, loadPitfalls, matchPitfall, writeEvolutionMd, anonymize, extractPatterns, SYN_KEYS, inferFix, guessCategory, FIX_BRANCHES, FIX_PLACEHOLDER };
