# 贡献指南（Contributing）

software-verifier 的核心价值来自**真实世界踩过的坑**。你的每一次验证，都能让它更聪明。

## 两条贡献路线

### 1. 回流踩坑（最推荐，零代码）

验证引擎 `verify.cjs` 跑完会自动调用 `evolve.cjs`：
- 失败命中 `evolution/pitfalls.json` 已知坑 → 累加命中次数；
- 未命中 → 自动生成 `auto_<特征>` 新坑写入 playbook。

回流步骤：

```bash
# 1. 打包你机器上的「新坑」（已共享的坑不会重复）
node contribute.cjs --make
#   → 生成 evolution/contrib/contribution-<ts>.json

# 2. 查状态
node contribute.cjs --status

# 3. 把该 JSON 提 PR / 丢共享目录 / 发给维护者
# 维护者合并：
node contribute.cjs --merge <bundle.json>
#   → 按 id 去重；命中取 max、出现软件取并集；自动重算 evolution.md
```

合并后即可重新分发（上架市场 / 发新版 zip），所有用户下次更新即获得新解法。

### 2. 直接提 PR（代码 / spec / 文档）

```bash
git clone <repo> && cd software-verifier
# 改 SKILL.md / 驱动 / evolve / 新增示例 spec
git commit -m "feat: ..."
git push && 开 PR
```

## 质量标准

- 新坑 `pitfalls.json` 条目需含：`id` / `category` / `symptom`（现象）/ `patterns`（错误特征正则数组）/ `fix`（解法）/ `apps`（出现软件）
- 示例 spec 必须能在本机真实跑通（`--ui-only` 全绿）
- 不改动「只验证不修复」铁律

## 行为准则

文明、务实、可复现。一条好的踩坑记录，胜过十行代码。
