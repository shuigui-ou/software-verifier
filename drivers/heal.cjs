'use strict';
/**
 * heal.cjs —— 自愈定位器（Healer 角色）【T3b 重构后】
 *
 * v1.5 T3b：自愈逻辑从「playwright page.evaluate 浏览器内打分」迁移到驱动无关 handle 模型，
 * 真实现位于 drivers/heal-adapter.cjs（scoreElement + 三驱动 HealAdapter + heal*Sel(adapter, ...)）。
 * 本文件仅做兼容 re-export，保持 dom.js / miniprogram.js / appium.js 的 import 行不变。
 *
 * 稳定信号优先级（分数越高越可信，与旧版一致）：
 *   data-testid 精确/包含  >  aria-label 包含  >  role + 文本  >  class 包含  >  文本包含  >  tag
 */
const adapter = require('./heal-adapter.cjs');

module.exports = {
  parseSel: adapter.parseSel,
  scoreElement: adapter.scoreElement,
  healClickSel: adapter.healClickSel,
  healFillSel: adapter.healFillSel,
  healWaitSel: adapter.healWaitSel,
  createHealAdapter: adapter.createHealAdapter,
};
