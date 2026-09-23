'use strict';
/**
 * evolution-candidate-gen.cjs —— software-verifier 的「生成式」本地候选生成器
 *
 * 为什么需要它（否则 A 方案无效）：
 *   引擎内置的 hostCandidateGenerator 只把信号文本与 seeds/*.jsonl 里 7 条人工骨架做
 *   **字面子串匹配**。新错误文本不含任何骨架 → 永远 no_candidate → 全部转人工 → 知识零增长。
 *   实测：3 条真实错误（resolvePwCore is not defined / playwright-core 硬编码路径 / spawn ENOENT）
 *   全部落到 no_candidate，landed=0。
 *
 *   本文件把宿主【已有】的推断能力（evolve.cjs 的 guessCategory / extractPatterns / inferFix）
 *   接成引擎的候选源：对任意 E 类错误**现场推断**可用解法，产出可落地候选。
 *   不引入任何新依赖，也不改被测软件。
 *
 * 契约（严格对齐 kernel candidates.add()，见 lib/evolution-kernel/src/candidates.cjs:79-114）：
 *   - 只处理 group.type === 'E'；其余类型返回 []（内置生成器同此约定）
 *   - 候选必须带 probe{trigger,judge}：E1 属 L1，缺 probe 会抛 PROBE_REQUIRED
 *   - expected_gain 必须是正数：<=0 会被判噪音、转人工（kernel.cjs 步骤5 收敛判据）
 *   - 全函数 try/catch 包裹：**绝不抛**。add() 会抛，若本函数抛异常会中断整条 runCycle
 *   - 推断结果仍是占位文本时不产候选：宁可不学，也不把「废提示」写进知识面
 *
 * 输入 group 实际字段（kernel signals.cjs:87-109 aggregate）：{fingerprint, type, count, title, ...}
 * —— 注意**没有 detail**，可用的推理输入就是 title。
 */

const path = require('node:path');

// inferFix 兜底文案特征串：命中即视为「没推断出真解法」。运行时首选 evolve.cjs 导出的
// FIX_PLACEHOLDER（单一事实源），此常量仅作 evolve.cjs 未导出时的兜底。
const PLACEHOLDER = '待人工补充解法';

// 领域闸（A 方案的必要条件）。inferFix/guessCategory 的能力域 = 浏览器/DOM 验证类错误，
// 而宿主工具链错误的措辞与之高度同形（例：not found 既指 selector 未出现、也指依赖路径缺失），
// 直接套用会产出「看似合理但错误」的解法 —— 写进知识面比不写更糟。
// 故：带工具链特征 → 不产候选；不带验证域特征 → 不产候选；两者皆无歧义才产候选。
//
// 【v1.2.7 单一事实源】DOMAIN_MARKERS 不再硬编码：由 evolve.cjs 的 FIX_BRANCHES[].gate
// （省略 gate 时 = keywords）在 loadInference() 内派生 —— 往表里加一个分支，闸自动同步扩展
// （"会不会自动开"在机制上成立，不再依赖人工记得改两处）。设计细节：
//   - 派生放 loadInference() 而非模块顶层：保住「evolve.cjs 加载失败时本文件仍可被 require」的弹性；
//   - 旧硬编码清单中不 backed by 任何分支的词（locator/selector/data-testid/eval(/assert/
//     visible/hidden/frame/includes/indexof 等）已随之移除：它们只负责放行文本，inferFix
//     无分支可匹配时最终仍死于 placeholder 检查 —— 属死权重，只会把 lastReason 从
//     blocked:out-of-domain 误标成 no-inference(placeholder)；
//   - 'not clickable' 由 'clickable' 子串覆盖，无召回损失。
const HOST_TOOLCHAIN = [
  'enoent', 'eaddrinuse', 'module_not_found', 'cannot find module', 'eacces',
  'spawn', 'command not found', 'playwright-core', 'npm err', 'no such file',
  'tunnel', '502',
];
// 保守收益：低于种子精确命中（0.3），但必须 >0 才可能被 selectTop 选中
const DEFAULT_GAIN = 0.15;

/** 懒加载宿主推断函数（模块级 require 失败也不影响本文件被加载） */
function loadInference() {
  const m = require(path.join(__dirname, 'evolve.cjs'));
  if (typeof m.inferFix !== 'function' || typeof m.guessCategory !== 'function') {
    throw new Error('evolve.cjs 未导出 inferFix/guessCategory');
  }
  return {
    guessCategory: m.guessCategory,
    extractPatterns: typeof m.extractPatterns === 'function' ? m.extractPatterns : () => [],
    inferFix: m.inferFix,
    anonymize: typeof m.anonymize === 'function' ? m.anonymize : (s) => String(s || ''),
    matchPitfall: typeof m.matchPitfall === 'function' ? m.matchPitfall : () => null,
    loadPitfalls: typeof m.loadPitfalls === 'function' ? m.loadPitfalls : () => [],
    // 领域闸清单：由 FIX_BRANCHES[].gate（省略时 = keywords）派生，单一事实源（见文件头注释）。
    domainMarkers: Array.isArray(m.FIX_BRANCHES)
      ? [...new Set(m.FIX_BRANCHES.flatMap((b) => (Array.isArray(b.gate) ? b.gate : (b.keywords || []))).filter(Boolean))]
      : [],
    placeholder: typeof m.FIX_PLACEHOLDER === 'string' && m.FIX_PLACEHOLDER ? m.FIX_PLACEHOLDER : PLACEHOLDER,
  };
}

/**
 * 最近一次 generate() 的处置原因（可观测性：把「为什么没学到」从黑箱变成可查）。
 * 取值：landed / already-known:<id> / blocked:host-toolchain / blocked:out-of-domain
 *      / no-inference(placeholder) / skipped:type / skipped:empty / error
 */
let lastReason = '';
generate.lastReason = () => lastReason;

/**
 * 本地候选生成器（引擎注入签名：(group) => Promise<candidate[]>）
 * @param {object} group - 聚合信号组 {fingerprint, type, count, title}
 * @returns {Promise<object[]>} 合法候选数组；任何异常都返回 []
 */
async function generate(group) {
  const out = [];
  lastReason = '';
  try {
    if (!group || group.type !== 'E') { lastReason = 'skipped:type'; return out; }
    const raw = String(group.title || '').trim();
    if (!raw) { lastReason = 'skipped:empty'; return out; }

    const { guessCategory, extractPatterns, inferFix, anonymize, matchPitfall, loadPitfalls, domainMarkers, placeholder } = loadInference();

    // 关键：领域判定与推断都基于【原文】raw，不能用脱敏后的文本。
    // 实测踩坑：anonymize 会把 inferFix 赖以匹配的关键词一起抹掉
    // （classList.contains('on') → x<str>on，'classlist' 分支永不命中 → 只剩占位解法）。
    // 故 raw 只用于「判断 + 推断」，ae 用于「落盘内容 / 共享语料」。
    const lower = raw.toLowerCase();
    if (HOST_TOOLCHAIN.some((k) => lower.indexOf(k) >= 0)) { lastReason = 'blocked:host-toolchain'; return out; }
    if (!domainMarkers.some((k) => lower.indexOf(String(k).toLowerCase()) >= 0)) { lastReason = 'blocked:out-of-domain'; return out; }

    const ae = String(anonymize(raw));          // 落盘用：与宿主坑库同一套脱敏口径

    // 已知即不学（与宿主 evolve.cjs runEvolution 同口径：脱敏文本 × 脱敏 patterns）。
    // 宿主机坑库已收录该失败模式时，engine 再落地一次只是【复述已有知识】——
    // 会把 landed 数抬高，但软件并不会因此变强。宁可 lastReason 如实记 already-known，
    // 也不制造"跑完有改进"的假象。
    try {
      const known = matchPitfall(ae, loadPitfalls());
      if (known) { lastReason = 'already-known:' + (known.id || '?'); return out; }
    } catch (_e) { /* 坑库不可读时不阻断：按未知识别，宁可学也不静默丢 */ }

    const category = guessCategory(raw);
    const patterns = extractPatterns(raw);
    const fix = String(inferFix(category, raw, patterns) || '');

    // 质量闸：占位解法不入库
    if (!fix || fix.indexOf(placeholder) >= 0 || fix.indexOf(PLACEHOLDER) >= 0) { lastReason = 'no-inference(placeholder)'; return out; }

    out.push({
      title: '推断解法：' + (category || '未分类') + ' — ' + ae.slice(0, 60),
      content: [
        '类别：' + category,
        '症状：' + ae,
        '推断解法：' + fix,
        '命中模式：' + patterns.join(' / '),
        '来源：software-verifier 本地推断（evolve.cjs inferFix@64）',
      ].join('\n'),
      unit: 'E1',
      expected_gain: DEFAULT_GAIN,
      category,
      source: 'host-infer',
      // L1 候选必填：生效判据
      probe: {
        trigger: patterns[0] || ae.slice(0, 36),
        judge: '同一失败模式在后续运行中不再复现（该 pattern 不再命中）',
      },
    });
    lastReason = 'landed';
  } catch (e) {
    // fail-open：推断层任何故障都不得中断宿主 runCycle
    lastReason = 'error:' + String((e && e.message) || e).slice(0, 60);
    return [];
  }
  return out;
}

module.exports = generate;
module.exports.generate = generate;
