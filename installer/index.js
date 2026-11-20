#!/usr/bin/env node
/**
 * Claude Desktop CN Installer (v0.1)
 *
 * 命令：
 *   node index.js install     注入汉化
 *   node index.js uninstall   还原官方 asar
 *   node index.js status      显示当前状态
 *
 * 设计原则：
 *   - 首次 install 时备份 app.asar -> app.asar.bak（仅一次）
 *   - 每次 install 都基于 .bak 重新解包 → 保证幂等
 *   - uninstall 用 .bak 还原
 *   - 状态写到 %APPDATA%\claude-cn\state.json
 *   - 安装位置发现统一走 lib/discover.js（唯一实现入口，动态发现链，
 *     禁止在本文件再写路径表）；检测到 MSIX 包时明确拒绝，绝不写 WindowsApps
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execSync } = require('child_process');
const asar = require('@electron/asar');
const {
  discoverClaudeInstall,
  isRunningUnderInstall,
  describeInfo,
  MSIX_NOTE
} = require(path.join(__dirname, '..', 'lib', 'discover.js'));
const msixOps = require(path.join(__dirname, '..', 'lib', 'msix-ops.js'));

const PAYLOAD_DIR = path.resolve(__dirname, '..', 'payload', 'src');
const STATE_DIR = path.join(process.env.APPDATA || os.homedir(), 'claude-cn');
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const CONFIG_FILE = path.join(STATE_DIR, 'config.json');

const BOOT_TAG = '<!-- CLAUDE-CN-BOOT -->';

const DEFAULT_CONFIG = {
  version: '1',
  i18n: {
    enabled: true
  }
};

function log(msg, kind = 'info') {
  const prefix = { info: '[i]', ok: '[+]', warn: '[!]', err: '[x]' }[kind] || '[i]';
  console.log(`${prefix} ${msg}`);
}

// 安装发现已收敛到 lib/discover.js（动态发现链：进程→Appx→注册表→开始菜单→兜底）。
// 此处不再持有任何硬编码路径表。

function sha256(file) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(file));
  return h.digest('hex');
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function saveState(s) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

function rmrf(p) {
  if (!fs.existsSync(p)) return;
  // Node 16+ 支持 fs.rmSync recursive
  fs.rmSync(p, { recursive: true, force: true });
}

function findIndexHtml(extractDir) {
  const candidates = [
    'index.html',
    path.join('.vite', 'renderer', 'main_window', 'index.html'),
    path.join('app', 'index.html'),
    path.join('build', 'index.html'),
    path.join('dist', 'index.html'),
    path.join('out', 'index.html'),
    path.join('renderer', 'index.html'),
    path.join('app', 'renderer', 'index.html'),
  ];
  for (const c of candidates) {
    const p = path.join(extractDir, c);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// 进程占用检测统一走 discover.claudeExePaths（wmic 在新系统已弃用/移除）
function isClaudeRunning(installRoot) {
  if (process.platform !== 'win32') return false;
  return isRunningUnderInstall(installRoot);
}

// 把 discover 的 squirrel 信息适配成本文件流程使用的形状
function toLegacyFound(squirrelInfo) {
  return {
    asarPath: squirrelInfo.asarPath,
    version: squirrelInfo.version,
    base: squirrelInfo.installRoot
  };
}

// 安装发现 + 形态守门：仅 Squirrel 直装版可继续；MSIX 明确拒绝（exit 20）
function requirePatchable() {
  const disc = discoverClaudeInstall();
  if (!disc.found) {
    log('未找到 Claude Desktop 安装。请先运行 scripts/probe.ps1', 'err');
    process.exit(1);
  }
  if (!disc.squirrel) {
    log('检测到 ' + describeInfo(disc.msix) + '：' + disc.msix.asarPath, 'err');
    log('Squirrel 注入流程不适用此形态。如需汉化 MSIX 版，请运行: node index.js install-msix（需管理员）', 'err');
    process.exit(20);
  }
  if (disc.msix) {
    log('另检测到 ' + describeInfo(disc.msix) + '（MSIX 版不受本工具影响，也不会被注入）', 'warn');
  }
  return toLegacyFound(disc.squirrel);
}

// ============== Electron Fuse 处理 ==============
const FUSE_SENTINEL = 'dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX';
const FUSE_INTEGRITY_INDEX = 4; // EnableEmbeddedAsarIntegrityValidation

function findExe(base) {
  const exePath = path.join(base, 'claude.exe');
  return fs.existsSync(exePath) ? exePath : null;
}

function patchFuse(exePath) {
  const buf = fs.readFileSync(exePath);
  const sentinel = Buffer.from(FUSE_SENTINEL, 'ascii');
  const idx = buf.indexOf(sentinel);
  if (idx < 0) {
    log('未在 exe 中找到 fuse sentinel', 'err');
    return false;
  }

  // Fuse 格式: sentinel(32) + version(1) + length(1) + fuse_values(N as ASCII '0'/'1')
  const fuseStart = idx + sentinel.length + 2; // skip version + length bytes
  const integrityOffset = fuseStart + FUSE_INTEGRITY_INDEX;

  if (buf[integrityOffset] === 0x30) { // '0' = already disabled
    log('ASAR 完整性校验已是禁用状态，无需修改', 'ok');
    return true;
  }
  if (buf[integrityOffset] !== 0x31) { // not '1'
    log('Fuse 字节异常 (0x' + buf[integrityOffset].toString(16) + ')，跳过', 'warn');
    return false;
  }

  // 备份 exe
  const exeBak = exePath + '.bak';
  if (!fs.existsSync(exeBak)) {
    fs.copyFileSync(exePath, exeBak);
    log('已备份 claude.exe → claude.exe.bak', 'ok');
  }

  // 翻转: '1' → '0'
  buf[integrityOffset] = 0x30;
  fs.writeFileSync(exePath, buf);
  log('已禁用 ASAR 完整性校验 (fuse #4)', 'ok');
  return true;
}

function restoreFuse(exePath) {
  const exeBak = exePath + '.bak';
  if (fs.existsSync(exeBak)) {
    fs.copyFileSync(exeBak, exePath);
    log('已还原 claude.exe', 'ok');
    return true;
  }
  // 没有备份，直接改回去
  const buf = fs.readFileSync(exePath);
  const sentinel = Buffer.from(FUSE_SENTINEL, 'ascii');
  const idx = buf.indexOf(sentinel);
  if (idx < 0) return false;
  const fuseStart = idx + sentinel.length + 2;
  const integrityOffset = fuseStart + FUSE_INTEGRITY_INDEX;
  if (buf[integrityOffset] === 0x30) {
    buf[integrityOffset] = 0x31;
    fs.writeFileSync(exePath, buf);
    log('已恢复 ASAR 完整性校验', 'ok');
  }
  return true;
}

async function cmdInstall() {
  const found = requirePatchable();
  log(`定位到 Claude ${found.version}`);
  log(`asar: ${found.asarPath}`);

  // 进程检测：Claude 占用 asar 时 copy 会 EBUSY（仅检查目标安装根下的进程）
  if (isClaudeRunning(found.base)) {
    log('检测到 Claude.exe 正在运行。请先右键托盘 → Quit 完全退出。', 'err');
    log('（任务管理器确认无 Claude.exe 进程后再重试）', 'err');
    process.exit(1);
  }

  // ---- 禁用 ASAR 完整性校验 ----
  const exePath = findExe(path.dirname(path.dirname(found.asarPath)));
  if (exePath) {
    if (!patchFuse(exePath)) {
      log('无法禁用 ASAR 完整性校验，注入后可能无法启动', 'warn');
    }
  } else {
    log('未找到 claude.exe，跳过 fuse 修改', 'warn');
  }

  // ---- .bak 基线校验：确保备份是"未注入的官方原版" ----
  const bakPath = found.asarPath + '.bak';
  const state = loadState();
  const curAsarHash = sha256(found.asarPath);

  if (!fs.existsSync(bakPath)) {
    // 首次安装：把当前 asar 当作官方原版备份
    // 但要先检查它本身是否含我们的注入标记，避免把"已注入但 .bak 丢失"的状态当成官方
    if (asarHasInjection(found.asarPath)) {
      log('当前 asar 已含注入标记但缺 .bak，无法确定官方基线。', 'err');
      log('请重装 Claude Desktop 后再运行 install。', 'err');
      process.exit(10);
    }
    fs.copyFileSync(found.asarPath, bakPath);
    log('已备份原 asar -> app.asar.bak', 'ok');
  } else {
    // 已有 .bak：校验它是否仍是官方原版
    if (asarHasInjection(bakPath)) {
      log('.bak 已被污染（含注入标记）。基于污染备份重装会导致脚本嵌套。', 'err');
      log('请删除 .bak 并重装 Claude Desktop 后再运行 install。', 'err');
      process.exit(11);
    }
    if (state && state.claudeVersion && state.claudeVersion !== found.version) {
      // Claude 升级了，原 .bak 已过时
      log(`检测到 Claude 版本变化（${state.claudeVersion} → ${found.version}）`, 'warn');
      if (state.asarSha256 && curAsarHash === state.asarSha256) {
        log('当前 asar 哈希与上次安装一致，不应发生（可能是手动改动），仍以 .bak 为基线');
      } else {
        // 当前 asar 是新版官方包，应该用它替换旧 .bak
        if (!asarHasInjection(found.asarPath)) {
          fs.copyFileSync(found.asarPath, bakPath);
          log('已用新版官方 asar 更新 .bak 基线', 'ok');
        } else {
          log('当前 asar 已含注入但 state 显示是新版本，状态不一致', 'err');
          process.exit(12);
        }
      }
    } else {
      log('备份已存在且基线有效，本次基于 .bak 解包（幂等）');
    }
  }

  const tmp = path.join(os.tmpdir(), 'claude-cn-' + Date.now());
  fs.mkdirSync(tmp, { recursive: true });

  // 处理 .unpacked 目录：asar 解包需要 {asarName}.unpacked 在旁边
  const origUnpacked = found.asarPath + '.unpacked';
  const bakUnpacked = bakPath + '.unpacked';
  let junctionCreated = false;
  if (fs.existsSync(origUnpacked) && !fs.existsSync(bakUnpacked)) {
    try {
      execSync(`mklink /J "${bakUnpacked}" "${origUnpacked}"`, { stdio: 'ignore' });
      junctionCreated = true;
      log('已创建 .bak.unpacked 目录链接');
    } catch (e) {
      log('创建目录链接失败，尝试直接解包: ' + e.message, 'warn');
    }
  }

  log(`解包到 ${tmp}`);
  try {
    asar.extractAll(bakPath, tmp);
  } catch (e) {
    log('解包失败: ' + e.message, 'err');
    if (junctionCreated) try { fs.rmSync(bakUnpacked, { recursive: true }); } catch {}
    rmrf(tmp);
    process.exit(2);
  }
  if (junctionCreated) {
    try { fs.rmSync(bakUnpacked, { recursive: true }); } catch {}
  }

  // 注入 payload（主进程 wrapper 方案）
  // 1. 复制 payload 文件到 cn-pack/（供 boot.js 运行时读取）
  const cnDir = path.join(tmp, 'cn-pack');
  fs.mkdirSync(cnDir, { recursive: true });
  const payloadFiles = fs.readdirSync(PAYLOAD_DIR).filter(f => f !== 'boot.js');
  for (const f of payloadFiles) {
    fs.copyFileSync(path.join(PAYLOAD_DIR, f), path.join(cnDir, f));
  }
  log(`已复制 payload 到 cn-pack/ (${payloadFiles.length} files)`, 'ok');

  // 2. 将原 index.pre.js 重命名为 index.original.js
  const mainEntry = path.join(tmp, '.vite', 'build', 'index.pre.js');
  const origEntry = path.join(tmp, '.vite', 'build', 'index.original.js');
  if (!fs.existsSync(mainEntry)) {
    log('未找到主进程入口 .vite/build/index.pre.js，注入失败', 'err');
    rmrf(tmp);
    process.exit(3);
  }
  if (!fs.existsSync(origEntry)) {
    fs.renameSync(mainEntry, origEntry);
    log('已重命名 index.pre.js → index.original.js', 'ok');
  }

  // 3. 用我们的 boot.js 作为新的 index.pre.js（主进程 wrapper）
  fs.copyFileSync(path.join(PAYLOAD_DIR, 'boot.js'), mainEntry);
  log('已注入主进程 wrapper (boot.js → index.pre.js)', 'ok');

  // ---- 原子替换：先打包到 .tmp.asar，校验，再 rename ----
  const tmpAsar = found.asarPath + '.cn-tmp';
  const tmpAsarUnpacked = tmpAsar + '.unpacked';
  log('打包到临时 asar ...');
  try {
    const hasNative = fs.existsSync(origUnpacked);
    if (hasNative) {
      await asar.createPackageWithOptions(tmp, tmpAsar, {
        unpack: '**/*.{node,exe,dll}'
      });
      // 新生成的 .unpacked 与原始相同，删除它（原始 app.asar.unpacked 保持不变）
      rmrf(tmpAsarUnpacked);
    } else {
      await asar.createPackage(tmp, tmpAsar);
    }
  } catch (e) {
    log('打包失败: ' + e.message, 'err');
    rmrf(tmp);
    try { fs.unlinkSync(tmpAsar); } catch {}
    rmrf(tmpAsarUnpacked);
    process.exit(4);
  }

  // 校验：临时 asar 必须能被 asar 正常识别 + 含我们的注入文件 + 大小合理 + 关键文件齐全
  try {
    const list = asar.listPackage(tmpAsar);
    const hasInject = list.some((p) => /[\\/]cn-pack[\\/]/i.test(p));
    const hasOriginal = list.some((p) => /index\.original\.js$/i.test(p));
    if (!hasInject || !hasOriginal) {
      log('临时 asar 校验失败：未找到注入文件', 'err');
      try { fs.unlinkSync(tmpAsar); } catch {}
      rmrf(tmp);
      process.exit(5);
    }
    // 关键文件存在性
    const needs = ['package.json'].concat(
      list.find((p) => /[\\/]index\.html$/i.test(p)) ? [] : ['index.html']
    );
    for (const need of needs) {
      if (!list.some((p) => p.toLowerCase().endsWith(need.toLowerCase()))) {
        log(`临时 asar 缺少关键文件: ${need}`, 'err');
        try { fs.unlinkSync(tmpAsar); } catch {}
        rmrf(tmp);
        process.exit(6);
      }
    }
    // 大小比例校验：与 .bak 比较，新包不应比 .bak 小（我们只增不删）
    const tmpStat = fs.statSync(tmpAsar);
    const bakStat = fs.statSync(bakPath);
    if (tmpStat.size < bakStat.size * 0.9) {
      log(`临时 asar 异常小（${tmpStat.size} vs .bak ${bakStat.size}），疑似截断`, 'err');
      try { fs.unlinkSync(tmpAsar); } catch {}
      rmrf(tmp);
      process.exit(6);
    }
  } catch (e) {
    log('临时 asar 校验异常: ' + e.message, 'err');
    try { fs.unlinkSync(tmpAsar); } catch {}
    rmrf(tmp);
    process.exit(7);
  }

  // 原子 rename：在同盘是原子操作
  // 流程：原 → .pre.bak → tmp → 原 → 删 .pre.bak
  // 任何中途失败 .pre.bak 都还在，可手动还原
  const prePath = found.asarPath + '.pre';
  try {
    // 把当前 asar 移到 .pre（同盘 rename 原子）
    if (fs.existsSync(prePath)) fs.unlinkSync(prePath);
    fs.renameSync(found.asarPath, prePath);
  } catch (e) {
    log('移动原 asar 失败: ' + e.message, 'err');
    try { fs.unlinkSync(tmpAsar); } catch {}
    rmrf(tmp);
    process.exit(8);
  }
  try {
    // 把临时 asar 移到正式位置（同盘 rename 原子）
    fs.renameSync(tmpAsar, found.asarPath);
  } catch (e) {
    // 失败 → 立即用 .pre 还原
    log('安装新 asar 失败: ' + e.message, 'err');
    try { fs.renameSync(prePath, found.asarPath); log('已自动还原原 asar', 'ok'); }
    catch (e2) { log('还原失败！原 asar 仍在 ' + prePath, 'err'); }
    rmrf(tmp);
    process.exit(9);
  }
  // 安装成功，删除 .pre
  try { fs.unlinkSync(prePath); } catch {}
  log('已替换 app.asar（原子操作）', 'ok');

  // 创建默认配置文件（如果不存在）
  if (!fs.existsSync(CONFIG_FILE)) {
    try {
      fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf8');
      log(`已创建默认配置文件 ${CONFIG_FILE}`, 'ok');
    } catch (e) {
      log('创建配置文件失败: ' + e.message, 'warn');
    }
  } else {
    log('配置文件已存在，跳过创建', 'info');
  }

  saveState({
    claudeVersion: found.version,
    asarPath: found.asarPath,
    installedAt: new Date().toISOString(),
    payloadFiles,
    bakSha256: sha256(bakPath),
    asarSha256: sha256(found.asarPath),
  });
  log(`状态已写入 ${STATE_FILE}`, 'ok');

  rmrf(tmp);
  log('完成。请完全退出 Claude（含托盘）后重新启动。', 'ok');
}

// 检查 asar 包内是否已含我们的注入
// 多重检测：cn-pack/ 目录存在 OR index.original.js 存在
// listPackage 抛错时 fail closed（视为已污染）
function asarHasInjection(asarPath) {
  let list;
  try {
    list = asar.listPackage(asarPath);
  } catch (e) {
    log('asar 内容读取失败（可能已损坏）: ' + e.message, 'warn');
    return true; // fail closed
  }
  // 检测 1：cn-pack 目录存在
  if (list.some((p) => /[\\/]cn-pack[\\/]/i.test(p))) return true;
  // 检测 2：index.original.js 存在（说明我们重命名过）
  if (list.some((p) => /index\.original\.js$/i.test(p))) return true;
  return false;
}

function cmdUninstall() {
  const found = requirePatchable();
  if (isClaudeRunning(found.base)) {
    log('检测到 Claude.exe 正在运行。请先完全退出后再卸载。', 'err');
    process.exit(1);
  }
  const bak = found.asarPath + '.bak';
  if (!fs.existsSync(bak)) {
    log('未找到 .bak，无需还原（或从未安装）', 'warn');
    process.exit(0);
  }
  fs.copyFileSync(bak, found.asarPath);
  log('已用 .bak 还原 app.asar', 'ok');

  // 恢复 exe fuse
  const exePath = findExe(path.dirname(path.dirname(found.asarPath)));
  if (exePath) restoreFuse(exePath);

  log('（保留 .bak 以便重装；如需彻底清除手动删除即可）');
  try {
    fs.unlinkSync(STATE_FILE);
  } catch {}
  log('完成。请重启 Claude。', 'ok');
}

// ============== MSIX 版注入（v1.1.3+） ==============
// 编排逻辑统一走 lib/msix-ops.js（唯一实现入口，launcher GUI 同源共用）

async function cmdInstallMsix() {
  const disc = discoverClaudeInstall();
  if (!disc.msix) {
    log('未发现 MSIX 版 Claude Desktop（也许你是 Squirrel 直装版？请用 node index.js install）', 'err');
    process.exit(1);
  }
  const info = disc.msix;
  log(`asar: ${info.asarPath}`);

  if (isRunningUnderInstall(info.installRoot)) {
    log('检测到 Claude 正在运行。请先右键托盘 → Quit 完全退出（任务管理器确认无 claude.exe）。', 'err');
    process.exit(1);
  }
  if (!msixOps.isAdminUser()) {
    log('MSIX 注入需要管理员权限（WindowsApps 文件归 TrustedInstaller 所有）。', 'err');
    log('请以管理员身份打开终端后重试：右键终端 → 以管理员身份运行 → cd 到 installer 目录 → node index.js install-msix', 'err');
    process.exit(21);
  }
  const payloadText = {
    i18n: fs.readFileSync(path.join(PAYLOAD_DIR, 'i18n.js'), 'utf8'),
    panel: fs.readFileSync(path.join(PAYLOAD_DIR, 'panel.js'), 'utf8')
  };
  try {
    msixOps.installMsix(info, payloadText, log);
  } catch (e) {
    const codeMap = { PRISTINE: 22, BACKUP: 26, ACL: 23, VERIFY: 24, INJECTED: 28 };
    log((e.code === 'PRISTINE' ? '前置校验失败：' : '❌ ') + e.message, 'err');
    if (e.code === 'PRISTINE') log('若之前已注入过，请先 node index.js uninstall-msix 再重试。', 'err');
    if (e.code === 'INJECTED') log('请先 node index.js uninstall-msix 还原原包，再重新安装。', 'err');
    if (e.code === 'VERIFY') log('注后校验未全过！请立即用 uninstall-msix 回滚。', 'err');
    process.exit(codeMap[e.code] || 99);
  }
  log('注意：Claude 自动升级（包版本变化）后需重新运行 install-msix；uninstall-msix 可一键还原。');
}

function cmdUninstallMsix() {
  const state = loadState();
  if (
    state && state.kind === 'msix' && state.asarPath &&
    fs.existsSync(state.asarPath) &&
    isRunningUnderInstall(path.dirname(path.dirname(state.asarPath)))
  ) {
    log('检测到 Claude 正在运行，请先完全退出。', 'err');
    process.exit(1);
  }
  if (!msixOps.isAdminUser()) {
    log('回滚同样需要管理员权限（还原 TrustedInstaller 保护下的文件内容）。', 'err');
    process.exit(21);
  }
  try {
    msixOps.uninstallMsix(log);
  } catch (e) {
    const codeMap = { NOBACKUP: 25, ACL: 23, ROLLBACK: 27 };
    log((e.code === 'NOOP' ? '' : '❌ ') + e.message, e.code === 'NOOP' ? 'warn' : 'err');
    process.exit(codeMap[e.code] || (e.code === 'NOOP' ? 0 : 99));
  }
}

function cmdStatus() {
  const disc = discoverClaudeInstall();
  const state = loadState();
  console.log('--- Claude Desktop CN status ---');

  // Squirrel 直装版（本工具的目标形态）
  const found = disc.squirrel ? toLegacyFound(disc.squirrel) : null;
  if (found) {
    console.log(
      'Claude (直装版):',
      `${found.version}  (${found.asarPath})`,
      '—— 可注入'
    );
    console.log(
      '原始备份 (.bak):',
      fs.existsSync(found.asarPath + '.bak') ? '存在' : '不存在'
    );
  } else {
    console.log('Claude (直装版): 未发现');
  }

  // MSIX 包（新版形态，仅识别，不注入）
  if (disc.msix) {
    console.log(
      'Claude (MSIX 包):',
      `${describeInfo(disc.msix)}  (${disc.msix.asarPath})`
    );
  }

  if (!disc.found) console.log('未发现任何 Claude Desktop 安装。');

  console.log(
    '安装状态:',
    state ? JSON.stringify(state, null, 2) : '未安装（无 state.json）'
  );

  if (state && found && state.claudeVersion !== found.version) {
    console.log(
      '\n[!] 检测到 Claude 已升级（state=' +
        state.claudeVersion +
        ' actual=' +
        found.version +
        '）'
    );
    console.log('    建议重新运行: node index.js install');
  }
  if (state && found && fs.existsSync(found.asarPath)) {
    const cur = sha256(found.asarPath);
    if (state.asarSha256 && cur !== state.asarSha256) {
      console.log(
        '\n[!] 当前 asar 哈希与安装时记录不一致，可能已被升级覆盖。'
      );
    }
  }
  if (!found && disc.msix) {
    console.log('\n[!] 仅检测到 MSIX 版：' + MSIX_NOTE);
  }
}

const cmd = process.argv[2];
(async () => {
  switch (cmd) {
    case 'install':
      await cmdInstall();
      break;
    case 'uninstall':
      cmdUninstall();
      break;
    case 'install-msix':
      await cmdInstallMsix();
      break;
    case 'uninstall-msix':
      cmdUninstallMsix();
      break;
    case 'status':
      cmdStatus();
      break;
    default:
      console.log('用法: node index.js <install|uninstall|install-msix|uninstall-msix|status>');
      console.log('  install        注入 Squirrel 直装版');
      console.log('  install-msix   注入 MSIX 版（需管理员，自动备份可回滚）');
      console.log('  status         查看安装状态');
      process.exit(1);
  }
})().catch((e) => {
  log('未处理异常: ' + e.message, 'err');
  process.exit(99);
});
