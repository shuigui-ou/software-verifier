# 推送到 GitHub（公开仓库，承接贡献回流）

> 为何要 Git 公开：SkillHub 上的版本是**发布快照**，不会自动汇总用户的踩坑。
> 把源码公开到 GitHub，贡献者就能直接提 PR 进主干，`--merge` 后重新打包上架，
> 全量用户下一版即受益——这是「人越多越强」最顺的闭环。

## 0. 前置（一次性）
- 安装并登录 Git 凭证（HTTPS 用 Personal Access Token，或配 SSH key）。
- 若没装 `gh`：去 github.com 网页建空仓库也行。

## 1. 用 GitHub CLI 建仓库并推送（推荐）
```bash
# 在 skill 目录执行
cd ~/.workbuddy/skills/software-verifier

# 建公开仓库（自动加 origin remote）
gh repo create software-verifier --public --description "像真人一样按说明书把软件功能全量验证一遍，带自进化知识库" --source . --remote origin --push --branch master
```
> 首次会让你浏览器授权 `gh`；仓库名 `software-verifier` 可改。

## 2. 不用 CLI，网页建仓后推送
```bash
cd ~/.workbuddy/skills/software-verifier

# 把下面 URL 换成你在 github.com 新建的空仓库地址
git remote add origin https://github.com/<你的账号>/software-verifier.git

# 若 GitHub 新建仓库带了 README/LICENSE（非空），先拉再推：
git pull origin master --allow-unrelated-histories
git push -u origin master
```

## 3. 以后发新版
```bash
# 改完代码/知识库后
git add -A && git commit -m "bump: vX.Y.Z 说明"
git tag vX.Y.Z            # 可选，打版本标签
git push && git push --tags
```

## 4. 贡献者回流（PR 或 bundle）
- PR 流：别人 fork → 改 `evolution/pitfalls.json` / `verify-spec` → 提 PR → 你 review 合并 → 重新 `node pack.cjs` → 上架新版。
- bundle 流（无 Git 习惯的用户）：他们跑 `node contribute.cjs --make` 把新坑打包发你 → 你 `node contribute.cjs --merge <bundle>` → 重算 Playbook → 上架。

## 5. 同步 SkillHub 上架版本
每次合并贡献并重新打包后，去 skillhub.cn 重新上传 `../software-verifier.zip`（图标在表单单独传），版本号 +0.0.1。
