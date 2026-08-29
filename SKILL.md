---
name: software-verifier
displayName: 软件功能全量验证器
description: 像真人一样按说明书把软件功能全量验证一遍。解析说明书→生成可选功能清单→用本机自动化驱动（无头 Edge / Electron / 微信小程序 / Appium 原生 App）真实点击/填表/触发功能→截图+抓错误+断言→产出 ✅/❌ 报告。验证完只出报告、不修软件；并带自进化知识库，每次跑完把踩坑沉淀成可复用解法，越用越强。适用于 Web、Electron 桌面、微信小程序、原生移动 App 的功能走查与回归验证。v1.2 新增 verify_mcp 验收其他 MCP；v1.2.2 坑回流抽坑即脱敏+一键回传、预置 21 条公共 UI 验证坑语料（冷启动即有货）；v1.2.3 坑匹配泛化（核心关键词+大小写不敏感+同义归一），同类报错不同措辞也能命中，回流坑越积越聪明。
author: user_12807b25
version: 1.2.3
category: 开发工具
tags: [软件测试, 功能走查, 回归验证, 自动化, 无头浏览器, 自进化, MCP验收]
trigger:
  - 按说明书验证软件
  - 把软件功能全量验证一遍
  - 功能走查
  - 回归测试
  - 上线前冒烟测试
  - 验收/检查其他 MCP server 的行为
platforms: [workbuddy]
permission: 本机自动化（启无头浏览器/截图/写报告，不修改被测软件）
dependency: node >= 18 + playwright-core（browser 驱动默认）；electron 驱动需完整 playwright；小程序需 miniprogram-automator；原生需 webdriverio+Appium
pricing: 免费
icon: icon.png
---

# software-verifier · 软件功能全量验证器

读一份说明书（或你自己列的清单），转成结构化 spec，用本机无头 Edge **像真人一样**打开软件、逐个点按钮/填表/触发功能、截图、抓报错、断言预期，最后产出带 ✅/❌ 表格、截图和错误日志的报告（Markdown + HTML）。引擎与软件**解耦**：换软件只换 spec。

## 🚫 铁律（必须严格遵守）

1. **只验证，不修复被测软件。** 验证流程是只读观察：打开、点击、断言、截图、出报告。**绝不修改被测软件的源码/数据**，也**不在流程内自动重跑至全绿**。
2. **先出报告，再谈修复。** 跑完一次即产出报告（哪怕不是 100% 通过），把失败原样沉淀进报告。是否修复、怎么修复，由**人**基于报告决策，是独立动作。
3. **spec 本身是测试设计**，可在出报告前为"选择器/断言写错"做有限调适（这是让验证正确，不是改软件）；但一旦报告产出，停止自动迭代。

> 例外：若软件真有 bug，正确做法是报告里写清"失败根因 + 复现步骤"，交给人去修，而不是替它改。

## ✨ 自进化（越用越强）

每次 `verify.cjs` 跑完，会自动调用 `evolve.cjs`：

- 扫描 `result.json` 的失败与错误，命中 `evolution/pitfalls.json` 里的**已知坑**就累加命中次数，并在报告错误后附 `💡 已知坑[id]: 解法`；
- 没命中的新失败，自动生成一条新坑写入 playbook（去重）；**写入即脱敏**——`evolve.cjs` 已剥离 URL/路径/引号串/被测软件名，坑库只存失败模式、绝不含原始数据，故新坑默认 `consent: granted`；并写入 `evolution/last-evolution.json` 供出报告后一键回传。
- 把本次运行追加进 `evolution/learnings.jsonl`，并重算 `evolution/evolution.md`（人类可读 Playbook，按命中排序）。

知识库存于**用户级 skill 目录**，随本机所有项目累积。写新 spec 前先扫一眼 `evolution/evolution.md`，把规避写法直接写进 spec，可大幅减少误报。

## 🤝 贡献回流（让所有人变强 · 一键脱敏回传，绝不自动发送）

`evolution/` 默认是本机本地——各装一份不会汇总。要真正"人越多越强"，把各自踩的坑**回流**到共享 playbook。回流**完全手动发送、需用户同意**，skill 不会联网回传任何数据；但**抽坑即脱敏**，回传门槛降到最低。

### 回流为什么用户愿意做（设计要点）
- **零摩擦**：verify 后发现的新坑，`evolve.cjs` 已在写入时剥离 URL/路径/引号串/被测软件名——坑库只存「失败模式 + 解法」，不含任何原始数据。所以新坑默认 `consent: granted`，无需再逐条授权。
- **一键**：出报告后 agent 可直接 `node contribute.cjs --share` 把待回传坑打包成脱敏 bundle；用户只需把文件发回（提 PR / 丢共享目录 / 贴表单），脚本不代发。
- **可拒**：仍可用 `node contribute.cjs --make --decline <id>` 把某条坑仅留本地、永不打包。
- **互惠可见**：合并后所有人的坑库都变强；下次 verify 命中别人回传的坑会直接附 `💡 已知坑[id]: 解法`。

### 回流流程
1. **出坑+脱敏**：verify 后 evolve 自动把未命中新失败写成 `auto_*` 新坑，**已脱敏、默认可回传**。
2. **一键打包**：`node contribute.cjs --share` → 生成 `evolution/contrib/contribution-<ts>.json`（强制 `apps:['<anon>']`，再无真实项目名）；旧流程 `--make --grant/--decline` 仍可用。
3. **发回**：用户把该文件提 PR / 丢共享目录 / 贴维护者表单（脚本不代发）。
4. **合并**：维护者 `node contribute.cjs --merge <bundle>` → 合并进发布版 `pitfalls.json` 并自动重算 Playbook → 重新分发（上架市场 / 发新版 zip）。
5. **查状态**：`node contribute.cjs --status` 看「已共享 / 待回传 / 已拒绝」计数。

> 坑库已预置 26 条种子（5 条项目实测 + 21 条公开 UI 验证坑：overlay 拦截、shadow DOM、iframe、strict mode、动画不稳、token 过期等），冷启动即有货。合并时按 `id` 去重，命中次数取 max、出现软件取并集。被拒绝的坑只留本地，绝不会进 bundle。

### 🛡️ 回流安全过滤（merge 失败即中止）
外部 bundle 是**不可信输入**，维护者执行 `--merge` 前 `contribute.cjs` 会先跑 `sanitizeBundle` 逐字段校验，**任一硬错误则整体拒绝、不写入任何数据**（fail-closed）。覆盖的攻击面：

- **原型污染**：拒绝 `__proto__` / `prototype` / `constructor` 等键；合并时只按白名单字段显式拷贝，未知字段一律忽略。
- **ReDoS 拒绝服务**：坑的匹配在 `evolve.cjs` 改为**字面量子串 `includes()`**（绝不对 `patterns` 执行 `new RegExp`）；恶意正则无法再让每次验证卡死。
- **`id` 投毒**：`id` 限定 `^[A-Za-z0-9_]{2,64}$`，畸形 id（含空格/路径/保留字）直接拒绝。
- **`hits` 投毒**：`hits` 钳制为有限整数 `[0, 1_000_000]`，杜绝 `Infinity` 让恶意坑永远排最前。
- **`apps` 路径/超长注入**：数组每项去 `\\` `/` 路径分隔、限长 60、最多 30 项。
- **文本/模式长度**：`symptom≤200`、`fix≤1200`、`patterns` 每项≤80 且最多 8 个，剥离控制字符。
- **包体量**：`pitfalls` 最多 200 条；`skill` 必须为 `software-verifier`、`schema` 必须为 `1`，否则拒绝。

> 推荐合并前先 `node contribute.cjs --merge --check <bundle>` 预检，确认「可安全合并」再正式合并。
> 维护者仍需**人工审阅** bundle 内容（过滤只挡结构性/恶意数据，不挡语义误导），审阅通过再 `--merge`。

## 📦 如何分享给更多人（分发）

- **上架 WorkBuddy 技能市场**（发现性最好）：整理成市场就绪形态后，在市场侧提交，用户可一键安装。
- **打包 zip 直接发**（零平台依赖）：把整个 `software-verifier/` 目录打成压缩包，任何人解压到 `~/.workbuddy/skills/software-verifier/` 即用。
- **Git 开源仓库**：初始化仓库 + README + 一行安装命令，便于版本演进与他人提 PR（与贡献回流天然契合）。

> 无论哪条路，配合上面的「贡献回流」才能越用越强——否则知识库只在单机累积。

## ♻ 自愈（Healer · 默认开）

`clickSel` / `fillSel` / `waitSel` 命中失败时，**不会立刻 FAIL**，而是用稳定信号（`data-testid` → `aria-label` → `role`+文本 → `class` → 文本）在 DOM 里找回等价元素，自动恢复点击/填值/等待。

- 默认开启；想关掉加 `--no-heal`（选择器写错就直接失败，便于暴露 spec 问题）。
- 自愈**只修正测试定位，绝不改被测软件**（符合铁律），断言仍然严格——它是把"选择器写错"这种测试设计问题修对，不是替软件修 bug。
- 报告「自愈记录」逐条列出：原选择器 → 命中策略 → 是否恢复，便于把稳定写法沉淀回 spec（如改用 `data-testid`）。
- 可单独用 MCP 工具 `heal_selector` 诊断某个失效选择器。

## 👁 视觉验证（零依赖视觉回归）

不引入任何图片库，用「DOM 布局指纹」做视觉回归，足以区分**真缺陷**（元素消失/被遮挡/报错遮罩/内容区塌缩）与**设计变更**（位置微调/重排，不误报）：

- 步骤 `visual`：`{ "do":"visual", "name":"首页", "sel":"可选关注的选择器", "baseline":true }` —— 首次建基线，之后每次比对返回 `changed / moved / disappeared / appeared / severity`。
- 断言 `visual`：`{ "visual":"首页", "severity":3 }` —— 严重度 ≤ 阈值判过；消失元素贡献 3 分，故默认「1 个关键元素消失」即 FAIL（真缺陷），纯位置微调不误报。
- 基线存 `evolution/visual-baselines/`（本机本地、不入库）。
- 可单独用 MCP 工具 `visual_capture` / `visual_diff`。

## 🔌 MCP server（让别的 agent 也能调验证能力）

把本 skill 包成 MCP server，**别的 agent / 别的 skill** 可直接调用验证工具，不必加载整份 skill 指令：

- 暴露工具：`verify_run` / `browser_run` / `heal_selector` / `visual_capture` / `visual_diff`（完整 schema 见 `mcp-server.cjs` 头部）。
- 注册：在 `~/.workbuddy/mcp.json` 的 `mcpServers` 加 `software-verifier`，`command` 指向本机 node，`args` 指向本 skill 的 `mcp-server.cjs`，`env` 设 `PW_CORE`。
- 零依赖：原生 Node stdio JSON-RPC 实现，无需 `@modelcontextprotocol/sdk`。日志走 stderr，不污染协议流。

## 🔍 验收其他 MCP（verify_mcp · 我们的 skill 检查其他 MCP）

software-verifier 不只「被调用」，还能**作为 MCP client 去检查另一个 MCP server** 的行为是否符合契约——这正是「我们的 skill 检查其他 MCP」的能力落地：

- 新增 `mcp-client.cjs`（零依赖 stdio JSON-RPC client）连接目标 server；`mcp-server.cjs` 暴露 `verify_mcp` 工具。
- 流程：连接目标 → `tools/list` 核对工具清单 → 按 spec 调用工具并校验返回（`contains` 文本命中 / `noError` 无错误）→ 输出 ✅/❌ 报告（含 toolsMissing / calls 明细）。
- 工具入参示例：
  ```yaml
  targetServer:
    command: '<node>'
    args: ['<mcp-server.cjs>']
    env: { PW_CORE: '...' }
  spec:
    tools:
      - name: tool_a
        args: {}
        expect: { contains: '成功', noError: true }
  ```
- 当前以**结构化契约验收**为主（清单核对 + 返回内容/错误校验）。视觉叠加（对工具返回的页面做视觉指纹比对）预留接口，待目标工具返回可截图页面时由浏览器驱动触发。
- 差异化：外部 mcp-scan 等偏安全静态扫描，我们补齐了**行为级契约验收**这一块。

## 何时用

- 用户要"像真人一样按说明书把软件功能全验证一遍" → 用本 skill。
- Web 应用功能走查、回归验证、上线前冒烟测试；或有一份 README/需求想逐条确认"都好使"。

## 运行底座

- 引擎 `verify.cjs` 驱动可插拔，用 `--driver` 选环境；与软件/平台无关。
- 默认 `browser` 用 `playwright-core` 的 `channel:'msedge'` 启本机无头 Edge（需装 Microsoft Edge）。路径：`C:/Users/199720.PC2775/.workbuddy/binaries/node/versions/22.22.2/node_modules/playwright-core`（`PW_CORE` 可覆盖）。
- 引擎已全局**自动接受 `prompt()`/dialog**，兼容"新建项目/导出选择"类弹窗（仅 browser/electron）。
- 启动即自动 `goto(BASE+"/")`，无需在 spec 里写首屏导航。

## 安全与信任边界

- **断言表达式来源可信**：`assertEval`/`exec`/`getBusyDone` 运行的 JS 表达式**仅来自你本地编写的 spec 文件**（说明书），属 by-design 的可信输入；执行前经 `drivers/safe-expr.cjs` 黑名单校验，拦截 `require`/`process`/`child_process`/`fs`/`eval`/`Function`/`constructor`/`__proto__`/`globalThis`/`fetch` 等危险标识符，防止任意代码执行。
- **路径经环境变量覆盖（无硬编码绑定）**：`playwright-core` 路径读 `process.env.PW_CORE`、`Node` 路径读 `process.env.SV_NODE`，均 `env || 开发机默认兜底`——部署到任意机器只需设环境变量，无需改代码。
- **零依赖、不传云端**：全程本机运行，spec 与结果不上传第三方；自进化知识库仅存本地 `evolution/`。

## 驱动对照

| 驱动 | 适用 | 前置 | 关键参数 |
|---|---|---|---|
| `browser`（默认） | Web / H5 / 移动网页 | 本机 Edge + playwright-core | `--url <地址>` |
| `electron` | Electron 桌面 | 完整 `playwright` | `--app <main.js>` |
| `miniprogram` | 微信小程序 | `miniprogram-automator` + 开发者工具 | `--app <工程根>` |
| `appium` | iOS/Android 原生 | `webdriverio` + Appium | `--platform android\|ios` `--caps <caps.json>` |

> `miniprogram`/`appium` 按官方 API 实现但**未在沙盒实跑校准**；`browser`/`electron` 共用 DOM 原语、行为一致。

## 工作流

1. **确认形态 → 选驱动**（Web/Electron/小程序/原生）。
2. **读说明书**：列功能点，标 `ui`（纯界面）或 `ai`（需后端）。
3. **扫已知坑**：看 `evolution/evolution.md`，把规避写法预置进 spec。
4. **写 spec**：见下。
5. **起服务**：Web 起静态服务器（`python -m http.server`）；Electron `--app`；小程序/Appium 起工具链。
6. **跑一次、出报告**（不重跑至绿）：
   - 全量含 AI：`node verify.cjs --spec s.json --url http://localhost:3000 --ai on`
   - 仅界面（零额度）：`node verify.cjs --spec s.json --url http://localhost:3000 --ui-only`
   - 勾选：`--only F01,F04` 或 `--ui-only --also F04,F16`
7. **看报告**：`verify_report/VERIFY-报告.html`（含截图+已知坑提示）+ `.md` + `result.json`。报告产出即停止。

## spec 格式

```jsonc
{
  "app": "软件名",                 // 报告标题用；也可用 "name"
  "features": [
    { "id":"F01", "name":"功能", "type":"ui|ai", "group":"分组(可选)",
      "setup": [ /* 前置：loadSample()、清空字段等，用 exec */ ],
      "steps": [ /* 操作步骤，见 DSL */ ],
      "asserts": [ /* 预期断言 */ ] }
  ]
}
```

### 步骤 DSL（steps）

| do | 字段 | 说明 |
|---|---|---|
| `goto` | `path` | 跳 `BASE+path` |
| `clickText` | `text`,`nth` | 点文本含 text 的元素（重复按钮用 `nth`） |
| `clickSel` | `sel`,`nth` | 按 CSS 点击 |
| `fillSel` | `sel`,`value` | 按选择器填表（兼容 v-model，自动派发 input） |
| `fillNear` | `label`,`value` | 填"标签/占位符含 label"的输入框 |
| `wait` | `ms` | 等毫秒 |
| `waitSel`/`waitText` | `sel`/`text`,`timeout` | 等出现 |
| `ai` | `clickText`/`clickSel`,`busySel`,`doneEval` | 触发 AI 并轮询到忙消失/`doneEval` 成立 |
| `exec` | `js` | 页面内执行任意 JS（选测试对象、读 state、精确点击） |
| `screenshot` | `name` | 截图存 `shots/` |
| `assert` | 同 asserts | **中途断言**（如先断言已打开→再关→再断言消失） |

### 断言（asserts，任一不过即 FAIL）

- `{ "sel":".x", "min":1, "desc":"出现卡片" }` 命中数 ≥ min
- `{ "notSel":".err", "desc":"无错误遮罩" }`
- `{ "includes":"已连接", "desc":"状态变已连接" }`
- `{ "eval":"document.querySelector('.x')?.value.length>0", "desc":"内容非空" }`

## 断言设计原则

- AI 功能**不断言具体文字**（非确定性），断言**界面状态变化**：按钮可点→禁用→恢复、内容由空变非空、结果容器出现、无 console/page 报错。
- 时序场景用 `assert` 步骤嵌在 steps 中（不要全堆末尾 asserts，弹窗那时已关）。关弹窗后判 `getComputedStyle(mask).display==='none'` 比 `notSel` 更稳（v-show 仅隐藏）。
- 优先 `clickText`（文字稳），少用 `clickSel`（DOM 易变）。同名多按钮用 `nth` 或先 `exec` 定位目标 id 再精确点。

## 产出物

- `verify_report/VERIFY-报告.html` —— 主报告（✅/❌ + 截图 + 已知坑提示）
- `verify_report/VERIFY-报告.md` / `result.json` / `shots/`
- `software-verifier/evolution/` —— 自进化知识库（playbook / 学习流 / Playbook.md）

## 注意

- AI 功能真实消耗额度、耗时（单次 1~2 分钟）。先 `--ui-only` 跑界面，再按需 `--ai on`。
- 文件型功能（上传/下载 Excel、导入 JSON）用 `fillSel` 配 `<input type=file>` 或引擎 `fileSel` 步骤，需准备测试文件。
