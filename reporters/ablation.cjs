/**
 * reporters/ablation.cjs —— 受控消融（Controlled Ablation）数据分析
 *
 * v1.4.6 随 --ablate 引入。输入 N+1 份 result.json（1 份基线 + N 份"去掉 k 个因子"），
 * 产出三样东西：
 *   ① Δ 矩阵：行=被排除组合，列=功能点，单元格=该组合下该点的 PASS/FAIL（null=本次未运行）
 *   ② 翻转摘要：某个因子被去掉后，其余功能点里谁从 ✅ 翻 ❌（或反之）→ 因子交互 / 掩盖关系
 *   ③ 假消融嫌疑：spec.featureDependencies 声明了前置关系时，翻转点恰好依赖被排除因子 → 提示人工复核
 *
 * 设计注意：被排除的功能点在该次运行中根本不存在，其状态记 null，绝不因此判为"一致"或"翻转"。
 */
'use strict';

function build(runs, spec) {
  const featureIds = [];
  for (const r of runs || []) {
    for (const f of (r.features || [])) if (featureIds.indexOf(f.id) < 0) featureIds.push(f.id);
  }
  const base = (runs || []).find(r => !(r.exclude && r.exclude.length)) || (runs || [])[0] || { features: [] };
  const baseStates = {};
  for (const f of (base.features || [])) baseStates[f.id] = !!f.pass;
  const basePass = Object.keys(baseStates).filter(k => baseStates[k]).length;
  const deps = (spec && spec.featureDependencies) || {};

  const rows = (runs || []).map(r => {
    const st = {};
    for (const id of featureIds) {
      const f = (r.features || []).filter(x => x.id === id)[0];
      st[id] = f ? !!f.pass : null;
    }
    return {
      tag: r.tag,
      label: (r.exclude && r.exclude.length) ? ('去掉 ' + r.exclude.join(',')) : '基线（全部）',
      exclude: (r.exclude || []).slice(),
      states: st
    };
  });

  const flips = [];
  for (const r of (runs || [])) {
    if (!r.exclude || !r.exclude.length) continue;
    const row = rows.filter(x => x.tag === r.tag)[0];
    if (!row) continue;
    for (const id of featureIds) {
      if (r.exclude.indexOf(id) >= 0) continue; // 本次被排除，不参与翻转判定
      const b = baseStates[id], a = row.states[id];
      if (b === undefined || a === null) continue;
      if (b === a) continue;
      // spec.featureDependencies 的语义是「键 = 依赖方，值 = 其前置」。
      // 因此翻转若由「某个被排除项恰好是它的前置」引起 → 假消融嫌疑（前置缺失，而非因子交互）。
      // 旧实现写成 dependents.indexOf(id)：拿翻转点去查它自己的前置列表，恒为 false → 嫌疑永不触发。
      const prereqs = deps[id] || [];
      const suspect = r.exclude.some(ex => prereqs.indexOf(ex) >= 0);
      flips.push({
        excluded: r.exclude.join(','), feature: id,
        basePass: b, pass: a,
        direction: b ? 'PASS→FAIL' : 'FAIL→PASS',
        suspect: suspect,
        suspectReason: suspect ? ('「' + id + '」在 spec.featureDependencies 中声明依赖 ' + r.exclude.join(',') + '，翻转可能由前置缺失而非因子本身引起') : ''
      });
    }
  }

  return {
    featureIds: featureIds,
    baseTag: base.tag,
    rows: rows,
    flips: flips,
    generatedAt: new Date().toISOString(),
    summary: {
      totalRuns: (runs || []).length,
      baseline: { pass: basePass, total: Object.keys(baseStates).length, fail: Object.keys(baseStates).length - basePass },
      flipCount: flips.length,
      suspectCount: flips.filter(f => f.suspect).length,
      independent: flips.length === 0
    }
  };
}

const cell = (v) => (v === true ? '✅' : (v === false ? '❌' : '—'));
const esc = (s) => String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function renderMarkdown(d) {
  let md = '# 受控消融报告（Ablation）\n\n';
  md += '- 基线：`' + esc(d.baseTag) + '`\n';
  md += '- 功能点：' + (d.featureIds || []).join(', ') + '\n';
  md += '- 运行次数：' + d.summary.totalRuns + '（基线 1 + 去因子 ' + (d.summary.totalRuns - 1) + '）\n';
  md += '- 基线结果：**' + d.summary.baseline.pass + '/' + d.summary.baseline.total + ' 通过**（失败 ' + d.summary.baseline.fail + '）\n';
  md += '- 翻转：' + d.summary.flipCount + ' 处' + (d.summary.suspectCount ? '（含假消融嫌疑 ' + d.summary.suspectCount + ' 处）' : '') + '\n\n';

  md += '## Δ 矩阵\n\n';
  md += '| 组合 | 排除 | ' + (d.featureIds || []).join(' | ') + ' |\n|---|---|';
  for (const i in (d.featureIds || [])) md += '---|';
  md += '\n';
  for (const row of (d.rows || [])) {
    md += '| ' + esc(row.label) + ' | ' + (row.exclude.length ? esc(row.exclude.join(',')) : '无') + ' | ';
    for (const id of d.featureIds) md += cell(row.states[id]) + ' | ';
    md += '\n';
  }
  md += '\n> `—` 表示该功能点在此组合中被排除、本次未运行，不参与翻转判定。\n';

  md += '\n## 翻转摘要（因子交互 / 掩盖关系）\n\n';
  if (!d.flips.length) {
    md += '未观察到任何翻转：**各因子独立，去除任一均不改变其余功能点状态**。\n';
  } else {
    for (const f of d.flips) {
      md += '- 去掉 `' + esc(f.excluded) + '` → `' + esc(f.feature) + '` **' + f.direction + '**';
      if (f.suspect) md += ' ⚠️ **假消融嫌疑**：' + esc(f.suspectReason);
      md += '\n';
    }
  }

  md += '\n## 方法学警示\n\n';
  md += '- 消融结论只在「各次运行互相独立」时成立。本工具用独立子进程保证每组有干净会话；\n';
  md += '- 若 spec 的功能点存在 **setup 顺序依赖**（后续功能点依赖前序的副作用/登录态），去掉前置点会改变后续 setup，\n';
  md += '  造成**假消融**——此时翻转未必反映因子本身的交互。请用 `spec.featureDependencies: { "F01": ["F02"] }` 声明前置关系，\n';
  md += '  本工具会把这类翻转标记为「假消融嫌疑」。未声明时请人工复核前置关系。\n';
  return md;
}

function renderHtml(d) {
  const head = (d.featureIds || []).map(id => '<th>' + esc(id) + '</th>').join('');
  const rows = (d.rows || []).map(row => {
    const tds = (d.featureIds || []).map(id => {
      const v = row.states[id];
      const cls = v === true ? 'pass' : (v === false ? 'fail' : 'na');
      return '<td class="' + cls + '">' + cell(v) + '</td>';
    }).join('');
    return '<tr><td>' + esc(row.label) + '</td><td>' + esc(row.exclude.join(',') || '无') + '</td>' + tds + '</tr>';
  }).join('');
  const flips = (d.flips || []).map(f => '<li>去掉 <code>' + esc(f.excluded) + '</code> → <code>' + esc(f.feature) + '</code> <b>' + esc(f.direction) + '</b>' + (f.suspect ? ' ⚠️ 假消融嫌疑' : '') + '</li>').join('');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>消融报告</title>
<style>
body{font-family:-apple-system,Segoe UI,Roboto,'Microsoft YaHei',sans-serif;background:#f6f7f9;color:#1c1e21;margin:0;padding:24px}
h1{font-size:19px;margin:0 0 8px}
.meta{color:#666;font-size:13px;margin-bottom:14px}
table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #e3e6ea;border-radius:10px;overflow:hidden}
th,td{text-align:left;padding:8px 11px;border-bottom:1px solid #eef0f2;font-size:13px}
th{background:#f0f2f5;font-weight:600}
td.pass{color:#1a7f37}td.fail{color:#c0392b;font-weight:600}td.na{color:#aaa}
.box{background:#fff;border:1px solid #e3e6ea;border-radius:10px;padding:12px 16px;margin-top:16px;font-size:13px}
.warn{border-left:4px solid #d68910;padding-left:10px;color:#7a5b12}
</style></head><body>
<h1>受控消融报告（Ablation）</h1>
<div class="meta">基线 ${esc(d.baseTag)} · 运行 ${d.summary.totalRuns} 次 · 基线 ${d.summary.baseline.pass}/${d.summary.baseline.total} 通过 · 翻转 ${d.summary.flipCount} 处</div>
<table><thead><tr><th>组合</th><th>排除</th>${head}</tr></thead><tbody>${rows}</tbody></table>
<div class="box"><b>翻转摘要</b><ul>${flips || '<li>未观察到翻转：各因子独立</li>'}</ul>
<div class="warn"><b>方法学警示</b>：若功能点存在 setup 顺序依赖，去掉前置点会改变后续 setup，造成假消融；用 spec.featureDependencies 声明前置关系后本工具会自动标记嫌疑。</div>
</div></body></html>`;
}

module.exports = { build, renderMarkdown, renderHtml };
