'use strict';
/**
 * question-prefs.cjs —— 交互式追问「用户意见记忆」（v1.10.0）
 * ============================================================================
 *  为什么需要它：
 *    v1.9.0 的 --question 是**无状态 opt-in**：每次跑都是空白问、不跨 run 记。
 *    但真实用户偏好分化——有人要细、有人嫌烦。产品要求（用户定）：
 *      ① 默认每次新跑都先确认要不要补测点；
 *      ② 用户已经给过意见的（补过点 / 明确拒过）自动沿用，不再重复问；
 *      ③ 开头拒了但后面冒出「新需求」时仍可适当问一次（JIT）；
 *      ④ 被问时拒绝 → 默认全局不再问（察觉用户意愿）。
 *    这些都需要把「用户意见」**跨 run 持久化**，故独立成模块。
 *
 *  存储口径：
 *    · 按**项目**隔离：以 spec 文件解析路径为 key（测试点本就项目相关）。
 *    · 落盘在 spec 同目录的 `.software-verifier-question-prefs.json`（随项目走，非 tmp——tmp 会丢，违背「记忆」语义）。
 *    · 结构 { version, entries: { <specPath>: {optedOutStart, optedOutHard, supplements, declinedCats, updatedAt} } }
 *
 *  fail-open 铁律：读写任何异常都不抛，返回空意见 / {ok:false}。
 *  监督器出问题，绝不能让被验证的流程崩溃。
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');

const FILE_NAME = '.software-verifier-question-prefs.json';

function scopeKey(specPath) {
  if (!specPath) return null;
  try { return path.resolve(specPath); } catch (_) { return String(specPath); }
}

function prefsFile(specPath) {
  try {
    if (!specPath) return null;
    return path.join(path.dirname(path.resolve(specPath)), FILE_NAME);
  } catch (_) { return null; }
}

function emptyPrefs() {
  return { optedOutStart: false, optedOutHard: false, supplements: {}, declinedCats: [] };
}

/**
 * 读取某项目的用户意见。任何失败 → 空意见（fail-open）。
 * @param {string} specPath spec 文件路径
 * @returns {{optedOutStart:boolean, optedOutHard:boolean, supplements:object, declinedCats:string[]}}
 */
function load(specPath) {
  try {
    const f = prefsFile(specPath);
    if (!f || !fs.existsSync(f)) return emptyPrefs();
    const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
    const key = scopeKey(specPath);
    const entries = (raw && raw.entries) || {};
    const e = (key && entries[key]) || {};
    const supplements = {};
    if (e.supplements && typeof e.supplements === 'object') {
      for (const k of Object.keys(e.supplements)) {
        const v = e.supplements[k];
        if (Array.isArray(v)) supplements[k] = v.map(function (x) { return String(x); }).filter(Boolean);
      }
    }
    return {
      optedOutStart: !!e.optedOutStart,
      optedOutHard: !!e.optedOutHard,
      supplements: supplements,
      declinedCats: Array.isArray(e.declinedCats) ? e.declinedCats.map(String) : [],
    };
  } catch (_) {
    return emptyPrefs();
  }
}

/**
 * 写入某项目的用户意见（合并进已有 entries，不动其它项目）。任何失败 → {ok:false}。
 * @param {string} specPath
 * @param {object} prefs
 */
function save(specPath, prefs) {
  try {
    const f = prefsFile(specPath);
    const key = scopeKey(specPath);
    if (!f || !key) return { ok: false, reason: 'no_spec_path' };
    let raw = { version: 1, entries: {} };
    if (fs.existsSync(f)) {
      try {
        const r = JSON.parse(fs.readFileSync(f, 'utf8'));
        if (r && typeof r === 'object') { raw = r; if (!raw.entries) raw.entries = {}; }
      } catch (_) { /* 损坏则重建，不让脏数据阻断 */ }
    }
    const p = prefs || {};
    raw.version = raw.version || 1;
    raw.entries[key] = {
      optedOutStart: !!p.optedOutStart,
      optedOutHard: !!p.optedOutHard,
      supplements: (p.supplements && typeof p.supplements === 'object') ? p.supplements : {},
      declinedCats: Array.isArray(p.declinedCats) ? p.declinedCats.slice() : [],
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(f, JSON.stringify(raw, null, 2));
    return { ok: true, file: f, key: key };
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e) };
  }
}

module.exports = { load, save, scopeKey, prefsFile, emptyPrefs, FILE_NAME };
