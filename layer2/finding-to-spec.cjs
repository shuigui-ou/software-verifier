'use strict';
// T7 confirmed finding → Layer 3 regression spec 翻译器 —— 闭环最后一段：把已确认缺陷变成可执行回归断言。
// 物理隔离于 drivers/、evolution/；不接入 T4 状态机模块、不读其任何判定函数；只读 findings 落盘，只写 Layer 3 spec 目录。
// 设计要点（逐条对齐规格定稿）：
//  - 维度一 = oracle 类别（explore.cjs 六类，逐类枚举，不留「等」）；维度二 = 是否存在可构造确定性断言的最小结构化字段，
//    **不看 evidence 是否 prose**（否则会误杀「oracle 自带字段 + reproPath 可构造断言」的 case）。
//  - 可译性按 oracle 分档，不是统一松紧：requestfailed/dead-link/crash 靠自带 url/href/rootEmpty 即可独立构造断言，**不要求重放路径**；
//    pageerror/timeout/empty-state 的断言天然依赖「在哪个操作序列下检查」，故需 reproPath/target/阈值/前置条件之一兜底。
//    两档松紧不同是有意的设计要求，不是例外。
//  - not-translatable 一律不强行造 spec，只带 reason 留在 findings 人审队列。
//  - 幂等 = 原地更新（去重键 originFindingId），**不新建第二条**；历史版本摘要进 prevTranslations，updatedAt 每次刷新。
//  - 每次 emit 跑完与当前 confirmed 集合对账：不再 confirmed → deprecated；回到 confirmed → 恢复并追加 prevTranslations。
//    对账**只读** reviewStatus 字段：不改 findings、不做状态判定。
//  - 回归回流上限 MAX_REGRESSION_LOOP=3，达上限标 loopExhausted 强制人审；deprecated 与 loopExhausted 任一为真则不再自动回流。
//  - reopened candidate 只按规格字段表产出**纯对象**（references / proposedStatus / generator / referencedFindings / outcome），
//    candidateConfidence / humanReviewRequired / basis 一律**不手填**，由 T5 侧算。generator 必须落在确定性前缀白名单，
//    绝不用 model:*（回归复现是确定性事实，不是模型推断）。
//  - **outcome 归属写死**：T7 绝不判真伪。自动流程不传第三参 → outcome=null（只报「回归失败了」，不报「复发还是合法变更」），
//    人审判定后才带 recurrence / legitimate-change。非法 outcome 一律抛错，不静默降级当未判定
//    （静默降级会把「还没判定」误记成「已判定」，是语义洞而不是宽容）。
//  - **未判定时不主张状态**：outcome 为空时 proposedStatus 一律 null，绝不是 confirmed。填 confirmed 等于自动流程
//    预设「这是真复发」，与上面「outcome 归人审」自相矛盾；且未判定记录若照旧走候选链，会走成 confirmed→confirmed
//    自环空转，正好把「复发没留痕」这个已知缺口盖住。null 会被 T5 侧候选构造的状态校验当场拦下抛错 ——
//    未判定记录**天然进不了 T5**，不必靠约定拦。
//  - **未判定的去处 = T7 自己的待判定队列**（不进 T5 的人审队列：那里要求先构造合法候选，未判定时构造不出）：
//    回归失败被计数即开条目（spec 上 needsOutcomeJudgement），人审界面消费该队列、读 pendingOutcomeCandidate 判
//    recurrence / legitimate-change；判定后条目出队。人审不可省略 —— 本模块只出指引，不兜底代判。
//  - **回流计数不等判定**：regressionLoopCount 每次回归失败即递增（noteRegressionFailure 负责），因为限流是 spec 自身的
//    稳定性问题，与人审判定无关（否则「一直失败但没人审」的 spec 永远不被限流）。人审判定 recurrence 时**复用**
//    失败时已记的次数，不重复递增（一次失败只能记一次数，否则回流次数虚增）。
//  - 两条路径按 outcome 分派（堵「合法变更信息丢失」）：
//    · recurrence（真复发）→ 产出候选输入交 T5 侧走候选分级 + 应用链；spec 回流计数递增，达上限标 loopExhausted。
//      已知边界：状态自环不刷新审计，**复发痕迹只活在 spec 的回流计数上**，findings 侧不留痕（本轮不修，见规格已知边界节）。
//    · legitimate-change（合法变更）→ **不投候选应用链**（该链对 ignored 一律拦截，投进去会落回人审队列形成死循环），
//      只产出**人审动作指引**（把 finding 置为 ignored + 记录人审来源 + spec 标废弃），由人审界面调用状态机执行。
//      本模块只产出指令、不自己执行 —— 保持对状态机模块的零依赖（源码静态零命中）。
//  - **合法变更的状态变更属人审侧**：本模块**不调用状态机**，只产出指引对象 { nextAction, targetStatus, judgmentSource }。
//    对外措辞一律「人审界面调用」，禁止写成「本模块调用」。
//  - **待判定队列：本轮只产出，无消费方实现**。T7 落盘队列条目（spec 上 needsOutcomeJudgement + 待判定候选输入），
//    并提供 listPendingOutcomeJudgements 供外部拉取列表；**当前没有任何消费方实现** —— 消费方在「人审界面 / 人审流程侧」，
//    不在 T7 内。未来形态（独立 CLI、MCP 工具、或并入既有评审界面）**本轮不选型**（无真实人审流程可对齐，凭空选型是臆造）。
//    未消费时队列只增不减，需人工直接翻 spec 文件。**任何材料都不得声称「T7 已提供人审工作流」。**
//  - **finding 离开 confirmed 时，待判定条目同次出队**：对账标废弃的同一次写入里一并清 needsOutcomeJudgement +
//    清空待判定候选（与 applyHumanOutcome 正常出队同一口径），否则人审界面会看到「已废弃的 spec 上还挂着待判定条目」
//    的僵尸项（finding 都不 confirmed 了，这条断言已失效，再让人审去判是浪费且误导）。
//    spec 文件**保留不删**：deprecated 的 spec 是回归历史的一部分，删除会破坏 prevTranslations 版本链与 G13/G14 的对照验证。
//  - **反向恢复不复活队列**：finding 回到 confirmed 只恢复 deprecated 标记，回流计数保持原值、待判定标记保持 false，
//    **不重新入队** —— 失败事实不因状态恢复而消失或重现。

const fs = require('fs');
const path = require('path');

// 回流次数上限（规格 §3.4）：同 originFindingId 达此值仍失败 → 不再自动 reopen，强制人审
const MAX_REGRESSION_LOOP = 3;

// 六类 oracle 分档（对照 explore.cjs 的六类分类，不留「等」）
// 无条件可译档：靠 oracle 自带结构化字段即可独立构造断言
const TRANSLATABLE_ORACLES = ['requestfailed', 'dead-link', 'crash', 'pageerror'];
// 条件可译档：断言依赖阈值或前置条件，前置不满足即 not-translatable
const CONDITIONAL_ORACLES = ['timeout', 'empty-state'];
const ALL_ORACLES = TRANSLATABLE_ORACLES.concat(CONDITIONAL_ORACLES);

// oracle → 回归断言类型（规格 §5，一一对应，无兜底默认）
const ASSERTION_BY_ORACLE = {
  requestfailed: 'status-2xx',
  'dead-link': 'href-200',
  crash: 'root-nonempty',
  pageerror: 'no-pageerror',
  timeout: 'completes-within-ms',
  'empty-state': 'container-nonempty',
};

// oracle 自带结构化字段（维度二来源 1）。timeout 的「阈值 N」单独判定（阈值来源面更宽）
const ORACLE_SELF_FIELDS = {
  requestfailed: ['url', 'requestUrl'],
  'dead-link': ['href', 'link'],
  crash: ['rootEmpty'],
  pageerror: ['message', 'stack'],
  timeout: [],
  'empty-state': ['hasData', 'dataPresent', 'expectedData', 'hasRecords'],
};

// timeout 阈值字段名（evidence 上或 finding 上任一命中即算有阈值 N）
const THRESHOLD_FIELDS = ['thresholdMs', 'timeoutMs', 'maxMs', 'expectedMs', 'threshold'];

const DEPRECATE_REASON_NO_LONGER_CONFIRMED = 'finding-no-longer-confirmed';

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------
function isNonEmpty(v) {
  if (v == null) return false;
  if (typeof v === 'string') return v.trim().length > 0;
  if (typeof v === 'number') return Number.isFinite(v);
  if (typeof v === 'boolean') return v === true;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v).length > 0;
  return false;
}

function evidenceOf(finding) {
  const ev = finding && finding.evidence;
  return ev && typeof ev === 'object' && !Array.isArray(ev) ? ev : {};
}

function reproPathOf(finding) {
  const rp = finding && finding.reproPath;
  return Array.isArray(rp) ? rp.filter((s) => isNonEmpty(s)) : [];
}

function targetOf(finding) {
  const t = finding && finding.target;
  return isNonEmpty(t) ? String(t) : null;
}

/** 断言锚点：finding.target 优先，其次 oracle 自带 url/href，最后锚在 reproPath 最后一步 */
function resolveTarget(finding) {
  const direct = targetOf(finding);
  if (direct) return direct;
  const ev = evidenceOf(finding);
  if (isNonEmpty(ev.url)) return String(ev.url);
  if (isNonEmpty(ev.href)) return String(ev.href);
  const rp = reproPathOf(finding);
  if (rp.length) return String(rp[rp.length - 1]);
  return null;
}

function pickEvidenceField(finding, keys) {
  const ev = evidenceOf(finding);
  for (const k of keys) {
    if (isNonEmpty(ev[k])) return ev[k];
  }
  return null;
}

/** timeout 阈值 N：evidence 优先（可在 expected 嵌套里），其次 finding 同名字段；找不到返回 null */
function resolveThreshold(finding) {
  const keys = THRESHOLD_FIELDS;
  const ev = evidenceOf(finding);
  for (const k of keys) {
    if (isNonEmpty(ev[k]) && Number.isFinite(Number(ev[k]))) return Number(ev[k]);
  }
  const nested = ev.expected && typeof ev.expected === 'object' ? ev.expected : null;
  if (nested) {
    for (const k of keys) {
      if (isNonEmpty(nested[k]) && Number.isFinite(Number(nested[k]))) return Number(nested[k]);
    }
  }
  for (const k of keys) {
    if (isNonEmpty(finding && finding[k]) && Number.isFinite(Number(finding[k]))) return Number(finding[k]);
  }
  return null;
}

// ---------------------------------------------------------------------------
// 可译性判定（两维度）
// ---------------------------------------------------------------------------
/**
 * 判定维度二（最小结构化字段）：oracle 自带字段 / finding.target / reproPath 三处任一有稳定字段即可译。
 * @param {object} f
 * @param {string} oracle
 * @returns {boolean}
 */
function hasStructuredField(f, oracle) {
  if (pickEvidenceField(f, ORACLE_SELF_FIELDS[oracle] || [])) return true;
  // timeout 的自带字段就是「阈值 N」，认它（否则有阈值也会被判成无结构化字段）
  if (oracle === 'timeout' && resolveThreshold(f) != null) return true;
  if (targetOf(f)) return true;
  if (reproPathOf(f).length > 0) return true;
  return false;
}

/**
 * 可译性判定（含 reason）。这是 classifyTranslatability 的带原因版本，
 * 两者判同一套规则；此处额外返回 reason 与结构化字段来源，供 spec.notes 与人审队列使用。
 * @param {object} finding
 * @returns {{level:'translatable'|'conditional'|'not-translatable', reason:string|null, source:string|null}}
 */
function explainTranslatability(finding) {
  if (!finding || typeof finding !== 'object' || Array.isArray(finding)) {
    return { level: 'not-translatable', reason: 'finding-absent', source: null };
  }
  const oracle = finding.oracle;
  if (typeof oracle !== 'string' || ALL_ORACLES.indexOf(oracle) === -1) {
    return { level: 'not-translatable', reason: 'unknown-oracle', source: null };
  }

  // ---- oracle 专属前置（写在维度二通用检查之前，保证 reason 精确到专属原因）----
  if (oracle === 'pageerror') {
    // 仅 evidence.message 不足以构造可执行断言：没有重放路径，Layer 3 不知道在哪个操作序列下检查
    if (reproPathOf(finding).length === 0 && !targetOf(finding)) {
      return { level: 'not-translatable', reason: 'pageerror-without-repro-path', source: null };
    }
  }
  if (oracle === 'timeout') {
    if (resolveThreshold(finding) == null) {
      return { level: 'not-translatable', reason: 'timeout-without-threshold', source: null };
    }
  }
  if (oracle === 'empty-state') {
    // 判定字段写死 = finding.precondition，三态；字段缺失绝不默认当 met（否则登录墙会被误判成缺陷回归）
    const pre = finding.precondition;
    if (pre === undefined || pre === null || pre === '') {
      return { level: 'not-translatable', reason: 'precondition-field-absent', source: null };
    }
    if (pre === 'not-met') {
      return { level: 'not-translatable', reason: 'precondition-not-met', source: null };
    }
    if (pre !== 'met') {
      return { level: 'not-translatable', reason: 'precondition-unknown', source: null };
    }
  }

  // ---- 维度二通用检查 ----
  if (!hasStructuredField(finding, oracle)) {
    return { level: 'not-translatable', reason: 'no-structured-field', source: null };
  }

  let source = 'reproPath';
  if (pickEvidenceField(finding, ORACLE_SELF_FIELDS[oracle] || [])) source = 'oracle-field';
  else if (targetOf(finding)) source = 'target';
  const level = CONDITIONAL_ORACLES.indexOf(oracle) !== -1 ? 'conditional' : 'translatable';
  return { level, reason: null, source };
}

/**
 * 可译性三档判定。
 * @param {object} finding
 * @returns {'translatable'|'conditional'|'not-translatable'}
 */
function classifyTranslatability(finding) {
  return explainTranslatability(finding).level;
}

// ---------------------------------------------------------------------------
// 断言构造（按 oracle 一一映射）
// ---------------------------------------------------------------------------
function buildExpected(oracle, finding, threshold) {
  const ev = evidenceOf(finding);
  const target = resolveTarget(finding);
  switch (oracle) {
    case 'requestfailed':
      return { status: '2xx', url: isNonEmpty(ev.url) ? String(ev.url) : target };
    case 'dead-link':
      return { status: 200, href: isNonEmpty(ev.href) ? String(ev.href) : target };
    case 'crash':
      return { rootNonempty: true };
    case 'pageerror':
      return { noPageError: true };
    case 'timeout':
      return { maxMs: threshold };
    case 'empty-state':
      return { containerNonempty: true, hasData: true };
    default:
      return {};
  }
}

function buildNotes(finding, cls, threshold) {
  const oracle = finding.oracle;
  const parts = ['oracle=' + oracle, '判定档=' + cls.level];
  if (cls.source) parts.push('结构化字段来源=' + cls.source);
  if (oracle === 'timeout') parts.push('阈值N=' + threshold + 'ms');
  if (oracle === 'empty-state') parts.push('前置条件=met（有数据）');
  if (oracle === 'pageerror') {
    parts.push('需重放路径：' + (reproPathOf(finding).length ? 'reproPath' : 'target'));
  }
  parts.push('翻译依据=' + (cls.level === 'conditional' ? 'conditional 前置满足，翻译存在误报风险' : '无条件可译'));
  parts.push('风险：断言基于结构化字段构造，不等于零误报；回归失败真伪由 T5 判');
  return parts.join('；');
}

// ---------------------------------------------------------------------------
// 翻译（纯函数，不落盘）
// ---------------------------------------------------------------------------
/**
 * 把一条 confirmed finding 翻译成 Layer 3 回归 spec；不可译则返回 { translatable:false, reason }。
 * @param {object} finding
 * @param {{nowMs?:number, regressionLoopCount?:number}} [opts] 注入时钟便于断言 updatedAt 刷新；
 *   regressionLoopCount = 该 spec 已发生的回归失败次数（回流历史单调不减，不传按 0 起算）
 * @returns {object} regression spec 或不可译标记
 */
function translateFinding(finding, opts) {
  const options = opts || {};
  const nowMs = typeof options.nowMs === 'number' ? options.nowMs : Date.now();
  const cls = explainTranslatability(finding);
  const originFindingId = finding && finding.id != null ? String(finding.id) : null;

  if (cls.level === 'not-translatable') {
    return {
      translatable: false,
      translatability: 'not-translatable',
      reason: cls.reason,
      originFindingId,
      oracle: (finding && finding.oracle) || null,
      updatedAt: new Date(nowMs).toISOString(),
    };
  }

  const oracle = finding.oracle;
  const threshold = oracle === 'timeout' ? resolveThreshold(finding) : null;
  const spec = {
    id: 'regr-' + originFindingId,
    origin: 'layer1-confirmed',
    originFindingId,
    oracle,
    target: resolveTarget(finding),
    assertionType: ASSERTION_BY_ORACLE[oracle],
    expected: buildExpected(oracle, finding, threshold),
    reproPath: reproPathOf(finding),
    regressionOnly: true,
    translatability: cls.level,
    notes: buildNotes(finding, cls, threshold),
    updatedAt: new Date(nowMs).toISOString(),
    prevTranslations: [],
    regressionLoopCount: typeof options.regressionLoopCount === 'number' ? options.regressionLoopCount : 0,
    loopExhausted: false,
    deprecated: false,
    deprecateReason: null,
    supersededBy: null,
  };
  // 关联的 finding 处于「回归失败、尚未判定」状态 → 进 T7 自己的待判定队列（不进 T5，见 §4.1.1）。
  // 首次翻译（回流计数 0）本函数返回原 spec，无字段污染。
  return markNeedsOutcomeJudgement(spec, finding);
}

// ---------------------------------------------------------------------------
// 只读落盘：loadConfirmed
// ---------------------------------------------------------------------------
/**
 * 只读 findings 落盘，取 reviewStatus==='confirmed' 的子集。
 * 判定条件写死：readFileSync + JSON.parse + filter；**不 require / 不调用 T4 状态机模块任何函数**，
 * 也不复用其证据实质判定辅助 —— 保证独立性不被暗伤。
 * @param {string} findingsPath
 * @returns {object[]}
 */
function loadConfirmed(findingsPath) {
  const raw = fs.readFileSync(findingsPath, 'utf8'); // 只读，不写回
  const parsed = JSON.parse(raw);
  const list = Array.isArray(parsed) ? parsed : (parsed.findings || []);
  return list.filter((f) => f && f.reviewStatus === 'confirmed');
}

// ---------------------------------------------------------------------------
// 幂等写入 + confirmed 集合对账
// ---------------------------------------------------------------------------
function safeFileName(originFindingId) {
  const safe = String(originFindingId).replace(/[^A-Za-z0-9_.-]/g, '-');
  return 'regr-' + safe + '.json';
}

function specFilePath(layer3Dir, originFindingId) {
  return path.join(layer3Dir, safeFileName(originFindingId));
}

function readJsonSafe(p) {
  try {
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    return null;
  }
}

function writeJson(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}

function prevListOf(cur) {
  return Array.isArray(cur && cur.prevTranslations) ? cur.prevTranslations.slice() : [];
}

/**
 * 待判定候选入版本链前的**浅拷贝**（顶层键拷贝 + 数组值 slice）。
 *
 * 为什么要拷贝：版本链是**历史快照**，一旦入链就不得被调用方后续的原地改动改写 —— 否则历史被篡改，等于没留痕。
 *   · 顶层只拷贝一层：候选内容的顶层键值要么是标量（outcome / proposedStatus / generator / origin /
 *     regressionSpecId / regressionLoopCount），要么是数组（references / referencedFindings）。
 *   · 数组做 slice：切断与当前值的引用关系，避免「后来 push 了一条」把已入链的历史悄悄改掉。
 *   · 数组元素本身是 finding 对象引用，**不再深拷贝**：候选内容只要求「进入版本链后可回溯」，深拷贝代价与收益不成正比；
 *     且本模块落盘一律经 JSON 序列化，跨文件读回时引用天然断开。
 *   · 非对象 / 数组 / 缺失 → 一律归 null（不用 undefined），保证 JSON 落盘结构稳定。
 * @param {*} p 当前的待判定候选（通常为对象或 null）
 * @returns {object|null}
 */
function snapshotPendingCandidate(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
  const snap = Object.assign({}, p);
  Object.keys(snap).forEach((k) => {
    if (Array.isArray(snap[k])) {
      // referencedFindings 的元素是「活 finding 对象引用」：外部状态变更（把 finding 置为 ignored 等）是
      // 原地修改该对象，若不逐元素拷贝，版本链里的快照会被活 finding 的后续原地改写污染（历史失真）。
      // 故对 referencedFindings 做逐元素浅拷贝断引用；其余数组仅 slice。
      if (k === 'referencedFindings' && snap[k].length && typeof snap[k][0] === 'object' && !Array.isArray(snap[k][0])) {
        snap[k] = snap[k].map((item) =>
          item && typeof item === 'object' && !Array.isArray(item) ? Object.assign({}, item) : item);
      } else {
        snap[k] = snap[k].slice();
      }
    }
  });
  return snap;
}

/**
 * 历史版本摘要：只留可追溯的翻译/状态位，不整份堆叠。
 *
 * **版本链的职责 = 让「会被清空的字段」可回溯。** 所以摘要里必须收录一切**出队处置会清掉**的字段；
 * 当前被清空的就是 needsOutcomeJudgement 与 pendingOutcomeCandidate —— finding 离开 confirmed 时同一次对账
 * 会把两者写成 false / null（僵尸条目处置）。若摘要不收这两项，出队前的候选内容（引用了哪条 finding、
 * 原 outcome、原 proposedStatus）就**永久丢失、无法回溯** —— 这是真实数据丢失，不是可接受的取舍。
 *
 * 向后兼容：旧格式文件的历史条目没有这两项 → 读回是 undefined，本函数统一归一为 false / null，
 * **不需要迁移脚本**（历史格式差异可接受；新产生的摘要一律带齐两项）。
 * @param {object} s 出链那一刻的 spec 状态
 * @returns {object} 版本摘要
 */
function versionSummary(s) {
  return {
    updatedAt: (s && s.updatedAt) || null,
    translatability: (s && s.translatability) || null,
    assertionType: (s && s.assertionType) || null,
    expected: (s && s.expected) || null,
    deprecated: !!(s && s.deprecated === true),
    deprecateReason: (s && s.deprecateReason) || null,
    loopExhausted: !!(s && s.loopExhausted === true),
    regressionLoopCount: s && typeof s.regressionLoopCount === 'number' ? s.regressionLoopCount : 0,
    needsOutcomeJudgement: !!(s && s.needsOutcomeJudgement === true),
    pendingOutcomeCandidate: snapshotPendingCandidate(s && s.pendingOutcomeCandidate),
  };
}

/**
 * confirmed 集合来源：可注入（confirmedIds）以便测试；未注入时从 findingsPath 只读取。
 * 两者都没有 → 返回 null 表示**不做对账**（宁不对账，不猜集合）。
 */
function confirmedIdSet(options) {
  if (Array.isArray(options.confirmedIds)) return new Set(options.confirmedIds.map(String));
  if (typeof options.findingsPath === 'string' && options.findingsPath) {
    return new Set(loadConfirmed(options.findingsPath).map((f) => String(f.id)));
  }
  return null;
}

/**
 * 与当前 confirmed 集合对账（只读 findings）：
 *  - 不在集合里的 originFindingId → deprecated:true + reason + **待判定条目同次出队** + 刷新 updatedAt（保留 spec 文件）；
 *  - 回到集合但当前 deprecated 的 → 恢复 deprecated:false + 清 reason + 刷新 updatedAt + 追加 prevTranslations；
 *    **只动这四项**：回流计数与待判定队列字段一律保持原值（失败事实不因状态恢复而消失或重现）。
 * @returns {{deprecated:string[], restored:string[]}}
 */
function reconcileWithConfirmed(layer3Dir, confirmedIds, nowIso) {
  const out = { deprecated: [], restored: [] };
  if (!confirmedIds) return out;
  let names;
  try {
    names = fs.readdirSync(layer3Dir);
  } catch (e) {
    return out;
  }
  names
    .filter((n) => /^regr-.+\.json$/.test(n))
    .sort()
    .forEach((name) => {
      const p = path.join(layer3Dir, name);
      const cur = readJsonSafe(p);
      if (!cur || cur.originFindingId == null) return;
      const inSet = confirmedIds.has(String(cur.originFindingId));
      if (!inSet && cur.deprecated !== true) {
        const prev = prevListOf(cur);
        prev.push(versionSummary(cur));
        writeJson(p, Object.assign({}, cur, {
          deprecated: true,
          deprecateReason: DEPRECATE_REASON_NO_LONGER_CONFIRMED,
          // 待判定条目同次出队（与 applyHumanOutcome 正常出队同一口径）：
          // finding 已离开 confirmed → 这条断言已失效，若还挂着待判定条目，人审界面会看到僵尸项
          //（finding 都不 confirmed 了，再让人审去判真伪是浪费且误导）。
          // 出队而非删文件：deprecated 的 spec 是回归历史的一部分，删掉会破坏 prevTranslations 版本链。
          needsOutcomeJudgement: false,
          pendingOutcomeCandidate: null,
          prevTranslations: prev,
          updatedAt: nowIso,
        }));
        out.deprecated.push(String(cur.originFindingId));
      } else if (inSet && cur.deprecated === true && cur.deprecateReason === DEPRECATE_REASON_NO_LONGER_CONFIRMED) {
        // 仅恢复「因不再 confirmed 而被对账标废弃」的 spec；
        // 「合法变更」等人工判定的废弃（deprecateReason 不同）不得被自动恢复，否则合法变更会被悄悄复活。
        const prev = prevListOf(cur);
        prev.push(versionSummary(cur));
        // 恢复分支只动 deprecated / deprecateReason / prevTranslations / updatedAt 四项：
        //   · regressionLoopCount 保持原值 —— 回归失败是既成事实，不因 finding 状态恢复而清零，
        //     否则限流（loopExhausted）会被悄悄绕过、复发次数虚增。
        //   · needsOutcomeJudgement 保持 false、不重新入队 —— 断言虽然恢复可跑，但它此前的失败已随出队处置结束，
        //     重新入队等于凭空造出一次没人判定的回归失败。
        // 两者都不写，即自然沿用 cur 里的现值。
        writeJson(p, Object.assign({}, cur, {
          deprecated: false,
          deprecateReason: null,
          prevTranslations: prev,
          updatedAt: nowIso,
        }));
        out.restored.push(String(cur.originFindingId));
      }
    });
  return out;
}

/**
 * 待判定队列字段（needsOutcomeJudgement / pendingOutcomeCandidate）的幂等合并。
 * 语义：新 spec 显式带 needsOutcomeJudgement===false → 人审已判定，条目出队（以新为准）；
 * 新 spec 没带该字段 → 说明本次是纯重翻译（translateFinding 不知道队列状态），**必须沿用已有值**，
 * 绝不能因为整体覆盖把「在等人审判定」的标记抹掉（抹掉 = 未判定记录在人审界面上凭空消失）。
 */
function mergePendingJudgement(spec, existing) {
  const incoming = spec && Object.prototype.hasOwnProperty.call(spec, 'needsOutcomeJudgement');
  if (incoming && spec.needsOutcomeJudgement === false) {
    return { needsOutcomeJudgement: false, pendingOutcomeCandidate: null };
  }
  if (spec && spec.pendingOutcomeCandidate != null) {
    return { needsOutcomeJudgement: true, pendingOutcomeCandidate: spec.pendingOutcomeCandidate };
  }
  if (existing && existing.needsOutcomeJudgement === true) {
    return {
      needsOutcomeJudgement: true,
      pendingOutcomeCandidate: existing.pendingOutcomeCandidate != null ? existing.pendingOutcomeCandidate : null,
    };
  }
  return { needsOutcomeJudgement: spec && spec.needsOutcomeJudgement === true ? true : false, pendingOutcomeCandidate: null };
}

/**
 * 幂等写入回归 spec（同 originFindingId 原地更新，不新建第二条），随后做 confirmed 集合对账。
 * @param {object} spec translateFinding 的产出
 * @param {string} layer3Dir Layer 3 spec 目录
 * @param {{confirmedIds?:string[], findingsPath?:string, nowMs?:number}} [opts]
 * @returns {{written:string[], deprecated:string[], restored:string[], skipped:string|null}}
 */
function emitRegressionSpec(spec, layer3Dir, opts) {
  const options = opts || {};
  const nowMs = typeof options.nowMs === 'number' ? options.nowMs : Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const result = { written: [], deprecated: [], restored: [], skipped: null };

  if (!spec || spec.translatable === false || spec.translatability === 'not-translatable') {
    result.skipped = (spec && spec.reason) || 'not-translatable';
    return result;
  }
  if (spec.originFindingId == null) {
    throw new Error('[emitRegressionSpec] spec 必须含 originFindingId');
  }

  const file = specFilePath(layer3Dir, spec.originFindingId);
  fs.mkdirSync(layer3Dir, { recursive: true });
  const existing = readJsonSafe(file);

  let next;
  if (existing) {
    // 原地更新：旧版本摘要进 prevTranslations；回流计数/耗尽/deprecated/待判定队列沿用已有值，不被重翻译冲掉
    const prev = prevListOf(existing);
    prev.push(versionSummary(existing));
    next = Object.assign({}, spec, {
      prevTranslations: prev,
      // 回流计数是回归历史（单调不减），重翻译出的 0 不得抹掉已有计数
      regressionLoopCount: Math.max(
        typeof spec.regressionLoopCount === 'number' ? spec.regressionLoopCount : 0,
        typeof existing.regressionLoopCount === 'number' ? existing.regressionLoopCount : 0
      ),
      loopExhausted: spec.loopExhausted === true || existing.loopExhausted === true,
      deprecated: spec.deprecated === true || existing.deprecated === true,
      deprecateReason: spec.deprecateReason || existing.deprecateReason || null,
      supersededBy: spec.supersededBy || existing.supersededBy || null,
      // 待判定队列字段按 mergePendingJudgement 合并，不整体覆盖
      ...mergePendingJudgement(spec, existing),
      updatedAt: nowIso,
    });
  } else {
    next = Object.assign({}, spec, {
      prevTranslations: [],
      regressionLoopCount: typeof spec.regressionLoopCount === 'number' ? spec.regressionLoopCount : 0,
      loopExhausted: spec.loopExhausted === true,
      deprecated: spec.deprecated === true,
      deprecateReason: spec.deprecateReason || null,
      supersededBy: spec.supersededBy || null,
      ...mergePendingJudgement(spec, null),
      updatedAt: nowIso,
    });
  }
  writeJson(file, next);
  result.written.push(file);

  const rec = reconcileWithConfirmed(layer3Dir, confirmedIdSet(options), nowIso);
  result.deprecated = rec.deprecated;
  result.restored = rec.restored;
  return result;
}

// ---------------------------------------------------------------------------
// 回流防循环
// ---------------------------------------------------------------------------
/**
 * 记一次回归失败：递增 regressionLoopCount；达 MAX_REGRESSION_LOOP 即 loopExhausted，不再自动 reopen。
 * deprecated 与 loopExhausted 任一为真 → 不回流（互斥于回流动作，不互斥于字段本身）。
 *
 * 递增时机写死：**每次回归失败即递增，不等 outcome 判定**。理由——限流是 spec 自身的稳定性问题
 * （「一直失败但没人审」的 spec 也必须被限流，否则永远不被限流）；若改成人审后才递增，
 * 就变成「每次失败自动 reopen、等人审才计数」。故 applyHumanOutcome 判定时复用本函数的计数，不重复递增。
 * @param {object} spec
 * @returns {{spec:object, count:number, canReopen:boolean, requiresHumanReview:boolean, reason:string|null}}
 */
function noteRegressionFailure(spec) {
  const base = spec || {};
  const count = (typeof base.regressionLoopCount === 'number' ? base.regressionLoopCount : 0) + 1;
  const next = Object.assign({}, base, { regressionLoopCount: count });
  let reason = null;
  if (count >= MAX_REGRESSION_LOOP) {
    next.loopExhausted = true;
    reason = 'regression-loop-exhausted';
  }
  const canReopen = !next.loopExhausted && next.deprecated !== true;
  if (!canReopen && !reason) reason = 'deprecated';
  return { spec: next, count, canReopen, requiresHumanReview: !canReopen, reason };
}

/**
 * 合法变更：标 deprecated（保留历史，不删除），不再回流；可附后继断言。
 * @param {object} spec
 * @param {string} [reason]
 * @param {string} [supersededBy]
 * @returns {object} 新 spec（纯函数，不落盘）
 */
function markDeprecated(spec, reason, supersededBy) {
  return Object.assign({}, spec || {}, {
    deprecated: true,
    deprecateReason: (reason || 'legitimate-change') || null,
    supersededBy: supersededBy || null,
    updatedAt: new Date().toISOString(),
  });
}

// ---------------------------------------------------------------------------
// 回流候选输入（§4.1 字段表，纯对象构造；不引入 T5 候选分级模块）
// ---------------------------------------------------------------------------

// outcome 三态：未判定（自动流程，恒为 null）+ 人审判定后的二值。**不设第三种值**（§4.1 硬约束）
const OUTCOME_RECURRENCE = 'recurrence';
const OUTCOME_LEGITIMATE_CHANGE = 'legitimate-change';
const HUMAN_OUTCOMES = [OUTCOME_RECURRENCE, OUTCOME_LEGITIMATE_CHANGE];

// outcome → 候选输入的 proposedStatus / generator（§4.1 表 + §4.2 分派）
//  - 未判定（null）：**proposedStatus=null（不主张状态）**。这里绝不能填 confirmed —— 未判定时填 confirmed 等于自动流程
//    预设「这是真复发」，与「outcome 归人审、T7 不判真伪」直接自相矛盾；而且那条记录进不了 T5（候选构造器对非
//    confirmed/ignored 的状态当场抛错），自动流程连走自环的机会都没有。generator 仍记 rule: 前缀：回归失败这件事本身
//    是确定性事实（断言确实失败了），需要记录的只是来源、不是对真伪的判断。
//  - recurrence：proposedStatus=confirmed，generator 走 rule: 前缀 → 高置信可过闸门直接进 applied（G15）
//  - legitimate-change：**故意不在 OUTCOME_DISPATCH 里，本函数对它也直接抛错**（见 buildReopenedCandidateInput）。
//    原因：legitimate-change 的状态变更（finding 置 ignored）由人审界面直调状态机改写入口完成，根本不是候选；
//    若允许本函数构造 `proposedStatus:'ignored'` 候选并投 T5，会撞 candidate-spec 的 AUTO_IGNORE_NOT_ALLOWED 硬闸门
//    → 落人审队列 → 人审再判 → 又构造 ignored 候选 → 又撞闸门 → 死循环（镜像 recurrence 的 human:recurrence 死循环）。
//    故从类型上禁止：legitimate-change 不产生候选输入，唯一出口是 applyHumanOutcome 的人审动作指引 + 状态机改写入口。
const OUTCOME_DISPATCH = {
  recurrence: { proposedStatus: 'confirmed', generator: 'rule:regression-reopen' },
  // 注意：'legitimate-change' 故意不在此表——见上。
};
// 未判定分派：状态留空 = 不主张。generator 仍记确定性来源（回归失败是确定性事实），但不含任何真伪判断。
const UNJUDGED_DISPATCH = { proposedStatus: null, generator: 'rule:regression-reopen' };

// 人审后动作指引（applyHumanOutcome 合法变更路径的产物；本模块只出指令、不执行）
const HUMAN_ACTION_NEXT = 'human-ui-set-status-ignored';
const LEGITIMATE_CHANGE_JUDGMENT_SOURCE = 'human:legitimate-change';

/**
 * outcome 归一化：**T7 绝不自己判真伪**。
 *  - undefined / null → null（未判定，自动流程的诚实取值）
 *  - ∈ {recurrence, legitimate-change} → 原值
 *  - 其他任何值 → 抛错（不许静默当 null：静默降级会把「未判定」伪装成「未判定」而丢掉非法输入的信号）
 * @param {*} outcome
 * @returns {string|null}
 */
function normalizeOutcome(outcome) {
  if (outcome === undefined || outcome === null) return null;
  if (typeof outcome === 'string' && HUMAN_OUTCOMES.indexOf(outcome) !== -1) return outcome;
  throw new Error(
    '[outcome] 非法：只允许 recurrence / legitimate-change / null（未判定），实际=' + JSON.stringify(outcome)
  );
}

/**
 * 产出 T5 reopened candidate 的输入对象。
 * 只填 T7 能确定的五个字段：references / proposedStatus / generator / referencedFindings / outcome；
 * candidateConfidence / humanReviewRequired / basis **一律不手填**（由 T5 侧分级算）。
 * @param {object} finding 触发本次回归失败的那条 confirmed finding（从落盘取，不重新探测）
 * @param {object} spec 触发失败的回归 spec
 * @param {string|null} [outcome] 人审判定结果；**不传 / 传 null = 未判定**（自动流程，T7 不猜 recurrence）
 * @returns {{references:string[], proposedStatus:string|null, generator:string, referencedFindings:object[], outcome:string|null, ...}}
 *   未判定时 proposedStatus 为 null（不主张状态）—— 该输入会被 T5 侧的候选构造器当场抛错拦下，
 *   故未判定记录**进不了 T5**，只能进 T7 的待判定队列（见 markNeedsOutcomeJudgement）。
 */
function buildReopenedCandidateInput(finding, spec, outcome) {
  if (!finding || finding.id == null) {
    throw new Error('[buildReopenedCandidateInput] finding 必须含 id');
  }
  // 先归一化：非法 outcome 直接抛，绝不静默落成 null
  const oc = normalizeOutcome(outcome);
  // legitimate-change 不是候选：构造 ignored 候选投 T5 会撞 AUTO_IGNORE_NOT_ALLOWED 死循环。
  // 从类型上禁止——合法变更的唯一出口是状态机改写入口（经 applyHumanOutcome 的人审动作指引）。
  if (oc === OUTCOME_LEGITIMATE_CHANGE) {
    throw new Error(
      '[buildReopenedCandidateInput] legitimate-change 不走候选链：合法变更的状态变更由人审界面直接调 '
      + "状态机改写入口（'ignored' + 'human:legitimate-change'）完成，本函数只产出 recurrence / 未判定 的候选输入。"
      + '构造 ignored 候选投 T5 会撞 AUTO_IGNORE_NOT_ALLOWED 形成死循环，故从类型上禁止。'
    );
  }
  const d = oc === null ? UNJUDGED_DISPATCH : OUTCOME_DISPATCH[oc];
  return {
    references: [finding.id],
    proposedStatus: d.proposedStatus,
    generator: d.generator,
    referencedFindings: [finding],
    // outcome 恒在返回对象里：人审界面据此区分「疑似合法变更」与「普通误报」
    outcome: oc,
    origin: 'regression-spec',
    regressionSpecId: spec && spec.id ? spec.id : null,
    regressionLoopCount: spec && typeof spec.regressionLoopCount === 'number' ? spec.regressionLoopCount : 0,
  };
}

/**
 * T7 自己的待判定队列：把「已记一次回归失败、尚未判定真伪」的 spec 标记为待判定，
 * 并挂上 pendingOutcomeCandidate（= 未判定候选输入，outcome 与 proposedStatus 均为 null）。
 *
 * 队列归属写死：未判定记录**不进** T5 的人审队列（那里要先构造合法候选，未判定时构造不出），
 * 人审界面只消费 T7 的 needsOutcomeJudgement 列表。
 *
 * 入队判据 = 「确实发生过回归失败」（regressionLoopCount > 0；递增不等判定，见 noteRegressionFailure）
 * 且该 spec 关联的 finding 存在且对得上号。人审判定后由 applyHumanOutcome 清标记出队。
 * @param {object} spec 回归 spec（须已带回归失败计数）
 * @param {object} finding 该 spec 关联的 confirmed finding（用于构造未判定候选输入）
 * @returns {object} 新 spec（纯函数，不落盘）；不满足条件时原样返回
 */
function markNeedsOutcomeJudgement(spec, finding) {
  const base = spec || {};
  if (base.translatable === false || base.translatability === 'not-translatable') return base;
  // 队列条目必须能指回 finding，否则待判定的候选输入构造不出来
  if (!finding || finding.id == null) return base;
  if (base.originFindingId != null && String(finding.id) !== String(base.originFindingId)) return base;
  // 「回归失败未判定」的判据：确实发生过回归失败（计数 > 0），且尚未走人审判定
  const counted = typeof base.regressionLoopCount === 'number' && base.regressionLoopCount > 0;
  if (!counted) return base;
  return Object.assign({}, base, {
    needsOutcomeJudgement: true,
    // 未判定候选：outcome=null、proposedStatus=null（不主张状态）→ 天然进不了 T5，只能等人审
    pendingOutcomeCandidate: buildReopenedCandidateInput(finding, base, null),
  });
}

/**
 * 回流计数结算（判定时调用）：**复用**失败发生时已记的次数，不重复递增。
 * needsOutcomeJudgement===true 表示这次失败已由 noteRegressionFailure 计过数、正在等人审 → 计数保持不变，
 * 只把条目出队（needsOutcomeJudgement=false）。若调用方没走过失败计数（fresh spec 直接带判定进来），
 * 则补记一次，保持「一次失败记一次数」的不变量。
 */
function settleLoopCountAfterJudgement(spec) {
  const base = spec || {};
  if (base.needsOutcomeJudgement === true) {
    const settled = Object.assign({}, base, {
      needsOutcomeJudgement: false,
      pendingOutcomeCandidate: null,
    });
    const count = typeof settled.regressionLoopCount === 'number' ? settled.regressionLoopCount : 0;
    const canReopen = !settled.loopExhausted && settled.deprecated !== true;
    let reason = null;
    if (settled.loopExhausted) reason = 'regression-loop-exhausted';
    else if (!canReopen) reason = 'deprecated';
    return { spec: settled, count, canReopen, requiresHumanReview: !canReopen, reason };
  }
  return noteRegressionFailure(base);
}

/**
 * 人审判定后的动作（§4.2 两条路径）。**供人审界面调用，不是自动流程的一步**。
 * 本模块对状态机零依赖，故合法变更路径只能产出**动作指引**（由人审界面调用状态机把该 finding
 * 置为 ignored、judgmentSource 记为 human:legitimate-change），不自己改 finding 状态。
 * @param {object} finding 触发本次回归失败的那条 confirmed finding
 * @param {object} spec 触发失败的回归 spec
 * @param {string} outcome 人审判定结果，必为 recurrence 或 legitimate-change（**不许传 null**：未判定时还没有人审动作）
 * @param {{supersededBy?:string}} [opts] 合法变更时可附后继断言 id
 * @returns {object} recurrence → {path, candidateInput, spec, loopExhausted, canReopen, requiresHumanReview}
 *                   legitimate-change → {path, nextAction, findingId, targetStatus, judgmentSource, spec, loopExhausted, canReopen}
 */
function applyHumanOutcome(finding, spec, outcome, opts) {
  if (!finding || finding.id == null) {
    throw new Error('[applyHumanOutcome] finding 必须含 id');
  }
  const oc = normalizeOutcome(outcome);
  if (oc === null) {
    // 未判定不是「缺个默认值」，而是「还没判」：抛错而非兜底填值。
    // 兜底填值等于 T7 自己判真伪（等于预设「这是真复发」），与「outcome 归人审」直接冲突。
    // 未判定记录的正经去处 = T7 自己的待判定队列（spec.needsOutcomeJudgement / spec.pendingOutcomeCandidate）。
    throw new Error(
      '[applyHumanOutcome] 未判定（outcome 为空）不产生人审后动作：请先查 T7 待判定队列（spec.needsOutcomeJudgement=true，'
      + '候选输入见 spec.pendingOutcomeCandidate），由人审界面消费该队列、判定 recurrence 或 legitimate-change 后再调用本函数；'
      + 'T7 不兜底代判真伪'
    );
  }
  const options = opts || {};

  if (oc === OUTCOME_RECURRENCE) {
    // 路径 A（真复发）：产出候选输入交调用方走分级 + 应用链；spec 回流计数结算，达上限强制人审。
    // 计数口径：regressionLoopCount 每次回归失败即递增（不等 outcome 判定），由失败发生时的 noteRegressionFailure 记。
    // 故本分支**复用**已记的次数而不重复递增（否则一次失败被记两次，回流次数虚增、限流提前触发）；
    // 只有调用方没走过失败计数（fresh spec 直接带判定进来）时才补记一次。
    // 已知边界：状态自环不刷新审计，故 findings 侧不留复发痕迹，复发次数只活在 spec 的回流计数上。
    const noted = settleLoopCountAfterJudgement(spec || {});
    return {
      path: OUTCOME_RECURRENCE,
      candidateInput: buildReopenedCandidateInput(finding, noted.spec, OUTCOME_RECURRENCE),
      spec: noted.spec,
      loopExhausted: noted.spec.loopExhausted === true,
      canReopen: noted.canReopen,
      requiresHumanReview: noted.requiresHumanReview,
    };
  }

  // 路径 B（合法变更）：finding 必须真的离开 confirmed，否则「已确认缺陷」与「已判合法变更」两条语义在 findings 上无法区分。
  // 但候选应用链对 ignored 一律硬拦（投进去 = 死循环），故这里只出**人审动作指引** + 废弃 spec。
  // 计数口径同路径 A：复用失败时已记的次数，不重复递增。
  const dep = markDeprecated(spec || {}, OUTCOME_LEGITIMATE_CHANGE, options.supersededBy);
  const noted = settleLoopCountAfterJudgement(dep);
  return {
    path: OUTCOME_LEGITIMATE_CHANGE,
    nextAction: HUMAN_ACTION_NEXT,
    findingId: finding.id,
    targetStatus: 'ignored',
    judgmentSource: LEGITIMATE_CHANGE_JUDGMENT_SOURCE,
    spec: noted.spec,
    loopExhausted: noted.spec.loopExhausted === true,
    canReopen: noted.canReopen,
    requiresHumanReview: noted.requiresHumanReview,
  };
}

// ---------------------------------------------------------------------------
// 待判定队列：枚举接口（消费方在「人审界面 / 人审流程侧」，本轮只提供列表，不实现任何消费动作）
// ---------------------------------------------------------------------------

/**
 * 枚举 Layer 3 spec 目录里所有待判定条目（needsOutcomeJudgement===true），供人审界面拉取列表。
 *
 * 定位与边界（**不得夸大**）：T7 只**产出**队列，当前**没有任何消费方实现**。
 * 未来形态（独立 CLI / MCP 工具 / 并入既有评审界面）本轮不选型 —— 无真实人审流程可对齐，凭空选型是臆造。
 * 本函数是纯只读列举：既不改 finding，也不改 spec，更不代任何人审判定真伪。
 *
 * 排序：按 regressionLoopCount 降序（失败次数多的优先给人审），同数按 id 字典序 → 输出稳定可测。
 *
 * 返回 [] 的三种边界情形（都是正常结果，不是错误）：
 *  1. 目录不存在 / 不可读 —— 返回 [] 而**不抛**：调用方通常是「有没有待人审的条目」这类探测式查询，
 *     目录还没建（还没跑过翻译）时应答「没有」，不该把调用方打挂。
 *  2. 目录里没有待判定条目 —— 返回 []：没人审完、没回归失败、或都已出队，都是常态。
 *  3. 目录里没有任何 regr-*.json —— 返回 []：本模块只认自己产出的文件命名，其他文件一概不认。
 *
 * 单个文件 JSON 损坏时**跳过该条并继续**（复用 readJsonSafe）：一条坏文件不该让整张人审列表拉不出来。
 *
 * @param {string} layer3Dir Layer 3 spec 目录
 * @returns {Array<{id:string, originFindingId:string, regressionLoopCount:number, updatedAt:string|null, outcome:string|null, proposedStatus:string|null}>}
 *   outcome / proposedStatus 取自待判定候选输入，恒为 null（枚举出的必然是「未判定」态，
 *   已判定残留不入队 —— 出队由 applyHumanOutcome 或对账的僵尸处置完成）；人审界面靠 outcome 区分
 *   「疑似合法变更」与「普通误报」，故恒在返回结构里。
 */
function listPendingOutcomeJudgements(layer3Dir) {
  let names;
  try {
    names = fs.readdirSync(layer3Dir);
  } catch (e) {
    return [];
  }
  const rows = [];
  names
    .filter((n) => /^regr-.+\.json$/.test(n))
    .forEach((name) => {
      const cur = readJsonSafe(path.join(layer3Dir, name));
      if (!cur || cur.needsOutcomeJudgement !== true) return; // 坏文件/未入队：跳过，不影响其他条目
      const pending = cur.pendingOutcomeCandidate && typeof cur.pendingOutcomeCandidate === 'object'
        ? cur.pendingOutcomeCandidate
        : null;
      rows.push({
        id: cur.id != null ? String(cur.id) : null,
        originFindingId: cur.originFindingId != null ? String(cur.originFindingId) : null,
        regressionLoopCount: typeof cur.regressionLoopCount === 'number' ? cur.regressionLoopCount : 0,
        updatedAt: cur.updatedAt != null ? String(cur.updatedAt) : null,
        outcome: pending && pending.outcome != null ? String(pending.outcome) : null,
        proposedStatus: pending && pending.proposedStatus != null ? String(pending.proposedStatus) : null,
      });
    });
  rows.sort((a, b) => {
    if (a.regressionLoopCount !== b.regressionLoopCount) return b.regressionLoopCount - a.regressionLoopCount;
    const ka = a.id == null ? '' : a.id;
    const kb = b.id == null ? '' : b.id;
    return ka < kb ? -1 : (ka > kb ? 1 : 0);
  });
  return rows;
}

module.exports = {
  MAX_REGRESSION_LOOP,
  TRANSLATABLE_ORACLES,
  CONDITIONAL_ORACLES,
  ALL_ORACLES,
  ASSERTION_BY_ORACLE,
  ORACLE_SELF_FIELDS,
  DEPRECATE_REASON_NO_LONGER_CONFIRMED,
  OUTCOME_RECURRENCE,
  OUTCOME_LEGITIMATE_CHANGE,
  HUMAN_OUTCOMES,
  OUTCOME_DISPATCH,
  UNJUDGED_DISPATCH,
  HUMAN_ACTION_NEXT,
  LEGITIMATE_CHANGE_JUDGMENT_SOURCE,
  resolveTarget,
  resolveThreshold,
  explainTranslatability,
  classifyTranslatability,
  translateFinding,
  loadConfirmed,
  emitRegressionSpec,
  reconcileWithConfirmed,
  noteRegressionFailure,
  markDeprecated,
  normalizeOutcome,
  buildReopenedCandidateInput,
  markNeedsOutcomeJudgement,
  applyHumanOutcome,
  listPendingOutcomeJudgements,
  snapshotPendingCandidate,
};