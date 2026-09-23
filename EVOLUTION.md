# agent-evolution 接入脚手架（turnkey）

让一个**全新/独立项目**用最小成本接入 agent-evolution，拿到「 recurring 错误自动捕获 → 经验 playbook → 审计留痕」的能力。无需写接线代码。

## 三步接入

1. 把本目录的 `evolution-host.cjs` + `evolution.yaml` + `seeds/` + `EVOLUTION.md` 放进项目根（接入文档会写成 `EVOLUTION.md`，不会覆盖你既有的 `README.md`）。
2. 在入口或构建脚本里：

   ```js
   const evo = require('./evolution-host.cjs');
   evo.init({ autoStart: true });   // autoStart 启动 5 分钟周期分析
   ```

3. 在报错点把错误喂进来（一行，零语法负担）：

   ```js
   try { await doBuild(); }
   catch (err) { evo.tapError(err, { taskId: 'build' }); }
   // 或命令结果：
   evo.tapToolResult(result, { taskId: 'test' });
   ```

## 引擎 / 内核从哪来（无需手写）

`evolution-host.cjs` 按以下顺序解析，**宿主不用管路径**：

- 引擎：`EVOLUTION_ENGINE_PATH`（ENV）> 项目内 `lib/evolution-engine/engine.cjs`
- 内核：`EVOLUTION_KERNEL_ROOT`（ENV）> `evolution.yaml` 的 `kernel.kernelRoot` > 引擎内置共享内核

生产建议：把 `agent-evolution/engine` 与 `agent-evolution/kernel/src` 复制到宿主 `lib/evolution-engine` 与 `lib/evolution-kernel`（vendor），再提交。验证期可临时设置 ENV 指向 agent-evolution 仓库免 vendor。

## 拿到什么（从宿主视角）

| 能力 | 触发 | 产出 |
|------|------|------|
| recurring 错误捕获 | `tapError` / `tapE` | 指纹归一入账本，同类错误自动归并 |
| 即时 playbook | 种子 `seeds/common-pitfalls.jsonl` | 命中已知坑 → 候选修复建议（如 EADDRINUSE→查端口杀进程） |
| 周期分析 | `analyze.intervalMs` / `start()` | 自动跑八步链路：归因→候选→实证选优→落地 |
| 审计留痕 | 每条动作 | 哈希链可 `status().auditVerify` 校验 |
| 失败兜底 | 全部 | **fail-open**：引擎未就绪/降级时方法返回 `{ok:false}` 不抛，宿主主流程不受影响 |

## 可调项（evolution.yaml）

- `meta.agent`：改成你的项目名（进审计）。
- `knowledge.whitelist`：声明受管知识面（越权写/读被拒）。
- `objectives`：声明你想压制的错误类型与权重。
- `analyze.intervalMs`：周期分析间隔（默认 5 分钟）。
- `kernel.level`：`auto_report`（默认，自动落地+报告）/ `ask` / `off`。

详见仓库 `docs/EVOLUTION-YAML.md`。

## 已落地：行为闭环（本宿主 software-verifier）

上面的三步只做"**写侧**"（把错误喂进引擎）。**只写不读 = 学到的经验没人用**，对宿主零改进。
本宿主进一步把回路**闭合到行为**：

```
报错 → tapError（写侧：verify.cjs 5 处报错点）
     → 引擎按 fingerprint 归并复发记忆（.evolution/signals/signals.jsonl）
     → 下次动作前读取：recurringErrors() + preActionGate()（读侧）
     → 命中复发风险 → preflight 自愈（行为）：launch 前探测端口，占用则改用空闲端口
     → status()/审计链显性化（报告回显，不再"没人看"）
```

- 读取侧 API：`evo.recurringErrors({ minHits })`、`evo.preActionGate({ action })`。
- 执行器：`preflight.cjs`（`portRisk` / `ensureFreePort`）——首个策略是"端口占用自愈"（把反复出现的 EADDRINUSE 变成不再发生）。
- 结果回写：`evo.reportOutcome({ lane, key, verdict })`（可选增强；内核也会从事件流自动推导）。
- 全程 fail-open；**不改宿主任何既有文件**。
- 已知边界：引擎 `tapError` 的 fingerprint 含调用栈（去数字/路径后仍含函数名），故**同宿主同一调用点**复发可稳定归并；**跨宿主**同源错误因栈形状不同可能指纹不同——跨宿主共享是后续课题。

## 已落地：复发哨兵（让 loop 不再自欺）

**问题**：引擎会为复发错误不断"落地"候选、版本号一路涨（实测 `element intercepts pointer events` v1.0.1→v1.0.2→v1.0.3），**却一次没止住复发** —— 有动作、无进展，且没人发现。

**做法**：`evo.recurrenceSentinel({ minRecur })` 读 `.evolution/signals/signals.jsonl` + `reports/reports.jsonl`，对每个指纹判定"空转"（任一命中即判候选无效）：

1. **同一指纹被 land ≥2 次** → 反复落地 = 前次候选没止住（核心信号）；
2. **首次 land 之后该指纹仍复发 ≥ minRecur 次**。

判定后**回写否决**：`kernel.recordVeto(fp, candidateId, …)`（同候选对同指纹被否 ≥2 次 → 黑名单，后续选优自动排除）。`verify.cjs` 收尾会显性打印，例如：

```
⚠ 复发哨兵：1 个指纹在"落地后仍复发" → 判定候选无效（已否决 3 个）
   • fdfb44b9ee4030b8 v1.0.3 已落地 3 次、首次落地后仍复发 12 次：element intercepts pointer events
```

**为什么不能只看"最后一次 land 之后"**：实测该指纹 18 次信号分布在 3 次 land 之间（land#1 后复发 12 次、land#2 后 6 次、land#3 后 0 次，因运行结束）——只看末次会漏判为"无复发"。**必须同时统计"被反复 land"**。

## 已落地：遮挡自愈（直面复发最狠的一条）

**问题**：`element intercepts pointer events`（单次运行复发 ≥18 次）——`clickSel` 走 Playwright 可操作性检查，元素被 loading 遮罩/模态挡住即报错，整个功能点判失败。

**做法**（`drivers/dom.js` 的 `robustClick` 三档阶梯 + `waitSel` 同步自愈）：

| 档 | 动作 | strategy |
|----|------|----------|
| ① | 正常 `el.click()` | （无，plain） |
| ② | `dismissOverlays()`（Esc + 点常见关闭按钮 + 等遮罩消失）后重试 | `overlay-wait` |
| ③ | 兜底**原生 DOM** `el.evaluate(e => e.click())` | `dom-click` |

命中兜底会记入 `heals`，报告「自愈记录」可见（逐功能点）。

> ⚠ **关键坑（已踩）**：兜底**不能**用 Playwright 的 `click({force:true})`。实测它对被永久遮罩盖住的按钮 **handler 触发 0 次** —— force 只按坐标派发事件，事件打在遮罩上，**不报错却没点到（静默失效）**；原生 `el.click()` 触发 **1 次**。静默失效比失败更危险，故弃用 force。

**实测（真实 msedge 无头 + 合成遮挡页）**：模态遮罩→`overlay-wait` ✅；永久遮罩→`dom-click` 且 handler 确实触发 ✅；正常路径行为不变（非干扰）✅。

## 已知边界（诚实披露）

- 复发哨兵的"空转"判定依赖 `.evolution/reports` 的 `decisions`（我们自己落的 report），若引擎切到别的落地面需同步。
- 遮挡自愈档 ③（`dom-click`）绕过命中测试：对"必须由真实鼠标事件驱动"的控件（如某些 canvas/手势）可能不生效——此时 `heals` 会如实记录，报告可见。
- `dismissOverlays` 会等待"所有遮罩都消失"，页面若存在永久遮罩，本档固定消耗约 2.5s（仅失败路径，fail-open）。
