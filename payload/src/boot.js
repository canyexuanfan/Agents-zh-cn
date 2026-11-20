/* Claude Desktop CN - boot.js (v0.7 主进程 wrapper)
 * 此文件替代原 index.pre.js 作为 Electron 主进程入口。
 *   1. Hook web-contents-created，在 claude.ai 页面注入 renderer payload
 *   2. 原生菜单汉化（可动态开关）
 *   3. 加载原始主进程代码
 */
const { app, Menu, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');

const cnPackDir = path.join(__dirname, '..', '..', 'cn-pack');
let i18nCode = '';
let fullPayloadCode = '';
try {
  const i18nPath = path.join(cnPackDir, 'i18n.js');
  if (fs.existsSync(i18nPath)) {
    i18nCode = fs.readFileSync(i18nPath, 'utf8') + '\n;\n';
  }
  fullPayloadCode = i18nCode;
  for (const f of ['guard.js', 'panel.js']) {
    const filePath = path.join(cnPackDir, f);
    if (fs.existsSync(filePath)) {
      fullPayloadCode += fs.readFileSync(filePath, 'utf8') + '\n;\n';
    }
  }
} catch (e) {
  console.error('[claude-cn] Failed to read payload:', e.message);
}

function isChatPage(url) {
  if (!url) return false;
  return /claude\.ai/i.test(url);
}

function isAppPage(url) {
  if (!url) return true;
  if (/^(file:|app:|chrome-extension:|about:blank)/i.test(url)) return true;
  if (/claude\.ai/i.test(url)) return true;
  if (/^https?:\/\/localhost/i.test(url)) return true;
  return false;
}

function injectPayload(contents) {
  try {
    const url = contents.getURL();
    if (!isAppPage(url)) return;
    const code = isChatPage(url) ? fullPayloadCode : i18nCode;
    if (!code) return;
    contents.executeJavaScript(code).catch(() => {});
  } catch (e) {}
}

app.on('web-contents-created', (event, contents) => {
  contents.on('dom-ready', () => {
    injectPayload(contents);
  });
  contents.on('did-navigate-in-page', () => {
    setTimeout(() => injectPayload(contents), 300);
  });
  // 汉化窗口标题
  contents.on('page-title-updated', (event, title) => {
    if (title === 'Claude') {
      event.preventDefault();
      const win = contents.getOwnerBrowserWindow();
      if (win) win.setTitle('Claude 中文版');
    }
  });
});

// ============== 原生菜单汉化 ==============
// 菜单汉化状态（默认启用）
let menuI18nEnabled = true;

// 监听渲染进程的汉化状态变化
ipcMain.on('claude-cn:menu-i18n', (event, enabled) => {
  menuI18nEnabled = enabled;
  console.log('[claude-cn] Menu i18n:', enabled ? 'enabled' : 'disabled');
  // 立即重建菜单
  const currentMenu = Menu.getApplicationMenu();
  if (currentMenu) {
    Menu.setApplicationMenu(currentMenu);
  }
});

const MENU_DICT = {
  // 顶级菜单
  'File': '文件', 'Edit': '编辑', 'View': '视图',
  'Window': '窗口', 'Help': '帮助', 'Developer': '开发者',
  // File
  'New Conversation': '新建对话', 'Settings...': '设置……',
  'Close Window': '关闭窗口', 'Exit': '退出',
  'Quit Claude': '退出 Claude', 'Quit': '退出',
  // Edit
  'Undo': '撤销', 'Redo': '重做',
  'Cut': '剪切', 'Copy': '复制', 'Paste': '粘贴',
  'Paste and Match Style': '粘贴并匹配样式',
  'Select All': '全选', 'Find': '查找',
  // View
  'Reload': '重新加载', 'Back': '返回', 'Forward': '前进',
  'Actual Size': '实际大小', 'Zoom In': '放大', 'Zoom Out': '缩小',
  'Zoom In (indie cooler version)': '放大（备用）',
  'Zoom In (numpad)': '放大（小键盘）',
  'Zoom Out (numpad)': '缩小（小键盘）',
  'Actual Size (numpad)': '实际大小（小键盘）',
  'Copy URL': '复制链接',
  'Toggle Full Screen': '切换全屏', 'Full Screen': '全屏',
  // Developer
  'Open MCP Log File...': '打开 MCP 日志文件……',
  'Reload MCP Configuration': '重新加载 MCP 配置',
  'Configure Third-Party Inference…': '配置第三方推理……',
  'Extensions': '扩展',
  'Install Extension...': '安装扩展……',
  'Install Unpacked Extension...': '安装未打包扩展……',
  'Open Extensions Folder...': '打开扩展文件夹……',
  'Open Extension Settings Folder...': '打开扩展设置文件夹……',
  'Open App Config File...': '打开应用配置文件……',
  'Open Developer Config File...': '打开开发者配置文件……',
  'Show Dev Tools': '显示开发者工具',
  'Show All Dev Tools': '显示所有开发者工具',
  'Enable Main Process Debugger': '启用主进程调试器',
  'Record Performance Trace': '录制性能跟踪',
  'Write Main Process Heap Snapshot': '写入主进程堆快照',
  'Record Memory Trace (auto-stop)': '录制内存跟踪（自动停止）',
  // Help
  'Open Documentation': '打开文档',
  'Checking for Updates...': '正在检查更新……',
  'Check for Updates...': '检查更新……', 'Check for Updates': '检查更新',
  'Troubleshooting': '故障排除',
  'Show Logs in Explorer': '在资源管理器中显示日志',
  'Show Cowork Session Data in Explorer': '在资源管理器中显示协作会话数据',
  'Copy Installation ID': '复制安装 ID',
  'Record Net Log (30s)': '录制网络日志（30秒）',
  'Disable Hardware Acceleration': '禁用硬件加速',
  'Enable Cowork VM Debug Logging': '启用协作虚拟机调试日志',
  'Enable Cowork SDK Debugging': '启用协作 SDK 调试',
  'Delete Cowork VM Bundle and Restart…': '删除协作虚拟机包并重启……',
  'Delete Cowork VM Sessions and Restart…': '删除协作虚拟机会话并重启……',
  'Clear Cache and Restart': '清除缓存并重启',
  'Reset App Data…': '重置应用数据……',
  'Get Support': '获取支持',
  'About...': '关于……',
  // 可能动态出现的
  'Open Hardware Buddy...': '打开 Hardware Buddy……',
  'Open Hardware Buddy…': '打开 Hardware Buddy……',
};

function menuTranslate(label) {
  if (!menuI18nEnabled) return label; // 汉化关闭时直接返回原文
  if (!label) return label;
  if (MENU_DICT[label]) return MENU_DICT[label];
  const noEllipsis = label.replace(/…/g, '...');
  if (noEllipsis !== label && MENU_DICT[noEllipsis]) return MENU_DICT[noEllipsis];
  const noAmp = label.replace(/&/g, '');
  if (noAmp !== label && MENU_DICT[noAmp]) return MENU_DICT[noAmp];
  const both = noAmp.replace(/…/g, '...');
  if (both !== noAmp && MENU_DICT[both]) return MENU_DICT[both];
  return label;
}

function itemToTemplate(item) {
  if (item.type === 'separator') return { type: 'separator' };
  const tmpl = {};
  tmpl.label = menuTranslate(item.label || '');
  if (item.role) tmpl.role = item.role;
  if (item.accelerator) tmpl.accelerator = item.accelerator;
  if (item.type) tmpl.type = item.type;
  if (item.id) tmpl.id = item.id;
  if (item.click && !item.role) tmpl.click = item.click;
  if (item.sublabel) tmpl.sublabel = item.sublabel;
  if (item.toolTip) tmpl.toolTip = item.toolTip;
  if (typeof item.enabled === 'boolean' && !item.enabled) tmpl.enabled = false;
  if (typeof item.visible === 'boolean' && !item.visible) tmpl.visible = false;
  if (typeof item.checked === 'boolean') tmpl.checked = item.checked;
  if (item.submenu && item.submenu.items && item.submenu.items.length > 0) {
    tmpl.submenu = item.submenu.items.map(itemToTemplate);
  }
  return tmpl;
}

// 包装 setApplicationMenu，每次设置菜单时自动翻译
const origSetAppMenu = Menu.setApplicationMenu;
Menu.setApplicationMenu = function (menu) {
  if (menu && menu.items) {
    try {
      const template = menu.items.map(itemToTemplate);
      const translated = Menu.buildFromTemplate(template);
      return origSetAppMenu.call(Menu, translated);
    } catch (_) {}
  }
  return origSetAppMenu.call(Menu, menu);
};

// 加载原始主进程
require('./index.original.js');
