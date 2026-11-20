#!/usr/bin/env node
/**
 * Claude Desktop CN 启动器构建脚本（唯一构建入口，v1.1.3 起收口）
 *
 * 用法：
 *   node build.js                      → build/ClaudeDesktopCN.exe（默认输出，pkg 打包 + Claude 图标 + 版本信息）
 *   node build.js <输出文件名.exe>      → build/<输出文件名.exe>
 *   node build.js --no-pkg             → 只做占位符内联，产出 build/launcher.bundle.js
 *                                        （语法/内容校验用，不调用 pkg、不改 PE 头/图标）
 *
 * 步骤：读取 payload → 读取 launcher.js 模板 → 替换 payload 占位符
 *       → 内联 lib/discover.js + assets/claude.ico（base64）
 *       → pkg 打包（优先本地 node_modules/.bin，缓存重定向到工作空间）
 *       → resedit 写入 exe 图标（Claude）与版本信息（1.1.3）
 *       → PE 头 CONSOLE→GUI
 */
const fs = require('fs');
const path = require('path');
const { execSync, execFileSync } = require('child_process');

const args = process.argv.slice(2);
const noPkg = args.includes('--no-pkg');
const nameArg = args.find((a) => !a.startsWith('--'));
const VERSION = '1.1.7';
// 与历史版本统一：默认输出带版本号的存档名（ClaudeDesktopCN-v1.1.3.exe）；
// 构建完成后额外产出固定分发名 ClaudeDesktopCN.exe（server/version.json 的 download_url 指向它）
const OUTPUT_NAME = nameArg || 'ClaudeDesktopCN-v' + VERSION + '.exe';

// pkg 下载的预编译二进制缓存重定向到工作空间（避免写用户目录）
process.env.PKG_CACHE_PATH = path.join(__dirname, '..', '.workspace', 'pkg-cache');

console.log('开始构建 Claude Desktop CN 启动器 v' + VERSION + '...\n');

// 1. 读取 payload / 图标 / discover
console.log('[1/6] 读取 payload 与图标...');
const payloadDir = path.join(__dirname, '..', 'payload', 'src');
const payloadFiles = {
  'boot.js': fs.readFileSync(path.join(payloadDir, 'boot.js'), 'utf8'),
  'i18n.js': fs.readFileSync(path.join(payloadDir, 'i18n.js'), 'utf8'),
  'guard.js': fs.readFileSync(path.join(payloadDir, 'guard.js'), 'utf8'),
  'panel.js': fs.readFileSync(path.join(payloadDir, 'panel.js'), 'utf8')
};
const iconB64 = fs.readFileSync(path.join(__dirname, 'assets', 'claude.ico')).toString('base64');
const discoverSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'discover.js'), 'utf8');

// 2. 读取模板
console.log('[2/6] 处理模板...');
let code = fs.readFileSync(path.join(__dirname, 'launcher.js'), 'utf8');

// 3. 替换占位符
console.log('[3/6] 嵌入 payload + discover + 图标 ...');
for (const [filename, content] of Object.entries(payloadFiles)) {
  const placeholder = filename.toUpperCase().replace('.', '_') + '_PLACEHOLDER';
  const escaped = content
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$/g, '\\$');
  code = code.replace(placeholder, escaped);
}

// 内联 discover（函数替换规避 $ 模式歧义）
const REQUIRE_LINE = "const DISCOVER = require('../lib/discover.js');";
if (!code.includes(REQUIRE_LINE)) {
  console.error('未找到 discover require 行，模板与构建脚本不匹配');
  process.exit(1);
}
const discoverWrapped =
  'const DISCOVER = (function (module, exports) {\n' + discoverSrc + '\nreturn module.exports;})({}, {});';
code = code.replace(REQUIRE_LINE, () => discoverWrapped);
code = code.replace('/*BUILD:INLINE_DISCOVER*/', '');

// 内联图标 base64
const ICON_TOKEN = "'__CN_ICON_ICO_B64__'";
if (!code.includes(ICON_TOKEN)) {
  console.error('未找到图标占位符');
  process.exit(1);
}
code = code.replace(ICON_TOKEN, () => JSON.stringify(iconB64));

// 内联 MSIX 编排模块（msix-ops + 依赖链，单文件分发）：
// 组合成自带 require 路由的 IIFE 工厂，launcher 运行时解码执行
console.log('[3.5/6] 内联 MSIX 编排模块...');
const libDir = path.join(__dirname, '..', 'lib');
const msixInjectRaw = fs
  .readFileSync(path.join(libDir, 'msix-inject.js'), 'utf8')
  .replace(
    "const MENU_DICT = JSON.parse(fs.readFileSync(path.join(__dirname, 'menu-dict.json'), 'utf8'));",
    'const MENU_DICT = ' + fs.readFileSync(path.join(libDir, 'menu-dict.json'), 'utf8').trim().replace(/;\s*$/, '') + ';'
  );
const msixBundle =
  'const __makeOps = (function (require) {\n' +
  '  const __mods = {};\n' +
  '  const __req = (p) => (__mods[p] !== undefined ? __mods[p] : require(p));\n' +
  '  function def(name, src) {\n' +
  '    const m = { exports: {} };\n' +
  "    new Function('module', 'exports', 'require', src)(m, m.exports, __req);\n" +
  '    __mods[name] = m.exports; // 模块体执行后再登记（module.exports 可能被整体替换）\n' +
  '  }\n' +
  "  def('./asar-append.js', " + JSON.stringify(fs.readFileSync(path.join(libDir, 'asar-append.js'), 'utf8')) + ');\n' +
  "  def('./msix-integrity.js', " + JSON.stringify(fs.readFileSync(path.join(libDir, 'msix-integrity.js'), 'utf8')) + ');\n' +
  "  def('./msix-inject.js', " + JSON.stringify(msixInjectRaw) + ');\n' +
  "  def('./msix-ops.js', " + JSON.stringify(fs.readFileSync(path.join(libDir, 'msix-ops.js'), 'utf8')) + ');\n' +
  "  return __mods['./msix-ops.js'];\n" +
  '});\nreturn __makeOps(require);';
const MSIX_TOKEN = "'__CN_MSIX_OPS_B64__'";
if (!code.includes(MSIX_TOKEN)) {
  console.error('未找到 MSIX 占位符');
  process.exit(1);
}
code = code.replace(MSIX_TOKEN, () => JSON.stringify(Buffer.from(msixBundle, 'utf8').toString('base64')));

// 4. 打包
const buildDir = path.join(__dirname, 'build');
if (!fs.existsSync(buildDir)) fs.mkdirSync(buildDir, { recursive: true });

if (noPkg) {
  const bundlePath = path.join(buildDir, 'launcher.bundle.js');
  fs.writeFileSync(bundlePath, code, 'utf8');
  const msixBundlePath = path.join(__dirname, '..', '.workspace', 'tmp', 'msix-bundle.js');
  fs.mkdirSync(path.dirname(msixBundlePath), { recursive: true });
  fs.writeFileSync(msixBundlePath, msixBundle, 'utf8');
  console.log('\n[no-pkg] 已产出 ' + bundlePath);
  console.log('[no-pkg] MSIX bundle 已产出 ' + msixBundlePath);
  console.log('校验提示: node --check "' + bundlePath + '"');
  process.exit(0);
}

console.log('[4/6] 打包 exe ...');
const tempEntry = path.join(__dirname, '_build_entry.js');
fs.writeFileSync(tempEntry, code, 'utf8');

// 解析 pkg：优先本地 node_modules/.bin，其次全局
function resolvePkg() {
  const localCmd = path.join(__dirname, 'node_modules', '.bin', 'pkg.cmd');
  if (fs.existsSync(localCmd)) return localCmd;
  const localCmd2 = path.join(__dirname, 'node_modules', '.bin', 'pkg');
  if (fs.existsSync(localCmd2)) return localCmd2;
  try {
    execSync('pkg --version', { stdio: 'pipe' });
    return 'pkg';
  } catch (_) {
    return null;
  }
}

const outputFile = path.join(buildDir, OUTPUT_NAME);
try {
  const pkgBin = resolvePkg();
  if (!pkgBin) {
    console.error('未检测到 pkg（本地与全局均无）。请先在 launcher 目录执行：npm install --save-dev pkg');
    console.error('或使用校验模式：node build.js --no-pkg');
    process.exit(1);
  }
  if (fs.existsSync(outputFile)) fs.unlinkSync(outputFile);
  execSync(`"${pkgBin}" "${tempEntry}" --targets node18-win-x64 --output "${outputFile}"`, { stdio: 'inherit' });
  fs.unlinkSync(tempEntry);
} catch (error) {
  try { fs.unlinkSync(tempEntry); } catch (_) {}
  console.error('\n❌ 打包失败:', error.message);
  process.exit(1);
}

// 5. resedit 写入 Claude 图标 + 版本信息（resedit v2 / pe-library API）
console.log('[5/6] 写入 exe 图标与版本信息（resedit）...');
let reseditOk = false;
try {
  const { NtExecutable, NtExecutableResource, Data, Resource } = require('resedit');
  const exe = NtExecutable.from(fs.readFileSync(outputFile));
  const res = NtExecutableResource.from(exe);

  // 图标：跟随已有图标组的 id+lang 精准替换（避免产生同 id 异语言的歧义图标组）
  const groups = Resource.IconGroupEntry.fromEntries(res.entries);
  const iconId = groups.length > 0 ? groups[0].id : 1;
  const iconLang = groups.length > 0 ? groups[0].lang : 1033;
  const iconFile = Data.IconFile.from(
    fs.readFileSync(path.join(__dirname, 'assets', 'claude.ico'))
  );
  Resource.IconGroupEntry.replaceIconsForResource(
    res.entries,
    iconId,
    iconLang,
    iconFile.icons.map((i) => i.data)
  );

  // 版本信息
  const viList = Resource.VersionInfo.fromEntries(res.entries);
  const vi = viList[0];
  vi.setStringValues({ lang: 1033, codepage: 1200 }, {
    ProductName: 'Claude Desktop CN',
    FileDescription: 'Claude Desktop 中文汉化与反风控守护启动器',
    ProductVersion: VERSION,
    FileVersion: VERSION,
    OriginalFilename: OUTPUT_NAME
  });
  vi.setFileVersion('1.1.7.0');
  vi.setProductVersion('1.1.7.0');
  vi.outputToResourceEntries(res.entries);

  res.outputResource(exe);
  fs.writeFileSync(outputFile, Buffer.from(exe.generate()));
  reseditOk = true;
} catch (e) {
  console.warn('  resedit 处理失败（exe 仍可用，但图标/版本信息为默认）: ' + e.message);
}

// 6. PE 头 CONSOLE→GUI
console.log('[6/6] 修改 PE 子系统...');
const buf = fs.readFileSync(outputFile);
const peOff = buf.readUInt32LE(0x3C);
if (buf.readUInt16LE(peOff + 0x5C) === 3) {
  buf.writeUInt16LE(2, peOff + 0x5C);
  fs.writeFileSync(outputFile, buf);
  console.log('  CONSOLE → WINDOWS ✓');
}

console.log('\n✅ 构建成功' + (reseditOk ? '（图标+版本信息已写入）' : '（未写入自定义图标）'));
console.log(`输出: ${outputFile}`);
console.log(`大小: ${(fs.statSync(outputFile).size / 1024 / 1024).toFixed(1)} MB`);

// 固定分发名副本（线上 download_url 固定指向 ClaudeDesktopCN.exe）
if (!noPkg && OUTPUT_NAME !== 'ClaudeDesktopCN.exe') {
  const distCopy = path.join(buildDir, 'ClaudeDesktopCN.exe');
  fs.copyFileSync(outputFile, distCopy);
  console.log(`分发副本: ${distCopy}`);
}
