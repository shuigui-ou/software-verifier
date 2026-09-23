/**
 * @module audit
 * @layer L1 数据层（审计链）
 * @owner Kou（工程师，K1）
 *
 * 规范 §4 审计链：append-only hash chain，可离线校验完整性。
 * 记录结构：{ seq, ts, type, payload, prev, hash }
 *   hash = sha256(JSON({seq, ts, type, payload, prev}))
 *   prev = 上一条 hash（首条为 'GENESIS'）
 * 任何篡改（改内容 / 删行 / 插行）都会导致 verify() 断链。
 *
 * 并发语义（BUG：跨进程 append 链尾分叉修复，2026-09）：
 *  - 旧实现启动时把全链读入内存，append 基于"内存链尾"算 seq/prev —— 若另一进程
 *    在本实例启动后先 append，内存链尾陈旧 → seq 重复 / prev 指向旧 hash → verify() 断链。
 *  - 现实现 append 前强制以【磁盘最新链尾】为准（refreshFromDisk：磁盘尾与内存尾不一致
 *    即整链重载），并加进程级互斥锁文件（wx 原子创建，带陈旧检测 + 超时 fail-open），
 *    使并发 append 顺序化，从机制上消除"内存链尾陈旧"这一分叉主因。
 *  - 仍为 append-only：只 push/追加，不提供任何改/删接口。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { KernelError, sha256hex, readJsonl, appendJsonl, nowIso } = require('./util.cjs');

/** 创世 prev 值 */
const GENESIS = 'GENESIS';

/** 锁文件陈旧判定：超过 10s 视为崩溃残留，可清理接管 */
const LOCK_STALE_MS = 10 * 1000;
/** 锁获取总等待上限：超时则 fail-open（不加锁直接写，宁可竞争窗口也不拖垮宿主） */
const LOCK_WAIT_MS = 2 * 1000;
/** 锁重试轮询间隔（忙等粒度） */
const LOCK_POLL_MS = 5;
/** 降级冷却窗口：一次 fail-open 后，进程内后续取锁只做有限次非阻塞尝试，不再各付满 LOCK_WAIT_MS */
const LOCK_COOLDOWN_MS = 30 * 1000;

function computeRecordHash(rec) {
  return sha256hex(
    JSON.stringify({ seq: rec.seq, ts: rec.ts, type: rec.type, payload: rec.payload, prev: rec.prev })
  );
}

/** 同步忙等（Atomics.wait 不占 CPU 自旋；Node 主线程可用） */
function sleepSync(ms) {
  try {
    const sab = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(sab, 0, 0, ms);
  } catch (_e) {
    /* 极端环境无 SharedArrayBuffer 时退化为空转上限 */
  }
}

/**
 * 创建审计链
 * @param {object} opts
 * @param {string} [opts.dataDir='runtime']
 */
function createAudit({ dataDir = 'runtime' } = {}) {
  const file = path.join(dataDir, 'audit', 'audit.jsonl');
  const lockFile = file + '.lock';
  const chain = readJsonl(file);

  /**
   * 锁降级现场（本实例）：null = 从未降级。
   * 非空即表示"锁不可用，已按 fail-open 不加锁继续"——调用方可据此告警，
   * 避免接入方只能看到"什么都没发生"。
   * @type {{at: string, waitedMs: number, code: string|null, message: string}|null}
   */
  let lockDegrade = null;
  /** 降级告警只打一次，避免被写在阻塞路径上的日志淹没 */
  let lockDegradeWarned = false;
  /** 降级冷却截止时刻（0=不在冷却）。冷却期间取锁不再等待，只做有限次非阻塞尝试。 */
  let lockCooldownUntil = 0;

  /**
   * 记录一次锁降级（并打一行可见告警）。
   * @param {number} waitedMs 已等待毫秒
   * @param {Error|null} err 最后一次失败原因（可为 null）
   */
  function noteLockDegrade(waitedMs, err) {
    lockDegrade = {
      at: nowIso(),
      waitedMs,
      code: err && err.code ? String(err.code) : null,
      message: err && err.message ? String(err.message).slice(0, 300) : String(err || 'lock-unavailable'),
    };
    lockCooldownUntil = Date.now() + LOCK_COOLDOWN_MS;
    if (lockDegradeWarned) return;
    lockDegradeWarned = true;
    try {
      console.warn(
        '[evolution-kernel/audit] 审计锁不可用，已降级为不加锁继续（fail-open）：等待 ' +
          waitedMs + 'ms 后放弃；最后一个错误 code=' + lockDegrade.code + ' :: ' + lockDegrade.message
      );
    } catch (_e) {
      /* 极端环境无 console 时忽略 */
    }
  }

  /** 末条记录（内存链尾） */
  function last() {
    return chain.length ? chain[chain.length - 1] : null;
  }

  /**
   * 读磁盘文件最后一条有效记录（不重建整链；文件不存在 → null）。
   * @returns {object|null}
   */
  function readDiskTail() {
    if (!fs.existsSync(file)) return null;
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (_e) {
      return null;
    }
    const lines = raw.split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i--) {
      const t = lines[i].trim();
      if (!t) continue;
      try {
        return JSON.parse(t);
      } catch (_e) {
        return null; // 末行损坏 → 交由 verify() 检出，不臆测链尾
      }
    }
    return null;
  }

  /**
   * 以磁盘链尾为准同步内存链：
   *  - 磁盘尾与内存尾一致 → 无需处理（同一进程常规追加零额外开销）；
   *  - 磁盘尾更新（另一进程已续写 / 新实例基于磁盘续写）→ 整链重载；
   *  - 磁盘尾缺失但内存非空（文件被外部清空）→ 保持内存（不臆造断链），后续 append 重建文件。
   */
  function refreshFromDisk() {
    const diskTail = readDiskTail();
    const memTail = last();
    if (diskTail && memTail && diskTail.hash === memTail.hash) return;
    if (!diskTail && !memTail) return;
    if (!diskTail) return; // 文件不存在/空：内存链视为有效（appendJsonl 会重建文件）
    chain.length = 0;
    chain.push(...readJsonl(file));
  }

  /**
   * 进程级互斥锁（基于文件系统 wx 原子创建；best-effort）。
   * @returns {{release: Function}|null} null = 无法取得锁（fail-open，不阻塞写）
   */
  function acquireLock() {
    const start = Date.now();
    // 冷却期（本进程刚经历过 fail-open）：不做任何休眠等待，最多 2 次非阻塞尝试即放弃。
    const cooling = Date.now() < lockCooldownUntil;
    let tries = 0;
    for (;;) {
      tries += 1;
      try {
        const fd = fs.openSync(lockFile, 'wx');
        fs.closeSync(fd);
        lockCooldownUntil = 0; // 锁恢复了 → 立即退出冷却，恢复正常加锁语义
        let released = false;
        return {
          release() {
            if (released) return;
            released = true;
            try {
              fs.unlinkSync(lockFile);
            } catch (_e) { /* 已被清理则忽略 */ }
          },
        };
      } catch (e) {
        if (e && e.code !== 'EEXIST') return null; // 权限等非竞争错误 → fail-open
        // 冷却态：第 2 次仍拿不到就立即放弃（上限 2 次 → 单次开销从 2000ms 降到 ~5ms）
        if (cooling && tries >= 2) {
          noteLockDegrade(Date.now() - start, e);
          return null;
        }
        // 锁已存在：陈旧检测（崩溃残留 → 清理接管）
        try {
          const st = fs.statSync(lockFile);
          if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
            fs.unlinkSync(lockFile);
            // 陈旧清理同样受总超时约束：unlink 成功但文件被反复重建时不得无限接管
            if (Date.now() - start > LOCK_WAIT_MS) {
              noteLockDegrade(Date.now() - start, null);
              return null; // 超时 → fail-open
            }
            continue;
          }
        } catch (_e2) {
          // 关键修复（2026-09-23）：stat/unlink 持续失败（锁文件存在但删不掉）时，
          // 旧实现在此直接 continue，绕过了下方唯一的超时判定 → 无退避、无上限的同步忙等；
          // sleepSync 用 Atomics.wait 同步冻住事件循环（stdout 永不 flush），
          // 表现为整轮验证静默消失（0 字节输出 / 无报告 / 进程不退出）。
          if (Date.now() - start > LOCK_WAIT_MS) {
            noteLockDegrade(Date.now() - start, _e2);
            return null; // 超时 → fail-open（兑现上方注释承诺）
          }
          sleepSync(LOCK_POLL_MS); // 退避：避免"锁删不掉"时的紧忙等
          continue;
        }
        if (Date.now() - start > LOCK_WAIT_MS) {
          noteLockDegrade(Date.now() - start, null);
          return null; // 超时 → fail-open
        }
        sleepSync(LOCK_POLL_MS);
      }
    }
  }

  /**
   * 追加一条审计记录（append-only：只 push，不提供任何改/删接口）
   * @param {string} type - 事件类型（如 KNOWLEDGE_WRITE / T4_BLOCKED / ROLLBACK）
   * @param {object} [payload]
   * @returns {object} 完整记录（含 hash）
   */
  function append(type, payload = {}) {
    if (!type || typeof type !== 'string') {
      throw new KernelError('AUDIT_INVALID', '审计记录必须有 type');
    }
    const lock = acquireLock();
    try {
      // 以磁盘最新链尾为准（消除"内存链尾陈旧"导致的 seq/prev 分叉）
      refreshFromDisk();
      const prev = last() ? last().hash : GENESIS;
      const rec = {
        seq: chain.length ? last().seq + 1 : 1,
        ts: nowIso(),
        type,
        payload,
        prev,
        hash: '',
      };
      rec.hash = computeRecordHash(rec);
      chain.push(rec);
      appendJsonl(file, rec);
      return rec;
    } finally {
      if (lock) lock.release();
    }
  }

  /**
   * 离线校验链完整性：逐条重算 hash + 校验 prev 链接 + seq 连续
   * @returns {{ok: boolean, checked: number, brokenAt: number|null, reason: string|null}}
   */
  function verify() {
    let prevHash = GENESIS;
    let expectSeq = 1;
    for (const rec of chain) {
      if (rec.seq !== expectSeq) {
        return { ok: false, checked: expectSeq - 1, brokenAt: rec.seq, reason: 'seq_gap' };
      }
      if (rec.prev !== prevHash) {
        return { ok: false, checked: expectSeq - 1, brokenAt: rec.seq, reason: 'prev_mismatch' };
      }
      if (computeRecordHash(rec) !== rec.hash) {
        return { ok: false, checked: expectSeq - 1, brokenAt: rec.seq, reason: 'hash_mismatch' };
      }
      prevHash = rec.hash;
      expectSeq += 1;
    }
    return { ok: true, checked: chain.length, brokenAt: null, reason: null };
  }

  /** 全量记录 */
  function list() {
    return chain.slice();
  }

  /** 链长度 */
  function length() {
    return chain.length;
  }

  /** 按类型过滤 */
  function listByType(type) {
    return chain.filter((r) => r.type === type);
  }

  /**
   * 锁状态（读侧用）：degraded=true 表示"本轮写入未加锁"。
   * @returns {{degraded: boolean, at?: string, waitedMs?: number, code?: string|null, message?: string}}
   */
  function lockStatus() {
    const remain = lockCooldownUntil - Date.now();
    const cooling = remain > 0;
    return Object.assign(
      { degraded: !!lockDegrade, cooling, cooldownRemainMs: cooling ? remain : 0 },
      lockDegrade || {}
    );
  }

  return { append, verify, list, listByType, length, file, lockStatus };
}

module.exports = { createAudit, GENESIS, computeRecordHash };
