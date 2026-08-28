#!/usr/bin/env node
// 把当前 skill 目录打成可上传 skillhub.cn 的 zip（排除运行时产物）。
// 用法：在 skill 根目录 `node pack.cjs` → 生成 ../software-verifier.zip
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// 极简 zip 写入（store + deflate），无需第三方依赖
const ROOT = __dirname;
const OUT = path.resolve(ROOT, '..', 'software-verifier.zip');

const SKIP = new Set(['node_modules', '.git', 'verify_report', 'shots']);
const SKIP_FILE = (p) => {
  if (p.endsWith('.log')) return true;
  if (p.endsWith('.gitignore')) return true;
  if (p.endsWith('evolution/learnings.jsonl')) return true;
  if (p.endsWith('evolution/evolution.md')) return true;
  // SkillHub 上传包禁止二进制文件，图标需单独在表单「图标」处上传
  if (/\.(png|jpe?g|gif|ico|webp|bmp)$/i.test(p)) return true;
  return false;
};

function walk(dir, base, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    const rel = path.join(base, e.name).split(path.sep).join('/');
    if (e.isDirectory()) {
      if (SKIP.has(e.name)) continue;
      walk(full, path.join(base, e.name), out);
    } else {
      if (SKIP_FILE(rel)) continue;
      out.push({ rel, full });
    }
  }
}

const files = [];
walk(ROOT, 'software-verifier', files);

// ---- zip container (local file headers) ----
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return ~c >>> 0;
}

const local = [];
const central = [];
let offset = 0;
for (const f of files) {
  const data = fs.readFileSync(f.full);
  const comp = zlib.deflateRawSync(data);
  const name = Buffer.from(f.rel, 'utf8');
  const crc = crc32(data);
  const lh = Buffer.alloc(30);
  lh.writeUInt32LE(0x04034b50, 0);
  lh.writeUInt16LE(20, 4);
  lh.writeUInt16LE(0, 6);
  lh.writeUInt16LE(8, 8); // deflate
  lh.writeUInt16LE(0, 10);
  lh.writeUInt16LE(0, 12);
  lh.writeUInt32LE(crc, 14);
  lh.writeUInt32LE(comp.length, 18);
  lh.writeUInt32LE(data.length, 22);
  lh.writeUInt16LE(name.length, 26);
  lh.writeUInt16LE(0, 28);
  const lb = Buffer.concat([lh, name, comp]);
  local.push(lb);

  const ch = Buffer.alloc(46);
  ch.writeUInt32LE(0x02014b50, 0);
  ch.writeUInt16LE(20, 4);
  ch.writeUInt16LE(20, 6);
  ch.writeUInt16LE(0, 8);
  ch.writeUInt16LE(8, 10);
  ch.writeUInt16LE(0, 12);
  ch.writeUInt16LE(0, 14);
  ch.writeUInt32LE(crc, 16);
  ch.writeUInt32LE(comp.length, 20);
  ch.writeUInt32LE(data.length, 24);
  ch.writeUInt16LE(name.length, 28);
  ch.writeUInt16LE(0, 30);
  ch.writeUInt16LE(0, 32);
  ch.writeUInt16LE(0, 34);
  ch.writeUInt16LE(0, 36);
  ch.writeUInt32LE(0, 38);
  ch.writeUInt32LE(offset, 42);
  central.push(Buffer.concat([ch, name]));
  offset += lb.length;
}

const cdStart = offset;
const cd = Buffer.concat(central);
const eo = Buffer.alloc(22);
eo.writeUInt32LE(0x06054b50, 0);
eo.writeUInt16LE(0, 4);
eo.writeUInt16LE(0, 6);
eo.writeUInt16LE(files.length, 8);
eo.writeUInt16LE(files.length, 10);
eo.writeUInt32LE(cd.length, 12);
eo.writeUInt32LE(cdStart, 16);
eo.writeUInt16LE(0, 20);

fs.writeFileSync(OUT, Buffer.concat([...local, cd, eo]));
console.log('已生成 ' + OUT + '  (' + files.length + ' 个文件, ' + (fs.statSync(OUT).size / 1024).toFixed(1) + ' KB)');
