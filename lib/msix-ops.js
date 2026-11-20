'use strict';
/**
 * MSIX 注入/卸载编排（唯一实现入口）
 *
 * installer CLI 与 launcher GUI 共用：CLI 传磁盘 payload 文本；GUI（pkg 单文件）
 * 传内嵌 payload 文本。仅编排，不持路径表（发现走 discover.js，改写走 msix-inject.js）。
 *
 * 真机落地的系统级前置仍由调用方保证：Claude 已退出 + 管理员权限（UAC/管理员终端）。
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const msixInject = require('./msix-inject.js');
const msixIntegrity = require('./msix-integrity.js');

const MSIX_ENTRY = 'resources\\app.asar';
const STATE_DIR = path.join(process.env.APPDATA || process.env.USERPROFILE || '.', 'claude-cn');
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const LOCK_FILE = path.join(STATE_DIR, 'install.lock');
const WATCHER_TASK = 'ClaudeDesktopCN-Watcher'; // 计划任务名前缀：-Hourly / -Logon

function log_default(msg, kind) { console.log('[' + (kind === 'ok' ? '+' : kind === 'err' ? 'x' : 'i') + '] ' + msg); }

function isAdminUser() {
  if (process.platform !== 'win32') return false;
  try {
    execSync('net session', { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    return true;
  } catch (_) {
    return false;
  }
}

// takeown 给 Administrators 组 + icacls 授完全控制
function ensureWritable(file, log) {
  try {
    execSync(`takeown /a /f "${file}"`, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  } catch (e) {
    log('takeown 失败: ' + e.message, 'err');
    return false;
  }
  try {
    execSync(`icacls "${file}" /grant "*S-1-5-32-544:F"`, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  } catch (e) {
    log('icacls 授权失败: ' + e.message, 'err');
    return false;
  }
  return true;
}

function sha256File(file) {
  const crypto = require('crypto');
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(file));
  return h.digest('hex');
}

function msixBackupDir(msixInfo) {
  return path.join(STATE_DIR, 'msix-backup', msixInfo.packageVersion || 'unknown');
}

function saveState(state) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (_) {
    return null;
  }
}

// ============ 注入互斥锁（手动安装 vs watcher 自动注入防并发） ============
function acquireInstallLock() {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const age = Date.now() - fs.statSync(LOCK_FILE).mtimeMs;
      if (age < 10 * 60 * 1000) return false; // 活锁（10 分钟内视为注入进行中）
    }
    fs.writeFileSync(LOCK_FILE, String(process.pid), { flag: 'wx' });
    return true;
  } catch (_) {
    return false;
  }
}

function releaseInstallLock() {
  try { fs.unlinkSync(LOCK_FILE); } catch (_) {}
}

// ============ 自动守护计划任务（非常驻：每小时 + 登录时单次检查，秒级即退） ============
function registerWatcher(execLine, log) {
  const tasks = [
    { name: WATCHER_TASK + '-Hourly', sched: '/sc minute /mo 60' },
    { name: WATCHER_TASK + '-Logon', sched: '/sc onlogon /rl HIGHEST' }
  ];
  for (const t of tasks) {
    try { execSync('schtasks /delete /f /tn "' + t.name + '"', { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }); } catch (_) {}
    const rl = t.name.indexOf('Hourly') >= 0 ? ' /rl HIGHEST' : '';
    execSync('schtasks /create /f /tn "' + t.name + '" ' + t.sched + rl + ' /tr "\\"' + execLine + '\\""', { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    try { execSync('schtasks /run /tn "' + t.name + '"', { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }); } catch (_) {}
  }
  try { fs.writeFileSync(path.join(STATE_DIR, 'watcher-registered.flag'), new Date().toISOString()); } catch (_) {}
  if (log) log('自动守护已注册（每小时 + 登录时单次检查，无常驻进程），Claude 升级后自动重注入', 'ok');
  return true;
}

function unregisterWatcher(log) {
  for (const tn of [WATCHER_TASK + '-Hourly', WATCHER_TASK + '-Logon']) {
    try { execSync('schtasks /delete /f /tn "' + tn + '"', { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }); } catch (_) {}
  }
  try {
    const pid = fs.readFileSync(path.join(STATE_DIR, 'watcher.pid'), 'utf8').trim();
    if (pid) process.kill(parseInt(pid, 10));
  } catch (_) {}
  try { fs.unlinkSync(path.join(STATE_DIR, 'watcher.pid')); } catch (_) {}
  try { fs.unlinkSync(path.join(STATE_DIR, 'watcher-registered.flag')); } catch (_) {}
  if (log) log('自动守护已注销', 'ok');
  return true;
}

function isWatcherRegistered() {
  try {
    if (fs.existsSync(path.join(STATE_DIR, 'watcher-registered.flag'))) return true; // 本机注册标记（零外部进程依赖）
  } catch (_) {}
  try {
    const { execSync } = require('child_process');
    execSync('schtasks /query /tn "' + WATCHER_TASK + '-Hourly"', { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    return true;
  } catch (_) {}
  return false;
}

/** GUI 状态：MSIX 是否已注入（以 state.json + 备份元数据为准；stale=记录版本与当前包不一致） */
function readMsixInjectedState(currentPackageVersion) {
  const s = loadState();
  if (s && s.kind === 'msix') {
    const stale = !s.claudeVersion || (currentPackageVersion && s.claudeVersion !== currentPackageVersion);
    return {
      injected: !stale,
      stale: stale,
      recordedVersion: s.claudeVersion,
      packageVersion: s.claudeVersion,
      innerVersion: s.innerVersion,
      backupDir: s.backupDir
    };
  }
  // state.json 缺失时尝试 rollback.json（uninstall 的兜底信息也证明曾注入）
  try {
    const backupRoot = path.join(STATE_DIR, 'msix-backup');
    for (const ver of fs.readdirSync(backupRoot)) {
      const meta = JSON.parse(fs.readFileSync(path.join(backupRoot, ver, 'rollback.json'), 'utf8'));
      if (meta && meta.kind === 'msix-rollback') {
        const stale = currentPackageVersion && meta.packageVersion !== currentPackageVersion;
        return {
          injected: false,
          stale: stale,
          recordedVersion: meta.packageVersion,
          packageVersion: meta.packageVersion,
          innerVersion: meta.innerVersion,
          backupDir: path.join(backupRoot, ver),
          rollbackOnly: true
        };
      }
    }
  } catch (_) {}
  return { injected: false, stale: false, packageVersion: null, innerVersion: null, backupDir: null };
}

/**
 * MSIX 注入全流程（前置：Claude 已退出 + 管理员权限）。
 * @param info discover 的 msix 形态信息
 * @param payloadText {{i18n, guard, panel}} 渲染进程 payload 源码文本
 * @param log 日志回调 (msg, kind)
 */
function installMsix(info, payloadText, log) {
  log = log || log_default;
  if (!isAdminUser()) {
    throw Object.assign(new Error('需要管理员权限（WindowsApps 写入）。请以管理员身份运行或经 GUI 开启自动守护。'), { code: 'ACL' });
  }
  if (!acquireInstallLock()) {
    throw Object.assign(new Error('另一个安装/注入正在进行中，请稍后再试。'), { code: 'BUSY' });
  }
  try {
    log(`定位到 MSIX ${info.packageVersion}（内部 ${info.version}）`);

    // 已注入检测提前到最前：注入后的包与原包备份哈希必然不同，若先走备份校验会误报
    const asarAppend = require('./asar-append.js');
    const entryText = asarAppend.extractFile(info.asarPath, msixInject.ENTRY_PARTS).toString('utf8');
    if (entryText.indexOf('Claude CN MSIX prelude') >= 0) {
      throw Object.assign(new Error('检测到已注入过汉化（入口含 prelude 标记）。请先执行卸载还原，再重新安装。'), { code: 'INJECTED' });
    }

    // 前置完整性校验：确认是未动过的原包
    const embedded = msixIntegrity.expectedHash(info.exePath, MSIX_ENTRY);
    const actual = msixIntegrity.computeAsarHeaderHash(info.asarPath);
    if (embedded !== actual) {
      throw Object.assign(new Error('前置校验失败：asar 头哈希与 exe 内嵌值不一致（可能已注入过或版本异常）。若已注入过请先卸载。'), { code: 'PRISTINE' });
    }
    log('前置完整性校验通过（原包未被动过）', 'ok');

    // 备份（唯一回滚依据：副本哈希必须与源逐字节一致才算成功）
    const backupDir = msixBackupDir(info);
    fs.mkdirSync(backupDir, { recursive: true });
    const asarBak = path.join(backupDir, 'app.asar');
    const exeBak = path.join(backupDir, 'claude.exe');
    if (!fs.existsSync(asarBak)) {
      log(`备份 app.asar → ${asarBak} ...`);
      fs.copyFileSync(info.asarPath, asarBak);
    }
    if (!fs.existsSync(exeBak)) {
      log(`备份 claude.exe → ${exeBak} ...`);
      fs.copyFileSync(info.exePath, exeBak);
    }
    if (sha256File(asarBak) !== sha256File(info.asarPath) || sha256File(exeBak) !== sha256File(info.exePath)) {
      throw Object.assign(new Error('备份校验失败（副本与源不一致，可能磁盘满/被占用），未做任何修改。'), { code: 'BACKUP' });
    }
    fs.writeFileSync(
      path.join(backupDir, 'rollback.json'),
      JSON.stringify(
        {
          kind: 'msix-rollback',
          packageVersion: info.packageVersion,
          innerVersion: info.version,
          packageFamilyName: info.packageFamilyName,
          asarPath: info.asarPath,
          exePath: info.exePath,
          asarSha256: sha256File(info.asarPath),
          exeSha256: sha256File(info.exePath),
          headerHashBefore: actual,
          backedUpAt: new Date().toISOString()
        },
        null,
        2
      )
    );
    log('备份完成并校验一致（rollback.json 已写）', 'ok');

    // 可写化
    log('获取文件写权限（takeown/icacls，不会改动目录结构）...');
    for (const f of [info.asarPath, info.exePath]) {
      if (!ensureWritable(f, log)) {
        throw Object.assign(new Error('获取写权限失败，中止（未做任何修改）。'), { code: 'ACL' });
      }
    }

    // 注入（原地）
    log('注入中（追加式 asar 改写 + exe 哈希同步）...');
    const r = msixInject.inject(info, payloadText, null);
    log(`blob ${r.blobSize} 字节已追加，新头哈希 ${r.headerHash.slice(0, 16)}...`, 'ok');

    const checks = msixInject.verifyInjected(info.asarPath, info.exePath);
    const allOk = Object.values(checks).every(Boolean);
    log('注后校验: ' + JSON.stringify(checks), allOk ? 'ok' : 'err');
    if (!allOk) {
      throw Object.assign(new Error('注后校验未全过！请立即执行卸载回滚。'), { code: 'VERIFY', checks: checks });
    }

    saveState({
      kind: 'msix',
      claudeVersion: info.packageVersion,
      innerVersion: info.version,
      packageFamilyName: info.packageFamilyName,
      asarPath: info.asarPath,
      exePath: info.exePath,
      backupDir: backupDir,
      installedAt: new Date().toISOString(),
      headerHash: r.headerHash
    });
    log(`状态已写入 ${STATE_FILE}`, 'ok');
    // 注入成功即自动注册守护计划任务（每小时 + 登录时单次检查；升级后自动重注入，用户无需做任何事）
    try {
      registerWatcher(globalThis.__cnWatcherExecLine || (process.execPath + (process.argv[1] ? ' "' + process.argv[1] + '"' : '')), log);
    } catch (e) {
      log('自动守护注册失败: ' + (e.message || e), 'warn');
    }
    releaseInstallLock();
    log('完成。请启动 Claude 验证汉化效果。', 'ok');
    return { headerHash: r.headerHash, blobSize: r.blobSize, backupDir: backupDir };
  } catch (e) {
    releaseInstallLock();
    throw e;
  }
}

/** MSIX 卸载全流程（前置：Claude 已退出 + 管理员权限）。 */
function uninstallMsix(log) {
  log = log || log_default;
  if (!isAdminUser()) {
    throw Object.assign(new Error('回滚同样需要管理员权限（还原 TrustedInstaller 保护下的文件内容）。'), { code: 'ACL' });
  }
  if (!acquireInstallLock()) {
    throw Object.assign(new Error('另一个安装/卸载正在进行中，请稍后再试。'), { code: 'BUSY' });
  }
  try {
    let state = loadState();
    if (!state || state.kind !== 'msix') {
      // state.json 缺失时从备份元数据恢复
      const backupRoot = path.join(STATE_DIR, 'msix-backup');
      let latest = null;
      try {
        for (const ver of fs.readdirSync(backupRoot)) {
          const metaFile = path.join(backupRoot, ver, 'rollback.json');
          if (!fs.existsSync(metaFile)) continue;
          const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
          if (meta && meta.kind === 'msix-rollback' && (!latest || meta.backedUpAt > latest.meta.backedUpAt)) {
            latest = { meta: meta, backupDir: path.join(backupRoot, ver) };
          }
        }
      } catch (_) {}
      if (!latest) {
        throw Object.assign(new Error('无 MSIX 安装记录（state.json 与备份元数据均不存在），无需回滚。'), { code: 'NOOP' });
      }
      log('state.json 缺失，已从备份元数据 rollback.json 恢复回滚信息');
      state = {
        kind: 'msix',
        claudeVersion: latest.meta.packageVersion,
        asarPath: latest.meta.asarPath,
        exePath: latest.meta.exePath,
        backupDir: latest.backupDir
      };
    }
    const asarBak = path.join(state.backupDir, 'app.asar');
    const exeBak = path.join(state.backupDir, 'claude.exe');
    // Claude 升级换包后，记录中的旧包文件已不存在：注入随旧包一起消失，
    // 无需（也无法）还原——清除记录即可，保留备份供追溯
    if (!fs.existsSync(state.asarPath) || !fs.existsSync(state.exePath)) {
      try { fs.unlinkSync(STATE_FILE); } catch (_) {}
      try { unregisterWatcher(log); } catch (_) {}
      try { fs.unlinkSync(path.join(STATE_DIR, 'watcher-registered.flag')); } catch (_) {}
      log('检测到 Claude 已升级换包（记录中的旧包 ' + state.claudeVersion + ' 已被移除），注入随旧包消失。');
      log('已清除安装记录（备份保留在 ' + state.backupDir + '）。请对当前版本重新执行安装。', 'ok');
      return { clearedStale: true, backupDir: state.backupDir };
    }
    if (!fs.existsSync(asarBak) || !fs.existsSync(exeBak)) {
      throw Object.assign(new Error('备份缺失，无法回滚: ' + state.backupDir), { code: 'NOBACKUP' });
    }
    for (const f of [state.asarPath, state.exePath]) {
      if (!ensureWritable(f, log)) {
        throw Object.assign(new Error('获取写权限失败，中止（当前文件未动）。'), { code: 'ACL' });
      }
    }
    log('还原 app.asar ...');
    fs.copyFileSync(asarBak, state.asarPath);
    log('还原 claude.exe ...');
    fs.copyFileSync(exeBak, state.exePath);
    const byteOk = sha256File(state.asarPath) === sha256File(asarBak) && sha256File(state.exePath) === sha256File(exeBak);
    if (!byteOk) {
      throw Object.assign(new Error('回滚校验失败：还原文件与备份不一致！备份仍在 ' + state.backupDir), { code: 'ROLLBACK' });
    }
    const embedded = msixIntegrity.expectedHash(state.exePath, MSIX_ENTRY);
    const actual = msixIntegrity.computeAsarHeaderHash(state.asarPath);
    if (embedded === actual) {
      log('回滚校验通过：已恢复官方原包状态（字节数 + 完整性双通过）', 'ok');
    } else {
      log('回滚字节数校验通过，但完整性校验不一致（可能包已升级），请检查版本。', 'warn');
    }
    try {
      fs.unlinkSync(STATE_FILE);
    } catch (_) {}
    try { unregisterWatcher(log); } catch (_) {}
    releaseInstallLock();
    log('完成。请重启 Claude。备份保留在 ' + state.backupDir + '，确认正常后可手动删除。', 'ok');
    return { backupDir: state.backupDir };
  } catch (e) {
    releaseInstallLock();
    throw e;
  }
}

module.exports = {
  installMsix: installMsix,
  uninstallMsix: uninstallMsix,
  registerWatcher: registerWatcher,
  unregisterWatcher: unregisterWatcher,
  isWatcherRegistered: isWatcherRegistered,
  WATCHER_TASK: WATCHER_TASK,
  readMsixInjectedState: readMsixInjectedState,
  isAdminUser: isAdminUser,
  STATE_DIR: STATE_DIR,
  STATE_FILE: STATE_FILE
};
