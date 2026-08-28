# 贡献指南（Contributing）

software-verifier 的核心价值来自**真实世界踩过的坑**。你的每一次验证，都能让它更聪明。

## 两条贡献路线

### 1. 回流踩坑（最推荐，零代码 · opt-in）

验证引擎 `verify.cjs` 跑完会自动调用 `evolve.cjs`：
- 失败命中 `evolution/pitfalls.json` 已知坑 → 累加命中次数；
- 未命中 → 自动生成 `auto_<特征>` 新坑，默认 `consent: pending`（**尚未授权回流**），并写入 `evolution/last-evolution.json`。

**回流需你同意，且 skill 不会自动发送任何数据。** 默认（`evolution/contrib.json` 的 `mode: ask`）下，skill 识别到新坑会主动询问你是否回流：

```bash
# 1. 查状态（已共享 / 已授权待提交 / 未授权）
node contribute.cjs --status

# 2. 你同意回流的坑 → 授权并打包（仅打包 consent=granted 且未共享的坑）
node contribute.cjs --make --grant <id1>,<id2>
#   → 生成 evolution/contrib/contribution-<ts>.json

# 3. 你拒绝的坑 → 仅留本地，永不打包
node contribute.cjs --make --decline <id>

# 4. 把该 JSON 手动提 PR / 丢共享目录 / 发给维护者（脚本不代发）
# 维护者合并前先预检（仅校验、不写入）：
node contribute.cjs --merge --check <bundle.json>
#   → 打印每条坑的校验结果；结论「可安全合并」才继续
# 维护者合并：
node contribute.cjs --merge <bundle.json>
#   → 先跑安全过滤(sanitizeBundle)：任一硬错误整体拒绝、不写入任何数据
#   → 按 id 去重；命中取 max、出现软件取并集；自动重算 evolution.md
```

- 行为开关：`evolution/contrib.json` 的 `mode`：`ask`（默认，每遇新坑询问）/ `always`（自动授权并打包，仍手动发送）/ `never`（永不回流）。
- 合并后即可重新分发（上架市场 / 发新版 zip），所有用户下次更新即获得新解法。

### 维护者必读：回流安全过滤

外部 bundle 是**不可信输入**。`contribute.cjs --merge` 在写入前会先 `sanitizeBundle` 逐字段校验，**任一硬错误整体拒绝（fail-closed），绝不部分写入**。维护者仍需**人工审阅**内容（过滤只挡结构性/恶意数据，不挡语义误导）。

| 防护 | 规则 |
|---|---|
| 原型污染 | 拒绝 `__proto__`/`prototype`/`constructor` 键；合并只按白名单字段显式拷贝，未知字段忽略 |
| ReDoS | `evolve.cjs` 坑匹配为字面量 `includes()`，绝不对 `patterns` 执行正则；恶意正则无法卡死验证 |
| id 投毒 | `id` 限定 `^[A-Za-z0-9_]{2,64}$`，畸形 id 直接拒绝 |
| hits 投毒 | 钳制为有限整数 `[0, 1_000_000]` |
| apps 注入 | 去 `\\`/`/` 路径分隔、限长 60、最多 30 项 |
| 长度限制 | `symptom≤200` `fix≤1200` `patterns` 每项≤80 且最多 8 个，剥离控制字符 |
| 包体量与信封 | `pitfalls` ≤200 条；`skill` 须为 `software-verifier`、`schema` 须为 `1` |

> 安全过滤是最后一道闸，不是替代审阅。**确认 bundle 内容可信、语义无害**后再 `--merge`。

### 2. 直接提 PR（代码 / spec / 文档）

```bash
git clone <repo> && cd software-verifier
# 改 SKILL.md / 驱动 / evolve / 新增示例 spec
git commit -m "feat: ..."
git push && 开 PR
```

## 质量标准

- 新坑 `pitfalls.json` 条目需含：`id` / `category` / `symptom`（现象）/ `patterns`（错误特征**字面量子串**数组，用于 `includes` 匹配）/ `fix`（解法）/ `apps`（出现软件）
- 示例 spec 必须能在本机真实跑通（`--ui-only` 全绿）
- 不改动「只验证不修复」铁律

## 行为准则

文明、务实、可复现。一条好的踩坑记录，胜过十行代码。
