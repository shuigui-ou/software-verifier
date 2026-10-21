'use strict';
/**
 * reporters/layer1.cjs —— Layer 1 落盘与报告
 *
 * 把 explore.cjs 的发现落盘为：
 *   - artifacts/layer1-findings.json  （机器可读，含 summary + findings）
 *   - artifacts/layer1-报告.md        （人类可读）
 *
 * 落盘目录为独立 artifacts/，不进 .evolution/ 隐私区（spec §4）。
 * summary 层携带 anchorSource 与 coverage（锚点缺失时为 'not-computable'）。
 */

const fs = require('fs');
const path = require('path');

function defaultOutDir() {
  return path.join(process.cwd(), 'artifacts');
}

/**
 * @param {{findings:object[], summary:object, outDir?:string}} input
 * @returns {{jsonPath:string, mdPath:string}}
 */
function writeReport(input) {
  const findings = Array.isArray(input.findings) ? input.findings : [];
  const summary = input.summary || {};
  const outDir = input.outDir ? path.resolve(input.outDir) : defaultOutDir();
  fs.mkdirSync(outDir, { recursive: true });

  const jsonPath = path.join(outDir, 'layer1-findings.json');
  const mdPath = path.join(outDir, 'layer1-报告.md');

  // ---- JSON 落盘 ----
  const payload = {
    summary,
    findings,
    generatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2), 'utf8');

  // ---- Markdown 报告 ----
  const lines = [];
  lines.push('# Layer 1 探索报告');
  lines.push('');
  lines.push('> 生成时间：' + payload.generatedAt);
  lines.push('');
  lines.push('## 摘要');
  lines.push('');
  lines.push('- 锚点来源（anchorSource）：`' + (summary.anchorSource == null ? '无' : summary.anchorSource) + '`');
  lines.push('- 覆盖率（coverage）：`' + (summary.coverage === 'not-computable' ? 'not-computable（锚点缺失，未回退自发现集合）' : (summary.coverage * 100).toFixed(1) + '%') + '`');
  lines.push('- 声明页面数：' + (summary.declaredPages == null ? '—' : summary.declaredPages));
  lines.push('- 已到达页面数：' + (summary.reachedPages == null ? '—' : summary.reachedPages));
  if (summary.elementCoverage) {
    lines.push('- 元素级覆盖（elementCoverage，独立指标）：' + (summary.elementCoverage.ratio * 100).toFixed(1) + '%（' + summary.elementCoverage.reached + '/' + summary.elementCoverage.declared + '）');
  } else {
    lines.push('- 元素级覆盖（elementCoverage）：未提供元素锚点，null');
  }
  lines.push('- 发现总数：' + findings.length);
  lines.push('');

  // 按 oracle 汇总
  const byOracle = {};
  const byConf = {};
  for (const f of findings) {
    byOracle[f.oracle] = (byOracle[f.oracle] || 0) + 1;
    byConf[f.confidence] = (byConf[f.confidence] || 0) + 1;
  }
  lines.push('## 分类统计');
  lines.push('');
  lines.push('### 按 oracle');
  lines.push('');
  for (const k of Object.keys(byOracle)) lines.push('- ' + k + '：' + byOracle[k]);
  lines.push('');
  lines.push('### 按 confidence');
  lines.push('');
  for (const k of Object.keys(byConf)) lines.push('- ' + k + '：' + byConf[k]);
  lines.push('');

  // 发现明细
  lines.push('## 发现明细');
  lines.push('');
  if (findings.length === 0) {
    lines.push('_无发现。_');
  } else {
    for (const f of findings) {
      lines.push('### [' + f.id + '] ' + f.oracle + ' / ' + f.confidence);
      lines.push('');
      lines.push('- layer：' + f.layer);
      lines.push('- suspect：' + f.suspect);
      lines.push('- businessPass：' + f.businessPass);
      lines.push('- falsePositiveNote：' + (f.falsePositiveNote || '（无）'));
      lines.push('- reproPath：' + (Array.isArray(f.reproPath) && f.reproPath.length ? f.reproPath.join(' → ') : '（空）'));
      if (f.evidence && Object.keys(f.evidence).length) {
        lines.push('- evidence：```json');
        lines.push(JSON.stringify(f.evidence, null, 2));
        lines.push('```');
      }
      lines.push('');
    }
  }

  fs.writeFileSync(mdPath, lines.join('\n'), 'utf8');
  return { jsonPath, mdPath };
}

module.exports = { writeReport, defaultOutDir };
