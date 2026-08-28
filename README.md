# software-verifier · 软件功能全量验证器

像真人一样按说明书把软件功能**全量验证**一遍：解析说明书 → 用本机无头 Edge / Electron / 微信小程序 / Appium 真实点击、填表、触发功能 → 截图 + 抓报错 + 断言 → 产出 ✅/❌ 报告。

> 🚫 **只验证，不修复被测软件**。跑完一次即出报告，是否修复由人决策。
> ✨ **自带自进化知识库**：每次跑完把踩的坑沉淀成可复用解法，并支持**贡献回流**——用的人越多，playbook 越准越强。

## 能力

- 驱动可插拔：`browser`（默认，无头 Edge）/ `electron` / `miniprogram` / `appium`
- 步骤 DSL 驱动：`clickText` / `clickSel` / `fillSel` / `fillNear` / `wait` / `exec` / `screenshot` / `assert` / `ai`
- 断言丰富：`sel` / `notSel` / `includes` / `eval`
- 自进化：命中已知坑 → 报告附 `💡 解法`；未命中 → 自动生成新坑
- 贡献回流：本地新坑 `--make` 打包 → 维护者 `--merge` 合并进共享 playbook

## 安装（三选一）

### A. Git（推荐，便于贡献）

```bash
git clone <你的仓库地址> ~/.workbuddy/skills/software-verifier
# 或软链： ln -s "$(pwd)/software-verifier" ~/.workbuddy/skills/software-verifier
```

### B. 压缩包直发

把 `software-verifier/` 整个目录解压到 `~/.workbuddy/skills/software-verifier/` 即生效（无需命令行）。

### C. skillhub-cli

```bash
npm i -g skillhub-cli
skillhub install software-verifier
# 或本地发布：在 skill 目录内 skillhub login && skillhub publish --access public
```

> WorkBuddy 的技能目录是 `~/.workbuddy/skills/`（skillhub-cli 默认装到 `~/.claude/skills/`，发布/安装时留意路径）。

## 运行前置

- `node >= 18`
- `browser` 驱动：`playwright-core` + 本机 Microsoft Edge
- `electron` 驱动：完整 `playwright`
- 小程序：`miniprogram-automator` + 微信开发者工具
- 原生：`webdriverio` + Appium

## 快速开始

```bash
# 1) 起被测服务（Web 举例）
cd your-app && python -m http.server 3000

# 2) 跑界面验证（零额度）
node verify.cjs --spec your-spec.json --url http://localhost:3000 --ui-only

# 3) 看报告
open verify_report/VERIFY-报告.html
```

spec 写法见 `SKILL.md` →「spec 格式」一节，或参考 `examples/block-workplan-spec.json`。

## 贡献回流（让所有人变强）

本 skill 的价值随使用人数增长。踩到的新坑请回流：

```bash
# 你跑完 verify 后，未命中的新失败已被写成 auto_* 新坑
node contribute.cjs --make     # 打包本机新坑 → evolution/contrib/contribution-<ts>.json
node contribute.cjs --status   # 看「已共享 / 待提交」计数
# 把 bundle 提 PR 或发给维护者
# 维护者侧：
node contribute.cjs --merge <bundle.json>   # 合并进发布版 pitfalls.json 并重算 Playbook
```

详见 `CONTRIBUTING.md`。

## 许可

MIT（免费，可商用、可改）。
