#!/usr/bin/env node
// 一键发新版：改版本号 → 重打包 → 提交打 tag → 推 GitHub → 发 Release。
// 用法（在 skill 根目录执行）：
//   node release.cjs 1.0.1            # 正式发版（会自动合并贡献回流、改版本、打包、提交、打 tag、推送、发 Release）
//   node release.cjs 1.0.1 --no-contrib # 跳过 contribute.cjs --merge（没有待合并的坑时用）
//   node release.cjs 1.0.1 --dry       # 只打印将要执行的步骤，不改动任何东西
//   node release.cjs 1.0.1 --gh "C:/Program Files/GitHub CLI/gh.exe"  # 指定 gh 绝对路径（沙盒/非 PATH 环境）
//
// 注意：SkillHub 上架 zip 需手动在 skillhub.cn 网页重新上传（脚本只负责生成 ../software-verifier.zip），
//       跑完后会打印提醒与上传地址。SkillHub 不支持自动上传。

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = __dirname;
const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const NO_CONTRIB = args.includes('--no-contrib');
const FORCE = args.includes('--force');
const ghFlagIdx = args.indexOf('--gh');
const GH_ARG = ghFlagIdx >= 0 ? args[ghFlagIdx + 1] : null;

const NEW_VER = args.find((a) => /^\d+\.\d+\.\d+$/.test(a));
if (!NEW_VER) {
  console.error('✗ 用法: node release.cjs <新版本号 x.y.z> [--no-contrib] [--dry] [--force] [--gh <gh路径>]');
  process.exit(1);
}

// ---- 工具 ----
function run(cmd, opts = {}) {
  if (DRY) { console.log('  $ ' + cmd); return ''; }
  return execSync(cmd, { cwd: ROOT, encoding: 'utf8', ...opts });
}
function read(p) { return fs.readFileSync(path.join(ROOT, p), 'utf8'); }
function write(p, s) { if (!DRY) fs.writeFileSync(path.join(ROOT, p), s); }

// 解析当前版本（取 SKILL.md frontmatter 的 version:）
function getCurrentVersion() {
  const m = read('SKILL.md').match(/^version:\s*([\d.]+)/m);
  return m ? m[1] : null;
}
function bumpVersionInFile(rel, newVer) {
  const src = read(rel);
  const out = src.replace(/^[ \t]*version:\s*[\d.]+/m, 'version: ' + newVer);
  if (out === src) { console.error('✗ 未在 ' + rel + ' 找到可替换的 version: 行'); process.exit(1); }
  write(rel, out);
}

// 找 gh 可执行文件：优先 PATH，其次 --gh，最后常见 Windows 绝对路径
function findGh() {
  if (GH_ARG) return GH_ARG;
  try { execSync('gh --version', { stdio: 'ignore' }); return 'gh'; } catch {}
  const candidates = [
    'C:/Program Files/GitHub CLI/gh.exe',
    '/c/Program Files/GitHub CLI/gh.exe',
  ];
  for (const c of candidates) { if (fs.existsSync(c)) return c; }
  return 'gh'; // 最后兜底，报错由后续命令暴露
}
const GH = findGh();
const gh = (sub) => `${JSON.stringify(GH)} ${sub}`;

// ---- 前置检查 ----
const CUR = getCurrentVersion();
if (!CUR) { console.error('✗ 无法从 SKILL.md 读取当前版本'); process.exit(1); }
console.log(`当前版本: ${CUR}  →  目标版本: ${NEW_VER}`);

// 工作区需干净（版本号改动 + 打包产生的 zip 是脚本自己做的，不希望混入其它未提交改动）
const dirty = execSync('git status --porcelain', { cwd: ROOT, encoding: 'utf8' }).trim();
if (dirty && !FORCE && !DRY) {
  console.error('✗ 工作区有未提交改动，先处理或加 --force：\n' + dirty);
  process.exit(1);
}

console.log('\n=== 步骤 1/6  合并贡献回流（contribute.cjs --merge）===');
if (NO_CONTRIB) {
  console.log('  跳过（--no-contrib）');
} else {
  run('node contribute.cjs --merge');
}

console.log('\n=== 步骤 2/6  更新版本号 ===');
console.log(`  SKILL.md / skillhub.yaml  → version: ${NEW_VER}`);
bumpVersionInFile('SKILL.md', NEW_VER);
bumpVersionInFile('skillhub.yaml', NEW_VER);

console.log('\n=== 步骤 3/6  重打包 SkillHub zip ===');
run('node pack.cjs');

console.log('\n=== 步骤 4/6  生成 Release notes（自 git 历史）===');
let lastTag = '';
try { lastTag = execSync('git describe --tags --abbrev=0', { cwd: ROOT, encoding: 'utf8' }).trim(); } catch {}
const range = lastTag ? `${lastTag}..HEAD` : '';
const log = execSync(`git log ${range} --oneline`, { cwd: ROOT, encoding: 'utf8' }).trim();
const notesBody = log
  ? log.split('\n').map((l) => '- ' + l).join('\n')
  : '- 见提交历史';
const notes = `## 软件功能全量验证器 v${NEW_VER}\n\n${notesBody}\n\n### 配套\n- 已上架 SkillHub：https://skillhub.cn/skills/software-verifier\n- 许可：MIT`;
const notesFile = path.join(ROOT, 'RELEASE_NOTES_tmp.md');
if (DRY) { console.log('  (Release notes 预览)\n' + notes.split('\n').map((l) => '    ' + l).join('\n')); }
else { fs.writeFileSync(notesFile, notes); }

console.log('\n=== 步骤 5/6  git 提交 + 打 tag + 推送 ===');
run('git add -A');
run(`git commit -m "release: v${NEW_VER}"`);
run(`git tag v${NEW_VER}`);
run('git push origin master');
run('git push origin --tags');

console.log('\n=== 步骤 6/6  发布 GitHub Release ===');
run(gh(`release create v${NEW_VER} --repo shuigui-ou/software-verifier --title "v${NEW_VER} · 软件功能全量验证器" --notes-file RELEASE_NOTES_tmp.md`));
if (!DRY) { fs.unlinkSync(notesFile); }

console.log('\n✅ 发版完成：');
console.log(`   GitHub:    https://github.com/shuigui-ou/software-verifier/releases/tag/v${NEW_VER}`);
console.log(`   zip 已生成: ${path.resolve(ROOT, '..', 'software-verifier.zip')}`);
console.log('\n⚠️  还需手动完成：到 https://skillhub.cn/skills/software-verifier 重新上传该 zip（SkillHub 不支持自动上传），');
console.log('    并在表单把"版本"填为 ' + NEW_VER + '、重新传一次图标。');
