'use strict';
/**
 * error-classify.cjs —— 错误归因分类（software-verifier v1.4.4）
 *
 * 为什么需要它（来自第三方靶子验证的真实教训）：
 *   在 element-plus.org / cn.vuejs.org / tldraw.com 等**第三方站点**上跑验证时，
 *   采集到的错误混了完全不同的东西，而报告只把它们平铺成"错误日志"：
 *     ① 宿主缺陷   —— 被测软件自身的问题（水合失配、逻辑报错、自家服务 5xx）→ 站点维护者关心，计入 FAIL
 *     ② 环境噪声   —— 网络受限/第三方 CDN 不可达（`net::ERR_*`、第三方源 4xx）
 *                     → 与宿主无关，却会把**无关功能点**染成 FAIL（实测三轮三次不同结果）
 *     ③ 工具自身   —— 验证器自身能力边界或降级（未知断言类型、截图未采集）
 *                     → 是"验证器的话"，不是"被测软件的话"
 *     ④ 非功能性   —— 浏览器自发起/开发期产物（favicon、source-map）→ 与功能结论无关
 *   混在一起导致两个后果：(a) 消费者分不清"该找谁"；(b) 环境噪声污染功能点判定。
 *
 * ===== v1.4.4 核心变更：**归因拆两层** =====
 *
 * v1.4.3 用一条 `/Failed to load resource/` 规则把两个**本质不同**的层合并成 env：
 *   (a) 服务端确实应答了 4xx/5xx —— **HTTP 状态层**：有人应答，归属可查（"server responded with a status of NNN"）
 *   (b) 根本没拿到应答        —— **网络传输层**：`net::ERR_*`（DNS/连接/证书/阻断）
 * 后果（审计实测，压力样本准确率仅 60%）：**同源 404/500 被判为「环境噪声」→ 默认模式不计入 FAIL**，
 * 站点自己坏掉的资源 / spec 路径写错造成的同源 404 就这样被"洗白"了。
 *
 * 拆层后的判定（顺序即优先级）：
 *
 *   【HTTP 状态层】有服务器应答 —— 默认 **host**（有人应答就必须有人负责，不再默认洗成 env）
 *     · 资源属第三方源（origin ≠ 被测站点）      → env   （第三方 CDN/上游错误，非宿主可控）
 *     · URL 即本次导航入口 URL 且状态为 4xx      → tool  （入口 URL 不可用 = spec/--url 配置问题）
 *     · 其余同源（含拿不到 URL 的裸文本）        → host
 *     · 例外：favicon / source-map 等非功能性请求 → noise（浏览器自发起，与功能结论无关）
 *
 *   【网络传输层】未拿到应答 —— 按来源判定
 *     · 同源（被测服务自己的资源连不上）          → host（服务自身问题）
 *     · 跨源（第三方资源连不上）                  → env
 *     · 拿不到 URL 的裸文本（如 `Failed to fetch`）→ env（已知环境特征，与 v1.4.3 一致，避免无依据翻转判定）
 *
 * 设计原则（不可退让）：
 *   - **不静默丢弃**：任何被判定为 env / noise 的条目都必须带类别与理由出现在报告里，
 *     并计入 `result.envNoise` / `result.nonFunctional`；绝不因为"不算 FAIL"就从报告消失。
 *   - **保守归因**：只有命中**已知**的环境特征才降级为 env；其余一律默认 host——
 *     宿主自己的全局（如 `myAppWidget is not defined`）仍判 host，不会被洗白。
 *   - **可复核**：每条都带 `reason`（为什么这么判）、`pattern`（命中哪条规则）、`layer`（命中哪一层）。
 *
 * 注：env / noise 默认不计入功能点 FAIL（功能结论由断言语义决定），可用 `--strict-env`
 *     让严格模式把 env 也计入 FAIL（noise 无论如何都不计入）。
 */

// 类别标签（报告/控制台展示用）
const LABEL = { host: '宿主', env: '环境', tool: '工具', noise: '非功能性' };

// 归因层级：区分"有服务器应答"与"没拿到应答"
const LAYERS = { HTTP: 'http', NET: 'net', APP: null };

/**
 * 第三方库全局白名单（v1.4.4：前缀**显式化**）
 *
 * 旧规则写成 `ReferenceError:\s*(?:Handlebars|Vue|...)\s+is not defined`——依赖 `ReferenceError:` 前缀，
 * 这是**隐式契约**：审计实测 `classifyError("ReferenceError: Handlebars is not defined")` → env，
 * 而 `classifyError("Handlebars is not defined")` → host。上游一旦有调用点只传 `err.message`，
 * 同一条错误就会从 env 退化成 host。v1.4.4 把这个前缀契约显式化：
 *   - `PREFIX` 显式声明"前缀可有可无"，两端都能稳定命中；
 *   - 匹配做**有界 token 检查**（前后不得紧邻 `[\w$.]`），所以 `MyHandlebars` / `HandlebarsUtil`
 *     不会被误吞（负对照 C2 守住）；
 *   - 库名族用**显式前缀族**声明，而不是靠子串碰运气。
 */
// 精确全局名（只匹配自己）
const THIRD_PARTY_EXACT = [
  'Handlebars', 'jQuery', '$', 'Vue', 'React', 'ReactDOM', 'ReactDOMServer', '_', 'axios', 'dayjs',
  'moment', 'lodash', 'Chart', 'Swiper', 'Popper', 'ApexCharts', 'mermaid', 'katex', 'hljs', 'Prism',
  'Alpine', 'htmx', 'bootstrap', 'Splide', 'Leaflet', 'Mapbox', 'three', 'anime', 'Embla',
];
// 显式前缀族（库名命名空间可带后缀：VueRouter/Vuex、echarts 实例、d3 插件等）
const THIRD_PARTY_PREFIX = ['React', 'Vue', 'Vuex', 'VueRouter', 'echarts', 'ECharts', 'd3', 'gsap', 'Lottie', 'swiper'];
// 兼容旧导出：扁平全量名单（老脚本按数量读取）
const THIRD_PARTY_GLOBALS = Array.from(new Set([...THIRD_PARTY_EXACT, ...THIRD_PARTY_PREFIX]));

const esc = (s) => String(s).replace(/\$/g, '\\$').replace(/\./g, '\\.');
// 有界 token：前后不得紧邻标识符字符或 . / $
const B = '(?<![\\w$.])';
const A = '(?![\\w$.])';
const LIB_PATTERN =
  B + '(?:' + THIRD_PARTY_EXACT.map(esc).join('|') + ')' + A +
  '|' + B + '(?:' + THIRD_PARTY_PREFIX.map(esc).join('|') + ')[A-Za-z0-9_]*' + A;
// 前缀显式可无（v1.4.4 显式化契约）
const LIB_UNDEFINED_RE = new RegExp('(?:ReferenceError:\\s*)?(?:' + LIB_PATTERN + ')\\s+is not defined');

// 非功能性请求（证据：v1.4.4 实测某次真实运行 /favicon.ico 404 出现、且页面并未声明 icon → 浏览器自发起）
// 刻意只收两类：favicon（浏览器 chrome 资产）与 source map（开发期产物）。不扩大，避免变成洗白后门。
const NON_FUNCTIONAL_RE = /favicon\.(ico|png|svg)|apple-touch-icon|\.map(\?|$)|\/\.well-known\//i;

// 规则表：按顺序匹配，先命中先归类（tool → noise → http 状态层 → net 传输层 → 白名单 → host 兜底）
const RULES = [
  // ---- ① 工具自身（验证器的话）----
  { category: 'tool', layer: null, reason: '验证器能力边界：spec 使用了引擎未实现的断言/步骤', re: /未知断言类型|引擎不支持该断言|表达式含被禁止的标识符|安全校验未通过/ },
  { category: 'tool', layer: null, reason: '验证器自身降级：截图/可视化采集未成功（不影响被测软件功能结论）', re: /截图未采集|screenshot 失败|视觉基线.*失败|visual.*失败/i },
  { category: 'tool', layer: null, reason: 'MCP/子进程调用层问题（非被测软件）', re: /verify_run 退出码|spawn .*ENOENT|MCP .*超时/i },
  // ---- ⑤ 第三方库全局缺失（前缀显式可无）----
  { category: 'env', layer: null, reason: '第三方 CDN 脚本未就绪：知名库全局缺失（常见于外网受限/间歇加载失败，非宿主逻辑缺陷）', re: LIB_UNDEFINED_RE },
];

// ---------- 小工具 ----------
function extractUrl(msg) {
  const m = String(msg == null ? '' : msg).match(/\|\s*url=(\S+)/);
  return m ? m[1] : null;
}
function originOf(u) {
  try { const x = new URL(u); return x.protocol + '//' + x.host; } catch (_e) { return null; }
}
function normUrl(u) {
  try { const x = new URL(u); x.hash = ''; const s = x.toString(); return s.endsWith('/') ? s.slice(0, -1) : s; } catch (_e) { return null; }
}
function statusOf(msg) {
  const m = String(msg == null ? '' : msg).match(/(?:the server responded with a status of|http-status:)\s*(\d{3})/i);
  return m ? parseInt(m[1], 10) : null;
}
function isNetLayer(msg) {
  return /requestfailed:|net::ERR_|Failed to fetch|Load failed|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION_|ERR_INTERNET_DISCONNECTED|ERR_CERT_|ERR_TIMED_OUT|ERR_ABORTED|ERR_UNSAFE_PORT/i.test(String(msg == null ? '' : msg));
}

/**
 * 归类单条错误
 * @param {string} msg 原始错误文本（网络类条目带 ` | url=<URL>` 尾巴，由 drivers/dom.js 附加）
 * @param {{targetUrl?:string, navUrl?:string}} [ctx] 被测站点入口（用于判定同源/跨源与入口 URL）
 * @returns {{category:'host'|'env'|'tool'|'noise', label:string, reason:string, pattern:string|null, layer:'http'|'net'|null, url:string|null, sameOrigin:boolean|null}}
 */
function classifyError(msg, ctx) {
  const s = String(msg == null ? '' : msg);
  const c = ctx || {};
  const url = extractUrl(s);
  const targetOrigin = originOf(c.targetUrl || c.navUrl || '') ;
  const urlOrigin = url ? originOf(url) : null;
  const sameOrigin = (urlOrigin && targetOrigin) ? (urlOrigin === targetOrigin) : null;

  // ---- ① / ⑤ 文本规则（工具自身、白名单库）----
  for (const r of RULES) {
    if (r.re.test(s)) return mk(r.category, r.reason, String(r.re), r.layer, url, sameOrigin);
  }

  // ---- ④ 非功能性请求（浏览器自发起 / 开发期产物）----
  if (NON_FUNCTIONAL_RE.test(url || s)) {
    return mk('noise', '非功能性请求（浏览器自发起或开发期产物：favicon / source-map），与功能结论无关，不计入 FAIL', nonFunctionalPatternOf(url || s), null, url, sameOrigin);
  }

  const st = statusOf(s);

  // ---- ③ HTTP 状态层：有服务器应答 ----
  if (st != null) {
    if (sameOrigin === false) {
      return mk('env', 'HTTP 状态层（第三方源）：' + st + ' 由第三方源应答，属外部依赖错误，非被测软件逻辑缺陷', String(st), LAYERS.HTTP, url, sameOrigin);
    }
    const isNav = url && (normUrl(url) === normUrl(c.navUrl || '') || normUrl(url) === normUrl(c.targetUrl || ''));
    if (isNav && st >= 400 && st < 500) {
      return mk('tool', 'HTTP 状态层（入口 URL）：本次导航入口 URL 本身返回 ' + st + '（spec 路径或 --url 配置问题，非被测软件功能缺陷）', String(st), LAYERS.HTTP, url, sameOrigin);
    }
    return mk('host', 'HTTP 状态层（同源/未知源）：服务端确实应答了 ' + st + '——有人应答就必须有人负责，按被测软件自身问题处理（v1.4.3 曾把此情形误判为环境噪声而洗白）', String(st), LAYERS.HTTP, url, sameOrigin);
  }

  // ---- ② 网络传输层：未拿到应答 ----
  if (isNetLayer(s)) {
    if (sameOrigin === true) {
      return mk('host', '网络传输层（同源）：被测服务自己的资源连不上（无服务器应答），属服务自身问题', 'net', LAYERS.NET, url, sameOrigin);
    }
    if (sameOrigin === false) {
      return mk('env', '网络传输层（第三方源）：无服务器应答（DNS/连接/证书/阻断），属外部环境因素', 'net', LAYERS.NET, url, sameOrigin);
    }
    return mk('env', '网络传输层（来源未知）：无服务器应答，命中已知环境特征（DNS/连接/证书/阻断），与 v1.4.3 行为一致', 'net', LAYERS.NET, url, sameOrigin);
  }

  // ---- 兜底：宿主 ----
  return mk('host', '默认归因：非已知环境/工具/非功能性特征，按被测软件自身问题处理', null, LAYERS.APP, url, sameOrigin);
}

function mk(category, reason, pattern, layer, url, sameOrigin) {
  return { category, label: LABEL[category], reason, pattern: pattern ? String(pattern).slice(0, 160) : null, layer: layer || null, url: url || null, sameOrigin: sameOrigin === null || sameOrigin === undefined ? null : sameOrigin };
}
function nonFunctionalPatternOf(s) {
  const m = String(s).match(NON_FUNCTIONAL_RE);
  return m ? m[0] : null;
}

/**
 * 批量分桶（保留原始顺序与原文，绝不丢弃）
 * @param {string[]} list
 * @param {{targetUrl?:string, navUrl?:string}} [ctx]
 * @returns {{host:Array, env:Array, tool:Array, noise:Array, counts:{host:number,env:number,tool:number,noise:number}}}
 */
function bucketize(list, ctx) {
  const out = { host: [], env: [], tool: [], noise: [] };
  for (const e of (list || [])) {
    const c = classifyError(e, ctx);
    out[c.category].push({ msg: String(e), reason: c.reason, layer: c.layer, url: c.url });
  }
  out.counts = { host: out.host.length, env: out.env.length, tool: out.tool.length, noise: out.noise.length };
  return out;
}

module.exports = {
  classifyError, bucketize,
  LABEL, LAYERS, RULES,
  THIRD_PARTY_GLOBALS, THIRD_PARTY_EXACT, THIRD_PARTY_PREFIX,
  LIB_UNDEFINED_RE, NON_FUNCTIONAL_RE,
  // 供测试/自检复用的内部工具（显式导出，避免调用方再实现一份导致漂移）
  _internals: { extractUrl, originOf, normUrl, statusOf, isNetLayer },
};
