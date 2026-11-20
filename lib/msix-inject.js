'use strict';
/**
 * MSIX 版注入编排（Claude Desktop CN）
 *
 * 原理：MSIX 版无法解包/重打包 asar（会破坏 exe 内嵌头哈希校验与包结构），
 * 采用追加式改写：
 *   1. 生成自包含 wrapper blob = 主进程 prelude（hooks + 渲染进程 payload 内嵌）
 *      + 原 .vite/build/index.pre.js 全文（hooks 必须先于原代码注册）
 *   2. lib/asar-append.rewriteEntryAppend 把 blob 追加到 app.asar EOF，
 *      仅更新该条目 offset/size/integrity，头部 JSON 用空格 padding 复原字节长度
 *   3. lib/msix-integrity.patchHash 用新头哈希等长替换 exe 内嵌 JSON 的 value
 *   4. ion-dist.asar 不动
 *
 * 真机落地前置条件（缺一不做）：Claude 完全退出 + 管理员授权（WindowsApps 写入）+ 已备份。
 */

const fs = require('fs');
const path = require('path');
const asarAppend = require('./asar-append.js');
const msixIntegrity = require('./msix-integrity.js');

const MENU_DICT = JSON.parse(fs.readFileSync(path.join(__dirname, 'menu-dict.json'), 'utf8'));

const MSIX_ENTRY = 'resources\\app.asar';
// 入口候选回退（首选 package.json main 自描述，见 discoverEntryParts）
const ENTRY_PARTS = ['.vite', 'build', 'index.pre.js'];

/**
 * 动态发现主进程入口（版本/布局无关）：
 *   1. 读 asar 自带的 package.json main 字段（包自描述，Anthropic 改布局也自适应）
 *   2. 回退候选路径
 *   3. 全失败则报错（明确信息，不静默）
 * 返回路径段数组（如 ['.vite','build','index.pre.js']）
 */
function discoverEntryParts(asarPath) {
  let header = null;
  try {
    header = JSON.parse(asarAppend.readLayout(asarPath).json);
  } catch (e) {
    throw new Error('asar 头部读取失败: ' + e.message);
  }
  const exists = (parts) => {
    try {
      const node = asarAppend.walkEntry(header, parts);
      return node && !node.files && node.size > 0 ? node : null;
    } catch (_) {
      return null;
    }
  };
  try {
    const pkg = JSON.parse(asarAppend.extractFile(asarPath, ['package.json']).toString('utf8'));
    if (typeof pkg.main === 'string' && pkg.main.trim()) {
      const parts = pkg.main.trim().replace(/^\.\//, '').split('/').filter(Boolean);
      if (exists(parts)) return parts;
    }
  } catch (_) { /* package.json 缺失/损坏时走回退 */ }
  if (exists(ENTRY_PARTS)) return ENTRY_PARTS;
  // 最后回退：扫描头 JSON 里任意 index.pre.js（防止仅目录名变化）
  try {
    const found = findEntryByRegex(header, /index\.pre\.js$/i, []);
    if (found) return found;
  } catch (_) {}
  throw new Error('未能定位主进程入口：package.json main 与候选路径均不存在。请把 package.json main 字段反馈给开发者。');
}

function findEntryByRegex(node, re, prefix) {
  if (!node || !node.files) return null;
  for (const name of Object.keys(node.files)) {
    const child = node.files[name];
    const parts = prefix.concat([name]);
    if (child.files) {
      const r = findEntryByRegex(child, re, parts);
      if (r) return r;
    } else if (re.test(name) && child.size > 0) {
      return parts;
    }
  }
  return null;
}

/** 生成主进程 prelude 源码（全组件 zlib+base64 内嵌：渲染 payload 三件 + 原入口，blob 远小于 4MB 单块） */
function buildPrelude(parts /* {i18n, original} 源码字符串 */) {
  const zlib = require('zlib');
  const pack = (s) => zlib.deflateSync(Buffer.from(s, 'utf8'), { level: 9 }).toString('base64');
  const i18nB64 = pack(parts.i18n);
  const origB64 = pack(parts.original);
  const dictJson = JSON.stringify(JSON.stringify(MENU_DICT)); // 二次序列化成 JS 字面量
  return [
    '/* Claude CN MSIX prelude (generated, do not edit) */',
    '(function () {',
    '  try {',
    '    var __cn_e = require("electron");',
    '    var __cn_zlib = require("zlib");',
    '    var __cn_app = __cn_e.app, __cn_Menu = __cn_e.Menu, __cn_ipcMain = __cn_e.ipcMain;',
    '    var __cn_un = function (b64) { return __cn_zlib.inflateSync(Buffer.from(b64, "base64")).toString("utf8"); };',
    '    var __cn_i18n = __cn_un(' + JSON.stringify(i18nB64) + ');',
    '    var __cn_full = __cn_i18n;',
    '    function __cn_isChat(u) { return u && /claude\\.ai/i.test(u); }',
    '    function __cn_isApp(u) {',
    '      if (!u) return true;',
    '      if (/^(file:|app:|chrome-extension:|about:blank)/i.test(u)) return true;',
    '      if (/claude\\.ai/i.test(u)) return true;',
    '      if (/^https?:\\/\\/localhost/i.test(u)) return true;',
    '      return false;',
    '    }',
    '    function __cn_inject(contents) {',
    '      try {',
    '        var url = contents.getURL();',
    '        if (!__cn_isApp(url)) return;',
    '        var code = __cn_isChat(url) ? __cn_full : __cn_i18n;',
    '        if (code) contents.executeJavaScript(code).catch(function () {});',
    '      } catch (e) {}',
    '    }',
    '    __cn_app.on("web-contents-created", function (ev, contents) {',
    '      contents.on("dom-ready", function () { __cn_inject(contents); });',
    '      contents.on("did-navigate-in-page", function () {',
    '        setTimeout(function () { __cn_inject(contents); }, 300);',
    '      });',
    '      contents.on("page-title-updated", function (ev, title) {',
    '        if (title === "Claude") {',
    '          ev.preventDefault();',
    '          var w = contents.getOwnerBrowserWindow();',
    '          if (w) w.setTitle("Claude 中文版");',
    '        }',
    '      });',
    '    });',
    '    var __cn_menuEnabled = true;',
    '    var __cn_DICT = JSON.parse(' + dictJson + ');',
    '    function __cn_mt(label) {',
    '      if (!__cn_menuEnabled || !label) return label;',
    '      if (__cn_DICT[label]) return __cn_DICT[label];',
    '      var noEll = label.replace(/…/g, "...");',
    '      if (noEll !== label && __cn_DICT[noEll]) return __cn_DICT[noEll];',
    '      var noAmp = label.replace(/&/g, "");',
    '      if (noAmp !== label && __cn_DICT[noAmp]) return __cn_DICT[noAmp];',
    '      var both = noAmp.replace(/…/g, "...");',
    '      if (both !== noAmp && __cn_DICT[both]) return __cn_DICT[both];',
    '      return label;',
    '    }',
    '    // 菜单项映射：浅克隆保留全部属性（icon/submenu/click/未知字段），仅翻译 label。',
    '    // 兼容两种形态：MenuItem 实例（submenu 是 Menu）与普通模板对象（submenu 是数组）。',
    '    function __cn_mapItem(item) {',
    '      var t = {};',
    '      try {',
    '        for (var k in item) { t[k] = item[k]; }',
    '      } catch (_) { return item; }',
    '      try {',
    '        if (typeof t.label === "string" && t.label) { t.label = __cn_mt(t.label); }',
    '      } catch (_) {}',
    '      try {',
    '        if (Object.prototype.toString.call(t.submenu) === "[object Array]") {',
    '          t.submenu = t.submenu.map(__cn_mapItem);',
    '        }',
    '      } catch (_) {}',
    '      return t;',
    '    }',
    '    var __cn_origSetMenu = __cn_Menu.setApplicationMenu;',
    '    __cn_Menu.setApplicationMenu = function (menu) {',
    '      if (menu && menu.items) {',
    '        try {',
    '          var translated = __cn_origBuild.call(__cn_Menu, menu.items.map(__cn_mapItem));',
    '          return __cn_origSetMenu.call(__cn_Menu, translated);',
    '        } catch (_) {}',
    '      }',
    '      return __cn_origSetMenu.call(__cn_Menu, menu);',
    '    };',
    '    var __cn_origBuild = __cn_Menu.buildFromTemplate;',
    '    __cn_Menu.buildFromTemplate = function (template) {',
    '      try {',
    '        if (Array.isArray(template)) {',
    '          return __cn_origBuild.call(__cn_Menu, template.map(__cn_mapItem));',
    '        }',
    '      } catch (_) {}',
    '      return __cn_origBuild.call(__cn_Menu, template);',
    '    };',
    '    __cn_ipcMain.on("claude-cn:menu-i18n", function (ev, enabled) {',
    '      __cn_menuEnabled = enabled;',
    '      var cur = __cn_Menu.getApplicationMenu();',
    '      if (cur) __cn_Menu.setApplicationMenu(cur);',
    '    });',
    '    console.info("[claude-cn] msix prelude ready");',
    '    // 原入口在当前模块上下文执行（与 require 同机制，require/__dirname 全部可用）',
    '    var __cn_orig = __cn_un(' + JSON.stringify(origB64) + ');',
    '    module._compile(__cn_orig, __filename);',
    '  } catch (e) {',
    '    console.error("[claude-cn] prelude error:", e && e.message);',
    '  }',
    '})();',
    ''
  ].join('\n');
}

/**
 * 生成追加 blob：prelude（内含渲染 payload 与原入口的压缩体）。
 * 原入口由 prelude 在模块上下文 module._compile 执行，hooks 先于原代码注册。
 * @param payload 目录路径（磁盘模式）或 {i18n} 文本对象（GUI 内嵌模式）
 */
function buildBlob(msixInfo, payload) {
  const entryParts = discoverEntryParts(msixInfo.asarPath);
  const originalEntry = asarAppend.extractFile(msixInfo.asarPath, entryParts).toString('utf8');
  // 防套娃守卫：入口已含我们的 prelude 标记 = 已注入过，拒绝（否则 blob 逐轮嵌套膨胀）
  if (originalEntry.indexOf('Claude CN MSIX prelude') >= 0) {
    throw new Error('目标已注入过（入口含 prelude 标记）。请先运行 uninstall-msix 还原原包，再重新 install-msix。');
  }
  let i18n;
  if (typeof payload === 'string') {
    const read = (f) => fs.readFileSync(path.join(payload, f), 'utf8');
    i18n = read('i18n.js');
  } else {
    i18n = payload.i18n;
  }
  const prelude = buildPrelude({ i18n: i18n, original: originalEntry });
  return Buffer.from(prelude, 'utf8');
}

/**
 * 完整注入（写入真实文件前调用方必须已备份并确认无进程占用）。
 * @param msixInfo discover.js 的 msix 形态信息（asarPath/exePath/installRoot）
 * @param payloadDir payload/src 目录
 * @param destPaths {{asarPath, exePath}} 输出目标；传 null = 原地写（真机模式）
 * @returns {{headerHash, entryOffset, blobSize}}
 */
function inject(msixInfo, payloadDir, destPaths) {
  const blob = buildBlob(msixInfo, payloadDir);
  const asarDest = destPaths ? destPaths.asarPath : null;
  const exeDest = destPaths ? destPaths.exePath : null;
  const entryParts = discoverEntryParts(msixInfo.asarPath);

  const r = asarAppend.rewriteEntryAppend(msixInfo.asarPath, asarDest, entryParts, blob);
  msixIntegrity.patchHash(msixInfo.exePath, exeDest, MSIX_ENTRY, r.newHeaderHash);
  return { headerHash: r.newHeaderHash, entryOffset: r.newOffset, blobSize: blob.length };
}

/** 注入后的只读校验（对已写入的文件） */
function verifyInjected(asarPath, exePath) {
  const layout = asarAppend.readLayout(asarPath);
  const header = JSON.parse(layout.json);
  const node = asarAppend.walkEntry(header, discoverEntryParts(asarPath));
  const entryEnd = layout.dataOffset + parseInt(node.offset, 10) + node.size;
  const checks = {
    jsonLenUnchanged: Buffer.from(layout.json).length === layout.jsonLen,
    entryEndAtEof: entryEnd === layout.fileSize,
    blobMarkOk: node.size > 0
  };
  const integ = msixIntegrity.verify(exePath, { 'resources\\app.asar': asarPath });
  checks.exeHashMatch = integ[MSIX_ENTRY] && integ[MSIX_ENTRY].match;
  checks.ionUntouched = !!msixIntegrity.expectedHash(exePath, 'resources\\ion-dist.asar');
  return checks;
}

module.exports = { buildPrelude: buildPrelude, buildBlob: buildBlob, inject: inject, verifyInjected: verifyInjected, discoverEntryParts: discoverEntryParts, MSIX_ENTRY: MSIX_ENTRY, ENTRY_PARTS: ENTRY_PARTS };
