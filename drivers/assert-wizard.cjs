#!/usr/bin/env node
/**
 * assert-wizard.cjs —— software-verifier 断言编写向导
 *
 * 解决痛点（来自坑库统计，断言语义类 9 条/129 命中 = 10.4%，且选择器精度 25.9% /
 * 显隐容器 26.5% 大半是"选择器写错 / 断言写错"导致的误报）：
 *   - 帮用户在写 spec 时挑「稳定信号」选择器，而不是 brittle 的 CSS Modules 哈希类 / nth-child。
 *   - 产出可直接粘进 verify.cjs spec 的断言模板片段（asserts 数组格式）。
 *   - 按已知坑类别给出「断言编写陷阱」提醒（遮罩只隐藏不移除、异步未等渲染就断言、严格模式多命中…）。
 *
 * 零依赖、纯 Node，可离线跑（--feature 模式），也可喂一段 HTML 扫描可锚定元素（--html 模式）。
 * 不修改被测软件，只辅助「把 spec 写对」——符合软件验证铁律。
 *
 * 用法：
 *   node assert-wizard.cjs --feature "F01:点提交后应有成功提示" [--type ui|ai]
 *   node assert-wizard.cjs --html page.html --hints "提交,成功,列表项"
 *   node assert-wizard.cjs --sel ".e2d9f3.submit-btn"        # 只评估一个选择器的稳定性
 *   node assert-wizard.cjs --feature "..." --json            # 机器可读输出
 */
'use strict';
const fs = require('fs');
const path = require('path');

/* ───────────────────────────────────────────────────────────────────────────
 * 稳定信号优先级（与 Healer 的找回策略保持一致，越靠前越稳）
 * ─────────────────────────────────────────────────────────────────────────── */
const SIGNAL_PRIORITY = [
  { key: 'testid', label: 'data-testid', weight: 5 },
  { key: 'aria', label: 'aria-label', weight: 4 },
  { key: 'role', label: 'role+文本', weight: 3 },
  { key: 'id', label: '稳定 id', weight: 3 },
  { key: 'text', label: '可见文本', weight: 2 },
  { key: 'class', label: 'class（慎用）', weight: 1 },
];

/* 选择器稳定性评估：识别 brittle 模式并给出改写建议 */
function classifySelector(sel) {
  if (typeof sel !== 'string' || !sel.trim()) return { stability: 'low', reason: '空选择器', suggestion: '请提供明确选择器' };
  const s = sel.trim();
  // CSS Modules 哈希类（.e2d9f3 / ._btn_xxx / .submit_btn__3k2a）
  if (/\.[_a-zA-Z0-9]*[a-f0-9]{4,}/.test(s) || /__[A-Za-z0-9_-]+/.test(s)) {
    return { stability: 'low', reason: '疑似 CSS Modules 哈希类名（重建即变，selector 精度类坑高发）', suggestion: '改用 data-testid 或 aria-label 锚定' };
  }
  // nth-child / nth-of-type（依赖 DOM 顺序，易因插入元素错位）
  if (/:nth-[a-z]+\(/.test(s)) {
    return { stability: 'medium', reason: 'nth-child 依赖 DOM 顺序（同名单元素错位→严格模式多命中/零命中）', suggestion: '优先用文本或稳定属性；必须时用 nth 参数显式声明，并加断言说明预期顺序' };
  }
  // 长链式后代（脆弱）
  if ((s.match(/\s[>+~]\s|\s{2,}/g) || []).length >= 2) {
    return { stability: 'medium', reason: '深层后代链选择器（结构一调就断）', suggestion: '改为靠近目标元素的稳定信号' };
  }
  // 含 data-testid / aria / role 视为稳
  if (/data-testid|\[aria-|\[role=/.test(s)) return { stability: 'high', reason: '命中稳定信号属性', suggestion: '' };
  // #id 稳定
  if (/^#[\w-]+$/.test(s)) return { stability: 'high', reason: '稳定 id 选择器', suggestion: '' };
  // 纯 .class 或 tag
  if (/^\.[\w-]+$/.test(s) || /^[a-z][\w-]*$/.test(s)) {
    return { stability: 'medium', reason: '纯 class/tag 选择器（改版易变）', suggestion: '若无可改属性，配合文本/计数断言，并准备 Healer 兜底' };
  }
  return { stability: 'medium', reason: '混合选择器，按具体结构判断', suggestion: '优先稳定信号属性' };
}

/* 从一段功能描述里猜意图（出现提示词 → 推断言模板） */
function inferIntent(text) {
  const t = String(text || '').toLowerCase();
  const intents = [];
  if (/提交|保存|发布|send|submit|save/.test(t)) intents.push('submit');
  if (/成功|完成|done|success|ok/.test(t)) intents.push('success');
  if (/错误|失败|报错|error|fail/.test(t)) intents.push('error');
  if (/列表|表格|list|table|项/.test(t)) intents.push('list');
  if (/打开|弹窗|显示|出现|open|show|modal/.test(t)) intents.push('appear');
  if (/消失|关闭|隐藏|close|hide|disappear/.test(t)) intents.push('disappear');
  if (/加载|loading|转圈|spinner/.test(t)) intents.push('loading');
  if (/跳转|导航|route|navigate|goto/.test(t)) intents.push('navigate');
  return intents;
}

/* 核心：为一个功能点推荐选择器 + 断言模板 + 陷阱提醒 */
function recommendForFeature(feature) {
  const f = typeof feature === 'string' ? { name: feature } : (feature || {});
  const text = [f.id, f.name, f.desc, f.description].filter(Boolean).join(' ');
  const intents = inferIntent(text);
  const caveats = [];
  const asserts = [];

  // 通用：出现型
  if (intents.includes('appear') || intents.includes('success') || intents.includes('list')) {
    asserts.push({ sel: '<稳定选择器>', min: 1, desc: '目标元素出现（用 data-testid/aria-label，勿用哈希 class）' });
  }
  if (intents.includes('submit') || intents.includes('success')) {
    asserts.push({ includes: '<成功/已保存等稳定文案>', desc: '状态文案变更（AI 功能不要断言具体生成文字，只断言界面状态）' });
  }
  if (intents.includes('error')) {
    asserts.push({ notSel: '.error,.err,[role="alert"]', desc: '无错误遮罩（v-show 仅隐藏时改用 getComputedStyle(x).display===\'none\' 判稳）' });
  }
  if (intents.includes('disappear') || intents.includes('loading')) {
    asserts.push({ eval: "getComputedStyle(document.querySelector('<遮罩sel>')||document.body).display==='none'", desc: '遮罩/loading 已消失（遮罩拦截 26.5%：只隐藏不移除，notSel 会误判）' });
    caveats.push('遮罩拦截（坑库 Top1，120 命中）：断言遮罩消失用 computed display，而非 notSel；点击前先等遮罩清除或用遮挡自愈。');
  }
  if (intents.includes('list')) {
    asserts.push({ sel: '<列表项sel>', min: 1, desc: '列表至少一项（用稳定列表项锚点，避免 nth-child）' });
  }
  if (intents.includes('navigate')) {
    asserts.push({ eval: "location.pathname.includes('<期望路径片段>')", desc: '已跳转到期望路由' });
  }

  // 通用陷阱（断言语义 10.4%）
  caveats.push('异步渲染：断言前用 waitSel/wait 等元素真出现，别在弹窗未关时就断言（时序场景把 assert 嵌进 steps 中部）。');
  caveats.push('不要断言框架内部变量/闭包状态；只断言可观测的 DOM/文案/控制台。');
  caveats.push('选择器精度 25.9%：优先 clickText（文字稳），少用 clickSel；同名多按钮用 nth 或先 exec 定位再精确点。');

  return {
    feature: f.id || f.name || '(未命名功能)',
    intent: intents,
    selectorHints: SIGNAL_PRIORITY.map(x => x.label),
    asserts,
    caveats,
  };
}

/* 解析 HTML，抽取可锚定的稳定元素 */
function scanHtml(html, hints) {
  const hintsArr = String(hints || '').split(/[,，\s]+/).filter(Boolean).map(h => h.toLowerCase());
  const tagRe = /<([a-zA-Z][\w-]*)\b([^>]*)>/g;
  const attrRe = /([a-zA-Z_:][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
  const anchors = [];
  let m;
  while ((m = tagRe.exec(html))) {
    const tag = m[1];
    const attrsStr = m[2];
    const attrs = {};
    let am;
    while ((am = attrRe.exec(attrsStr))) {
      attrs[am[1]] = am[3] !== undefined ? am[3] : am[4];
    }
    // 提取标签后紧跟的可见文本（如 <button ...>提交</button> 中的"提交"），用于与中文 hint 匹配
    const afterText = (html.slice(tagRe.lastIndex).match(/^([^<]*)/) || [null, ''])[1].trim();
    const searchText = [attrs['data-testid'], attrs['aria-label'], attrs['title'], tag, afterText].filter(Boolean).join(' ').toLowerCase();
    const matched = hintsArr.length === 0 || hintsArr.some(h => searchText.includes(h));
    if (!matched) continue;
    let suggestedSel = null, kind = null;
    if (attrs['data-testid']) { suggestedSel = `[data-testid="${attrs['data-testid']}"]`; kind = 'data-testid'; }
    else if (attrs['aria-label']) { suggestedSel = `[aria-label="${attrs['aria-label']}"]`; kind = 'aria-label'; }
    else if (attrs['role']) { suggestedSel = `[role="${attrs['role']}"]`; kind = 'role'; }
    else if (attrs.id && !/^[0-9]/.test(attrs.id)) { suggestedSel = '#' + attrs.id; kind = 'id'; }
    else if (attrs.class) {
      const c = String(attrs.class).split(/\s+/).find(c => !/^_|^[a-f0-9]{4,}/.test(c));
      if (c) { suggestedSel = '.' + c; kind = 'class(谨慎)'; }
    }
    if (!suggestedSel) continue;
    anchors.push({
      tag,
      kind,
      suggestedSel,
      sampleAssert: { sel: suggestedSel, min: 1, desc: `出现 <${tag}>（${kind}）` },
      rawAttrs: attrs,
    });
  }
  return anchors;
}

/* ── CLI ── */
function main() {
  const args = process.argv.slice(2);
  const opt = { feature: null, html: null, hints: null, sel: null, json: false, type: 'ui' };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--feature') opt.feature = args[++i];
    else if (a === '--html') opt.html = args[++i];
    else if (a === '--hints') opt.hints = args[++i];
    else if (a === '--sel') opt.sel = args[++i];
    else if (a === '--type') opt.type = args[++i];
    else if (a === '--json') opt.json = true;
  }

  if (opt.sel) {
    const r = classifySelector(opt.sel);
    if (opt.json) return console.log(JSON.stringify(r, null, 2));
    console.log(`选择器: ${opt.sel}\n稳定性: ${r.stability}\n${r.reason}${r.suggestion ? '\n建议: ' + r.suggestion : ''}`);
    return;
  }

  if (opt.html) {
    let html;
    try { html = fs.readFileSync(path.resolve(opt.html), 'utf8'); }
    catch (e) { console.error('无法读取 HTML 文件: ' + e.message); process.exit(2); }
    const anchors = scanHtml(html, opt.hints);
    if (opt.json) return console.log(JSON.stringify({ anchors }, null, 2));
    console.log(`\n=== HTML 扫描：找到 ${anchors.length} 个可锚定稳定元素 ===`);
    for (const a of anchors) {
      console.log(`\n[${a.kind}] <${a.tag}>`);
      console.log('  选择器: ' + a.suggestedSel);
      console.log('  断言模板: ' + JSON.stringify(a.sampleAssert));
    }
    if (!anchors.length) console.log('未发现带 data-testid/aria-label/role/id 的元素；建议让开发给关键节点加 data-testid，再跑本向导。');
    return;
  }

  if (opt.feature) {
    const r = recommendForFeature({ name: opt.feature, type: opt.type });
    if (opt.json) return console.log(JSON.stringify(r, null, 2));
    console.log(`\n=== 功能断言向导：${r.feature} ===`);
    console.log('识别意图: ' + (r.intent.join(', ') || '(通用)'));
    console.log('\n推荐稳定信号优先级: ' + r.selectorHints.join(' > '));
    console.log('\n断言模板（粘进 spec.features[].asserts）:');
    for (const a of r.asserts) console.log('  ' + JSON.stringify(a));
    console.log('\n⚠️ 编写陷阱提醒:');
    for (const c of r.caveats) console.log('  - ' + c);
    return;
  }

  console.error('用法:\n  node assert-wizard.cjs --feature "F01:点提交后应有成功提示"\n  node assert-wizard.cjs --html page.html --hints "提交,成功"\n  node assert-wizard.cjs --sel ".e2d9f3.btn"');
  process.exit(2);
}

if (require.main === module) main();
module.exports = { classifySelector, recommendForFeature, scanHtml, inferIntent, SIGNAL_PRIORITY };
