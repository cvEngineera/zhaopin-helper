/**
 * 读取 Chrome 扩展的 chrome.storage.local（LevelDB）。
 * 用途：核对/备份扩展配置，或在不打开浏览器的情况下把配置改好后让插件导入。
 *
 * 用法：
 *   node tools/read-extension-storage.cjs <扩展ID> [--key=web-geek-job-FormData] [--out=文件.json]
 *
 * 例：
 *   node tools/read-extension-storage.cjs ogkmgjbagackkdlcibcailacnncgonbn
 *   node tools/read-extension-storage.cjs ogkmgjbagackkdlcibcailacnncgonbn --key=web-geek-job-FormData --out=我的配置.json
 *
 * 依赖 classic-level：先 npm i classic-level
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

function loadClassicLevel() {
  const candidates = [
    'classic-level',
    path.join(process.cwd(), 'node_modules', 'classic-level'),
    path.join(os.homedir(), 'node_modules', 'classic-level'),
    path.join(os.homedir(), '.workbuddy', 'binaries', 'node', 'node_modules', 'classic-level')
  ];
  for (const c of candidates) {
    try { return require(c); } catch (e) { /* 下一个 */ }
  }
  console.error('✗ 找不到 classic-level。先执行：');
  console.error('  npm install classic-level   # 在本目录执行即可');
  process.exit(1);
}

const { ClassicLevel } = loadClassicLevel();

const argv = process.argv.slice(2);
const positional = argv.filter((a) => !a.startsWith('--'));
const flags = Object.fromEntries(
  argv.filter((a) => a.startsWith('--')).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v === undefined ? true : v];
  })
);

const extId = positional[0];
if (!extId) {
  console.error('用法: node tools/read-extension-storage.cjs <扩展ID> [--key=键] [--out=文件]');
  process.exit(1);
}

const root = process.env.CHROME_USER_DATA || path.join(os.homedir(), 'AppData/Local/Google/Chrome/User Data');
const profiles = fs.existsSync(root)
  ? fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && fs.existsSync(path.join(root, d.name, 'Local Extension Settings', extId))).map((d) => d.name)
  : [];

if (!profiles.length) {
  console.error('✗ 找不到扩展 ' + extId + ' 的存储目录');
  process.exit(1);
}

const work = path.join(os.tmpdir(), 'ext-store-' + extId + '-' + Date.now());
fs.mkdirSync(work, { recursive: true });
const srcDir = path.join(root, profiles[0], 'Local Extension Settings', extId);
for (const f of fs.readdirSync(srcDir)) {
  if (/\.(ldb|log)$/.test(f) || f === 'CURRENT' || f.startsWith('MANIFEST-')) {
    fs.copyFileSync(path.join(srcDir, f), path.join(work, f));
  }
}

(async () => {
  const db = new ClassicLevel(work, { keyEncoding: 'buffer', valueEncoding: 'buffer' });
  await db.open();
  const all = {};
  for await (const [k, v] of db.iterator()) all[k.toString('utf8')] = v.toString('utf8');
  await db.close();
  fs.rmSync(work, { recursive: true, force: true });

  console.log('配置目录: ' + profiles[0]);
  console.log('共 ' + Object.keys(all).length + ' 个键\n');
  for (const [k, v] of Object.entries(all)) {
    console.log('  ' + k.padEnd(28) + v.length + ' bytes');
  }

  if (flags.key) {
    const v = all[flags.key];
    if (!v) { console.error('\n✗ 没有这个键: ' + flags.key); process.exit(1); }
    let obj;
    try { obj = JSON.parse(v); } catch (e) { obj = v; }
    const text = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2);
    if (flags.out) {
      fs.writeFileSync(flags.out, text, 'utf8');
      console.log('\n✓ 已写入 ' + flags.out);
    } else {
      console.log('\n' + text.slice(0, 4000));
    }
  }
})();
