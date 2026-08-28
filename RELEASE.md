# software-verifier · GitHub 发布配置（v1.0.0）

> 仓库：https://github.com/shuigui-ou/software-verifier
> 本文档给「发布美化」与「发下一版」用，内容可直接复制粘贴到 GitHub 网页端。

---

## 1. About 描述（仓库主页 ⚙ → Description）

```
像真人一样按说明书把软件功能全量验证一遍：解析说明书 → 本机无头 Edge/Electron/小程序/Appium 真机走查 → 截图+抓错+断言 → 出 ✅/❌ 报告。只验证不修复，带自进化知识库与贡献回流。
```

## 2. Topics（仓库主页 ⚙ → Topics，逐个添加）

```
software-testing
automation
ai-agent
self-improving
end-to-end-testing
playwright
verification
skill
```

## 3. Release v1.0.0 发布说明（Releases → Draft a new release）

- Tag：`v1.0.0`（基于 `master`）
- Title：`v1.0.0 · 软件功能全量验证器`
- 正文（直接复制）：

```markdown
## 软件功能全量验证器 v1.0.0

像真人一样按说明书把软件功能**全量验证**一遍，产出 ✅/❌ 报告。

### 核心特性
- 🚫 **只验证不修复**：跑完一次即出报告，是否修复由人决策（铁律）。
- 🤖 **多驱动**：`browser`（默认，无头 Edge）/ `electron` / `miniprogram` / `appium`。
- 📜 **步骤 DSL**：`clickText` / `clickSel` / `fillSel` / `fillNear` / `wait` / `exec` / `screenshot` / `assert` / `ai`。
- 💡 **自进化**：每次跑完把踩的坑沉淀成可复用解法；命中已知坑报告附解法，未命中自动建新坑。
- 🤝 **贡献回流**：本地新坑 `contribute.cjs --make` 打包 → 维护者 `--merge` 合并进共享 playbook。

### 快速开始
\`\`\`bash
node verify.cjs --spec your-spec.json --url http://localhost:3000 --ui-only
\`\`\`

### 配套
- 已上架 SkillHub：https://skillhub.cn/skills/software-verifier
- 许可：MIT
```

---

## 4. v1.0.1 预填清单（发下一版时逐项勾）

- [ ] 合并社区 PR / `contribute.cjs --merge <bundle>`（新增/修正坑）
- [ ] `node evolve.cjs --regen` 重算 Playbook（如坑有变动）
- [ ] 跑一次真实验证确认 18/18 仍通过（回归）
- [ ] 更新 `SKILL.md` 版本号 `version: 1.0.1`
- [ ] 本地提交：
      \`\`\`bash
      git add -A
      git commit -m "bump: v1.0.1 <一句话改动>"
      git tag v1.0.1
      git push && git push --tags
      \`\`\`
- [ ] 重新打包上架 SkillHub：`node pack.cjs` → skillhub.cn 重新上传 zip（图标表单单独传），版本 +0.0.1
- [ ] 在 GitHub 发 `v1.0.1` Release（套用第 3 节格式，更新标题与改动点）
- [ ] README / SkillHub 页面同步新版本号

---

## 5. 网页端操作路径速查

- **Topics / About**：仓库首页右上角 ⚙（About 旁的齿轮）
- **Release**：仓库首页 → 右侧 `Releases` → `Draft a new release`
- **打 Tag**：Release 页面 Tag 下拉填 `v1.0.0` 并选 `master` 作为 target
