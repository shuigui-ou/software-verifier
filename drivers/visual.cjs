'use strict';
/**
 * visual.cjs —— 视觉签名（零依赖视觉回归）
 *
 * 不引入任何图片库：用「DOM 布局指纹」做视觉回归，足以区分
 *   - 真缺陷：元素消失 / 被遮挡 / 报错遮罩出现 / 关键内容区塌缩
 *   - 设计变更：元素位置微调、重排、样式微调（不误报）
 *
 * captureSignature(page, opts)：截图视口内关键元素的 标签/id/class/矩形/可见性/颜色/文本 指纹。
 *   - 不传 sel：取「可见面积最大的前 40 个」元素做概览指纹（覆盖整页布局）。
 *   - 传 sel（逗号分隔选择器）：只关注这些元素（精准比对某个组件）。
 *
 * diffSignature(base, cur, opts)：用 (tag|id|cls) 作键匹配，返回
 *   moved / disappeared / appeared / severity。severity = 消失*3 + 新增*1 + 位移*0.5。
 *   调用方可设 severity 阈值：超过即判为「视觉回归失败」。
 */
function captureSignature(page, opts) {
  opts = opts || {};
  return page.evaluate(({ sel }) => {
    const vw = window.innerWidth, vh = window.innerHeight;
    let nodes = [...document.querySelectorAll('*')].filter(e => e.offsetParent);
    if (sel) {
      const set = sel.split(',').map(s => s.trim()).filter(Boolean);
      const matchSel = (e) => set.some(s => {
        if (s[0] === '#') return e.id === s.slice(1);
        if (s[0] === '.') return ('' + (e.className || '')).split(/\s+/).includes(s.slice(1));
        return e.tagName.toLowerCase() === s.toLowerCase();
      });
      nodes = nodes.filter(matchSel);
    } else {
      nodes = nodes.map(e => { const r = e.getBoundingClientRect(); return { e, area: r.width * r.height }; })
        .filter(x => x.area > 200 && x.area < vw * vh)
        .sort((a, b) => b.area - a.area).slice(0, 40).map(x => x.e);
    }
    const els = nodes.map(e => {
      const r = e.getBoundingClientRect();
      const cs = getComputedStyle(e);
      return {
        tag: e.tagName.toLowerCase(),
        id: e.id || '',
        cls: ('' + (e.className || '')).split(/\s+/).filter(Boolean).slice(0, 3).join('.'),
        rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
        vis: cs.visibility !== 'hidden' && cs.display !== 'none' && parseFloat(cs.opacity) > 0.01,
        color: (cs.color || '').slice(0, 18),
        bg: (cs.backgroundColor || '').slice(0, 18),
        text: (e.textContent || '').trim().slice(0, 30)
      };
    });
    return { vw, vh, n: els.length, els, ts: Date.now() };
  }, { sel: sel || '' });
}

function keyOf(e) {
  return (e.tag + '|' + (e.id || '') + '|' + (e.cls || '')) || ('t:' + (e.text || '').slice(0, 12));
}

function diffSignature(base, cur, opts) {
  opts = opts || {};
  const thr = opts.moveThreshold || 12;
  const bMap = new Map(base.els.map(e => [keyOf(e), e]));
  const cMap = new Map(cur.els.map(e => [keyOf(e), e]));
  const moved = [], disappeared = [], appeared = [];
  for (const [k, e] of cMap) {
    const b = bMap.get(k);
    if (!b) { appeared.push(k); continue; }
    const dx = Math.abs(e.rect[0] - b.rect[0]);
    const dy = Math.abs(e.rect[1] - b.rect[1]);
    const dw = Math.abs(e.rect[2] - b.rect[2]);
    const dh = Math.abs(e.rect[3] - b.rect[3]);
    if (dx > thr || dy > thr || dw > thr * 3 || dh > thr * 3) moved.push({ k, dx, dy, dw, dh });
  }
  for (const [k] of bMap) if (!cMap.has(k)) disappeared.push(k);
  const changed = moved.length > 0 || disappeared.length > 0 || appeared.length > 0;
  const severity = +(disappeared.length * 3 + appeared.length * 1 + moved.length * 0.5).toFixed(1);
  return { changed, moved, disappeared, appeared, severity };
}

module.exports = { captureSignature, diffSignature, keyOf };
