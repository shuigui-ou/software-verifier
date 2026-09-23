# 上架 SkillHub 提交说明（PUBLISH）

本 skill 已整理为「市场就绪」形态。两种上架方式二选一。

## 方式一：网页上传（推荐，零命令行）

1. 打开 **https://skillhub.cn** → 微信扫码登录。
2. 点「发布技能 / 上传技能」。
3. 上传本目录打好的压缩包 `software-verifier.zip`（见下方「打包」）。
4. 填表（预填建议）：
   - 名称：软件功能全量验证器
   - Slug：`software-verifier`
   - 分类：开发工具
   - 标签：软件测试 / 功能走查 / 回归验证 / 自动化 / 无头浏览器 / 自进化
   - 描述：见 `SKILL.md` 顶部 `description`（可直接复制）
   - 图标：本目录 `icon.png`（512×512）
   - 权限说明：本机自动化（启无头浏览器/截图/写报告，不修改被测软件）
   - 依赖：node ≥ 18 + playwright-core（browser 默认）
   - 定价：免费
5. 提交审核（通常 1–7 个工作日，查安全/稳定/合规 + TRACE 五维质量分）。

## 方式二：skillhub-cli（命令行）

```bash
npm i -g skillhub-cli
skillhub login                 # 浏览器扫码，需本人操作
cd software-verifier
skillhub publish --access public
```

> 预检已验证：CLI 能正确解析本 skill 的 `SKILL.md`（读取 `version` 等元数据），仅 `publish` 需先 `login`。

## 打包（生成可上传的 zip）

```bash
# 在 software-verifier/ 的上级目录执行：
python -m zipapp   # 不适用，改用下方脚本
```

或直接用仓库内脚本（在 skill 根目录执行）：

```bash
node pack.cjs   # 生成 ../software-verifier.zip（已排除运行时日志/产物/.gitignore）
```

人工打包也可：选中 `software-verifier/` 整个目录压缩，排除 `node_modules/`、`verify_report/`、`*.log`、`evolution/learnings.jsonl`、`evolution/evolution.md`、**`.gitignore`**（SkillHub 上传包不允许含点文件，否则报「不允许的文件类型」）、**所有图片/二进制**（`*.png/*.jpg/*.ico` 等，SkillHub 上传包禁止二进制，否则报「部分文件被跳过 / 不支持的文件类型」）。

> ⚠️ **图标单独传**：`icon.png` 等二进制不要放进 zip，而是在提交表单的「图标 → 自定义」处单独上传。本仓库 `pack.cjs` 已自动排除图片。

## 上架前自检清单

- [ ] `SKILL.md` frontmatter 含 `name/displayName/version/author/category/tags/trigger/platforms/permission/dependency/pricing/icon`
- [ ] `icon.png` 存在（512×512）
- [ ] `skillhub.yaml` 与 frontmatter 一致
- [ ] `verify.cjs` 在本机 `node >= 18` 跑通（建议一份 `--ui-only` 示例）
- [ ] 不含密钥 / 不含修改被测软件的代码（铁律）
- [ ] `README.md` / `CONTRIBUTING.md` 齐全

## 上架后：贡献回流接上

用户跑 verify 踩的新坑，经 `node contribute.cjs --make` 回流，你 `--merge` 后重新 `publish`——社区越大，playbook 越准。
