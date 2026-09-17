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

---

## 6. 无 git 通道：`gh api` 内容接口直传（GFW 环境首选）

本机 `git push` 到 github.com 可能被阻断，且可能缺 Git for Windows。可行替代：用 `gh api` 的 contents 接口逐文件上传（`gh auth login` 后即可）。推荐直接跑本仓库配套脚本 **`../gh_publish_sv.py`**（幂等：仓库已存在则跳过建仓、文件已存在则取 sha 后更新）。

### ⚠️ 关键坑：大文件不能用 `-f content=<base64>`

`gh api -X PUT ... -f content=<b64>` 会把整段 base64 放进命令行参数，**超过 Windows 命令行长度上限（约 32KB）即失败**——一个 500KB 的 PNG base64 后约 700KB，必挂。

正确做法：把请求体写成临时 JSON 文件，用 `--input` 传：

```bash
# body.json = {"message":"add icon.png","content":"<base64>","sha":"<若已存在>"}
gh api -X PUT repos/OWNER/REPO/contents/icon.png --input body.json
```

`gh_publish_sv.py` 已按此实现（每个文件一个临时 body，用完即删）。

### Release / Topics 也走 API（免网页）

```bash
gh release create v1.3.0 --repo OWNER/REPO --title "v1.3.0 · <标题>" --notes-file NOTES.md
gh api -X PUT repos/OWNER/REPO/topics -H "Accept: application/vnd.github.mercy-preview+json" \
  -f names[]=software-testing -f names[]=automation ...
```

### 校验（上传后务必核对，别只看"上传成功"）

```bash
gh api repos/OWNER/REPO --jq '.full_name+" | default_branch="+.default_branch'
gh api repos/OWNER/REPO/contents/SKILL.md --jq '.content'   # base64 解码后确认 version 正确
```
