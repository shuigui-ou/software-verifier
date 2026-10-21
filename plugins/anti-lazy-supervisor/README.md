# anti-lazy-supervisor · 追问-对账-门禁闭环插件

> 接入对象：**software-verifier**（Node.js / CJS 宿主）
> 目录：`plugins/anti-lazy-supervisor/`
> 零第三方依赖 · CommonJS · 对账全流程 < 10ms

---

## 它解决什么

验证器最危险的失败模式不是**测错**，而是**漏测后宣称全过**：

```
验证器：✅ 全部测试通过
实际：  8 项契约只跑了 5 项，其中 2 项（安全注入）从未执行
```

本插件做三件事，把这件事变成**可机器判定**的：

| 阶段 | 做什么 |
|---|---|
| **① 追问扩容** | 按 6 类测试点类型追问，逼验证器把"没想到要测"的说出口 |
| **② 硬对账** | 拿契约对照**真实执行日志**，抓造假与漏检 |
| **③ 门禁注入** | 有漏检就 REJECT，并注入不可篡改的监督区块 |

---

## 快速开始

```js
const C = require('./plugins/anti-lazy-supervisor/reconcile-core.cjs');
const host = require('./evolution-host.cjs');

host.init({});

// ── 阶段一：追问 ──
const session = C.createQuestioning({ initial: ['登录流程', '登出流程'], host });

let q;
while ((q = C.nextQuestion(session))) {
  const answer = askVerifier(q.prompt);        // 你的追问逻辑
  C.submitAnswer(session, q.category, answer); // 空数组 = 明确说"无"
}
C.sealQuestioning(session);                    // 全部契约写入宿主 tapPlan

// ── 阶段二：对账 ──
const execLog = C.readExecutionLog(host.dataDir());
const recon = C.reconcile(session, execLog, {
  claimed:   verifierClaims,    // 口头声明（只记录，不作数）
  skipNotes: skipReasons,       // 跳过理由（无理由 → dangling）
});

// ── 阶段三：门禁 + 注入 ──
const out = C.injectReport(hostReportText, session, recon);
if (!out.gate.allow) {
  throw new Error(out.gate.banner);   // ⛔ 报告不得落盘
}
fs.writeFileSync(reportPath, out.text);
```

---

## 五条红线（写进实现，不只是文档）

### 1. 只信执行日志，不信口头声明

验证器说"测了"但 `ledger.jsonl` 无对应记录 → **一律 `dangling`**。
这是整个插件存在的理由：否则追问逼出的契约可以随口认领。

```js
claimed[it.id] = 'completed'    // 记录了，但不作数
// → status 仍为 'dangling'，且 details[].note 标注「声称已完成但日志无记录」
```

### 2. 追问不能逼出编造

追问只是"逼他说"，不是"信他说"。产出项必须经阶段二对账，
无日志的一律漏检。

### 3. 跳过必须留痕

`skipped` 必须带**非空白**理由。无理由的跳过判 `dangling`：

```js
skipNotes[id] = '   '    // 空白 → 判漏检，不是合法跳过
skipNotes[id] = '外部 API 依赖不可用'   // → skipped
```

### 4. 报告不可篡改

监督区块由插件生成并 **prepend 到宿主报告之前**，
数据全部来自 `ledger.jsonl` / `audit.jsonl`，验证器无法手写覆盖。

### 5. 绝不抛错

任何内部异常吞掉返回 `{ok:false}`，不中断宿主验证流程。
门禁自身异常时**保守拒绝**（`allow:false`），因为"拿不到结果"≠"一切正常"。

---

## 收敛机制

| 参数 | 默认 | 说明 |
|---|---|---|
| `maxRoundsPerCategory` | 3 | 每类型最多追问 3 轮 |
| `noNewStreakToStop` | 2 | 连续 2 轮无新增即该类型收敛 |

全部 6 类收敛后 `nextQuestion()` 返回 `null`，阶段一结束。

**收敛后仍需补充契约** → 走显式入口，不要反复调 `submitAnswer`（会被 `finished` 拒掉）：

```js
C.addContract(session, '特殊字符注入', 'security');
```

---

## 6 类测试点

| key | 名称 | 探针示例 |
|---|---|---|
| `input` | 输入边界 | 空值、超长、特殊字符、负数、null/undefined |
| `state` | 状态转换 | 从A到B、回退、重入、中间态 |
| `concurrency` | 并发/竞态 | 并发调用、竞态条件、重复提交、锁 |
| `error` | 异常/错误恢复 | 抛异常、超时、重试、降级 |
| `performance` | 性能/超时 | 响应时间、大输入、内存 |
| `security` | 安全/注入 | 注入、越权、敏感信息泄露、路径穿越 |

---

## 判定与门禁

| 条件 | verdict | allow |
|---|---|---|
| 有任何 `dangling` | **REJECT** | ⛔ |
| 仅 `skipped`（有理由） | PASS_WITH_WARNINGS | ✅ |
| 全部 `completed` | PASS | ✅ |
| 契约为空 | **REJECT**（保守） | ⛔ |

---

## 默认开启（2026-07-21 修正）

初版是**默认关闭**，用户质疑「不开启还有什么意义」——**这个质疑是对的**。
装了插件却看不到任何效果，用户只会得出「这东西没用」的结论，那是最坏的结果。

现在与宿主 `evolution.yaml` 的 `enabled: true` 保持一致，**默认开启**。
安全性不靠「默认关」，而靠三档语义：

| 情形 | 判定 | 门禁 |
|---|---|---|
| 压根没起监督会话（session=null） | `REJECT` | ⛔ 拦 |
| 起了会话但**还没声明测试点** | `NOT_APPLICABLE` | ✅ 不拦 |
| 声明了契约但**没执行 / 无日志** | `REJECT` | ⛔ 拦 |

一句话：**没声明过测试点就不介入，一旦声明就必须对账。**

显式关闭仍可用：`sup.start({ ..., enable: false })`。

三条已写成测试断言（`[补充] 默认开启` 段，共 3 项），防止后续又被改回默认关闭。

---

## ⚠ 一处与方案原文的偏差（必须说明）

方案原文要求"通过宿主的报告钩子注入，验证器无法绕过"。

**实测：宿主当前没有最终报告落盘钩子。**
`reports.jsonl` 是内核的「进化落地面」，不是验证报告；宿主没有暴露 report hook。

因此本插件的实现是：

- `injectReport()` 由插件生成区块并 **prepend** 到报告文本；
- `gate().allow=false` 时由调用方**自行拒绝落盘**。

这意味着**接入方必须真的检查 `gate.allow`**，
否则"验证器无法绕过"就退化成口头约定。

若后续宿主提供报告钩子，应把 `injectReport` 挂到该钩子上，
届时才是机制级不可绕过。

---

## 验收

```bash
node plugins/anti-lazy-supervisor/verify.test.cjs
```

```
通过 24 项，失败 0 项
```

覆盖方案「五、验收标准」全部 7 条：
追问闭环 / 对账抓漏检 / 抓造假 / 报告注入 / 门禁拦截 / 不干扰宿主 / 零依赖。

## 演示

```bash
node plugins/anti-lazy-supervisor/demo-e2e.cjs
```

完整跑一遍：追问（3→8 项）→ 对账（揪出 2 项伪造的安全测试）→ 门禁 REJECT → 报告拦截，
末尾再补齐日志反证"门禁是按证据放行，不是写死拒绝"。
