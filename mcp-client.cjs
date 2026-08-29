#!/usr/bin/env node
/**
 * mcp-client.cjs —— 零依赖的 MCP（Model Context Protocol）stdio 客户端
 *
 * 让 software-verifier 能「连接另一个 MCP server、列出它的工具、调用它的工具」，
 * 从而实现对「其他 MCP server」的行为/契约级验收（verify_mcp 模式的核心）。
 *
 * 不依赖 @modelcontextprotocol/sdk：原生 Node 子进程 + stdin/stdout JSON-RPC 2.0。
 * 日志一律走 stderr，绝不写 stdout。
 */
'use strict';
const { spawn } = require('child_process');

function connect({ command, args = [], env = {} }, opts = {}) {
  const timeout = opts.timeout || 30000;
  const child = spawn(command, args, {
    env: Object.assign({}, process.env, env),
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let buf = '';
  const pending = new Map();
  let seq = 0;
  let errored = false;

  child.stderr.on('data', (d) => process.stderr.write('[mcp-client] ' + d.toString()));
  child.stdout.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch (e) { continue; }
      if (msg.id != null && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else p.resolve(msg.result);
      }
    }
  });
  child.on('error', (e) => {
    errored = true;
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(e); }
    pending.clear();
  });

  function request(method, params) {
    if (errored) return Promise.reject(new Error('client 已断开'));
    const id = ++seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (pending.has(id)) { pending.delete(id); reject(new Error('MCP 请求超时: ' + method)); }
      }, timeout);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  async function initialize(clientInfo) {
    await request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: clientInfo || { name: 'software-verifier', version: '1.2.3' },
    });
    // 发送 initialized 通知（无 id，server 不回）
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  }

  async function listTools() {
    const r = await request('tools/list', {});
    return r.tools || [];
  }

  async function callTool(name, args) {
    return await request('tools/call', { name, arguments: args || {} });
  }

  function close() {
    try { child.kill('SIGTERM'); } catch (e) {}
  }

  return { initialize, listTools, callTool, close, get pid() { return child.pid; } };
}

module.exports = { connect };

// 直接运行：node mcp-client.cjs <command> [args...]  —— 连上后打印 tools/list，用于调试
if (require.main === module) {
  const target = process.argv.slice(2);
  if (!target.length) { console.error('用法: node mcp-client.cjs <command> [args...]'); process.exit(1); }
  const c = connect({ command: target[0], args: target.slice(1) });
  (async () => {
    try {
      await c.initialize();
      const tools = await c.listTools();
      console.log('tools:', tools.length);
      for (const t of tools) console.log(' -', t.name, '::', (t.description || '').slice(0, 60));
    } catch (e) {
      console.error('ERR', e.message);
      process.exit(1);
    } finally { c.close(); }
  })();
}
