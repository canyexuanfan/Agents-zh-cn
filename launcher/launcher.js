#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');
const crypto = require('crypto');

const VERSION = '1.1.7';
const PORT = 23456;
// MSIX 编排（构建时由 build.js 内联 lib/msix-ops.js 及其依赖；dev 模式回退 require）
const MSIX_OPS_B64 = '__CN_MSIX_OPS_B64__';
function getMsixOps() {
  try {
    if (MSIX_OPS_B64 && MSIX_OPS_B64.indexOf('__CN_MSIX_OPS_B64__') !== 0) {
      const factorySrc = Buffer.from(MSIX_OPS_B64, 'base64').toString('utf8');
      const factory = new Function('require', factorySrc);
      return factory(require);
    }
  } catch (_) {}
  try {
    return require('../lib/msix-ops.js');
  } catch (_) {
    return null;
  }
}
// Claude 图标（构建时由 build.js 内联 base64；dev 模式回退读 assets/claude.ico）
const CN_ICON_B64 = '__CN_ICON_ICO_B64__';
function getFaviconBuffer() {
  try {
    if (CN_ICON_B64 && CN_ICON_B64.indexOf('__CN_ICON_ICO_B64__') !== 0) {
      return Buffer.from(CN_ICON_B64, 'base64');
    }
    return fs.readFileSync(path.join(__dirname, 'assets', 'claude.ico'));
  } catch (_) {
    return null;
  }
}
const FUSE_SENTINEL = 'dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX';
const FUSE_INTEGRITY_INDEX = 4;

function compareVersion(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}

const PAYLOAD = {
  'boot.js': `BOOT_JS_PLACEHOLDER`,
  'i18n.js': `I18N_JS_PLACEHOLDER`,
  'guard.js': `GUARD_JS_PLACEHOLDER`,
  'panel.js': `PANEL_JS_PLACEHOLDER`
};

// ============== 纯 JS asar 解包/打包 ==============
function asarExtract(asarPath, destDir) {
  const buf = fs.readFileSync(asarPath);
  const headerPickleSize = buf.readUInt32LE(4);
  const jsonLength = buf.readUInt32LE(12);
  const jsonStr = buf.toString('utf8', 16, 16 + jsonLength);
  const header = JSON.parse(jsonStr);
  const dataOffset = 8 + headerPickleSize;

  function extractNode(node, dir) {
    if (!node.files) return;
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, entry] of Object.entries(node.files)) {
      const p = path.join(dir, name);
      if (entry.files) {
        extractNode(entry, p);
      } else if (entry.unpacked) {
        // 跳过 unpacked 文件（它们在 .unpacked 目录）
      } else if (entry.link) {
        try { fs.symlinkSync(entry.link, p); } catch (_) {}
      } else {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        const off = dataOffset + parseInt(entry.offset, 10);
        const data = buf.slice(off, off + entry.size);
        fs.writeFileSync(p, data);
      }
    }
  }
  extractNode(header, destDir);
}

function asarPack(srcDir, destPath) {
  const header = { files: {} };
  const chunks = [];
  let offset = 0;

  function scan(dir, node) {
    const entries = fs.readdirSync(dir).sort();
    for (const name of entries) {
      const full = path.join(dir, name);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) {
        node[name] = { files: {} };
        scan(full, node[name].files);
      } else {
        const data = fs.readFileSync(full);
        node[name] = { offset: String(offset), size: data.length };
        chunks.push(data);
        offset += data.length;
      }
    }
  }
  scan(srcDir, header.files);

  const jsonBuf = Buffer.from(JSON.stringify(header), 'utf8');
  const L = jsonBuf.length;
  const alignedL = ((L + 3) >> 2) << 2;
  const M = 4 + alignedL;
  const N = 4 + M;

  const hdr = Buffer.alloc(8 + N, 0);
  hdr.writeUInt32LE(4, 0);
  hdr.writeUInt32LE(N, 4);
  hdr.writeUInt32LE(M, 8);
  hdr.writeUInt32LE(L, 12);
  jsonBuf.copy(hdr, 16);

  fs.writeFileSync(destPath, Buffer.concat([hdr, ...chunks]));
}

function copyDirSync(src, dest) {
  if (!fs.existsSync(src)) return;
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(d, { recursive: true });
      copyDirSync(s, d);
    } else {
      fs.mkdirSync(path.dirname(d), { recursive: true });
      fs.copyFileSync(s, d);
    }
  }
}

// ============== 工具函数 ==============
// 安装发现统一走 lib/discover.js（唯一实现入口，禁止再写路径表）。
// 构建时 build.js 会将下面这行 require 替换为内联实现（单文件 exe 分发）。
const DISCOVER = require('../lib/discover.js'); /*BUILD:INLINE_DISCOVER*/

function getSquirrelInstall() {
  const disc = DISCOVER.discoverClaudeInstall();
  return disc.squirrel; // null = 没有可注入的 Squirrel 直装版
}

function checkInstallStatus(info) {
  if (!info || !info.asarPath) return { installed: false, version: null };
  const resourcesPath = path.dirname(info.asarPath);
  if (!fs.existsSync(info.asarPath + '.bak')) return { installed: false, version: null };
  const vFile = path.join(resourcesPath, 'app.asar.unpacked', 'cn-pack', 'version.txt');
  let ver = null;
  try { ver = fs.readFileSync(vFile, 'utf8').trim(); } catch (_) { ver = '1.0.0'; }
  return { installed: true, version: ver };
}

function isClaudeRunning(installRoot) {
  if (process.platform !== 'win32') return false;
  return DISCOVER.isRunningUnderInstall(installRoot || null);
}

// ============== Fuse 补丁（禁用 ASAR 完整性校验）==============
function patchFuse(exePath) {
  if (!fs.existsSync(exePath)) return { ok: false, msg: '未找到 claude.exe' };
  const buf = fs.readFileSync(exePath);
  const sentinel = Buffer.from(FUSE_SENTINEL, 'ascii');
  const idx = buf.indexOf(sentinel);
  if (idx < 0) return { ok: false, msg: '未找到 fuse sentinel' };

  const fuseStart = idx + sentinel.length + 2;
  const off = fuseStart + FUSE_INTEGRITY_INDEX;

  if (buf[off] === 0x30) return { ok: true, msg: '完整性校验已禁用' };
  if (buf[off] !== 0x31) return { ok: false, msg: 'fuse 字节异常' };

  const exeBak = exePath + '.bak';
  if (!fs.existsSync(exeBak)) fs.copyFileSync(exePath, exeBak);
  buf[off] = 0x30;
  fs.writeFileSync(exePath, buf);
  return { ok: true, msg: '已禁用完整性校验' };
}

function restoreFuse(exePath) {
  const exeBak = exePath + '.bak';
  if (fs.existsSync(exeBak)) {
    fs.copyFileSync(exeBak, exePath);
    return true;
  }
  return false;
}

// ============== 安装逻辑 ==============
function install(info) {
  const asarPath = info.asarPath;
  const bakPath = asarPath + '.bak';
  const unpackedDir = asarPath + '.unpacked';
  const tmpDir = path.join(os.tmpdir(), 'claude-cn-' + Date.now());
  const logs = [];

  function log(msg) { logs.push(msg); }

  try {
    if (isClaudeRunning(info.installRoot)) {
      return { success: false, error: 'Claude Desktop 正在运行，请先完全退出（包括托盘）' };
    }

    // 1. Fuse 补丁
    const fuse = patchFuse(info.exePath);
    log('Fuse: ' + fuse.msg);
    if (!fuse.ok) {
      return { success: false, error: 'Fuse 补丁失败: ' + fuse.msg };
    }

    // 2. 备份
    if (!fs.existsSync(bakPath)) {
      fs.copyFileSync(asarPath, bakPath);
      log('已备份 app.asar → app.asar.bak');
    } else {
      log('备份已存在');
    }

    // 3. 从备份解包（保证幂等）
    fs.mkdirSync(tmpDir, { recursive: true });
    asarExtract(bakPath, tmpDir);
    log('已解包 asar');

    // 4. 复制 unpacked 文件到临时目录（native 模块）
    if (fs.existsSync(unpackedDir)) {
      copyDirSync(unpackedDir, tmpDir);
      log('已合并 unpacked 文件');
    }

    // 5. 注入 payload
    const cnDir = path.join(tmpDir, 'cn-pack');
    fs.mkdirSync(cnDir, { recursive: true });
    for (const [name, content] of Object.entries(PAYLOAD)) {
      fs.writeFileSync(path.join(cnDir, name), content, 'utf8');
    }
    fs.writeFileSync(path.join(cnDir, 'version.txt'), VERSION, 'utf8');

    // 找到正确的入口文件路径
    const mainEntry = path.join(tmpDir, '.vite', 'build', 'index.pre.js');
    const origEntry = path.join(tmpDir, '.vite', 'build', 'index.original.js');
    if (!fs.existsSync(mainEntry)) {
      return { success: false, error: '未找到入口文件 .vite/build/index.pre.js', logs };
    }
    if (!fs.existsSync(origEntry)) {
      fs.renameSync(mainEntry, origEntry);
    }
    fs.copyFileSync(path.join(cnDir, 'boot.js'), mainEntry);
    log('已注入 boot.js');

    // 6. 重新打包
    const tmpAsar = asarPath + '.cn-tmp';
    asarPack(tmpDir, tmpAsar);
    log('已打包新 asar');

    // 7. 验证
    const tmpSize = fs.statSync(tmpAsar).size;
    const bakSize = fs.statSync(bakPath).size;
    if (tmpSize < bakSize * 0.9) {
      try { fs.unlinkSync(tmpAsar); } catch (_) {}
      return { success: false, error: '新 asar 异常小，打包可能失败', logs };
    }

    // 8. 原子替换
    const prePath = asarPath + '.pre';
    if (fs.existsSync(prePath)) fs.unlinkSync(prePath);
    fs.renameSync(asarPath, prePath);
    try {
      fs.renameSync(tmpAsar, asarPath);
    } catch (e) {
      fs.renameSync(prePath, asarPath);
      return { success: false, error: '替换 asar 失败: ' + e.message, logs };
    }
    try { fs.unlinkSync(prePath); } catch (_) {}
    log('已替换 app.asar');

    // 9. 写入版本标记到 unpacked 目录（用于状态检测）
    const cnUnpacked = path.join(info.resourcesPath, 'app.asar.unpacked', 'cn-pack');
    fs.mkdirSync(cnUnpacked, { recursive: true });
    fs.writeFileSync(path.join(cnUnpacked, 'version.txt'), VERSION, 'utf8');

    // 10. 清理
    fs.rmSync(tmpDir, { recursive: true, force: true });

    return { success: true, logs };
  } catch (error) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    return { success: false, error: error.message, logs };
  }
}

function uninstall(info) {
  const asarPath = info.asarPath;
  const bakPath = asarPath + '.bak';

  try {
    if (isClaudeRunning(info.installRoot)) {
      return { success: false, error: 'Claude Desktop 正在运行，请先完全退出' };
    }
    if (!fs.existsSync(bakPath)) {
      return { success: false, error: '未找到备份文件' };
    }
    fs.copyFileSync(bakPath, asarPath);
    fs.unlinkSync(bakPath);
    restoreFuse(info.exePath);

    const cnPackDir = path.join(info.resourcesPath, 'app.asar.unpacked', 'cn-pack');
    if (fs.existsSync(cnPackDir)) fs.rmSync(cnPackDir, { recursive: true, force: true });

    const stateDir = path.join(process.env.APPDATA || '', 'claude-cn');
    if (fs.existsSync(stateDir)) fs.rmSync(stateDir, { recursive: true, force: true });

    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// ============== HTTP 服务器 GUI ==============
const HTML_UI = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Claude Desktop CN - 安装器</title>
  <link rel="icon" href="/favicon.ico" type="image/x-icon">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { height: 100%; margin: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
      background: linear-gradient(160deg, #FAF9F5 0%, #F0EEE6 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 14px;
      box-sizing: border-box;
    }
    .container {
      background: white;
      border-radius: 16px;
      box-shadow: 0 16px 48px rgba(31, 30, 29, 0.18); border: 1px solid #E8E2D5;
      width: 100%;
      max-width: 760px;
      overflow: hidden;
    }
    .header {
      background: linear-gradient(135deg, #D97757 0%, #C96442 100%);
      color: #FAF9F5;
      padding: 18px;
      text-align: center;
    }
    .header h1 { font-size: 24px; font-weight: 600; margin-bottom: 0; }
    .header p { font-size: 14px; opacity: 0.9; }
    .content { padding: 20px 32px; }
    .status {
      background: #FAF9F5;
      border: 1px solid #E8E2D5;
      border-radius: 8px;
      padding: 14px 16px;
      margin-bottom: 18px;
    }
    .status-item {
      display: flex;
      justify-content: space-between;
      padding: 6px 0;
      font-size: 14px;
      gap: 12px;
    }
    .status-label { color: #6b7280; }
    .status-value { font-weight: 600; color: #374151; }
    .status-value.success { color: #10b981; }
    .status-value.error { color: #ef4444; }
    .button-group {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
      margin-bottom: 24px;
    }
    .btn {
      padding: 14px 24px;
      border: none;
      border-radius: 8px;
      font-size: 15px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s;
    }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .btn-primary {
      background: #D97757;
      color: #FAF9F5;
    }
    .btn-primary:hover:not(:disabled) {
      transform: translateY(-2px);
      background: #C96442;
      box-shadow: 0 8px 20px rgba(217, 119, 87, 0.4);
    }
    .btn-secondary {
      background: white;
      color: #374151;
      border: 2px solid #e5e7eb;
    }
    .btn-secondary:hover:not(:disabled) {
      border-color: #667eea;
      color: #667eea;
    }
    .btn-outline {
      background: white;
      color: #C96442;
      border: 2px solid #D97757;
    }
    .btn-outline:hover {
      background: #D97757;
      color: #FAF9F5;
    }
    .log {
      box-sizing: border-box;
      background: #1F1917;
      color: #f3f4f6;
      border-radius: 8px;
      padding: 16px;
      font-family: 'Consolas', 'Monaco', monospace;
      font-size: 12px;
      height: 180px;
      overflow-y: scroll;
      line-height: 1.6;
      scrollbar-width: thin;
      scrollbar-color: #64748b #334155;
    }
    @media (max-width: 620px) {
      .button-group { grid-template-columns: 1fr; }
      .content { padding: 14px 16px; }
    }
        .log::-webkit-scrollbar { width: 10px; }
    .log::-webkit-scrollbar-track { background: #3A3530; }
    .log::-webkit-scrollbar-thumb { background: #6B6657; border-radius: 5px; }
        .btn:hover:not(:disabled) { filter: brightness(1.12); }
    .btn:active:not(:disabled) { transform: translateY(1px); }


    .status-item:hover { background: rgba(217, 119, 87, 0.08); }
    .status-item { transition: background 0.15s; border-radius: 6px; padding-left: 6px; padding-right: 6px; margin-left: -6px; margin-right: -6px; }
    .log-entry { margin-bottom: 4px; }
    .log-entry.info { color: #D97757; }
    .log-entry.success { color: #34d399; }
    .log-entry.error { color: #f87171; }
    .footer {
      padding: 20px 32px;
      background: #F0EEE6;
      border-top: 1px solid #E8E2D5;
      text-align: center;
      font-size: 13px;
      color: #6B6657;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Claude Desktop CN <span style="font-size:16px;opacity:.85;font-weight:400">v${VERSION}</span></h1>
    </div>
    <div class="content">
      <div class="status">
        <div class="status-item">
          <span class="status-label" title="自动发现 Claude 安装形态：MSIX（微软新打包格式，可注入）/ Squirrel 直装版 / 未找到">Claude Desktop</span>
          <span class="status-value" id="s-found" title="当前检测到的 Claude 安装形态">-</span>
        </div>
        <div class="status-item">
          <span class="status-label" title="汉化注入状态：已注入（版本）/ 需重新注入（Claude 升级后）/ 未安装">汉化状态</span>
          <span class="status-value" id="s-inst" title="当前汉化注入状态">-</span>
        </div>
        <div class="status-item">
          <span class="status-label" title="Claude Desktop 当前包版本（括号内为内部版本号）">Claude 版本</span>
          <span class="status-value" id="s-ver" title="当前 Claude Desktop 版本">-</span>
        </div>
        <div class="status-item">
          <span class="status-label" title="下载新版本安装包时自动定位到旧版安装包所在目录（优先取正在运行的安装器所在文件夹），所有版本集中存放">安装包保存位置（自动识别）</span>
          <span class="status-value" id="s-dldir" style="max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="下载时自动定位旧版安装包所在目录" title="下载时自动识别的安装包保存目录">-</span>
        </div>
        <div class="status-item">
          <span class="status-label" title="每小时与登录时自动检查：Claude 升级换包后自动重新注入汉化，无常驻进程">自动守护（升级自动重注入）</span>
          <span class="status-value" id="s-watcher" title="自动守护状态：注入汉化后自动开启，Claude 升级后自动重注入（计划任务每小时+登录时检查）">查询中…</span>
        </div>
      </div>
      <div class="button-group">
        <button class="btn btn-primary" id="btn-i" onclick="doInstall()" title="注入汉化与反风控守护到 Claude Desktop（自动备份，可一键还原）">安装汉化</button>
        <button class="btn btn-secondary" id="btn-u" onclick="doUninstall()" title="还原官方原包（自动校验，旧文件已备份）" disabled>卸载还原</button>
      </div>
      <div class="button-group" style="margin-top:0">
        <button class="btn btn-outline" onclick="doCheckUpdate()" title="检查线上是否有新版安装器（服务端下载+断点续传+自动定位文件）">🔄 检查更新</button>
        <button class="btn btn-outline" onclick="window.open('https://www.hnwen17.top')" title="打开作者网站">🌐 联系作者</button>
      </div>
      <div class="log" id="log"></div>
    </div>
    <div class="footer">
      <p>安装后请完全退出 Claude Desktop 再重新打开</p>
    </div>
  </div>
  <script>
    function log(msg, type) {
      var el = document.getElementById('log');
      var d = document.createElement('div');
      d.className = 'log-entry ' + (type||'info');
      d.textContent = '[' + new Date().toLocaleTimeString() + '] ' + msg;
      el.appendChild(d);
      el.scrollTop = el.scrollHeight;
    }
    async function checkStatus() {
      var d = await fetchStatusWithRetry();
      window.__status = d;
      var foundText;
      if (d.found) { foundText = '已检测到（直装版）'; }
      else if (d.msixFound) { foundText = '已检测到（MSIX 版）'; }
      else { foundText = '未找到'; }
      document.getElementById('s-found').textContent = foundText;
      document.getElementById('s-found').className = 'status-value ' + ((d.found || d.msixFound) ? 'success' : 'error');
      var instEl = document.getElementById('s-inst');
      if (d.found) {
        if (d.installed && d.needsUpdate) {
          instEl.textContent = '需要更新 (v' + d.installedVersion + ' → v' + d.currentVersion + ')';
          instEl.className = 'status-value error';
        } else {
          instEl.textContent = d.installed ? '已安装 (v' + d.installedVersion + ')' : '未安装';
          instEl.className = 'status-value ' + (d.installed ? 'success' : '');
        }
      } else if (d.msixFound) {
        if (d.msixInjected) {
          instEl.textContent = '已注入 v' + d.currentVersion;
          instEl.className = 'status-value success';
        } else if (d.msixStale) {
          instEl.textContent = 'Claude 已升级（' + (d.msixRecordedVersion || '旧版') + ' → ' + d.msixPackageVersion + '），需重新注入';
          instEl.className = 'status-value error';
        } else {
          instEl.textContent = '未注入（可安装）';
          instEl.className = 'status-value';
        }
      } else {
        instEl.textContent = '-';
        instEl.className = 'status-value';
      }
      var verText = '-';
      if (d.msixFound) {
        verText = d.msixPackageVersion + (d.msixInnerVersion ? '（内部 ' + d.msixInnerVersion + '）' : '');
      } else if (d.version) { verText = d.version; }
      document.getElementById('s-ver').textContent = verText;
      try {
        document.getElementById('s-found').title = d.found ? '检测到 Squirrel 直装版（可注入）' : (d.msixFound ? '检测到 MSIX 版 Claude（新打包格式，支持一键注入）' : '未检测到 Claude Desktop');
        document.getElementById('s-inst').title = d.found ? ('注入状态：' + (d.installed ? '已安装 v' + d.installedVersion : '未安装')) : (d.msixInjected ? '已注入当前 Claude 包（版本 ' + d.msixPackageVersion + '）' : '尚未注入当前 Claude 包');
        document.getElementById('s-ver').title = d.msixFound ? '包版本 ' + d.msixPackageVersion + '，内部版本 ' + (d.msixInnerVersion || '?') : '当前 Claude 版本';
      } catch (_) {}
      var btnI = document.getElementById('btn-i');
      var msixOnly = d.msixFound && !d.found;
      if (d.found && d.needsUpdate) {
        btnI.textContent = '更新汉化';
        btnI.disabled = false;
      } else {
        btnI.textContent = msixOnly ? (d.msixStale ? '重新注入汉化（MSIX）' : '安装汉化（MSIX）') : '安装汉化';
        btnI.disabled = d.found ? (d.installed && !d.needsUpdate) : (d.msixFound ? d.msixInjected : true);
      }
      // stale（升级换包）时卸载按钮保持可用：点击可清除旧记录（msix-ops 优雅路径）
      document.getElementById('btn-u').disabled = !((d.found && d.installed) || (d.msixFound && (d.msixInjected || d.msixStale)));
    }
    async function doInstall() {
      document.getElementById('btn-i').disabled = true;
      var msixOnly = window.__status && window.__status.msixFound && !window.__status.found;
      log(msixOnly ? '开始 MSIX 注入（将在 UAC 弹窗中点"是"）...' : '开始安装/更新...');
      var r = await fetch(msixOnly ? '/api/install-msix' : '/api/install', {method:'POST'});
      var d = await r.json();
      if (d.logs) d.logs.forEach(function(m){log(m)});
      if (d.log) String(d.log).split(/\\r?\\n/).filter(Boolean).forEach(function (m) { log(m.replace(/^\\[.\\]\\s*/, '')); });
      if (d.success) {
        log(msixOnly ? '注入成功！请启动 Claude 验证汉化效果' : '操作成功！请完全退出 Claude Desktop 后重新打开', 'success');
      } else {
        log('操作失败: ' + (d.error || '详见上方日志'), 'error');
      }
      await checkStatus();
    }
    async function doUninstall() {
      var msixOnly = window.__status && window.__status.msixFound && !window.__status.found;
      if (!confirm('确定要卸载汉化吗？' + (msixOnly ? '（将还原官方原包）' : ''))) return;
      document.getElementById('btn-u').disabled = true;
      log(msixOnly ? '开始 MSIX 卸载（将在 UAC 弹窗中点"是"）...' : '开始卸载...');
      var r = await fetch(msixOnly ? '/api/uninstall-msix' : '/api/uninstall', {method:'POST'});
      var d = await r.json();
      if (d.logs) d.logs.forEach(function(m){log(m)});
      if (d.log) String(d.log).split(/\\r?\\n/).filter(Boolean).forEach(function (m) { log(m.replace(/^\\[.\\]\\s*/, '')); });
      if (d.success) {
        log('卸载成功！已还原官方原包', 'success');
      } else {
        log('卸载失败: ' + (d.error || '详见上方日志'), 'error');
      }
      await checkStatus();
    }
    async function doCheckUpdate() {
      log('正在检查更新...');
      try {
        var r = await fetch('/api/check-update', { signal: AbortSignal.timeout ? AbortSignal.timeout(35000) : undefined });
        var d = await r.json();
        if (d.error) { log('检查失败: ' + d.error, 'error'); return; }
        if (d.hasUpdate) {
          log('发现新版本: v' + d.remoteVersion + ' (当前安装: v' + d.installedVersion + ')', 'success');
          if (d.changelog) log('更新内容: ' + d.changelog);
          if (confirm('发现新版本 v' + d.remoteVersion + '，是否下载新版安装器？（服务端下载，完成后自动定位文件）')) {
            await startDownload();
          }
        } else {
          log('当前已是最新版本 (v' + d.installedVersion + ')', 'success');
        }
      } catch(e) { log('检查更新失败: ' + e.message, 'error'); }
    }
    async function startDownload() {
      try {
        var r = await fetch('/api/download-update', { method: 'POST' });
        var d = await r.json();
        if (d.error) { log('下载启动失败: ' + d.error, 'error'); return; }
        log('开始下载安装包（服务端下载，进度见下方）...');
        pollDownload();
      } catch (e) { log('下载启动失败: ' + e.message, 'error'); }
    }
    async function pollDownload() {
      for (;;) {
        await new Promise(function (res) { setTimeout(res, 700); });
        var d;
        try {
          var r = await fetch('/api/download-progress');
          d = await r.json();
        } catch (e) { log('进度获取失败: ' + e.message, 'error'); return; }
        if (d.total > 0) {
          var pct = Math.floor((d.received || 0) * 100 / d.total);
          var speedMB = ((d.speed || 0) / 1048576).toFixed(2);
          var etaTxt = d.eta != null ? '，剩余约 ' + (d.eta > 60 ? Math.round(d.eta / 60) + ' 分钟' : d.eta + ' 秒') : '';
          var gzTxt = d.isGz ? '（压缩包，完成后自动解压）' : '';
          log('下载中: ' + pct + '% (' + Math.round((d.received || 0) / 1048576) + ' / ' + Math.round(d.total / 1048576) + ' MB，' + speedMB + ' MB/s' + etaTxt + ')' + gzTxt);
        }
        if (d.error) { log('下载失败: ' + d.error, 'error'); return; }
        if (d.done && !d.active) {
          log('下载完成: ' + d.path, 'success');
          try { await fetch('/api/download-reveal', { method: 'POST' }); log('已在资源管理器中定位文件，双击即可运行新版安装器'); } catch (_) {}
          await checkStatus();
          return;
        }
        if (!d.active && !d.done) { log('下载中断，请重试检查更新', 'error'); return; }
      }
    }
    async function refreshDlDir() {
      try {
        var r = await fetch('/api/dldir');
        var d = await r.json();
        var el = document.getElementById('s-dldir');
        el.textContent = d.dir || '-';
        el.title = '下载时自动识别旧版安装包所在目录（当前识别: ' + (d.dir || '-') + ')';
      } catch (_) {}
    }
    async function refreshWatcherStatus() {
      try {
        var r = await fetch('/api/watcher-status');
        var d = await r.json();
        window.__watcherStatus = d;
        var wEl = document.getElementById('s-watcher');
        if (wEl) { wEl.title = '自动守护（计划任务每小时+登录时检查）：当前 ' + (d.enabled ? '运行中，Claude 升级后自动重注入' : '未运行'); }
        if (wEl) { wEl.textContent = d.enabled ? '已开启（升级自动重注入）' : '未注入'; wEl.className = 'status-value ' + (d.enabled ? 'success' : ''); }
      } catch (_) {}
    }
    window.addEventListener('error', function (ev) { try { log('页面错误: ' + ((ev && ev.message) || '未知')); } catch (_) {} });
    window.addEventListener('unhandledrejection', function (ev) { try { log('异步错误: ' + ((ev && ev.reason && ev.reason.message) || String(ev.reason || ''))); } catch (_) {} });
    async function fetchStatusWithRetry() {
      var lastErr = null;
      for (var i = 0; i < 60; i++) {
        try { var r = await fetch('/api/status'); if (r.ok) return await r.json(); lastErr = 'HTTP ' + r.status; } catch (e) { lastErr = e.message; }
        await new Promise(function (res) { setTimeout(res, 500); });
      }
      throw new Error(lastErr || '无法连接本地服务');
    }
    window.addEventListener('DOMContentLoaded', function(){
      log('安装器就绪');
      checkStatus().catch(function (e) { log('状态获取失败: ' + e.message + '（服务可能未运行，请重新打开本程序）', 'error'); });
      refreshDlDir();
      refreshWatcherStatus();
    });

  </script>
</body>
</html>`;

// ============== API 路由 ==============

// 配置读写（%APPDATA%\\claude-cn\\config.json）
// 自动识别旧版安装包所在目录（零配置）：
//   1) Windows 最近使用记录 Recent\*.lnk 解析 ClaudeDesktopCN 快捷方式的目标目录
//   2) 常见目录（下载/桌面/OneDrive 桌面）中 glob 最新 ClaudeDesktopCN*.exe
//   3) 都没有 → 回退系统下载文件夹
let cachedLegacyDir = null;
function findLegacyPackageDir() {
  // 首选：正在运行的安装器 exe 自身所在目录（旧版安装包在这里，新版下到同一处）
  if (process.execPath && /\.exe$/i.test(process.execPath) && process.execPath.toLowerCase().indexOf('node.exe') < 0) {
    try {
      const selfDir = path.dirname(process.execPath);
      if (fs.existsSync(selfDir)) return selfDir;
    } catch (_) {}
  }
  const { execSync } = require('child_process');
  const recentDir = path.join(process.env.APPDATA || '.', 'Microsoft', 'Windows', 'Recent');
  let bestDir = null;
  let bestM = 0;
  try {
    for (const f of fs.readdirSync(recentDir)) {
      if (!/^ClaudeDesktopCN.*\.lnk$/i.test(f)) continue;
      const full = path.join(recentDir, f);
      let m = 0;
      try { m = fs.statSync(full).mtimeMs; } catch (_) { continue; }
      if (m <= bestM) continue;
      const ps = 'powershell -NoProfile -Command "(New-Object -ComObject WScript.Shell).CreateShortcut(' + JSON.stringify(full).replace(/\\/g, '\\\\') + ').TargetPath"';
      let target = '';
      try { target = execSync(ps, { encoding: 'utf8', windowsHide: true, timeout: 8000 }).trim(); } catch (_) { continue; }
      if (/ClaudeDesktopCN.*\.exe$/i.test(target) && fs.existsSync(target)) {
        bestDir = path.dirname(target);
        bestM = m;
      }
    }
  } catch (_) {}
  if (bestDir) { cachedLegacyDir = bestDir; return bestDir; }
  const candidates = [getDownloadsDir(), path.join(process.env.USERPROFILE || '.', 'Desktop'), path.join(process.env.USERPROFILE || '.', 'OneDrive', 'Desktop'), path.join(process.env.USERPROFILE || '.', 'OneDrive', '桌面')];
  let bestFile = null;
  let bestFileM = 0;
  for (const dir of candidates) {
    try {
      for (const f of fs.readdirSync(dir)) {
        if (!/^ClaudeDesktopCN.*\.exe$/i.test(f)) continue;
        const full = path.join(dir, f);
        const m = fs.statSync(full).mtimeMs;
        if (m > bestFileM) { bestFileM = m; bestFile = full; }
      }
    } catch (_) {}
  }
  if (bestFile) { cachedLegacyDir = path.dirname(bestFile); return cachedLegacyDir; }
  return getDownloadsDir();
}

function readConfig() {
  try { return JSON.parse(fs.readFileSync(path.join(process.env.APPDATA || '.', 'claude-cn', 'config.json'), 'utf8')); } catch (_) { return {}; }
}
function writeConfig(c) {
  const dir = path.join(process.env.APPDATA || '.', 'claude-cn');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(c, null, 2), 'utf8');
}

// 系统"下载"文件夹（跟随用户实际设置，非硬编码）
let cachedDownloadsDir = null;
function getDownloadsDir() {
  if (cachedDownloadsDir) return cachedDownloadsDir;
  try {
    const { execSync } = require('child_process');
    const ps = 'powershell -NoProfile -Command "(New-Object -ComObject Shell.Application).NameSpace(\'shell:Downloads\').Self.Path"';
    const out = execSync(ps, { encoding: 'utf8', windowsHide: true, timeout: 10000 }).trim();
    if (out && fs.existsSync(out)) { cachedDownloadsDir = out; return out; }
  } catch (_) {}
  cachedDownloadsDir = path.join(process.env.USERPROFILE || '.', 'Downloads');
  return cachedDownloadsDir;
}

// MSIX 操作需管理员：自提权重启本 exe（headless 模式执行），完成后回读日志
function handleMsixElevated(mode, res) {
  const isWatcherToggle = mode === '--watcher-enable' || mode === '--watcher-disable';
  const ops = getMsixOps();
  const disc = DISCOVER.discoverClaudeInstall();
  if (!ops) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'MSIX 模块未加载' }));
    return;
  }
  if (!isWatcherToggle && mode === '--install-msix' && !disc.msix) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: '未发现 MSIX 版 Claude Desktop' }));
    return;
  }
  if (!isWatcherToggle && mode === '--uninstall-msix') {
    const st = ops.readMsixInjectedState(disc.msix ? disc.msix.packageVersion : null);
    // stale（升级换包）时也放行：msix-ops 会走优雅路径清除旧记录
    if (!st.injected && !st.rollbackOnly && !st.backupDir && !st.stale) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: '尚未注入，无需卸载' }));
      return;
    }
  }
  const logFile = path.join(ops.STATE_DIR, isWatcherToggle ? 'watcher-toggle.log' : 'msix-gui-last.log');
  try { fs.unlinkSync(logFile); } catch (_) {}
  const { spawn } = require('child_process');
  const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
  const psCmd = 'Start-Process -FilePath ' + q(process.execPath) +
    ' -ArgumentList ' + q(mode) + ',' + q('--headless') +
    ' -Verb RunAs -Wait -PassThru | ForEach-Object { $_.ExitCode }';
  const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psCmd], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', () => {});
  const timeout = setTimeout(() => { try { p.kill(); } catch (_) {} }, 10 * 60 * 1000);
  p.on('close', (code) => {
    clearTimeout(timeout);
    let exit = parseInt(String(out).trim().split(/\r?\n/).filter(Boolean).pop() || '', 10);
    if (isNaN(exit)) exit = code;
    let logText = '';
    try { logText = fs.readFileSync(logFile, 'utf8'); } catch (_) {}
    if (!logText) logText = exit === -1 || code === 1 ? '（UAC 已取消或未批准）' : '';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: exit === 0, exit: exit, log: logText }));
  });
}

function handleRequest(req, res) {
  // 剥离查询串后再匹配（openAppWindow 会带 ?v=版本号 绕缓存）
  const pathname = (req.url || '/').split('?')[0];
  if (pathname === '/favicon.ico' && req.method === 'GET') {
    const ico = getFaviconBuffer();
    if (ico) {
      res.writeHead(200, { 'Content-Type': 'image/x-icon', 'Content-Length': ico.length, 'Cache-Control': 'public, max-age=86400' });
      res.end(ico);
    } else {
      res.writeHead(404);
      res.end();
    }
    return;
  }
  if (pathname === '/' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(HTML_UI);
  } else if (pathname === '/api/status' && req.method === 'GET') {
    const disc = DISCOVER.discoverClaudeInstall();
    const status = checkInstallStatus(disc.squirrel);
    const ops = getMsixOps();
    const currentPkgVer = disc.msix ? disc.msix.packageVersion : null;
    const msixState = ops
      ? ops.readMsixInjectedState(currentPkgVer)
      : { injected: false, stale: false };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      found: !!disc.squirrel,
      msixFound: !!disc.msix,
      msixInjected: !!msixState.injected && !!disc.msix,
      msixStale: !!msixState.stale,
      msixRecordedVersion: msixState.recordedVersion || null,
      msixDescription: disc.msix ? DISCOVER.describeInfo(disc.msix) : null,
      msixPackageVersion: disc.msix ? disc.msix.packageVersion : (msixState.packageVersion || null),
      msixInnerVersion: (disc.msix && disc.msix.version) || msixState.innerVersion || null,
      installed: status.installed,
      installedVersion: status.version,
      currentVersion: VERSION,
      needsUpdate: status.installed && status.version && compareVersion(VERSION, status.version) > 0,
      version: disc.squirrel ? disc.squirrel.version : (disc.msix ? (disc.msix.packageVersion || disc.msix.version || '') : null)
    }));
  } else if (pathname === '/api/install-msix' && req.method === 'POST') {
    handleMsixElevated('--install-msix', res);
  } else if (pathname === '/api/uninstall-msix' && req.method === 'POST') {
    handleMsixElevated('--uninstall-msix', res);
  } else if (pathname === '/api/install' && req.method === 'POST') {
    const disc = DISCOVER.discoverClaudeInstall();
    if (!disc.squirrel) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: false,
        error: disc.msix ? DISCOVER.MSIX_NOTE : '未找到 Claude Desktop（Squirrel 直装版）'
      }));
      return;
    }
    const result = install(disc.squirrel);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  } else if (pathname === '/api/uninstall' && req.method === 'POST') {
    const disc = DISCOVER.discoverClaudeInstall();
    if (!disc.squirrel) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: false,
        error: disc.msix ? DISCOVER.MSIX_NOTE : '未找到 Claude Desktop（Squirrel 直装版）'
      }));
      return;
    }
    const result = uninstall(disc.squirrel);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  } else if (pathname === '/api/check-update' && req.method === 'GET') {
    const https = require('https');
    const disc = DISCOVER.discoverClaudeInstall();
    // 服务端加超时：网络慢时不再无限挂起（页面 fetch 也不至于干等到浏览器超时）
    const status = checkInstallStatus(disc.squirrel);
    const installedVer = status.version || VERSION;
    const url = 'https://inknexus.hnwen17.top/claude-desktop-cn/version.json';
    const verReq = https.get(url, { timeout: 20000 }, (resp) => {
      let data = '';
      resp.on('data', chunk => data += chunk);
      resp.on('end', () => {
        try {
          const remote = JSON.parse(data);
          const hasUpdate = compareVersion(remote.version, installedVer) > 0;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            hasUpdate,
            installedVersion: installedVer,
            remoteVersion: remote.version,
            downloadUrl: remote.download_url || '',
            changelog: remote.changelog || ''
          }));
        } catch (e) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '解析版本信息失败' }));
        }
      });
    });
    verReq.on('timeout', () => { verReq.destroy(new Error('连接超时（20 秒）')); });
    verReq.on('error', (e) => {
      if (!res.headersSent) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '网络连接失败: ' + e.message }));
      }
    });
    return;
  } else if (pathname === '/api/download-update' && req.method === 'POST') {
    const crypto = require('crypto');
    // 服务端代理下载：流式拉取线上 exe 到 %APPDATA%\claude-cn\update\，
    // 进度存全局状态供 /api/download-progress 轮询（替代不可靠的 window.open 直链下载）
    const https = require('https');
    const updateDir = findLegacyPackageDir();
    const dlState = (globalThis.__cnDl = globalThis.__cnDl || { active: false });
    if (dlState.active) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ started: true, note: '已有下载在进行中' }));
      return;
    }
    const verReq2 = https.get('https://inknexus.hnwen17.top/claude-desktop-cn/version.json', { timeout: 20000 }, (vr) => {
      let vd = '';
      vr.on('data', (c) => (vd += c));
      vr.on('end', () => {
        let remote = {};
        try { remote = JSON.parse(vd); } catch (_) {}
        const rVer = remote.version || VERSION;
        const target = path.join(updateDir, 'ClaudeDesktopCN-v' + rVer + '.exe');
        // 压缩分发优先（服务器带宽 ~3Mbps，gz 压缩率 42% → 提速 2.7 倍）
        const gzUrl = remote.download_url_gz || ((remote.download_url || '') + '.gz');
        const expectSha = remote.sha256 || null;
        const wantGz = !!gzUrl;
        try {
          if (fs.existsSync(target) && fs.statSync(target).size > 30 * 1024 * 1024) {
            dlState.done = true; dlState.total = fs.statSync(target).size; dlState.received = dlState.total;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ started: true, ready: true, path: target, bytes: dlState.total }));
            return;
          }
          fs.mkdirSync(updateDir, { recursive: true });
          dlState.active = true; dlState.done = false; dlState.received = 0; dlState.total = 0; dlState.error = null; dlState.path = target; dlState.isGz = wantGz; dlState.speed = 0; dlState.eta = null;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ started: true, target: target }));
          // 断点续传循环：中断后带 Range 头续传（最多 20 轮）
          let dlUrl = gzUrl;
          let useGz = wantGz;
          const gzFallbackUrl = remote.download_url || 'https://inknexus.hnwen17.top/claude-desktop-cn/ClaudeDesktopCN.exe';
          // 预检式：HEAD 探测压缩包是否存在，选定下载地址后才开始（无分支歧义）
          const startChecks = () => {
            https.request(gzUrl, { method: 'HEAD', timeout: 15000 }, (hr) => {
              hr.resume();
              useGz = hr.statusCode === 200;
              dlUrl = useGz ? gzUrl : gzFallbackUrl;
              dlState.isGz = useGz;
              attemptDownload();
            }).on('error', () => { useGz = false; dlUrl = gzFallbackUrl; dlState.isGz = false; attemptDownload(); }).end();
          };
          let round = 0;
          let lastTick = { t: Date.now(), r: 0 };
          const attemptDownload = () => {
            if (dlState.done || round >= 20) {
              if (!dlState.done) { dlState.active = false; dlState.error = '多次续传后仍失败，请稍后重试'; }
              return;
            }
            round++;
            const partFile = target + '.part';
            const startByte = fs.existsSync(partFile) ? fs.statSync(partFile).size : 0;
            dlState.received = startByte;
            const headers = startByte > 0 ? { Range: 'bytes=' + startByte + '-' } : {};
            let out;
            try { out = fs.createWriteStream(partFile, { flags: startByte > 0 ? 'a' : 'w' }); } catch (e2) { setTimeout(attemptDownload, 2500); return; }
            out.on('error', () => { try { out.destroy(); } catch (_) {} setTimeout(attemptDownload, 2500); });
            const exeReq = https.get(dlUrl, { timeout: 30000, headers: headers }, (er) => {
              if (startByte > 0 && er.statusCode !== 206) {
                er.destroy();
                try { out.destroy(); } catch (_) {}
                setTimeout(attemptDownload, 1500);
                return;
              }
              if (er.statusCode >= 400) {
                er.destroy();
                try { out.destroy(); } catch (_) {}
                dlState.active = false; dlState.error = '下载失败: HTTP ' + er.statusCode;
                return;
              }
              if (startByte === 0) dlState.total = parseInt(er.headers['content-length'] || '0', 10);
              else dlState.total = parseInt((er.headers['content-range'] || '').split('/')[1] || '0', 10) || (startByte + parseInt(er.headers['content-length'] || '0', 10));
              er.pipe(out);
              er.on('data', (c) => {
                dlState.received += c.length;
                const now = Date.now();
                if (now - lastTick.t >= 500) {
                  dlState.speed = Math.max(0, Math.round((dlState.received - lastTick.r) * 1000 / (now - lastTick.t)));
                  lastTick = { t: now, r: dlState.received };
                  dlState.eta = dlState.speed > 0 && dlState.total > 0 ? Math.max(0, Math.round((dlState.total - dlState.received) / dlState.speed)) : null;
                }
              });
              er.on('end', () => {
                out.end(() => {
                  const finishOk = (finalPath) => { dlState.active = false; dlState.done = true; dlState.path = finalPath; };
                  try {
                    if (dlState.isGz) {
                      const zlib = require('zlib');
                      const raw = zlib.gunzipSync(fs.readFileSync(partFile));
                      if (expectSha) {
                        const gotSha = crypto.createHash('sha256').update(raw).digest('hex');
                        if (gotSha !== expectSha) throw new Error('解压后 SHA 校验不符（' + gotSha.slice(0, 12) + '）');
                      }
                      fs.writeFileSync(target, raw);
                      try { fs.unlinkSync(partFile); } catch (_) {}
                      finishOk(target);
                    } else {
                      if (expectSha) {
                        const gotSha = crypto.createHash('sha256').update(fs.readFileSync(partFile)).digest('hex');
                        if (gotSha !== expectSha) throw new Error('SHA 校验不符（' + gotSha.slice(0, 12) + '）');
                      }
                      fs.renameSync(partFile, target);
                      finishOk(target);
                    }
                  } catch (e4) {
                    dlState.active = false; dlState.error = e4.message;
                    try { fs.unlinkSync(partFile); } catch (_) {}
                  }
                });
              });
              er.on('error', () => { try { out.destroy(); } catch (_) {} setTimeout(attemptDownload, 1500); });
            });
            exeReq.on('timeout', () => { exeReq.destroy(new Error('idle timeout')); });
            exeReq.on('error', () => { try { out.destroy(); } catch (_) {} setTimeout(attemptDownload, 1500); });
          };
          startChecks();
        } catch (e3) {
          dlState.active = false; dlState.error = e3.message;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ started: false, error: e3.message }));
        }
      });
    });
    verReq2.on('timeout', () => { verReq2.destroy(new Error('连接超时（20 秒）')); });
    verReq2.on('error', (e) => {
      dlState.active = false; dlState.error = e.message;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ started: false, error: e.message }));
    });
  } else if (pathname === '/api/download-progress' && req.method === 'GET') {
    const dl = (globalThis.__cnDl = globalThis.__cnDl || { active: false });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(dl));
  } else if (pathname === '/api/dldir' && req.method === 'GET') {
  const dir = findLegacyPackageDir();
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ dir: dir, auto: true }));
  return;
} else if (pathname === '/api/watcher-status' && req.method === 'GET') {
  // 守护状态 = 真实探测计划任务（flag 文件优先，schtasks 兜底）
  let flagExists = false;
  let schtasksErr = null;
  try { flagExists = fs.existsSync(path.join(process.env.APPDATA || '.', 'claude-cn', 'watcher-registered.flag')); } catch (_) {}
  const opsW = getMsixOps();
  let enabled = false;
  try { enabled = opsW.isWatcherRegistered(); } catch (e) { schtasksErr = (e.message || String(e)).slice(0, 120); }
  if (flagExists) enabled = true; // flag 为注册成功的本机标记，探测异常时兜底
  let logTail = '';
  try {
    logTail = fs.readFileSync(path.join(process.env.APPDATA || '.', 'claude-cn', 'watcher.log'), 'utf8').split('\n').filter(Boolean).slice(-3).join(' | ');
  } catch (_) {}
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ enabled: enabled, logTail: logTail, diag: { flagExists: flagExists, schtasksErr: schtasksErr } }));
  return;
  } else if (pathname === '/api/download-reveal' && req.method === 'POST') {
    // 资源管理器定位已下载的安装包（用户可见效果明确）
    const dl = (globalThis.__cnDl = globalThis.__cnDl || {});
    if (dl.path && fs.existsSync(dl.path)) {
      const { exec } = require('child_process');
      exec('explorer /select,"' + dl.path + '"');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: '文件不存在' }));
    }
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
}

// ============== 查找浏览器（app 模式）==============
function findBrowser() {
  const candidates = [
    path.join(process.env['ProgramFiles(x86)'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env.ProgramFiles || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env['ProgramFiles(x86)'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env.ProgramFiles || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ];
  for (const p of candidates) {
    if (p && fs.existsSync(p)) return p;
  }
  return null;
}

function openAppWindow(url) {
  const { spawn } = require('child_process');
  const browser = findBrowser();
  if (browser) {
    // 用户数据目录按 PID 唯一：强制启动独立浏览器实例（复用已有实例会秒退交权，
    // 触发 proc close -> 服务器被误杀，页面停留在缓存渲染）
    const proc = spawn(browser, [
      '--app=' + url,
      '--window-size=720,720',
      '--disable-extensions',
      '--user-data-dir=' + path.join(os.tmpdir(), 'claude-cn-launcher-' + process.pid)
    ], { stdio: 'ignore', detached: true });
    proc.on('close', () => {
      server.close();
      process.exit(0);
    });
    proc.unref();
  } else {
    require('child_process').exec('start ' + url);
  }
}

// ============== Headless CLI（自提权重入时由父进程以管理员运行本 exe） ==============
globalThis.__cnWatcherExecLine = '"' + process.execPath + '" --watcher-check';
const CLI_MODE = process.argv.find((a) => a === '--install-msix' || a === '--uninstall-msix' || a === '--headless' || a === '--watcher-check' || a === '--watcher-enable' || a === '--watcher-disable');

// ============== 自动守护检查（单次：升级换包检测 → 重注入，秒级即退；由计划任务每小时/登录时触发） ==============
if (CLI_MODE === '--watcher-check') {
  const ops = getMsixOps();
  const stateDir = (ops && ops.STATE_DIR) || path.join(process.env.APPDATA || '.', 'claude-cn');
  const logFile = path.join(stateDir, 'watcher.log');
  const logW = (msg) => {
    try {
      fs.appendFileSync(logFile, new Date().toISOString() + ' ' + msg + '\n');
      const s = fs.readFileSync(logFile, 'utf8');
      if (s.length > 20000) fs.writeFileSync(logFile, s.slice(-12000));
    } catch (_) {}
  };
  try {
    const disc = DISCOVER.discoverClaudeInstall();
    const st = ops.readMsixInjectedState(disc.msix ? disc.msix.packageVersion : null);
    if (st.stale && disc.msix) {
      logW('检测到 Claude 升级（' + (st.recordedVersion || '?') + ' → ' + disc.msix.packageVersion + '）');
      if (DISCOVER.isRunningUnderInstall(disc.msix.installRoot)) {
        logW('Claude 正在运行，本轮跳过（下次触发时重试）');
        process.exit(0);
      }
      try {
        ops.installMsix(disc.msix, { i18n: PAYLOAD['i18n.js'], guard: PAYLOAD['guard.js'], panel: PAYLOAD['panel.js'] }, (m) => logW('[install] ' + m));
        logW('自动重注入完成，汉化已恢复');
      } catch (e) {
        logW('自动重注入失败: ' + (e.message || e));
      }
    }
  } catch (e) {
    logW('watcher check err: ' + (e.message || e));
  }
  process.exit(0); // 单次检查即退，无常驻
}

// ============ --watcher-enable / --watcher-disable（管理员重入：计划任务自启 + 立即生效） ============
if (CLI_MODE === '--watcher-enable' || CLI_MODE === '--watcher-disable') {
  const { execSync } = require('child_process');
  const stateDir = path.join(process.env.APPDATA || '.', 'claude-cn');
  const logFile = path.join(stateDir, 'watcher-toggle.log');
  const logT = (m) => { try { fs.appendFileSync(logFile, new Date().toISOString() + ' ' + m + '\n'); } catch (_) {} console.log(m); };
  try {
    if (CLI_MODE === '--watcher-enable') {
      const tr = '""' + process.execPath + '\" --watcher"';
      execSync('schtasks /create /f /tn "ClaudeDesktopCN-Watcher" /sc onlogon /rl HIGHEST /tr ' + tr, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      execSync('schtasks /run /tn "ClaudeDesktopCN-Watcher"', { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      logT('自动守护已开启（计划任务 ClaudeDesktopCN-Watcher 已创建并启动）');
    } else {
      try { execSync('schtasks /delete /f /tn "ClaudeDesktopCN-Watcher"', { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }); } catch (_) {}
      try {
        const pid = fs.readFileSync(path.join(stateDir, 'watcher.pid'), 'utf8').trim();
        if (pid) process.kill(parseInt(pid, 10));
      } catch (_) {}
      try { fs.unlinkSync(path.join(stateDir, 'watcher.pid')); } catch (_) {}
      logT('自动守护已关闭');
    }
    process.exit(0);
  } catch (e) {
    logT('操作失败: ' + (e.message || e));
    process.exit(99);
  }
}

if (CLI_MODE) {
  const ops = getMsixOps();
  const stateDir = (ops && ops.STATE_DIR) || path.join(process.env.APPDATA || process.env.USERPROFILE || '.', 'claude-cn');
  const logLines = [];
  const logF = (msg, kind) => {
    const line = '[' + (kind === 'ok' ? '+' : kind === 'err' ? 'x' : 'i') + '] ' + msg;
    console.log(line);
    logLines.push(line);
  };
  const flushLog = () => {
    try {
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(path.join(stateDir, 'msix-gui-last.log'), logLines.join('\n'), 'utf8');
    } catch (_) {}
  };
  try {
    if (!ops || typeof ops.installMsix !== 'function') { logF('MSIX 模块未加载', 'err'); flushLog(); process.exit(1); }
    const disc = DISCOVER.discoverClaudeInstall();
    if (CLI_MODE === '--install-msix') {
      if (!disc.msix) { logF('未发现 MSIX 版 Claude Desktop', 'err'); flushLog(); process.exit(1); }
      if (DISCOVER.isRunningUnderInstall(disc.msix.installRoot)) { logF('检测到 Claude 正在运行，请先完全退出', 'err'); flushLog(); process.exit(1); }
      ops.installMsix(disc.msix, { i18n: PAYLOAD['i18n.js'], guard: PAYLOAD['guard.js'], panel: PAYLOAD['panel.js'] }, logF);
    } else {
      ops.uninstallMsix(logF);
    }
    flushLog();
    process.exit(0);
  } catch (e) {
    logF(e.message || String(e), 'err');
    flushLog();
    process.exit(e.code === 'NOOP' ? 0 : 99);
  }
}


// ============== 崩溃诊断（写入状态目录，便于事后排查） ==============
process.on("uncaughtException", function (e) {
  try { fs.appendFileSync(path.join(process.env.APPDATA || ".", "claude-cn", "launcher-crash.log"), new Date().toISOString() + " " + ((e && e.stack) || String(e)) + "\n"); } catch (_) {}
});
process.on("unhandledRejection", function (e) {
  try { fs.appendFileSync(path.join(process.env.APPDATA || ".", "claude-cn", "launcher-crash.log"), new Date().toISOString() + " [rejection] " + ((e && e.stack) || String(e)) + "\n"); } catch (_) {}
});

// ============== 启动 ==============
// 端口占用竞态修复：EADDRINUSE（上一实例退出延迟/TIME_WAIT/杀软锁）时自动换端口重试。
// 关键：每次尝试用全新 http.Server 实例（复用同一实例二次 listen 会产生幽灵 listening
// 回调，见 questions 排查指南 2026-11-14 条目），成功后先本地自检再开窗。
let activePort = PORT;
let activeServer = null;
function tryListen(port, attempt) {
  const server = http.createServer(handleRequest);
  let settled = false;
  const onError = (e) => {
    if (settled) return;
    settled = true;
    if (e && e.code === 'EADDRINUSE' && attempt < 10) {
      tryListen(port + 1, attempt + 1);
    } else {
      try {
        fs.appendFileSync(path.join(process.env.APPDATA || ".", "claude-cn", "launcher-crash.log"), new Date().toISOString() + " listen failed on port " + port + ": " + ((e && e.code) || e) + "\n");
      } catch (_) {}
      process.exit(1);
    }
  };
  server.once('error', onError);
  server.listen(port, '127.0.0.1', () => {
    if (settled) return; // 幽灵 listening 防护
    settled = true;
    activePort = port;
    activeServer = server;
    // 本地自检：确认 HTTP 可达后才开窗（最多重试 20 次 × 250ms）
    let probes = 0;
    const probe = () => {
      if (activeServer !== server) return;
      const req = http.get('http://127.0.0.1:' + port + '/api/status', { timeout: 1500 }, (res) => {
        res.resume();
        openAppWindow('http://127.0.0.1:' + port + '/?v=' + VERSION);
      });
      req.on('error', () => {
        if (++probes < 20) setTimeout(probe, 250);
      });
    };
    probe();
  });
}
tryListen(PORT, 0);
