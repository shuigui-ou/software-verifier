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

本机 `git push` 到 github.com 可能被阻断，且可能缺 Git for Windows。可行替代：用 `gh api` 的 contents 接口逐文件上传（`gh auth login` 后即可）。推荐直接跑配套脚本 **`../gh_publish.py`**（逐文件上传；幂等：仓库已存在则跳过建仓、文件已存在则取 sha 后更新；支持 `--dry-run` 先出新增/更新清单）与 **`../gh_release.py`**（打 tag + 建 Release，纯 API；同样支持 `--dry-run`）。

### ⚠️ 关键坑：大文件不能用 `-f content=<base64>`

`gh api -X PUT ... -f content=<b64>` 会把整段 base64 放进命令行参数，**超过 Windows 命令行长度上限（约 32KB）即失败**——一个 500KB 的 PNG base64 后约 700KB，必挂。

正确做法：把请求体写成临时 JSON 文件，用 `--input` 传：

```bash
# body.json = {"message":"add icon.png","content":"<base64>","sha":"<若已存在>"}
gh api -X PUT repos/OWNER/REPO/contents/icon.png --input body.json
```

`gh_publish.py` 已按此实现（每个文件一个临时 body，用完即删）；`gh_release.py` 建 Release 走同一模式。

### Release / Topics 也走 API（免网页）

```bash
gh release create v1.3.0 --repo OWNER/REPO --title "v1.3.0 · <标题>" --notes-file NOTES.md
gh api -X PUT repos/OWNER/REPO/topics -H "Accept: application/vnd.github.mercy-preview+json" \
  -f names[]=software-testing -f names[]=automation ...
```

> v1.4.5 实测路径：tag 与 Release 都由 `../gh_release.py` 经纯 API 完成（POST `git/refs` → POST `releases`），**不依赖本地 git 仓库**。

### 校验（上传后务必核对，别只看"上传成功"）

```bash
gh api repos/OWNER/REPO --jq '.full_name+" | default_branch="+.default_branch'
gh api repos/OWNER/REPO/contents/SKILL.md --jq '.content'   # base64 解码后确认 version 正确
```

---

## 7. v1.4.0 Release 说明（已发，套用此格式发下一版）

> Tag：`v1.4.0`（基于 `master`）；Title：`v1.4.0 · 软件功能全量验证器`
> 同步方式：`gh_publish.py`（gh api contents 接口，58 文件 ok=58 fail=0）；Release 用纯 `gh api`（POST git/refs + POST releases）。

```markdown
## 软件功能全量验证器 v1.4.0

**去守门员化（G/P/I 双线贯通 + 读侧闭环）**

agent-evolution 不再只当 E 类错误的守门员：

- 新增 **期望落差(G) / 计划偏离(P) / 悬挂未完结(I)** 三类信号接入进化账本并落盘；
- 外部解法经 `advisory` 读回 `verify.cjs` 报告的「进化提示」段；
- 资料 → 经验 → 行为真正闭合成环，**解除只写不读**。

仓库已同步全部源码（lib/ 内 vendored 引擎与内核、evolution-host.cjs、verify.cjs 等 58 个文件）。

详见 `EVOLUTION.md` 与 `SKILL.md` 顶部说明。
```

> 注：`gh release create` 在本机（无 git repo）会报 `failed to run git: not a git repository`，改为 `gh api -X POST repos/OWNER/REPO/git/refs`（body `{ref:"refs/tags/v1.4.0",sha:<master 最新 commit sha>}`）+ `gh api -X POST repos/OWNER/REPO/releases`（body `{tag_name, name, body, target_commitish:"master"}`）。

---

## 8. v1.4.5 Release 说明（已发 2026-09-23）

> Tag：`v1.4.5`（基于 `master`）；Title：`v1.4.5 · 声称即实现 + download 真根因`
> 同步方式：`gh_publish.py`（gh api contents 接口，71 文件 ok=71 fail=0，耗时 238s）；Release 用 `gh_release.py`（纯 `gh api`：POST git/refs 打 tag → POST releases；不依赖本地 git 仓库）。tag `v1.4.5` → `6dccdf6382b9`。
> **发版前置**：GitHub 远端 SKILL.md 目前落后（1.4.3），v1.4.4/v1.4.5 需一并同步；SkillHub 需重传 zip（无图片，纯文本）。

```markdown
## 软件功能全量验证器 v1.4.5

**声称即实现 · 去掉"文档写了、代码没做"**

审计发现 spec 表格里列着的 `api` / `openapi` / `download` 三类步骤与断言，引擎实际落到"未实现"兜底分支。本版补齐为真实现，且**每项都有探针证据**（不是"文件存在"）：

- `api` 步骤/断言 —— PASS（需 `--allow-api` 显式开启）；
- `openapi` 断言 —— PASS（按 OpenAPI 文档做契约校验）；
- `download` 步骤 —— PASS，真实捕获到 40 字节文件并校验大小。

**download 的真根因**：此前必然 12s 超时，曾被归为"无头环境限制"。裸 playwright A/B 对照否证了该假设——事件确实派发（事件数=1）却没接到，根因是 `waitForEvent('download')` 注册在 `click` 之后，事件在点击期间已错过。修法：注册提前到 click 之前。

**打包加固**：市场包不再收录 `.bak_*` 等补丁残留（此前会把修复前代码发给消费者）。

**知识库**：新增坑条目 1 条（合计 52 条 / 1288 命中 / 43 条已共享），并在同一次对照中修正 1 条既有误配（短通用 pattern 抢走无关文本归属）。

```

---

## 9. v1.4.6 Release 说明（已发 2026-09-23）

> Tag：`v1.4.6`（基于 `master`）；Title：`v1.4.6 · 公开产物隐私修复`
> 同步方式：**仓库重建**（旧历史自始即含私有项目名，且 GitHub 上移出分支的提交仍可按 sha 访问，故只清 HEAD 不够）；推送用 `gh_publish.py`，tag/Release 用 `gh_release.py`。
> **发版前置**：SkillHub 需重传 zip（无图片，纯文本）；图标未换不必重传。

```markdown
## 软件功能全量验证器 v1.4.6

**公开产物隐私修复 —— 坑库不再携带私有宿主名**

**背景**：内容级审计发现，随包发布/上架的 `evolution/pitfalls.json`（52 条中 43 条已共享）里 `apps` 字段携带真实私有宿主名，与 `evolve.cjs` 文档中「坑库只存失败模式、剥离被测软件名」的承诺冲突。

**真根因（A/B 对照）**：`evolve.cjs` 在「命中已知坑」分支执行 `p.apps.push(r.name)`，与同文件新建坑写 `apps: ['<anon>']` 自相矛盾。同一夹具两臂对照：修复前写入 `["<真实宿主名>"]`（复现缺陷），修复后写入 `["<anon>"]`；两臂都确实发生写入，排除"没触发"的假绿。原始宿主名仍按设计只留本地 `learnings.jsonl`。

**修法**：新增 `APP_PLACEHOLDER` 常量统一新建/累加两处；把匿名化收口到 `contribute.sanitizePit`（make/share/merge 的唯一必经点），放行占位符与公开域名、其余归 `<anon>`；单测 30 项全绿，含 8 条反例防止规则退化成"全洗白"。

**存量清洗**：坑库 15 处真实名匿名化（条目数/命中数/共享数不变）；实名示例改名为 `examples/demo-spec.json` 并同步引用；4 处注释去点名。

**发布面加固**：运行态文件（`learnings.jsonl` / `evolution.md` / `last-evolution.json` / `contrib-ledger.json`）只留本地并已从仓库移除；三端门禁新增泄漏断言，远端含不可发布路径即报错（此前无感，是该问题长期潜伏的原因）。

**知识库**：52 条 / 1288 命中 / 43 条已共享（本次只做匿名化，未增删条目）。
```
