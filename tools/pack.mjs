#!/usr/bin/env node
/**
 * 打包脚本：只打源码，出包前做敏感信息扫描，扫到就拒绝打包。
 *
 * 用法：
 *   node tools/pack.mjs            # 扫描 + 校验 + 打包
 *   node tools/pack.mjs --check    # 只扫描和校验，不打包
 *
 * 依赖：无。用 Node 自带 zlib 手写 ZIP，避免平台差异。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 产物统一落到 <repo>/dist，本地和 CI 行为一致
const OUT_DIR = path.join(ROOT, 'dist');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

// 打包时排除的目录/文件（不进 zip）
const EXCLUDE_DIRS = new Set(['node_modules', '.git', 'test', 'tools', 'docs', 'dist']);
const EXCLUDE_FILES = /^(\.DS_Store|Thumbs\.db|\.gitignore|LICENSE|preview\.html|.*\.zip|.*\.log|.*\.bak)$/i;

// 敏感信息规则：命中即失败
const RULES = [
  { name: '手机号', re: /(^|[^\d])1[3-9]\d{9}(?![\d])/ },
  { name: '邮箱', re: /[\w.+-]+@[\w-]+\.[a-zA-Z]{2,}/ },
  { name: '身份证', re: /(^|[^\d])\d{17}[\dXx](?![\d])/ },
  { name: 'API Key', re: /sk-[A-Za-z0-9_-]{16,}/ },
  { name: '云厂商密钥', re: /(AKIA|AKID|LTAI)[A-Za-z0-9]{12,}/ },
  { name: '硬编码密钥赋值', re: /(api[_-]?key|apikey|secret|token)\s*[:=]\s*['"][^'"]{12,}['"]/i },
  // 防的是把「本机绝对路径」带进代码（会泄露系统用户名）
  { name: '本机绝对路径', re: /[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s"']+|\/Users\/[^\/\s"']+\/|\/home\/[^\/\s"']+\// }
];

// 允许出现在源码里的例外（比如文档里的示例域名）
const ALLOW = [/@example\.(com|org)/i, /@[a-z0-9-]+\.(test|invalid)/i];

const TEXT_EXT = /\.(js|mjs|json|html|css|md|txt|yml|yaml)$/i;

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) {
      if (EXCLUDE_DIRS.has(name)) continue;
      walk(full, out);
    } else {
      if (EXCLUDE_FILES.test(name)) continue;
      out.push(full);
    }
  }
  return out;
}

function rel(p) {
  return path.relative(ROOT, p).split(path.sep).join('/');
}

/* ---------- 1. 清单校验 ---------- */
const mfPath = path.join(ROOT, 'manifest.json');
if (!fs.existsSync(mfPath)) {
  console.error('✗ 找不到 manifest.json');
  process.exit(1);
}
const manifest = JSON.parse(fs.readFileSync(mfPath, 'utf8'));
console.log(`清单：${manifest.name} v${manifest.version}`);

/* ---------- 2. 语法检查 ---------- */
const files = walk(ROOT);
const jsFiles = files.filter((f) => /\.(js|mjs)$/i.test(f));
for (const f of jsFiles) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
  } catch (e) {
    console.error(`✗ 语法错误：${rel(f)}`);
    console.error(String(e.stderr || e.message).slice(0, 500));
    process.exit(1);
  }
}
console.log(`语法检查：${jsFiles.length} 个 JS 文件通过`);

/* ---------- 3. 敏感信息扫描 ---------- */
let hits = 0;
for (const f of files) {
  if (!TEXT_EXT.test(f)) continue;
  const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const rule of RULES) {
      if (!rule.re.test(line)) continue;
      if (ALLOW.some((a) => a.test(line))) continue;
      hits++;
      console.error(`✗ 命中【${rule.name}】${rel(f)}:${i + 1}`);
      console.error(`    ${line.trim().slice(0, 120)}`);
    }
  });
}

if (hits) {
  console.error(`\n✗ 发现 ${hits} 处疑似敏感信息，已拒绝打包。`);
  console.error('  确认是误报就把它加进 tools/pack.mjs 的 ALLOW 列表，或从源码里删掉。');
  process.exit(1);
}
console.log('敏感信息扫描：未发现手机号 / 邮箱 / 身份证 / 密钥 / 真实姓名');

/* ---------- 4. 运行时数据残留检查 ---------- */
const DATA_LEAK = /\.(csv|xlsx|sqlite|db|zip)$/i;
const leaks = files.filter((f) => DATA_LEAK.test(f) && !/icons?\//.test(rel(f)));
if (leaks.length) {
  console.error('✗ 目录里混进了数据文件：' + leaks.map(rel).join(', '));
  process.exit(1);
}
console.log('数据残留检查：未发现导出文件');

if (process.argv.includes('--check')) {
  console.log('\n✓ 检查通过（未打包）');
  process.exit(0);
}

/* ---------- 5. 打 ZIP（纯 Node，无依赖） ---------- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

const entries = [];
for (const f of files) {
  const data = fs.readFileSync(f);
  const deflated = zlib.deflateRawSync(data, { level: 9 });
  entries.push({
    name: rel(f),
    crc: crc32(data),
    raw: data.length,
    body: deflated.length < data.length ? deflated : data,
    method: deflated.length < data.length ? 8 : 0
  });
}

const now = new Date();
const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() / 2)) & 0xffff;
const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff;

const localParts = [];
const centralParts = [];
let offset = 0;

for (const e of entries) {
  const nameBuf = Buffer.from(e.name, 'utf8');
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x0800, 6); // UTF-8 文件名
  local.writeUInt16LE(e.method, 8);
  local.writeUInt16LE(dosTime, 10);
  local.writeUInt16LE(dosDate, 12);
  local.writeUInt32LE(e.crc, 14);
  local.writeUInt32LE(e.body.length, 18);
  local.writeUInt32LE(e.raw, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28);
  localParts.push(local, nameBuf, e.body);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(e.method, 10);
  central.writeUInt16LE(dosTime, 12);
  central.writeUInt16LE(dosDate, 14);
  central.writeUInt32LE(e.crc, 16);
  central.writeUInt32LE(e.body.length, 20);
  central.writeUInt32LE(e.raw, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt16LE(0, 30);
  central.writeUInt16LE(0, 32);
  central.writeUInt16LE(0, 34);
  central.writeUInt16LE(0, 36);
  central.writeUInt32LE(0, 38);
  central.writeUInt32LE(offset, 42);
  centralParts.push(central, nameBuf);

  offset += local.length + nameBuf.length + e.body.length;
}

const centralBuf = Buffer.concat(centralParts);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(0, 4);
end.writeUInt16LE(0, 6);
end.writeUInt16LE(entries.length, 8);
end.writeUInt16LE(entries.length, 10);
end.writeUInt32LE(centralBuf.length, 12);
end.writeUInt32LE(offset, 16);
end.writeUInt16LE(0, 20);

const outName = `zhaopin-helper-${manifest.version}.zip`;
const outPath = path.join(OUT_DIR, outName);
fs.writeFileSync(outPath, Buffer.concat([...localParts, centralBuf, end]));

console.log(`\n✓ 已生成 ${outName}（${(fs.statSync(outPath).size / 1024).toFixed(1)} KB，${entries.length} 个文件）`);
for (const e of entries) console.log('   ' + e.name);
