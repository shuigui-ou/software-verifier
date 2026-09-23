# 上传 software-verifier 到 GitHub（详尽步骤）

> 目的：把技能源码公开到 GitHub，承接「贡献回流」闭环——别人提 PR 进主干，你合并后重新打包上架 SkillHub，全量用户下一版即受益。
> 当前本地状态：已推送至 `https://github.com/shuigui-ou/software-verifier`（`master` 分支，`origin` remote 已建，跟踪 `origin/master`）。

---

## 第 0 步：准备（仅需一次）

1. 注册 GitHub 账号（已注册可跳过）：https://github.com/signup
2. 安装 Git（本机已装，可跳过）。验证：`git --version`
3. 选一种**鉴权方式**（决定后面 `git push` 是否要输密码）：
   - **方式 A — Personal Access Token（HTTPS，简单）**：去 GitHub → 右上头像 → Settings → Developer settings → Personal access tokens → Tokens (classic) → Generate new token → 勾 `repo` → 生成后**复制保存**（只显示一次）。
   - **方式 B — SSH key（一劳永逸）**：
     ```bash
     # 本机生成密钥（一路回车）
     ssh-keygen -t ed25519 -C "你的邮箱"
     # 把公钥内容复制到 GitHub → Settings → SSH and GPG keys → New SSH key
     cat ~/.ssh/id_ed25519.pub
     ```

---

## 第 1 步（推荐）：用 GitHub CLI 一键建仓并推送

适合不想手动建仓的人。

```bash
# 1) 安装 gh（若未装）
#    Windows: winget install --id GitHub.cli  或  npm i -g gh
# 2) 登录（浏览器授权）
gh auth login
# 3) 进入技能目录
cd ~/.workbuddy/skills/software-verifier
# 4) 建公开仓库并直接推送当前分支（PowerShell 用反引号 ` 续行；或直接写成一整行）
gh repo create software-verifier --public `
  --description "像真人一样按说明书把软件功能全量验证一遍，带自进化知识库与贡献回流" `
  --source . --remote origin --push
```
> 注意：上面用的是 PowerShell 的反引号 `` ` `` 续行。若你是在 **cmd** 里跑，把每行末尾的 `` ` `` 换成 `^`。最稳妥是复制成**一整行**粘贴：
> `gh repo create software-verifier --public --description "像真人一样按说明书把软件功能全量验证一遍，带自进化知识库与贡献回流" --source . --remote origin --push`
> 成功后仓库在 `https://github.com/<你的账号>/software-verifier`。`gh` 会自动加好 `origin` remote 并推送。

---

## 第 2 步（备选）：网页建仓 + 命令行推送

适合不想装 `gh` 的人。

### 2.1 网页建空仓库
1. 打开 https://github.com/new
2. Repository name 填 `software-verifier`
3. 选 **Public**
4. **不要**勾 "Add a README file" / "Add .gitignore"（保持空仓库，避免冲突）
5. 点 **Create repository**
6. 页面会显示仓库地址，形如 `https://github.com/<你的账号>/software-verifier.git`

### 2.2 命令行关联并推送
```bash
cd ~/.workbuddy/skills/software-verifier

# 用你刚建好的地址（HTTPS 或 SSH）
git remote add origin https://github.com/<你的账号>/software-verifier.git
# 若用 SSH 则：git remote add origin git@github.com:<你的账号>/software-verifier.git

# 推送（-u 让 master 跟踪 origin/master）
git push -u origin master
```
- **HTTPS 鉴权**：弹窗/提示里用户名填 GitHub 账号，**密码填第 0 步的 Token**（不是登录密码）。
- **SSH 鉴权**：首次会问是否信任，输入 `yes`；之后免密。

---

## 第 3 步：验证与美化

1. 浏览器打开 `https://github.com/<你的账号>/software-verifier`，确认文件都在（SKILL.md / verify.cjs / evolve.cjs / contribute.cjs / drivers/ / evolution/ / examples/）。
2. 仓库主页 **About** 区点 ⚙ → 填 Description、加 Topics（`software-testing`、`automation`、`ai-agent`、`self-improving`），把 README 设为首页。
3. 在 README 顶部加一行：
   > 已上架 SkillHub：[软件功能全量验证器](https://skillhub.cn/skills/software-verifier)

---

## 第 4 步：以后发新版

```bash
cd ~/.workbuddy/skills/software-verifier

# 本地改完（如合并了别人的贡献、修了坑）后
git add -A
git commit -m "bump: v1.0.1 说明"
git tag v1.0.1              # 打版本标签（可选但推荐）
git push && git push --tags

# 重新打包并上架 SkillHub
node pack.cjs              # 生成 ../software-verifier.zip
# 去 skillhub.cn 重新上传 zip（图标在表单单独传），版本号 +0.0.1
```

---

## 第 5 步：贡献回流怎么接

- **PR 流**：别人 fork 本仓库 → 改 `evolution/pitfalls.json` 或加 `examples/*` → 提 PR → 你 review 合并 → 跑第 4 步重新上架。
- **bundle 流**（没 Git 习惯的用户）：他们跑 `node contribute.cjs --make` 把新坑打包发你 → 你 `node contribute.cjs --merge <bundle>` → 重算 Playbook → 重新上架。

---

## 常见问题

| 现象 | 原因 / 解决 |
|---|---|
| `remote origin already exists` | 之前加过，先 `git remote remove origin` 再重加 |
| `push` 弹窗要密码但怎么输都错 | HTTPS 要用 **Token** 不是登录密码（第 0 步 A） |
| `Permission denied (publickey)` | SSH key 没加到 GitHub，或用了 HTTPS 地址却想走 SSH |
| `failed to push some refs` | 远程有 README 导致历史分叉：`git pull origin master --allow-unrelated-histories` 后再 push |
| `Support for password authentication was removed` | GitHub 已停用密码登录，必须用 Token 或 SSH |
