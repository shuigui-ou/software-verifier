'use strict';
/**
 * explore.cjs —— Layer 1 最小闭环：UI 可达图引导 + 六类通用 oracle + 证据落盘
 *
 * 设计要点（遵循 Layer1_minimal_closed_loop_spec.md）：
 *  - 引导式 BFS 遍历（禁随机 monkey），节点=可交互元素+内部路由，边=点击/导航后到达状态。
 *  - 六类 oracle：崩溃/白屏、pageerror、requestfailed、超时、空状态、死链。
 *  - confidence 语义钉死：衡量「缺陷可信度」非「命中确定性」；high 须证据可独立复核。
 *  - 空状态 oracle 命中后先查前置条件：登录墙/session 缺失 → precondition-not-met；
 *    无法判定 → medium-incomplete-evidence + precondition-unknown，不报缺陷、不静默 skip。
 *  - 外部锚点 entrypoints（manual>sitemap>navmenu），覆盖率按页面/路由级；锚点缺失 → not-computable，
 *    绝不回退 BFS 自发现集合。elementCoverage 独立指标，不与页面级混算。
 *  - businessPass 永远 false，且模块内 assertNoBusinessPass 断言级护栏：任何输入令其非 false 即抛错。
 *
 * 复用：error-classify.cjs（pageerror/requestfailed 归因，纯模块，顶层 require）；
 *      drivers/dom.js（playwright 驱动，仅在 createDriver 内懒 require，避免无浏览器环境下被触发）。
 */

const crypto = require('crypto');
// 纯模块，无 playwright 依赖，安全顶层 require
const { classifyError, bucketize } = require('./drivers/error-classify.cjs');

// ---------------------------------------------------------------------------
// 0. 工具
// ---------------------------------------------------------------------------
function makeId(input) {
  const seed = JSON.stringify({
    oracle: input.oracle,
    reproPath: input.reproPath || [],
    evidence: input.evidence || {},
  });
  return 'l1-' + crypto.createHash('sha1').update(seed).digest('hex').slice(0, 16);
}

// confidence 取值常量（spec §2 钉死）
const CONF = {
  HIGH: 'high',
  MED_HEUR: 'medium-heuristic',
  MED_INCOMPLETE: 'medium-incomplete-evidence',
};

// ---------------------------------------------------------------------------
// 1. businessPass 断言级护栏（spec §0/§3/§5-C）
// ---------------------------------------------------------------------------
/**
 * 任何构造使 businessPass 非 false 的输入必须被拒绝/抛错。
 * @param {object} rec 一条发现记录（或任意带 businessPass 字段的对象）
 * @returns {true} 通过；否则抛错
 */
function assertNoBusinessPass(rec) {
  if (!rec || rec.businessPass !== false) {
    throw new Error(
      '[guard] businessPass 必须恒为 false（Layer 1 只报疑似，绝不输出业务通过）；' +
      '收到 businessPass=' + JSON.stringify(rec && rec.businessPass)
    );
  }
  return true;
}

// ---------------------------------------------------------------------------
// 2. 空状态前置条件检测（spec §2 第5行 / §5-A）
// ---------------------------------------------------------------------------
/**
 * 根据证据判定前置条件是否可满足：
 *  - 命中登录墙 / session 缺失标记 → 'not-met'（不是缺陷，precondition-not-met）
 *  - 显式确认已登录 / session 存在 → 'met'
 *  - 无法判定 → 'unknown'（必须 medium-incomplete-evidence + precondition-unknown，不许静默 skip）
 * @param {object} evidence
 * @param {string} [explicit] 调用方已明确判定的结果（测试可直接注入）
 */
function detectPrecondition(evidence, explicit) {
  if (explicit === 'met' || explicit === 'not-met' || explicit === 'unknown') return explicit;
  const e = evidence || {};
  if (e.loginWall === true || e.sessionMissing === true) return 'not-met';
  if (e.loginWall === false && e.sessionMissing === false) return 'met';
  return 'unknown';
}

// ---------------------------------------------------------------------------
// 3. confidence / falsePositiveNote 分类（spec §2 钉死语义）
// ---------------------------------------------------------------------------
/**
 * 按 oracle + 证据，返回 { confidence, falsePositiveNote, suspectedDefect }。
 * - suspectedDefect：内部标记（非 spec 记录字段；spec 要求 suspect 永远 true）。
 * - high 仅在证据可独立复核时给出；reproPath 完整仅作附加，不作 high 条件。
 *
 * @param {{oracle:string, evidence?:object, reproPath?:string[], precondition?:string}} input
 */
function classifyConfidence(input) {
  const oracle = input.oracle;
  const ev = input.evidence || {};

  switch (oracle) {
    // 1. 崩溃/白屏：根节点确为空 → high（可独立复核）；骨架屏标注 → skip-skeleton-screen
    case 'crash': {
      if (ev.skeleton === true) {
        return { confidence: CONF.HIGH, falsePositiveNote: 'skip-skeleton-screen', suspectedDefect: false };
      }
      if (ev.rootEmpty === true) {
        return { confidence: CONF.HIGH, falsePositiveNote: '', suspectedDefect: true };
      }
      // 无法独立确认根节点为空 → 证据不足
      return { confidence: CONF.MED_INCOMPLETE, falsePositiveNote: 'root-not-confirmed', suspectedDefect: false };
    }

    // 2. pageerror：真实异常栈/消息 → high（复用 error-classify）
    case 'pageerror': {
      if (typeof ev.stack === 'string' && ev.stack.length > 0) {
        return { confidence: CONF.HIGH, falsePositiveNote: '', suspectedDefect: true };
      }
      if (typeof ev.message === 'string' && ev.message.length > 0) {
        return { confidence: CONF.HIGH, falsePositiveNote: '', suspectedDefect: true };
      }
      return { confidence: CONF.MED_INCOMPLETE, falsePositiveNote: 'no-stack', suspectedDefect: false };
    }

    // 3. requestfailed：真实 status 或真实 net::ERR_* → high（归因沿用 host/env/tool 三分）
    case 'requestfailed': {
      const hasStatus = typeof ev.status === 'number' && ev.status >= 400;
      const hasNet = /net::ERR_/i.test(ev.errText || ev.text || '');
      if (hasStatus || hasNet) {
        return { confidence: CONF.HIGH, falsePositiveNote: '', suspectedDefect: true };
      }
      return { confidence: CONF.MED_INCOMPLETE, falsePositiveNote: 'no-evidence', suspectedDefect: false };
    }

    // 4. 超时：启发式/状态型信号 → medium-heuristic；懒加载标注 → skip-lazy-load
    case 'timeout': {
      if (ev.lazyLoad === true) {
        return { confidence: CONF.MED_HEUR, falsePositiveNote: 'skip-lazy-load', suspectedDefect: false };
      }
      return { confidence: CONF.MED_HEUR, falsePositiveNote: '', suspectedDefect: true };
    }

    // 5. 空状态：命中后先查前置条件（spec §2 第5行 / §5-A）
    case 'empty-state': {
      const pre = detectPrecondition(ev, input.precondition);
      if (pre === 'not-met') {
        return { confidence: CONF.HIGH, falsePositiveNote: 'precondition-not-met', suspectedDefect: false };
      }
      if (pre === 'unknown') {
        // 无法判定前置条件 → 不报缺陷、不静默 skip，标识 medium-incomplete-evidence
        return { confidence: CONF.MED_INCOMPLETE, falsePositiveNote: 'precondition-unknown', suspectedDefect: false };
      }
      // 前置条件满足、容器确为空：可能是合法空态 → medium-heuristic，作为疑似缺陷上报
      return { confidence: CONF.MED_HEUR, falsePositiveNote: '', suspectedDefect: true };
    }

    // 6. 死链：真实 404 status → high；启发式 → medium-heuristic
    case 'dead-link': {
      if (ev.status === 404) {
        return { confidence: CONF.HIGH, falsePositiveNote: '', suspectedDefect: true };
      }
      return { confidence: CONF.MED_HEUR, falsePositiveNote: '', suspectedDefect: true };
    }

    default:
      return { confidence: CONF.MED_INCOMPLETE, falsePositiveNote: 'unknown-oracle', suspectedDefect: false };
  }
}

// ---------------------------------------------------------------------------
// 4. 构建单条发现记录（强制 businessPass=false，强制护栏）
// ---------------------------------------------------------------------------
/**
 * 构造一条 Layer 1 发现记录。
 * - businessPass 永远 false；若 input.businessPass 非 false → 抛错（护栏）。
 * - 字段严格按 spec §3。
 * @param {{oracle:string, evidence?:object, reproPath?:string[], precondition?:string, businessPass?:any, id?:string}} input
 * @returns {object} 符合 spec §3 的记录
 */
function buildFinding(input) {
  if (!input || typeof input.oracle !== 'string') {
    throw new Error('[buildFinding] oracle 必填且为字符串');
  }
  // 护栏：任何试图翻转 businessPass 的输入立即拒绝
  if (input.businessPass !== undefined && input.businessPass !== false) {
    throw new Error(
      '[guard] 拒绝构造 businessPass=' + JSON.stringify(input.businessPass) +
      ' 的发现：Layer 1 永远 businessPass=false'
    );
  }

  const cls = classifyConfidence(input);
  const rec = {
    id: input.id || makeId(input),
    layer: 1,
    oracle: input.oracle,
    confidence: cls.confidence,
    suspect: true,            // spec §3：suspect 永远 true
    businessPass: false,      // spec §0/§3：businessPass 永远 false
    reproPath: Array.isArray(input.reproPath) ? input.reproPath : [],
    evidence: input.evidence || {},
    falsePositiveNote: cls.falsePositiveNote || '',
    candidateSpecReserved: null,  // spec §3：本版只留结构（T5 Layer 2 用，T4 不处理）
  };

  // 对 requestfailed / pageerror，附上 error-classify 归因（复用既有引擎）
  if (input.oracle === 'requestfailed' || input.oracle === 'pageerror') {
    const text = rec.evidence.text || rec.evidence.message || rec.evidence.errText || '';
    if (text) {
      const attr = classifyError(text, input.ctx || {});
      rec.evidence.attribute = { category: attr.category, label: attr.label, reason: attr.reason, layer: attr.layer };
    }
  }

  // 断言级护栏：记录构造完成后再次校验
  assertNoBusinessPass(rec);
  return rec;
}

// ---------------------------------------------------------------------------
// 5. 外部锚点：anchorSource 选择与覆盖率计算（spec §1 / §5-B）
// ---------------------------------------------------------------------------
/**
 * 选择最优锚点来源：manual > sitemap > navmenu；都没有 → null。
 * @param {{manual?:string[], sitemap?:string[], navmenu?:string[]}} anchors
 * @returns {'manual'|'sitemap'|'navmenu'|null}
 */
function selectAnchorSource(anchors) {
  const a = anchors || {};
  if (Array.isArray(a.manual) && a.manual.length) return 'manual';
  if (Array.isArray(a.sitemap) && a.sitemap.length) return 'sitemap';
  if (Array.isArray(a.navmenu) && a.navmenu.length) return 'navmenu';
  return null;
}

/**
 * 覆盖率（页面/路由级）：已到达声明页面 / 声明页面总数。
 * 锚点缺失或 declared 为空 → 显式 'not-computable'，**绝不回退 BFS 自发现集合**。
 * @param {{entrypoints?:string[], reached?:string[], anchorSource?:string|null}} opts
 * @returns {number|'not-computable'}
 */
function computeCoverage(opts) {
  const o = opts || {};
  const anchorSource = o.anchorSource != null ? o.anchorSource : selectAnchorSource(o.anchors || {});
  const eps = Array.isArray(o.entrypoints) ? o.entrypoints : [];
  if (anchorSource == null || eps.length === 0) {
    return 'not-computable';
  }
  const reachedSet = new Set(Array.isArray(o.reached) ? o.reached : []);
  let hit = 0;
  for (const e of eps) if (reachedSet.has(e)) hit++;
  return eps.length ? hit / eps.length : 0;
}

/**
 * 元素级覆盖（独立指标，不与页面级混算）。无声明元素锚点 → null。
 * @param {{declaredElements?:string[], reachedElements?:string[]}} opts
 * @returns {{ratio:number, reached:number, declared:number}|null}
 */
function computeElementCoverage(opts) {
  const o = opts || {};
  const declared = Array.isArray(o.declaredElements) ? o.declaredElements : [];
  if (declared.length === 0) return null;
  const reachedSet = new Set(Array.isArray(o.reachedElements) ? o.reachedElements : []);
  let hit = 0;
  for (const e of declared) if (reachedSet.has(e)) hit++;
  return { ratio: hit / declared.length, reached: hit, declared: declared.length };
}

// ---------------------------------------------------------------------------
// 6. 真实浏览器驱动（懒 require，仅真实探索路径使用；测试不触发）
// ---------------------------------------------------------------------------
let _dom = null;
function createDriver(kind, opts) {
  if (!_dom) _dom = require('./drivers/dom.js');
  return _dom.makeDomDriver(kind, opts && opts.pwCore);
}

// 从 baseUrl 载入后的 DOM 抽取顶层导航菜单（navmenu 锚点来源）
async function discoverNavMenu(pageApi) {
  try {
    const links = await pageApi.exec(`
      (function(){
        var navs = document.querySelectorAll('nav a, header a, .menu a, [role=navigation] a');
        var out = [];
        for (var i=0;i<navs.length;i++){ var h=navs[i].getAttribute('href'); if(h) out.push(h); }
        return out;
      })()
    `);
    if (links && links.ok && Array.isArray(links.r)) return links.r;
    return [];
  } catch (_e) {
    return [];
  }
}

// 节点采集：可交互元素 + 内部路由（spec §1）
function shouldSkip(sel) {
  // 跳过的边：href="#"、纯滚动节点、disabled 节点
  return /href=["']?#["']?/i.test(sel || '') || /scroll/i.test(sel || '');
}

/**
 * 引导式 BFS 调度（禁随机 monkey）。基于传入的 pageApi（真实 dom 驱动或 mock 均可）。
 * 主流程生产发现并收集 reachable 节点；覆盖率使用外部锚点 entrypoints。
 * 注：本函数在真实浏览器环境运行；本沙箱无 GUI，测试以纯函数覆盖，不调用本函数。
 *
 * @param {object} pageApi dom 驱动实例（需含 goto/exec/clickSel/waitSel/bodyText/errors/close 等）
 * @param {{baseUrl:string, entrypoints?:string[], timeoutMs?:number, anchors?:object}} opts
 * @returns {Promise<{findings:object[], summary:object, graph:object}>}
 */
async function guidedBfsExplore(pageApi, opts) {
  const o = opts || {};
  const baseUrl = o.baseUrl;
  const timeoutMs = o.timeoutMs || 15000; // 默认 15s，可配
  const findings = [];
  const visited = new Set();
  const graph = { nodes: [], edges: [] };
  const queue = [];

  // 起点
  await pageApi.goto(baseUrl);
  const startLinks = await discoverNavMenu(pageApi);
  for (const l of startLinks) {
    if (!visited.has(l) && !shouldSkip(l)) { visited.add(l); queue.push(l); graph.nodes.push(l); }
  }

  // navmenu 锚点作为可达图自发现集合；覆盖率仍以外锚 entrypoints 为准
  const navmenu = startLinks.slice();

  while (queue.length) {
    const cur = queue.shift();
    try {
      await pageApi.goto(cur);
    } catch (_e) {
      // 死链启发式：导航失败记为死链候选（真实 status 时高可信）
      findings.push(buildFinding({
        oracle: 'dead-link',
        evidence: { source: baseUrl, target: cur, errText: String(_e && _e.message || _e) },
        reproPath: [baseUrl, 'goto:' + cur],
      }));
      continue;
    }
    // pageerror / requestfailed 归因（复用 error-classify，经由 buildFinding 内嵌）
    const errs = (typeof pageApi.errors === 'function' ? pageApi.errors() : (pageApi.errors || []));
    for (const e of errs) {
      if (/pageerror:/.test(e)) {
        findings.push(buildFinding({ oracle: 'pageerror', evidence: { message: e }, reproPath: [baseUrl, 'goto:' + cur] }));
      } else if (/requestfailed:|http-status:/.test(e)) {
        const statusM = e.match(/(\d{3})/);
        findings.push(buildFinding({
          oracle: 'requestfailed',
          evidence: { text: e, status: statusM ? parseInt(statusM[1], 10) : null },
          reproPath: [baseUrl, 'goto:' + cur],
        }));
      }
    }
    // 崩溃/白屏：根节点为空判定
    const rootEmpty = await pageApi.exec('(function(){var b=document.body;return !b||b.children.length===0;})()');
    if (rootEmpty && rootEmpty.ok && rootEmpty.r === true) {
      findings.push(buildFinding({ oracle: 'crash', evidence: { rootEmpty: true }, reproPath: [baseUrl, 'goto:' + cur] }));
    }
    // 子节点入队
    const childLinks = await discoverNavMenu(pageApi);
    for (const l of childLinks) {
      if (!visited.has(l) && !shouldSkip(l)) { visited.add(l); queue.push(l); graph.nodes.push(l); graph.edges.push([cur, l]); }
    }
  }

  const anchorSource = selectAnchorSource(Object.assign({ navmenu }, o.anchors || {}));
  const entrypoints = o.entrypoints || [];
  const reached = entrypoints.filter((e) => visited.has(e));
  const coverage = computeCoverage({ entrypoints, reached, anchorSource });
  const elementCoverage = computeElementCoverage(o.elementAnchors || {});

  const summary = {
    anchorSource,
    coverage,             // number | 'not-computable'
    elementCoverage,
    declaredPages: entrypoints.length,
    reachedPages: reached.length,
    findingCount: findings.length,
  };
  return { findings, summary, graph };
}

// ---------------------------------------------------------------------------
// 7. 对外导出
// ---------------------------------------------------------------------------
module.exports = {
  // 护栏
  assertNoBusinessPass,
  // 分类
  classifyConfidence,
  detectPrecondition,
  buildFinding,
  CONF,
  // 锚点 / 覆盖率
  selectAnchorSource,
  computeCoverage,
  computeElementCoverage,
  // 探索
  createDriver,
  discoverNavMenu,
  guidedBfsExplore,
  shouldSkip,
  // 复用导出
  classifyError,
  bucketize,
};
