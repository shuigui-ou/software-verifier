#!/usr/bin/env node
/**
 * mcp-server.cjs —— software-verifier 的 MCP（Model Context Protocol）服务端
 *
 * 零依赖：用原生 Node 进程 stdin/stdout 实现 JSON-RPC 2.0（MCP 传输层），
 * 不需要 @modelcontextprotocol/sdk。让「别的 agent / 别的 skill」能直接调用
 * 本 skill 的验证能力（浏览器走查 / 自愈 / 视觉回归），而不必加载整个 skill 指令。
 *
 * 暴露的工具：
 *   - verify_run      : 跑一次完整验证（复用 verify.cjs 引擎），返回 result 摘要
 *   - browser_run     : 起一个浏览器会话，顺序执行 steps + asserts，返回结果/自愈/视觉
 *   - heal_selector   : 给定失效选择器，自愈找回等价元素（返回候选与策略）
 *   - visual_capture  : 为某页面建立视觉基线（布局指纹）
 *   - visual_diff     : 与已存视觉基线比对，返回位移/消失/新增 + 严重度
 *
 * 注册（~/.workbuddy/mcp.json）：
 * {
 *   "mcpServers": {
 *     "software-verifier": {
 *       "command": "C:/Users/199720.PC2775/.workbuddy/binaries/node/versions/22.22.2/node.exe",
 *       "args": ["C:/Users/199720.PC2775/.workbuddy/skills/software-verifier/mcp-server.cjs"],
 *       "env": { "PW_CORE": "C:/Users/199720.PC2775/.workbuddy/binaries/node/versions/22.22.2/node_modules/playwright-core" }
 *     }
 *   }
 * }
 *
 * 日志一律走 stderr，绝不写 stdout（避免污染 JSON-RPC 协议流）。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const { spawn } = require('child_process');

const SKILL_DIR = __dirname;
const PW_CORE = process.env.PW_CORE ||
  'C:/Users/199720.PC2775/.workbuddy/binaries/node/versions/22.22.2/node_modules/playwright-core';
const NODE = process.env.SV_NODE || 'C:/Users/199720.PC2775/.workbuddy/binaries/node/versions/22.22.2/node.exe';

const log = (...a) => process.stderr.write('[mcp] ' + a.join(' ') + '\n');

const { makeDomDriver } = require(path.join(SKILL_DIR, 'drivers', 'dom.js'));
const { healClickSel, healFillSel } = require(path.join(SKILL_DIR, 'drivers', 'heal.cjs'));
const { runStep, runAssert } = require(path.join(SKILL_DIR, 'engine.cjs'));
const visual = require(path.join(SKILL_DIR, 'drivers', 'visual.cjs'));

const TOOLS = [
  {
    name: 'verify_run', description: '运行一次完整功能验证（复用 verify.cjs 引擎），返回 result.json 摘要。',
    inputSchema: {
      type: 'object',
      properties: {
        specPath: { type: 'string', description: 'spec.json 绝对路径' },
        url: { type: 'string', description: '被测软件 baseUrl' },
        driver: { type: 'string', enum: ['browser', 'electron', 'miniprogram', 'appium'] },
        uiOnly: { type: 'boolean' }, ai: { type: 'boolean' },
        only: { type: 'string', description: '逗号分隔的功能 ID' }, also: { type: 'string' }
      },
      required: ['specPath', 'url']
    }
  },
  {
    name: 'browser_run', description: '起一个浏览器会话，顺序执行 steps + asserts，返回每步结果、自愈与视觉变化。无需 spec 文件。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' }, driver: { type: 'string', enum: ['browser', 'electron'] },
        steps: { type: 'array', description: '步骤 DSL 数组（同 SKILL.md steps）' },
        asserts: { type: 'array', description: '断言数组（同 SKILL.md asserts）' },
        sel: { type: 'string', description: '可选：关注这些选择器的视觉指纹' }
      },
      required: ['url']
    }
  },
  {
    name: 'heal_selector', description: '给定失效的 CSS 选择器，用稳定信号自愈找回等价元素。返回候选策略与是否成功。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' }, sel: { type: 'string', description: '失效的选择器' },
        action: { type: 'string', enum: ['click', 'fill'] }, value: { type: 'string', description: 'action=fill 时填的值' }
      },
      required: ['url', 'sel']
    }
  },
  {
    name: 'visual_capture', description: '为当前页面建立视觉基线（DOM 布局指纹，零依赖）。',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string' }, name: { type: 'string', description: '基线名（任意，作为基线 key）' }, sel: { type: 'string' } },
      required: ['url', 'name']
    }
  },
  {
    name: 'visual_diff', description: '与已存视觉基线比对，返回 moved/disappeared/appeared 与 severity。',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string' }, name: { type: 'string' }, sel: { type: 'string' }, moveThreshold: { type: 'number' } },
      required: ['url', 'name']
    }
  }
];

// ---------- 浏览器会话辅助 ----------
async function withBrowser(url, fn) {
  const drv = makeDomDriver('browser', PW_CORE);
  let page;
  try {
    const r = await drv.launch({});
    page = r.page;
    await drv.goto(url);
    await drv.wait(800);
    return await fn(drv, page);
  } finally {
    if (drv) await drv.close().catch(() => {});
  }
}

function visualBase(app, name) {
  return path.join(SKILL_DIR, 'evolution', 'visual-baselines', (app + '_' + name).replace(/[^\w一-龥]/g, '_').slice(0, 80) + '.json');
}

// ---------- 工具分发 ----------
async function handleTool(params, id) {
  try {
    const name = params.name;
    const args = params.arguments || {};
    if (name === 'verify_run') {
      const out = path.join(path.dirname(args.specPath), 'verify_report');
      const cli = [path.join(SKILL_DIR, 'verify.cjs'), '--spec', args.specPath, '--url', args.url, '--out', out];
      if (args.driver) cli.push('--driver', args.driver);
      if (args.uiOnly) cli.push('--ui-only');
      if (args.ai) cli.push('--ai', 'on');
      if (args.only) cli.push('--only', args.only);
      if (args.also) cli.push('--also', args.also);
      await runChild(cli);
      const result = JSON.parse(fs.readFileSync(path.join(out, 'result.json'), 'utf8'));
      return ok(id, { summary: result.summary, healTotal: result.healTotal || 0, features: (result.features || []).map(f => ({ id: f.id, name: f.name, pass: f.pass, errors: f.errors })) });
    }
    if (name === 'browser_run') {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-mcp-'));
      const SHOTS = path.join(tmp, 'shots'); fs.mkdirSync(SHOTS, { recursive: true });
      const BASE = (args.url || '').replace(/\/$/, '');
      const ctx = { BASE, SHOTS, SKILL_DIR, visualBase: (n) => visualBase('mcp', n) };
      const res = await withBrowser(args.url, async (drv) => {
        const steps = [];
        for (const s of (args.steps || [])) { const r = await runStep(drv, s, ctx); steps.push({ do: s.do, ...r }); }
        const asserts = [];
        for (const a of (args.asserts || [])) { const ar = await runAssert(drv, a, ctx); asserts.push({ desc: a.desc || a.sel || a.eval || a.includes || a.visual || '', ...ar }); }
        return { steps, asserts, heals: drv.heals.slice() };
      });
      return ok(id, res);
    }
    if (name === 'heal_selector') {
      const r = await withBrowser(args.url, async (drv, page) => {
        const h = args.action === 'fill'
          ? await healFillSel(page, args.sel, args.value || '')
          : await healClickSel(page, args.sel, 0);
        return h;
      });
      return ok(id, r);
    }
    if (name === 'visual_capture') {
      const bp = visualBase('mcp', args.name);
      const r = await withBrowser(args.url, async (drv) => {
        const cur = await drv.visualCapture({ sel: args.sel });
        fs.mkdirSync(path.dirname(bp), { recursive: true });
        fs.writeFileSync(bp, JSON.stringify(cur));
        return { elements: cur.n, baseline: bp };
      });
      return ok(id, r);
    }
    if (name === 'visual_diff') {
      const bp = visualBase('mcp', args.name);
      if (!fs.existsSync(bp)) return ok(id, { ok: false, error: 'no-baseline', hint: '请先用 visual_capture 建立基线: ' + args.name });
      const r = await withBrowser(args.url, async (drv) => {
        const cur = await drv.visualCapture({ sel: args.sel });
        const base = JSON.parse(fs.readFileSync(bp, 'utf8'));
        return drv.visualDiff(base, cur, { moveThreshold: args.moveThreshold || 12 });
      });
      return ok(id, r);
    }
    return err(id, -32602, '未知工具: ' + name);
  } catch (e) {
    return err(id, -32603, (e && e.message) || String(e));
  }
}

function runChild(cli) {
  return new Promise((resolve, reject) => {
    const p = spawn(NODE, cli, { env: Object.assign({}, process.env, { PW_CORE }), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', er = '';
    p.stdout.on('data', d => out += d);
    p.stderr.on('data', d => er += d);
    p.on('close', code => { if (code === 0) resolve(out); else reject(new Error('verify_run 退出码 ' + code + '\n' + er.slice(0, 800))); });
  });
}

function ok(id, data) { send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] } }); }
function err(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }

function send(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }

// ---------- JSON-RPC 主循环 ----------
const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', async (line) => {
  const t = line.trim();
  if (!t) return;
  let req;
  try { req = JSON.parse(t); } catch (e) { return; }
  const id = req.id;
  if (req.method === 'initialize') {
    return send({ jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'software-verifier', version: '1.1.0' } } });
  }
  if (req.method === 'notifications/initialized') return; // 通知，无回复
  if (req.method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
  if (req.method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
  if (req.method === 'tools/call') return handleTool(req.params, id);
  if (id != null) send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found: ' + req.method } });
});
rl.on('close', () => process.exit(0));
log('software-verifier MCP server 已启动（stdio）。');
