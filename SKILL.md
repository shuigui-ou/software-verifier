---
name: software-verifier
displayName: 软件功能全量验证器
description: 像真人一样按说明书把软件功能全量验证一遍。解析说明书→生成可选功能清单→用本机自动化驱动（无头 Edge / Electron / 微信小程序 / Appium 原生 App）真实点击/填表/触发功能→截图+抓错误+断言→产出 ✅/❌ 报告。验证完只出报告、不修软件；并带自进化知识库，每次跑完把踩坑沉淀成可复用解法，越用越强。适用于 Web、Electron 桌面、微信小程序、原生移动 App 的功能走查与回归验证。v1.2 新增 verify_mcp 验收其他 MCP；v1.2.2 坑回流抽坑即脱敏+一键回传、预置 21 条公共 UI 验证坑语料（冷启动即有货）；v1.2.3 坑匹配泛化（核心关键词+大小写不敏感+同义归一），同类报错不同措辞也能命中，回流坑越积越聪明；v1.2.4 坑库去重整理（64 条回流噪坑按失败模式归并为 9 条干净可复用坑并补真实解法，识别更准、库更轻）；v1.2.5 抓坑即推断默认解法（新坑出生即带可用提示，消除"待人工补充解法"废提示，外部用户不回传也有用）；v1.2.6 坑库自维护（按 SYN_KEYS 信号词签名自动归并，同失败模式家族跨运行合并进已有坑，库自洁净、不再需人工去重）；接入共享进化引擎（verify.cjs 加 --evolve 开关，默认静默落盘 pitfalls/learnings、显式 --evolve on 才触发旧行为；新增 evolution.yaml 声明式进化契约 Host B）。v1.3.0 行为闭环（学到 → 动作前拦截，不再是"只写不读"）：新增【复发哨兵】（同一指纹被反复 land 仍复发 → 判定候选无效并回写否决，loop 不再空转自欺）、【遮挡自愈】（点击/等待被 loading/模态遮罩拦截时三档自愈：清遮罩重试 → 原生 DOM click 兜底）、【网络与端口预检自愈】（导航前等待目标可达、端口被占自动改用空闲端口；证据驱动，只由本机学到的复发记忆触发）、【跨宿主指纹归一】（剥离调用栈帧，同源错误在不同宿主收敛到同一指纹，共享知识库真正可跨宿主命中）；并 vendor 引擎/内核到 lib/ 使接入自包含。v1.4.0 去守门员化（G/P/I 双线贯通 + 读侧闭环）：agent-evolution 不再只当 E 类错误的守门员——新增期望落差(G)/计划偏离(P)/悬挂未完结(I) 三类信号接入进化账本并落盘，外部解法经 advisory 读回 verify.cjs 报告「进化提示」段，资料→经验→行为真正闭合成环，解除只写不读。v1.4.1 断言向导（assert-wizard：写 spec 阶段实时提醒高频坑）。v1.4.2 严格化（未实现的断言/步骤明确判 FAIL 不再假绿 + CI 退出码）。v1.4.3 错误归因（宿主/环境/工具三分）与截图静默失效修复。v1.4.4 归因拆两层（HTTP 状态层不再默认洗成环境噪声，同源 4xx/5xx 归宿主并计入 FAIL；第三方源降环境；入口 URL 4xx 判工具；网络传输层按来源判）+ 采集通道补全（补 requestfailed / response≥400，真实站点上实测 18/31 条请求失败此前完全不可见）+ 第三方库白名单前缀显式化（不再隐式依赖 ReferenceError: 前缀）+ 非功能性请求单列（favicon/source-map，不计 FAIL）。v1.4.1 断言编写向导(assert-wizard)：写 spec 时按稳定信号优先级(data-testid→aria-label→role+文本→id→文本→class)推荐选择器、产出可粘贴断言模板，并实时提醒遮罩只隐藏不移除/异步未等渲染就断言/严格模式多命中等高频陷阱（回应坑库「断言语义」类 10.4% 短板，把“选择器/断言写错”挡在写 spec 阶段）。v1.4.2 严格化与 CI 友好（真机走查暴露的修复）：写了引擎不认识的断言键（如文档里规划中的 {api}/{openapi}/{download}）会明确判 FAIL 并提示「未知断言类型」，不再静默通过——消除“文档写了、代码没做”伪装成验证通过的假绿；verify.cjs 按验证结果设置退出码（有未通过功能点 → exit 1，全通过 → 0，参数错误 → 2），流水线可直接做门禁；MCP serverInfo.version 改为从 SKILL.md frontmatter 动态读取，根除版本漂移；文档与代码对齐（补齐 visual 步骤/断言说明，把未实现的 setLocale/download/api/openapi 与 --allow-api 显式标注为规划中）。v1.4.3 错误归因与静默失效修复（第三方靶子验证暴露）：把采集到的错误按「宿主缺陷 / 环境噪声 / 工具自身」三类归因——环境噪声（网络受限、第三方 CDN 全局缺失等与宿主逻辑无关的外部因素）不再把无关功能点染成 FAIL，但**带归因理由完整出现在报告里**（绝不静默丢弃），需要严格口径时用 --strict-env 把环境噪声也计入 FAIL；修复截图失败被改写成 ok:true 的静默失效（现在显式进 result.toolIssues 与报告「工具自身问题」段）；修复安全黑名单误杀合法断言（'Function' 配 i 标志会把 typeof x === 'function' 这类常见断言判为危险表达式，已改为大小写敏感匹配，并实测大小写变体不构成绕过）。 v1.4.6 公开产物隐私修复：坑库 `apps` 字段此前会在「命中已知坑」分支写入真实宿主名，使随包发布/上架的 `pitfalls.json` 携带私有项目名——现统一只写 `<anon>` 占位符，并把匿名化规则收口到 `contribute.sanitizePit`（make/share/merge 全路径覆盖；放行占位符与公开域名，其余归 `<anon>`）；同时清洗存量 15 处真实名与实名示例文件，运行态文件不再进公开仓库（门禁加泄漏断言防复发）。
author: user_12807b25
version: 1.4.6
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

## ⚠️ 风险分级与污染审阅（Governance）

- **风险等级 L1**：仅本机自动化 + 本地写报告/进化账本；不触外部账号、不涉资金/订单。所有写动作 **fail-open**——进化引擎未就绪或写失败即返回 `{ok:false}`，绝不阻断验证主流程。
- **持久化污染风险（明示）**：进化账本（`evolution/pitfalls.json`、`learnings.jsonl`、`signals.jsonl`、`reports.jsonl`）是**长期累积**的本地状态，可能被错误结论固化；尤其自动推断的解法在被裁决 `land` 前只是"建议"，不应被当作事实。
- **污染防护（已实做）**：① 写入即脱敏——`evolve.cjs` 剥离 URL/路径/引号串/被测软件名，坑库只存失败模式，绝不含原始数据；② 回流需同意——`evolution/contrib.json` 的 `mode` = `ask`(默认)/`always`/`never`，打包出的 bundle 不自动上传；③ 空转自检——`recurrenceSentinel` 判定"被反复 land 仍复发"的候选无效并回写否决，防错误候选被反复采纳。
- **定期审阅 SOP**：每次大版本发布前，或 `learnings.jsonl` 行数 ≥ 200 时，人工过一遍 `pitfalls.json` 与最近 `learnings.jsonl`，删除/修正已过时或被证伪条目；`evo.recurringErrors()` 可列复发指纹辅助复核。

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

### 🔁 行为闭环（v1.3.0 · 学到 → 动作前拦截）

知识不只"被记录下来"，还会**改变下一次的行为**（此前只写不读，等于零改进）：

| 机制 | 触发 | 行为改变 |
|------|------|----------|
| **遮挡自愈** | 点击/等待被 loading/模态遮罩拦截 | 三档阶梯：清遮罩重试 → 原生 DOM click 兜底 → 功能点由 FAIL 转 PASS（命中记入报告「自愈记录」） |
| **复发哨兵** | 同一指纹被反复 land 却仍复发 | 判定该候选无效并回写否决，报告显性打印"loop 在空转"，不再自欺 |
| **预检自愈** | 本机学到过网络/端口类复发 | 导航前等待目标可达；launch 前探测端口、占用则改空闲口 |

> **证据驱动原则**：自动动作只由**本机"学到的复发记忆"**触发；坑库（`pitfalls.json`）仅用于**提示**，不驱动动作——避免泛化关键词造成无依据探测。详见 `EVOLUTION.md`。

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
5. **查状态**：`node contribute.cjs --status` 看「已共享 / 待回传 / 已拒绝」计数。`--share` 跑完会直接打印当前共享率；新坑默认 `consent:granted` 已可回传，未共享的多是「从未跑过 --share」——出报告后顺手 `node contribute.cjs --share` 发回，共享池就变强（断言语义/选择器类坑都能被别人命中）。

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

- 暴露工具：`verify_run` / `verify_skill` / `browser_run` / `heal_selector` / `visual_capture` / `visual_diff` / `verify_mcp`（完整 schema 见 `mcp-server.cjs` 头部）。
- 报告即资源：每次 `verify_run`/`verify_skill` 后，最新报告可通过 MCP `resources/list` + `resources/read` 订阅，URI 为 `software-verifier://report/latest`（result.json）与 `software-verifier://report/latest.md`（VERIFY-报告.md）；`initialize` 已声明 `resources` 能力。
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
- 默认 `browser` 用 `playwright-core` 的 `channel:'msedge'` 启本机无头 Edge（需装 Microsoft Edge）。加载路径由 `PW_CORE` 指定；未设置时按 Node 模块解析（`node_modules/playwright-core`）——**包内不硬编码任何本机绝对路径**。
- 引擎已全局**自动接受 `prompt()`/dialog**，兼容"新建项目/导出选择"类弹窗（仅 browser/electron）。
- 启动即自动 `goto(BASE+"/")`，无需在 spec 里写首屏导航。

## 安全与信任边界

- **断言表达式来源可信**：`assertEval`/`exec`/`getBusyDone` 运行的 JS 表达式**仅来自你本地编写的 spec 文件**（说明书），属 by-design 的可信输入；执行前经 `drivers/safe-expr.cjs` 黑名单校验，拦截 `require`/`process`/`child_process`/`fs`/`eval`/`Function`/`constructor`/`__proto__`/`globalThis`/`fetch` 等危险标识符，防止任意代码执行。
- **路径经环境变量覆盖（无硬编码绑定）**：`playwright-core` 路径读 `process.env.PW_CORE`、`Node` 路径读 `process.env.SV_NODE`，均 `env || 开发机默认兜底`——部署到任意机器只需设环境变量，无需改代码。
- **零依赖、不传云端**：全程本机运行，spec 与结果不上传第三方；自进化知识库仅存本地 `evolution/`。
- **网络访问需显式 opt-in**（v1.4.5 起 `api`/`openapi` 步骤与断言、`--allow-api`/`allowApi` 开关**已实现并有探针证据**——`api` 步骤/断言与 `openapi` 契约断言在本地夹具上实测通过；未开启时不会放行，而是明确报「需显式开启网络」）：原设计为默认关闭，须由 `verify.cjs --allow-api`、spec 顶层 `allowApi:true`、或 MCP `verify_skill`/`browser_run` 的 `allowApi` 入参显式开启，避免 spec 暗地发起请求。**当前实际生效的只有第二层防护**——`assertEval`/`exec` 内的 `fetch` 被 `drivers/safe-expr.cjs` 黑名单拦截。

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
  - 接口/网络验证（v1.4.5 起可用，需显式开启）：`node verify.cjs --spec s.json --url http://x --allow-api`（启用 `api`/`openapi` 步骤与断言；默认关闭，未开启时明确报错而非静默放行）
  - 直接验证某个 skill：`node verify.cjs --skill <skill目录> --url http://x`（自动定位该目录下的 `verify-spec.json`/`spec.json` 跑完整验证）
7. **看报告**：`verify_report/VERIFY-报告.html`（含截图+已知坑提示）+ `.md` + `result.json`。报告产出即停止。
   - **退出码（v1.4.2 起，CI 友好）**：有未通过功能点 → `1`；全部通过 → `0`；参数/用法错误 → `2`。可直接用于流水线门禁（此前恒为 0，无法判定成败）。
   - **严格模式（v1.4.3）**：默认环境噪声不计入 FAIL；加 `--strict-env` 可把环境噪声也计入 FAIL（同一夹具、同一份 spec，只差这个开关 → 退出码与 pass 数随之变化）。

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
| `visual` | `name`,`sel?`,`baseline?`,`failOn?`(change\|disappear),`moveThreshold?` | **零依赖视觉回归**：建/比 DOM 布局指纹基线；`failOn:'change'`（默认）任何变化即失败，`'disappear'` 仅元素消失才失败 |
| `setLocale` | `locale`/`lang`/`value`,`url`/`path`/`sel`/`exec` | **国际化验证**：切到指定 locale（直接设 `ctx.locale`，或导航/点切换器/exec 触发），后续断言按该语言校验（本地夹具实测通过） |
| `download` | `sel`,`dir?`,`minBytes?`,`sha?`/`expectSha?` | **下载校验**（仅 browser/electron）：点 `sel` 触发下载，校验文件大小/SHA-256；结果存 `ctx._lastDownload` 供 `download` 断言复用。**v1.4.5 修复**：此前在 click 之后才 `waitForEvent('download')`，而事件在 click 期间已派发 → 必然超时（这就是「已落地 2 次仍复发 2 次」的根因）；现于 click 前建立等待 promise 并复用已注册回调捕获的事件，裸基线对照（203ms 捕获成功）证明修复方向正确 |
| `api` | `url`,`method?`,`headers?`,`body?`,`expectStatus?`,`contains?`,`jsonPath?`,`equals?`,`expectTruthy?` | **HTTP/接口验证**（需 `--allow-api` 显式开启网络）：请求接口并校验状态码/包含/JSON 字段（本地夹具实测通过） |

### 断言（asserts，任一不过即 FAIL）

- `{ "sel":".x", "min":1, "desc":"出现卡片" }` 命中数 ≥ min
- `{ "notSel":".err", "desc":"无错误遮罩" }`
- `{ "includes":"已连接", "desc":"状态变已连接" }`
- `{ "eval":"document.querySelector('.x')?.value.length>0", "desc":"内容非空" }`
- `{ "visual":"<基线名>", "sel?":"<区域>", "severity?":3, "moveThreshold?":12 }` —— **零依赖视觉回归**：与已存 DOM 布局指纹基线比对，严重度 ≤ `severity`（默认 3）即通过；基线不存在时首次自动建立并判通过
- `{ "download":".x", "path?":"<文件>", "minBytes?":1024, "sha?":"<sha256>" }` —— 校验已下载文件存在/大小/SHA-256（`path` 缺省复用上次 `download` 步骤的 `ctx._lastDownload`）
- `{ "api":{ "url":"...", "method?":"GET", "expectStatus?":200, "contains?":"ok", "jsonPath?":"$.data.id", "equals?":42 } }` —— **接口断言**（需 `--allow-api`），实测通过
- `{ "openapi":{ "specUrl":"https://.../openapi.json", "path":"/users", "method?":"get" } }` —— **契约断言**：校验目标 OpenAPI 声明了指定方法+路径（需 `--allow-api`），实测通过

> **v1.4.2 严格化**：写了引擎不认识的断言键将**明确判 FAIL 并提示「未知断言类型」**（v1.4.5 起 `download`/`api`/`openapi` 均已实现，不再属于此类；此分支仅兜真正未知的键/笔误），不再静默通过；只有完全不写断言的 `{}` 才视为跳过。这样"文档里写了、代码没做"不会再伪装成验证通过。

## 断言设计原则

- AI 功能**不断言具体文字**（非确定性），断言**界面状态变化**：按钮可点→禁用→恢复、内容由空变非空、结果容器出现、无 console/page 报错。
- 时序场景用 `assert` 步骤嵌在 steps 中（不要全堆末尾 asserts，弹窗那时已关）。关弹窗后判 `getComputedStyle(mask).display==='none'` 比 `notSel` 更稳（v-show 仅隐藏）。
- 优先 `clickText`（文字稳），少用 `clickSel`（DOM 易变）。同名多按钮用 `nth` 或先 `exec` 定位目标 id 再精确点。

## 🧙 断言编写向导（assert-wizard · v1.4.1）

写 spec 时最易踩的坑是「选择器/断言写错」——这恰是坑库里**选择器精度 25.9% + 断言语义 10.4%** 的来源，且会被 Healer 误当成"软件 bug"。`drivers/assert-wizard.cjs` 把高频坑变成**写 spec 阶段的实时提醒**，零依赖、可离线跑：

- **功能 → 模板**：`node drivers/assert-wizard.cjs --feature "F01:点提交后应有成功提示"` → 识别意图（submit/success…），产出可直接粘进 `features[].asserts` 的断言片段 + 陷阱提醒（遮罩只隐藏不移除、异步未等渲染就断言、严格模式多命中）。
- **选择器体检**：`node drivers/assert-wizard.cjs --sel ".e2d9f3.btn"` → 评估稳定性，哈希类名/CSS Modules 直接判 `low` 并建议改用 `data-testid`。
- **HTML 扫描**：`node drivers/assert-wizard.cjs --html page.html --hints "提交,成功"` → 解析页面、按稳定信号优先级（data-testid→aria-label→role→id→class）列出可锚定元素与断言模板，没带 `data-testid` 的节点会提示让开发补。
- 程序化入口：`module.exports = { classifySelector, recommendForFeature, scanHtml }`，可被 verify.cjs / MCP 工具在生成 spec 时调用。

> 向导只辅助「把 spec 写对」（属测试设计调适，符合铁律），不替软件修 bug；产出的断言仍由引擎严格校验。

## 🔎 错误归因与工具自检（v1.4.3）

在**第三方站点/别人的项目**上跑验证时，采集到的错误其实混了三类完全不同的东西，此前报告把它们平铺成一张"错误日志"，导致两个真实后果：**消费者分不清该找谁**，以及**环境噪声把无关功能点染成 FAIL**（实测：同一站点三轮跑出三种结果）。v1.4.3 起按"该找谁"归因：

| 类别 | 含义 | 是否计入 FAIL |
|---|---|---|
| 🐞 宿主缺陷 | 被测软件自身问题（水印失配、逻辑报错、自身全局缺失） | **是** |
| 🌐 环境噪声 | 网络/CDN 可达性等外部因素（`net::ERR_*`、**第三方源** 4xx/5xx、知名第三方库全局缺失） | 默认**否**（`--strict-env` 可改为是） |
| 🧰 工具自身 | 验证器能力边界或降级（未知断言类型、截图未采集） | **是** |

**三条不可退让的设计原则：**

1. **不静默丢弃**：被判定为环境噪声的条目，**带归因理由**逐条列在报告「错误归因」段，并写入 `result.envNoise`；绝不因为"不算 FAIL"就从报告消失。此前 `Failed to load resource` 被无标注过滤掉，报告里完全看不到——已修。
2. **保守归因**：只有命中**已知**的环境特征才降级。`X is not defined` 里的 X 必须是白名单内的知名第三方库；宿主自己的全局（如 `myApp is not defined`）仍判宿主缺陷、仍计入 FAIL（**不得被洗白**，有阴性对照用例守着）。
3. **可复核**：每条都带 `reason`（为什么这么判）。

**机器可读字段**（`result.json`）：`errorBuckets`（四桶明细 + counts）、`envNoise`（含所属功能点与理由）、`envNoiseCounted`（是否 --strict-env）、`nonFunctional`（非功能性请求清单）、`preErrors`（导航/前置阶段错误）、`classifyContext`（本次归因所用入口 URL）、`toolIssues`（验证器自身降级清单）。v1.4.4 起每条归因记录带 `layer`（`http` 状态层 / `net` 传输层 / 空=应用层）。

**工具自检（截图静默失效已修）**：截图是**证据材料**而非被测软件的功能声明，故采集失败不翻转功能点判定；但**必须显式上报**——进 `result.toolIssues`、控制台打印 `⚠ 工具自检`、报告单独成段说明"缺图，证据不完整"。旧行为把失败改写成 `{ok:true}` 且 warn 无人消费，消费者会以为有截图证据而 PNG 其实不存在。

## 🔬 错误归因拆两层 + 采集通道补全（v1.4.4）

v1.4.3 的归因只有一条 `/Failed to load resource/` 规则，把**两个本质不同的层**合并成"环境噪声"。真实站点压力样本实测的后果：**同源 404/500 被判环境噪声 → 默认模式不计入 FAIL**——站点自己坏掉的资源、或 spec 路径写错造成的同源 404，就这样被"洗白"了。

v1.4.4 拆成两层，顺序即优先级：

| 层 | 判定依据 | 归因 |
|---|---|---|
| **HTTP 状态层**（服务端确实应答了） | `the server responded with a status of NNN` / `http-status: NNN` | 同源 → 🐞 宿主（有人应答就必须有人负责，**不再默认洗成 env**）<br>第三方源 → 🌐 环境（外链/上游坏链，非宿主可控）<br>URL 即导航入口且 4xx → 🧰 工具（入口 URL 不可用 = spec/--url 配置问题） |
| **网络传输层**（没拿到应答） | `net::ERR_*` / `requestfailed:` / `Failed to fetch` | 同源 → 🐞 宿主（自有资源连不上 = 服务自身问题）<br>跨源 → 🌐 环境（DNS/连接/证书/阻断）<br>拿不到 URL 的裸文本 → 🌐 环境（与 v1.4.3 一致，避免无依据翻转判定） |

**采集通道补全**：此前驱动只监听 `console`/`pageerror`，审计实测真实站点上 **18/31 条请求失败对工具完全不可见**（没进 console 就永远看不到）。现补 `requestfailed` 与 `response(status≥400)` 两个通道，并把请求 URL 附在消息尾部（` | url=...`）供归因判同源/跨源。同一次失败在两个通道各出现一次时按 `(状态码|URL)` 归并，只出一条，且**保留 console 文本口径**（报告文本与坑库匹配不受影响）。

**🚫 非功能性请求**（第四个桶，与功能结论无关，**无论如何都不计入 FAIL**）：`favicon.ico` / `apple-touch-icon` / `*.map`。开这个口子有实测依据——某次真实运行出现 `/favicon.ico` 404 且页面并未声明 icon（浏览器自发起），若不区分会把无关功能点染红；刻意只收这两类，不扩大成"洗白后门"。

**⚠ 导航/前置阶段错误（preErrors）**：进入功能点之前（打开入口 URL / setup）采集到的错误此前被首个功能点的清理直接丢弃——入口 URL 本身 404 因此在任何功能点里都看不到，`入口 URL ⇒ tool` 规则形同死代码。现在显式收进 `result.preErrors` 并计入归因与报告（不归到任何功能点，不翻转功能点判定）。

**入口 URL 的 4xx/5xx 分开判**：入口 URL 返回 4xx → 🧰 工具（路径/配置写错，不是软件缺陷）；返回 5xx → 🐞 宿主（服务自己崩了，路径正确的请求本该 200）。靠状态码区分"URL 错了"与"服务坏了"。

**机器可读字段新增**：`result.errorBuckets.counts.noise`、`result.nonFunctional`、`result.preErrors`、`result.classifyContext`（本次判定所用入口 URL，便于复核归因）。每条归因记录另带 `layer`（`http` / `net` / 空=应用层）。

> **行为变化提示（消费者需知）**：同源 4xx/5xx 归因由"环境噪声（不计 FAIL）"改为"宿主（计入 FAIL）"——这是**去掉洗白**，代价是把站点自己的坏资源也纳入判定。若某站点确实存在与功能无关的同源坏资源，它会出现在失败明细里（带 URL，可直接定位）；报告仍在「错误归因」段完整列出所有条目，不存在静默丢弃。

## 🧩 声称即实现 + `download` 真根因（v1.4.5）

**背景**：审计发现下方 spec 表格里列着 `api` / `openapi` / `download` 三类步骤与断言，引擎却落到"未实现"兜底分支——即**"文档写了、代码没做"**。v1.4.5 把这几项补成真实现，并给出**真探针证据**（不是"文件存在"）：

| 能力 | 探针证据（同一夹具、同一份 spec） |
|---|---|
| `api` 步骤 + `api` 断言 | PASS（需 `--allow-api` 显式开启；未开启时该步骤明确报"网络访问未开启"，不会静默跳过） |
| `openapi` 断言 | PASS（按 OpenAPI 文档做契约校验） |
| `download` 步骤 | PASS —— 真实捕获到 `sample.txt`（40 字节），大小校验通过 |

**`download` 的真根因（A/B 裸基线对照，不经本工具任何代码）**：此前该步骤必然 12s 超时，一度被当成"无头环境限制"。裸 playwright 对照**否证**了这个假设：

| arm | 做法 | 结果 |
|---|---|---|
| A | `newContext({acceptDownloads:true})` + `page.click` | ❌ 12s 超时，但**捕获到的 `download` 事件数 = 1** |
| B | `browser.newPage()` + `page.click` | ✅ 203ms |
| C | `newContext({acceptDownloads:true})` + 原生 DOM `el.click()` | ✅ 180ms |

事件确实派发过却没接到 → 根因是 `waitForEvent('download')` 注册在 `click` **之后**，事件在点击期间就已错过（与 `acceptDownloads` 无关）。修法：把 `waitForEvent` 提到 `click` **之前**注册。对应坑库 `download-waitforevent-registered-after-click`（patterns 含"等待下载事件超时"）。

**打包加固**：`pack.cjs` 此前会把 `.bak_pre_*` 之类补丁残留打进市场包（内含**修复前**代码，消费者拿到的是旧实现）；v1.4.5 起在 `SKIP_FILE` 中排除 `.bak` / `.orig` / `.old` / `.tmp` 残留。

> 方法论备注：本节所有"能力可用"结论均以**探针 PASS**为准；"裸基线对照证明不是环境限制"是判定"工具自身缺陷 vs 环境限制"的必需步骤——只凭工具自己的报错无法区分两者。

## 🔒 公开产物隐私口径（v1.4.6）

**背景**：对公开仓库做内容级审计时发现，随包发布/上架的 `evolution/pitfalls.json`（52 条中 43 条已共享）里 `apps` 字段携带**真实私有宿主名**——与 `evolve.cjs` 自身文档「坑库只存失败模式、剥离被测软件名」的承诺冲突。

**真根因（A/B 对照，非推测）**：`evolve.cjs` 在「命中已知坑」分支执行 `p.apps.push(r.name)`，与同文件新建坑写 `apps: ['<anon>']` 自相矛盾。同一夹具、同一份构造 result 的两臂对照：

| 臂 | 命中已知坑后写入的 `apps` |
|---|---|
| 修复前 | `["<真实宿主名>"]` ← 复现缺陷 |
| 修复后 | `["<anon>"]` |

两臂都确实发生了写入（排除"没触发"造成的假绿）；原始宿主名仍按设计留在**本地** `learnings.jsonl`，供本机跨项目诊断，未过度清洗。

**修法**：① 新增 `APP_PLACEHOLDER` 常量，新建坑与命中累加统一使用；② 把匿名化规则收口到 `contribute.sanitizePit`——它是所有出站（`--make` / `--share`）与入站（`--merge`）路径的唯一必经点，故不依赖调用方"记得处理"；放行占位符（`<anon>`/`<public>`/`通用`）与公开站点域名（如 `element-plus.org`），其余一律 `<anon>`。③ 单元测试 30 项全绿，其中含 8 条**反例**（占位符与域名必须原样保留），防止规则退化成"全洗白"。

**存量清洗**：坑库 15 处真实名匿名化（条目数/命中数/共享数不变）；实名示例文件改名为 `examples/demo-spec.json` 并同步两处引用；4 处源码/夹具注释去掉点名。

**运行态不进公开仓库**：`evolution/{learnings.jsonl, evolution.md, last-evolution.json, contrib-ledger.json}` 只留本地（`pack.cjs` 与发布脚本均已排除），并已从仓库移除；三端门禁新增**泄漏断言**（要求远端不可发布路径为 0），此前该门禁对这类泄漏无感——这正是本次问题能长期潜伏的原因。

## 产出物

- `verify_report/VERIFY-报告.html` —— 主报告（✅/❌ + 截图 + 已知坑提示）
- `verify_report/VERIFY-报告.md` / `result.json` / `shots/`
- `software-verifier/evolution/` —— 自进化知识库（playbook / 学习流 / Playbook.md）

## 注意

- AI 功能真实消耗额度、耗时（单次 1~2 分钟）。先 `--ui-only` 跑界面，再按需 `--ai on`。
- 文件型功能（上传/下载 Excel、导入 JSON）用 `fillSel` 配 `<input type=file>` 或引擎 `fileSel` 步骤，需准备测试文件。
