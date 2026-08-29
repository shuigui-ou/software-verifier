'use strict';
/**
 * safe-expr.cjs —— 验证表达式安全校验（software-verifier P0 安全修复）
 *
 * 验证器的 assertEval / exec / getBusyDone 需要按 spec 运行用户提供的断言表达式。
 * 这些表达式来源为【本地可信 spec 文件】（用户自己编写的说明书），属 by-design。
 * 为满足 SkillHub 安全扫描对 eval / new Function 动态执行的要求，这里在执行前
 * 对表达式做「危险标识符黑名单」校验，拦截可造成 RCE / 文件 / 进程 / 网络 /
 * 全局原型逃逸的写法，同时保留常见断言（属性访问、比较、逻辑、正则字面量、.includes）。
 */

// 被禁止的标识符：能触发命令执行 / 文件 / 进程 / 网络 / 全局原型逃逸
// 注意：未列入 exec / spawn / atob / btoa / Proxy / Reflect —— 这些作为普通方法名
// （如正则 .exec、JSON 等）在断言中常见且无害；真正的危险通路 require/child_process
// 已被拦截，单独调用 exec 无从发起。
const BLOCKED = [
  'require', 'process', 'child_process', 'execSync', 'execFile', 'fs', 'module',
  'import', 'eval', 'Function', 'constructor', '__proto__',
  'globalThis', 'global', 'fetch', 'XMLHttpRequest', 'setTimeout', 'setInterval',
  'WebSocket', 'Worker'
];

function assertSafeExpr(expr) {
  if (typeof expr !== 'string' || !expr.trim()) {
    return { ok: false, reason: '表达式为空或非字符串（来源必须为本地可信 spec）' };
  }
  for (const b of BLOCKED) {
    // 匹配 .constructor / constructor / Function( 等；忽略大小写以防绕过
    const re = new RegExp('(?:\\.|\\b)' + b + '\\b', 'i');
    if (re.test(expr)) {
      return { ok: false, reason: '表达式含被禁止的标识符: ' + b + '（仅允许本地可信 spec 的声明式断言）' };
    }
  }
  return { ok: true };
}

module.exports = { assertSafeExpr, BLOCKED };
