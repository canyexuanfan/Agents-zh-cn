'use strict';
/**
 * Claude Desktop 安装发现模块（唯一实现入口）
 *
 * 供 installer/index.js、launcher/launcher.js（构建时内联）、scripts/probe.ps1（--json）共用。
 * 禁止在其他文件再写第二份路径表。
 *
 * 发现链（全部只读，按优先级）：
 *   1. 运行进程真实路径（Get-Process claude* -> Path）
 *   2. AppxPackage 注册信息（MSIX 包，含未运行场景）
 *   3. Uninstall 注册表（HKCU / HKLM / WOW6432Node）
 *   4. 开始菜单 .lnk 解析（WScript.Shell，只读）
 *   5. 常规路径兜底表（历史遗留，仅作最后兜底）
 *
 * 输出两种安装形态：
 *   - squirrel：Squirrel 直装版（%LOCALAPPDATA%\AnthropicClaude\app-X），可文件级注入
 *   - msix：WindowsApps MSIX 包，禁止注入（写不进 + fuse 校验 + 包身份管理）
 *
 * CLI：node lib/discover.js [--json]
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// ============ MSIX 说明（installer / launcher 共用同一份文案） ============
const MSIX_NOTE = [
  '检测到新版 Claude Desktop 为 MSIX 打包（C:\\Program Files\\WindowsApps）。',
  '常规 Squirrel 注入流程（node index.js install）不适用于此形态；',
  '如需汉化 MSIX 版，请运行专用命令（需管理员权限，自动备份可回滚）：',
  '  node index.js install-msix',
  '原理：takeown/icacls 获取写权限 → app.asar 追加式改写（零解包零重打包）',
  '     → claude.exe 内嵌完整性哈希同步（不翻 fuse，校验照样通过）。',
  '代价：claude.exe Authenticode 签名失效（实测不影响运行）；Claude 每次升级后需重跑。'
].join('\n');

// ============ 基础工具 ============

function cmpSemver(a, b) {
  const pa = String(a).replace(/^app-/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^app-/, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const da = pa[i] || 0;
    const db = pb[i] || 0;
    if (da !== db) return db - da; // 倒序
  }
  return 0;
}

function ps(command, timeoutMs) {
  const r = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
    {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      timeout: timeoutMs || 15000,
      maxBuffer: 4 * 1024 * 1024
    }
  );
  if (!r || r.status !== 0 || typeof r.stdout !== 'string') return '';
  return r.stdout;
}

function psLines(output) {
  return String(output)
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function readFileTrim(p, maxBytes) {
  try {
    const st = fs.statSync(p);
    if (!st.isFile() || st.size > (maxBytes || 64)) return '';
    return fs.readFileSync(p, 'utf8').trim();
  } catch (_) {
    return '';
  }
}

// ============ 从 exe 路径推导安装信息 ============

function squirrelInfoFromAppDir(appDir, source) {
  const asarPath = path.join(appDir, 'resources', 'app.asar');
  if (!fs.existsSync(asarPath)) return null; // 空壳（升级残留）不算有效安装
  const dirName = path.basename(appDir);
  const version = dirName.replace(/^app-/, '');
  return {
    kind: 'squirrel',
    version: version,
    asarPath: asarPath,
    exePath: path.join(appDir, 'claude.exe'),
    installRoot: path.dirname(appDir),
    appDir: appDir,
    source: source
  };
}

function scanSquirrelBase(base, source) {
  let subs;
  try {
    if (!fs.statSync(base).isDirectory()) return null;
    subs = fs.readdirSync(base).filter((n) => /^app-\d/.test(n));
  } catch (_) {
    return null;
  }
  subs.sort(cmpSemver);
  for (const sub of subs) {
    const info = squirrelInfoFromAppDir(path.join(base, sub), source);
    if (info) return info;
  }
  return null;
}

function msixInfoFromPackageRoot(pkgRoot, source, packageVersionHint) {
  const asarPath = path.join(pkgRoot, 'app', 'resources', 'app.asar');
  if (!fs.existsSync(asarPath)) return null;
  const dirName = path.basename(pkgRoot);
  // 例：Claude_4.23118.1.0_x64__pzs8sxrjxfjjc
  const m = dirName.match(/^([^_]+)_([^_]+)_(?:x64|x86|arm64)__(.+)$/i);
  const innerVersion = readFileTrim(path.join(pkgRoot, 'app', 'version'));
  return {
    kind: 'msix',
    packageName: m ? m[1] : dirName,
    packageVersion: m ? m[2] : (packageVersionHint || ''),
    packageFamilyName: m ? m[1] + '_' + m[3] : dirName,
    version: innerVersion || (m ? m[2] : '') || '', // 内部应用版本（如 44.9.3）
    asarPath: asarPath,
    exePath: path.join(pkgRoot, 'app', 'claude.exe'),
    installRoot: pkgRoot,
    appDir: path.join(pkgRoot, 'app'),
    source: source
  };
}

function infoFromExePath(exePath, source) {
  if (!exePath) return null;
  const norm = String(exePath).replace(/\//g, '\\').trim();
  // Squirrel：...\AnthropicClaude\app-X\claude.exe
  let m = norm.match(/^(.+\\AnthropicClaude)\\(app-[^\\]+)\\claude\.exe$/i);
  if (m) {
    const info = squirrelInfoFromAppDir(path.join(m[1], m[2]), source);
    if (info) info.exePath = norm;
    return info;
  }
  // MSIX：...\WindowsApps\Claude_X.Y.Z.W_arch__publisher\app\claude.exe
  m = norm.match(/^(.+\\WindowsApps\\[^\\]+)\\app\\claude\.exe$/i);
  if (m) {
    const info = msixInfoFromPackageRoot(m[1], source);
    if (info) info.exePath = norm;
    return info;
  }
  return null;
}

// ============ 发现链各环节 ============

// 1. 运行进程
function claudeExePaths() {
  if (process.platform !== 'win32') return [];
  const out = ps("$ErrorActionPreference='SilentlyContinue'; Get-Process -Name 'claude*' | ForEach-Object { $_.Path } | Where-Object { $_ } | Select-Object -Unique");
  return psLines(out).filter((p) => /\.exe$/i.test(p));
}

function discoverFromProcess() {
  const hits = [];
  for (const exePath of claudeExePaths()) {
    const info = infoFromExePath(exePath, 'process');
    if (info) hits.push(info);
  }
  return hits;
}

// 2. AppxPackage（MSIX）
function discoverFromAppx() {
  if (process.platform !== 'win32') return [];
  const out = ps("$ErrorActionPreference='SilentlyContinue'; Get-AppxPackage -Name '*claude*' | ForEach-Object { $_.PackageFamilyName + '|' + $_.Version + '|' + $_.InstallLocation }");
  const hits = [];
  for (const line of psLines(out)) {
    const parts = line.split('|');
    if (parts.length < 3 || !parts[2]) continue;
    const info = msixInfoFromPackageRoot(parts[2], 'appx', parts[1]);
    if (info) {
      if (!info.packageFamilyName || info.packageFamilyName === path.basename(parts[2])) {
        info.packageFamilyName = parts[0] || info.packageFamilyName;
      }
      if (parts[1] && !info.packageVersion) info.packageVersion = parts[1];
      hits.push(info);
    }
  }
  return hits;
}

// 3. Uninstall 注册表
function discoverFromRegistry() {
  if (process.platform !== 'win32') return [];
  const cmd =
    "$ErrorActionPreference='SilentlyContinue';" +
    "$keys = @('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'," +
    "'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'," +
    "'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*');" +
    "Get-ItemProperty $keys | Where-Object { $_.DisplayName -like '*Claude*' } |" +
    "ForEach-Object { $_.DisplayName + '|' + $_.DisplayVersion + '|' + $_.InstallLocation + '|' + $_.DisplayIcon }";
  const hits = [];
  for (const line of psLines(ps(cmd))) {
    const parts = line.split('|');
    const displayName = parts[0] || '';
    if (!/claude/i.test(displayName)) continue;
    const installLocation = (parts[2] || '').trim();
    const displayIcon = (parts[3] || '').split(',')[0].trim();
    let info = null;
    if (installLocation) {
      const norm = installLocation.replace(/\//g, '\\').replace(/[\\]+$/, '');
      const base = path.basename(norm);
      if (/^app-/i.test(base)) {
        info = squirrelInfoFromAppDir(norm, 'registry');
      } else {
        info = scanSquirrelBase(norm, 'registry');
      }
    }
    if (!info && displayIcon) {
      info = infoFromExePath(displayIcon, 'registry');
    }
    if (info) hits.push(info);
  }
  return hits;
}

// 4. 开始菜单 .lnk（只读解析）
function discoverFromStartMenu() {
  if (process.platform !== 'win32') return [];
  const cmd =
    "$ErrorActionPreference='SilentlyContinue';" +
    '$dirs = @("$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs", "$env:ProgramData\\Microsoft\\Windows\\Start Menu\\Programs");' +
    'Get-ChildItem $dirs -Recurse -Filter "*claude*.lnk" |' +
    'ForEach-Object { (New-Object -ComObject WScript.Shell).CreateShortcut($_.FullName).TargetPath }';
  const hits = [];
  for (const target of psLines(ps(cmd))) {
    const info = infoFromExePath(target, 'startmenu');
    if (info) hits.push(info);
  }
  return hits;
}

// 5. 常规路径兜底（历史遗留表，仅作最后兜底）
function discoverFromFallback() {
  const bases = [
    path.join(process.env.LOCALAPPDATA || '', 'AnthropicClaude'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'AnthropicClaude'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'claude'),
    path.join(process.env['ProgramFiles'] || '', 'AnthropicClaude'),
    path.join(process.env['ProgramFiles(x86)'] || '', 'AnthropicClaude')
  ].filter(Boolean);
  const hits = [];
  for (const base of bases) {
    const info = scanSquirrelBase(base, 'fallback');
    if (info) hits.push(info);
  }
  return hits;
}

// ============ 汇总 ============

function dedupeByAsar(list) {
  const seen = new Set();
  const out = [];
  for (const info of list) {
    const key = String(info.asarPath).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(info);
  }
  return out;
}

function bestOf(list) {
  if (!list || list.length === 0) return null;
  const sorted = list.slice().sort((a, b) => cmpSemver(a.version || a.packageVersion || '', b.version || b.packageVersion || ''));
  return sorted[0];
}

/**
 * 主入口。返回：
 * {
 *   found:    boolean                    // 是否发现任一形态
 *   squirrel: info | null                // Squirrel 直装版（可注入）
 *   msix:     info | null                // MSIX 包（禁止注入）
 *   chosen:   info | null                // squirrel 优先
 *   sources:  string[]                   // 命中的发现链环节
 * }
 */
function discoverClaudeInstall() {
  const all = []
    .concat(discoverFromProcess())
    .concat(discoverFromAppx())
    .concat(discoverFromRegistry())
    .concat(discoverFromStartMenu())
    .concat(discoverFromFallback());

  const squirrel = bestOf(dedupeByAsar(all.filter((i) => i.kind === 'squirrel')));
  const msix = bestOf(dedupeByAsar(all.filter((i) => i.kind === 'msix')));
  const chosen = squirrel || msix;
  const sources = [];
  if (squirrel) sources.push(squirrel.source);
  if (msix) sources.push(msix.source);
  return { found: !!chosen, squirrel: squirrel, msix: msix, chosen: chosen, sources: sources };
}

// 给定安装根，判断是否有 claude 进程运行在该安装之下（同一职责唯一实现，替代旧 wmic 检测）
function isRunningUnderInstall(installRoot) {
  const exes = claudeExePaths();
  if (!installRoot) return exes.length > 0;
  const rootNorm = String(installRoot).replace(/\//g, '\\').toLowerCase().replace(/[\\]+$/, '');
  return exes.some((p) => {
    const norm = String(p).replace(/\//g, '\\').toLowerCase();
    return norm.indexOf(rootNorm + '\\') === 0;
  });
}

function describeInfo(info) {
  if (!info) return '未发现';
  if (info.kind === 'msix') {
    const inner = info.version && info.version !== info.packageVersion
      ? '（内部 ' + info.version + '）'
      : '';
    return 'MSIX 包 ' + (info.packageVersion || '?') + inner + ' — 需用 install-msix 注入（管理员）';
  }
  return 'Squirrel 直装版 ' + (info.version || '?') + ' — 可注入';
}

module.exports = {
  discoverClaudeInstall: discoverClaudeInstall,
  claudeExePaths: claudeExePaths,
  isRunningUnderInstall: isRunningUnderInstall,
  describeInfo: describeInfo,
  cmpSemver: cmpSemver,
  MSIX_NOTE: MSIX_NOTE
};

// ============ CLI ============
if (require.main === module) {
  const r = discoverClaudeInstall();
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(r, null, 2));
  } else {
    console.log('found:', r.found);
    if (r.squirrel) console.log('[squirrel]', describeInfo(r.squirrel), '|', r.squirrel.asarPath);
    else console.log('[squirrel] 未发现');
    if (r.msix) console.log('[msix]', describeInfo(r.msix), '|', r.msix.asarPath);
    else console.log('[msix] 未发现');
    console.log('sources:', r.sources.join(', ') || '(none)');
  }
}
