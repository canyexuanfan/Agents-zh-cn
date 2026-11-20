/* Claude Desktop CN - panel.js
 * 浮窗 UI + 配置面板（v0.3）
 * 功能：
 *   - 右下角浮窗：实时显示配额（今日/小时/分钟）+ 倒计时
 *   - 可拖拽、可折叠
 *   - 开关切换（汉化/守护）
 *   - 设置弹窗（可改阈值 + 暂停/恢复）
 */
(function () {
  'use strict';

  if (window.__CLAUDE_CN_PANEL__) return;

  var panel, collapsed = false, paused = false, pauseUntil = 0;
  var countdownTimer = 0;
  var dragState = null;

  // ============== 工具函数 ==============
  function esc(str) {
    if (!str) return '';
    return String(str).replace(/[&<>"']/g, function (m) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m];
    });
  }

  // ============== 创建浮窗 HTML ==============
  function createPanel() {
    var div = document.createElement('div');
    div.id = 'claude-cn-panel';
    div.innerHTML = [
      '<div class="cn-panel-header">',
      '  <span class="cn-panel-title">Claude Desktop CN</span>',
      '  <button class="cn-btn-collapse" title="折叠/展开">−</button>',
      '</div>',
      '<div class="cn-panel-body">',
      '  <div class="cn-stat-row">',
      '    <span>🌐 汉化</span>',
      '    <label class="cn-switch"><input type="checkbox" checked data-module="i18n" /><span class="cn-slider"></span></label>',
      '  </div>',
      '  <div class="cn-stat-row">',
      '    <span>🛡️ 速率守护</span>',
      '    <label class="cn-switch"><input type="checkbox" checked data-module="guard" /><span class="cn-slider"></span></label>',
      '  </div>',
      '  <div class="cn-quota-section">',
      '    <div class="cn-quota-item">',
      '      <div class="cn-quota-label">',
      '        <span>今日</span>',
      '        <span class="cn-quota-value" data-type="day">0 / 200</span>',
      '      </div>',
      '      <div class="cn-progress-bar"><div class="cn-progress-fill" data-type="day" style="width:0%"></div></div>',
      '    </div>',
      '    <div class="cn-quota-item">',
      '      <div class="cn-quota-label">',
      '        <span>本小时</span>',
      '        <span class="cn-quota-value" data-type="hour">0 / 30</span>',
      '      </div>',
      '      <div class="cn-progress-bar"><div class="cn-progress-fill" data-type="hour" style="width:0%"></div></div>',
      '    </div>',
      '    <div class="cn-quota-item">',
      '      <div class="cn-quota-label">',
      '        <span>本分钟</span>',
      '        <span class="cn-quota-value" data-type="minute">0 / 6</span>',
      '      </div>',
      '      <div class="cn-progress-bar"><div class="cn-progress-fill" data-type="minute" style="width:0%"></div></div>',
      '    </div>',
      '    <div class="cn-countdown">',
      '      <span>下次可发：<strong>0s</strong></span>',
      '    </div>',
      '  </div>',
      '  <div class="cn-panel-footer">',
      '    <button class="cn-btn-pause">暂停 5 分钟</button>',
      '    <button class="cn-btn-settings">⚙️ 设置</button>',
      '    <button class="cn-btn-update" title="检查更新">🔄</button>',
      '    <button class="cn-btn-contact" title="联系作者">🌐</button>',
      '  </div>',
      '</div>'
    ].join('');

    injectStyles();
    return div;
  }

  // ============== 注入样式 ==============
  function injectStyles() {
    if (document.getElementById('__cn_panel_styles')) return;
    var style = document.createElement('style');
    style.id = '__cn_panel_styles';
    style.textContent = [
      '#claude-cn-panel {',
      '  position: fixed;',
      '  bottom: 20px;',
      '  right: 20px;',
      '  z-index: 2147483646;',
      '  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;',
      '  font-size: 13px;',
      '  background: rgba(255, 255, 255, 0.98);',
      '  border: 1px solid rgba(0, 0, 0, 0.1);',
      '  border-radius: 12px;',
      '  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.12);',
      '  min-width: 300px;',
      '  backdrop-filter: blur(20px);',
      '  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);',
      '}',
      '#claude-cn-panel.collapsed .cn-panel-body { display: none; }',
      '.cn-panel-header {',
      '  padding: 12px 16px;',
      '  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);',
      '  color: white;',
      '  border-radius: 12px 12px 0 0;',
      '  display: flex;',
      '  justify-content: space-between;',
      '  align-items: center;',
      '  cursor: move;',
      '  user-select: none;',
      '}',
      '.cn-panel-title {',
      '  font-weight: 600;',
      '  font-size: 14px;',
      '}',
      '.cn-btn-collapse {',
      '  background: rgba(255, 255, 255, 0.2);',
      '  border: none;',
      '  color: white;',
      '  width: 24px;',
      '  height: 24px;',
      '  border-radius: 6px;',
      '  cursor: pointer;',
      '  font-size: 16px;',
      '  line-height: 1;',
      '  transition: background 0.2s;',
      '}',
      '.cn-btn-collapse:hover { background: rgba(255, 255, 255, 0.3); }',
      '.cn-panel-body {',
      '  padding: 16px;',
      '}',
      '.cn-stat-row {',
      '  display: flex;',
      '  justify-content: space-between;',
      '  align-items: center;',
      '  margin-bottom: 12px;',
      '  font-size: 13px;',
      '  color: #374151;',
      '}',
      '.cn-switch {',
      '  position: relative;',
      '  display: inline-block;',
      '  width: 44px;',
      '  height: 24px;',
      '}',
      '.cn-switch input { opacity: 0; width: 0; height: 0; }',
      '.cn-slider {',
      '  position: absolute;',
      '  cursor: pointer;',
      '  top: 0; left: 0; right: 0; bottom: 0;',
      '  background-color: #cbd5e1;',
      '  transition: 0.3s;',
      '  border-radius: 24px;',
      '}',
      '.cn-slider:before {',
      '  position: absolute;',
      '  content: "";',
      '  height: 18px;',
      '  width: 18px;',
      '  left: 3px;',
      '  bottom: 3px;',
      '  background-color: white;',
      '  transition: 0.3s;',
      '  border-radius: 50%;',
      '}',
      '.cn-switch input:checked + .cn-slider { background: linear-gradient(135deg, #667eea, #764ba2); }',
      '.cn-switch input:checked + .cn-slider:before { transform: translateX(20px); }',
      '.cn-quota-section {',
      '  margin-top: 16px;',
      '  padding-top: 16px;',
      '  border-top: 1px solid #e5e7eb;',
      '}',
      '.cn-quota-item {',
      '  margin-bottom: 12px;',
      '}',
      '.cn-quota-label {',
      '  display: flex;',
      '  justify-content: space-between;',
      '  margin-bottom: 6px;',
      '  font-size: 12px;',
      '  color: #6b7280;',
      '}',
      '.cn-quota-value {',
      '  font-weight: 600;',
      '  color: #374151;',
      '}',
      '.cn-progress-bar {',
      '  height: 6px;',
      '  background: #f3f4f6;',
      '  border-radius: 3px;',
      '  overflow: hidden;',
      '}',
      '.cn-progress-fill {',
      '  height: 100%;',
      '  background: linear-gradient(90deg, #667eea, #764ba2);',
      '  transition: width 0.5s cubic-bezier(0.4, 0, 0.2, 1);',
      '  border-radius: 3px;',
      '}',
      '.cn-countdown {',
      '  margin-top: 12px;',
      '  text-align: center;',
      '  font-size: 12px;',
      '  color: #6b7280;',
      '}',
      '.cn-countdown strong {',
      '  color: #667eea;',
      '  font-size: 14px;',
      '}',
      '.cn-panel-footer {',
      '  margin-top: 16px;',
      '  display: flex;',
      '  gap: 8px;',
      '}',
      '.cn-panel-footer button {',
      '  flex: 1;',
      '  padding: 8px 12px;',
      '  border: 1px solid #e5e7eb;',
      '  border-radius: 8px;',
      '  background: white;',
      '  cursor: pointer;',
      '  font-size: 12px;',
      '  color: #374151;',
      '  transition: all 0.2s;',
      '}',
      '.cn-panel-footer button:hover {',
      '  background: #f9fafb;',
      '  border-color: #667eea;',
      '  color: #667eea;',
      '}',
      '.cn-btn-update, .cn-btn-contact {',
      '  flex: none !important;',
      '  width: 34px;',
      '  padding: 8px !important;',
      '  text-align: center;',
      '  font-size: 14px !important;',
      '}'
    ].join('\n');
    document.head.appendChild(style);
  }

  // ============== 拖拽功能 ==============
  function makeDraggable(el) {
    var header = el.querySelector('.cn-panel-header');
    header.addEventListener('mousedown', function (e) {
      if (e.target.classList.contains('cn-btn-collapse')) return;
      dragState = {
        startX: e.clientX,
        startY: e.clientY,
        elX: el.offsetLeft,
        elY: el.offsetTop,
        maxW: window.innerWidth - el.offsetWidth,
        maxH: window.innerHeight - el.offsetHeight
      };
      document.addEventListener('mousemove', onDrag);
      document.addEventListener('mouseup', onDragEnd);
      e.preventDefault();
    });
  }

  function onDrag(e) {
    if (!dragState) return;
    var dx = e.clientX - dragState.startX;
    var dy = e.clientY - dragState.startY;

    var x = Math.max(0, Math.min(dragState.maxW, dragState.elX + dx));
    var y = Math.max(0, Math.min(dragState.maxH, dragState.elY + dy));

    panel.style.left = x + 'px';
    panel.style.top = y + 'px';
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
  }

  function onDragEnd() {
    dragState = null;
    document.removeEventListener('mousemove', onDrag);
    document.removeEventListener('mouseup', onDragEnd);
  }

  // ============== 更新配额显示 ==============
  var lastStats = {};
  function update(force) {
    if (!window.__CLAUDE_CN_GUARD__ || !window.__CLAUDE_CN_GUARD__.getStats) return;

    try {
      var stats = window.__CLAUDE_CN_GUARD__.getStats();

      // 仅在数据变化或强制更新时操作 DOM
      ['day', 'hour', 'minute'].forEach(function (type) {
        if (force || !lastStats[type] || lastStats[type].current !== stats[type].current || lastStats[type].limit !== stats[type].limit) {
          var el = panel.querySelector('.cn-quota-value[data-type="' + type + '"]');
          var fill = panel.querySelector('.cn-progress-fill[data-type="' + type + '"]');
          if (el) el.textContent = stats[type].current + ' / ' + stats[type].limit;
          if (fill) {
            var pct = Math.min(100, (stats[type].current / stats[type].limit) * 100);
            fill.style.width = pct + '%';
          }
        }
      });

      lastStats = JSON.parse(JSON.stringify(stats));
      updateCountdown(stats.nextWait);
    } catch (e) {
      console.warn('[claude-cn] panel update failed:', e);
    }
  }

  function updateCountdown(wait) {
    var countdownEl = panel.querySelector('.cn-countdown strong');
    if (countdownEl) {
      countdownEl.textContent = wait + 's';
    }
  }

  // ============== 事件绑定 ==============
  function bindEvents() {
    // 监听数据更新事件
    window.addEventListener('claude-cn:guard-update', function() {
      update();
    });

    // 折叠/展开
    var btnCollapse = panel.querySelector('.cn-btn-collapse');
    btnCollapse.addEventListener('click', function () {
      collapsed = !collapsed;
      if (collapsed) {
        panel.classList.add('collapsed');
        btnCollapse.textContent = '+';
      } else {
        panel.classList.remove('collapsed');
        btnCollapse.textContent = '−';
      }
    });

    // 开关切换
    function loadModuleState() {
      try {
        var raw = localStorage.getItem('claude-cn:modules:v1');
        return raw ? JSON.parse(raw) : { i18n: true, guard: true };
      } catch (e) { return { i18n: true, guard: true }; }
    }
    function saveModuleState(state) {
      try { localStorage.setItem('claude-cn:modules:v1', JSON.stringify(state)); } catch (e) {}
    }

    var moduleState = loadModuleState();
    var switches = panel.querySelectorAll('.cn-switch input');
    switches.forEach(function (sw) {
      var mod = sw.getAttribute('data-module');
      if (mod === 'i18n') sw.checked = moduleState.i18n !== false;
      if (mod === 'guard') sw.checked = moduleState.guard !== false;

      sw.addEventListener('change', function () {
        var module = sw.getAttribute('data-module');
        var enabled = sw.checked;
        var state = loadModuleState();
        state[module] = enabled;
        saveModuleState(state);

        if (module === 'i18n') {
          if (window.__CLAUDE_CN_I18N__) {
            enabled ? window.__CLAUDE_CN_I18N__.enable() : window.__CLAUDE_CN_I18N__.disable();
          }
          // 通知主进程更新菜单汉化状态
          try {
            if (typeof require !== 'undefined') {
              var ipcRenderer = require('electron').ipcRenderer;
              ipcRenderer.send('claude-cn:menu-i18n', enabled);
            }
          } catch (e) {
            console.warn('[claude-cn] Failed to notify main process:', e);
          }
          if (!enabled) {
            // 关闭汉化需要刷新页面才能恢复原文
            setTimeout(function () { location.reload(); }, 300);
          }
        } else if (module === 'guard') {
          if (window.__CLAUDE_CN_GUARD__) {
            enabled ? window.__CLAUDE_CN_GUARD__.enable() : window.__CLAUDE_CN_GUARD__.disable();
          }
        }
      });
    });

    // 暂停按钮
    var btnPause = panel.querySelector('.cn-btn-pause');
    btnPause.addEventListener('click', function () {
      if (paused) {
        paused = false;
        pauseUntil = 0;
        btnPause.textContent = '暂停 5 分钟';
        if (window.__CLAUDE_CN_GUARD__) {
          if (window.__CLAUDE_CN_GUARD__.resume) window.__CLAUDE_CN_GUARD__.resume();
          if (window.__CLAUDE_CN_GUARD__.toast) window.__CLAUDE_CN_GUARD__.toast('速率守护已恢复', 'ok', 'pause');
        }
      } else {
        paused = true;
        pauseUntil = Date.now() + 5 * 60 * 1000;
        btnPause.textContent = '恢复守护';
        if (window.__CLAUDE_CN_GUARD__) {
          if (window.__CLAUDE_CN_GUARD__.pause) window.__CLAUDE_CN_GUARD__.pause(5 * 60 * 1000);
          if (window.__CLAUDE_CN_GUARD__.toast) window.__CLAUDE_CN_GUARD__.toast('速率守护已暂停 5 分钟', 'warn', 'pause');
        }
      }
    });

    // 设置按钮
    var btnSettings = panel.querySelector('.cn-btn-settings');
    btnSettings.addEventListener('click', function () {
      openSettingsModal();
    });

    var btnUpdate = panel.querySelector('.cn-btn-update');
    btnUpdate.addEventListener('click', function () {
      fetch('https://inknexus.hnwen17.top/claude-desktop-cn/version.json')
        .then(function(r) { return r.json(); })
        .then(function(d) {
          var local = '1.1.0';
          if (d.version && d.version !== local) {
            if (confirm('发现新版本 v' + d.version + '\\n' + (d.changelog || '') + '\\n\\n是否前往下载？')) {
              window.open(d.download_url || 'https://inknexus.hnwen17.top/claude-desktop-cn/');
            }
          } else {
            alert('当前已是最新版本');
          }
        })
        .catch(function() { alert('检查更新失败，请检查网络'); });
    });

    var btnContact = panel.querySelector('.cn-btn-contact');
    btnContact.addEventListener('click', function () {
      window.open('https://www.hnwen17.top');
    });
  }

  // ============== 设置弹窗 ==============
  var settingsModal = null;

  function createSettingsModal() {
    var modal = document.createElement('div');
    modal.id = 'claude-cn-settings-modal';
    modal.style.cssText = 'display:none;position:fixed;top:0;left:0;right:0;bottom:0;z-index:2147483647;';

    var cfg = (window.__CLAUDE_CN_GUARD__ && window.__CLAUDE_CN_GUARD__.cfg) || {};

    modal.innerHTML = [
      '<div class="cn-modal-overlay"></div>',
      '<div class="cn-modal-content">',
      '  <div class="cn-modal-header">',
      '    <h3>速率守护设置</h3>',
      '    <button class="cn-modal-close">×</button>',
      '  </div>',
      '  <div class="cn-modal-body">',
      '    <div class="cn-setting-item">',
      '      <label>最小间隔（秒）</label>',
      '      <input type="number" name="minInterval" value="' + esc(Math.floor((cfg.minInterval || 3000) / 1000)) + '" min="1" max="60" />',
      '      <span class="cn-setting-hint">两条消息之间的最小间隔时间</span>',
      '    </div>',
      '    <div class="cn-setting-item">',
      '      <label>每分钟上限</label>',
      '      <input type="number" name="perMinute" value="' + esc(cfg.perMinute || 6) + '" min="1" max="60" />',
      '      <span class="cn-setting-hint">1 分钟内最多发送的消息数</span>',
      '    </div>',
      '    <div class="cn-setting-item">',
      '      <label>每小时上限</label>',
      '      <input type="number" name="perHour" value="' + esc(cfg.perHour || 30) + '" min="1" max="300" />',
      '      <span class="cn-setting-hint">1 小时内最多发送的消息数</span>',
      '    </div>',
      '    <div class="cn-setting-item">',
      '      <label>每日上限</label>',
      '      <input type="number" name="perDay" value="' + esc(cfg.perDay || 200) + '" min="1" max="2000" />',
      '      <span class="cn-setting-hint">1 天内最多发送的消息数</span>',
      '    </div>',
      '  </div>',
      '  <div class="cn-modal-footer">',
      '    <button class="cn-btn-cancel">取消</button>',
      '    <button class="cn-btn-save">保存</button>',
      '  </div>',
      '</div>'
    ].join('');

    injectModalStyles();
    return modal;
  }

  function injectModalStyles() {
    if (document.getElementById('__cn_modal_styles')) return;
    var style = document.createElement('style');
    style.id = '__cn_modal_styles';
    style.textContent = [
      '.cn-modal-overlay {',
      '  position: absolute;',
      '  top: 0; left: 0; right: 0; bottom: 0;',
      '  background: rgba(0, 0, 0, 0.5);',
      '  backdrop-filter: blur(4px);',
      '}',
      '.cn-modal-content {',
      '  position: absolute;',
      '  top: 50%; left: 50%;',
      '  transform: translate(-50%, -50%);',
      '  background: white;',
      '  border-radius: 12px;',
      '  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);',
      '  min-width: 400px;',
      '  max-width: 90vw;',
      '  max-height: 90vh;',
      '  overflow: hidden;',
      '  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;',
      '}',
      '.cn-modal-header {',
      '  padding: 20px 24px;',
      '  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);',
      '  color: white;',
      '  display: flex;',
      '  justify-content: space-between;',
      '  align-items: center;',
      '}',
      '.cn-modal-header h3 {',
      '  margin: 0;',
      '  font-size: 18px;',
      '  font-weight: 600;',
      '}',
      '.cn-modal-close {',
      '  background: rgba(255, 255, 255, 0.2);',
      '  border: none;',
      '  color: white;',
      '  width: 32px;',
      '  height: 32px;',
      '  border-radius: 8px;',
      '  cursor: pointer;',
      '  font-size: 24px;',
      '  line-height: 1;',
      '  transition: background 0.2s;',
      '}',
      '.cn-modal-close:hover { background: rgba(255, 255, 255, 0.3); }',
      '.cn-modal-body {',
      '  padding: 24px;',
      '  max-height: 60vh;',
      '  overflow-y: auto;',
      '}',
      '.cn-setting-item {',
      '  margin-bottom: 20px;',
      '}',
      '.cn-setting-item:last-child { margin-bottom: 0; }',
      '.cn-setting-item label {',
      '  display: block;',
      '  margin-bottom: 8px;',
      '  font-size: 14px;',
      '  font-weight: 600;',
      '  color: #374151;',
      '}',
      '.cn-setting-item input {',
      '  width: 100%;',
      '  padding: 10px 12px;',
      '  border: 1px solid #d1d5db;',
      '  border-radius: 8px;',
      '  font-size: 14px;',
      '  transition: border-color 0.2s;',
      '}',
      '.cn-setting-item input:focus {',
      '  outline: none;',
      '  border-color: #667eea;',
      '  box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.1);',
      '}',
      '.cn-setting-hint {',
      '  display: block;',
      '  margin-top: 6px;',
      '  font-size: 12px;',
      '  color: #6b7280;',
      '}',
      '.cn-modal-footer {',
      '  padding: 16px 24px;',
      '  background: #f9fafb;',
      '  display: flex;',
      '  justify-content: flex-end;',
      '  gap: 12px;',
      '}',
      '.cn-modal-footer button {',
      '  padding: 10px 20px;',
      '  border: 1px solid #d1d5db;',
      '  border-radius: 8px;',
      '  font-size: 14px;',
      '  cursor: pointer;',
      '  transition: all 0.2s;',
      '}',
      '.cn-btn-cancel {',
      '  background: white;',
      '  color: #374151;',
      '}',
      '.cn-btn-cancel:hover {',
      '  background: #f3f4f6;',
      '}',
      '.cn-btn-save {',
      '  background: linear-gradient(135deg, #667eea, #764ba2);',
      '  color: white;',
      '  border-color: transparent;',
      '}',
      '.cn-btn-save:hover {',
      '  opacity: 0.9;',
      '  transform: translateY(-1px);',
      '  box-shadow: 0 4px 12px rgba(102, 126, 234, 0.4);',
      '}'
    ].join('\n');
    document.head.appendChild(style);
  }

  function openSettingsModal() {
    if (!settingsModal) {
      settingsModal = createSettingsModal();
      document.body.appendChild(settingsModal);
      bindModalEvents();
    }

    // 刷新当前配置值
    var cfg = (window.__CLAUDE_CN_GUARD__ && window.__CLAUDE_CN_GUARD__.cfg) || {};
    settingsModal.querySelector('[name="minInterval"]').value = Math.floor((cfg.minInterval || 3000) / 1000);
    settingsModal.querySelector('[name="perMinute"]').value = cfg.perMinute || 6;
    settingsModal.querySelector('[name="perHour"]').value = cfg.perHour || 30;
    settingsModal.querySelector('[name="perDay"]').value = cfg.perDay || 200;

    settingsModal.style.display = 'block';
  }

  function closeSettingsModal() {
    if (settingsModal) {
      settingsModal.style.display = 'none';
    }
  }

  function saveSettings() {
    try {
      var minInterval = parseInt(settingsModal.querySelector('[name="minInterval"]').value, 10);
      var perMinute = parseInt(settingsModal.querySelector('[name="perMinute"]').value, 10);
      var perHour = parseInt(settingsModal.querySelector('[name="perHour"]').value, 10);
      var perDay = parseInt(settingsModal.querySelector('[name="perDay"]').value, 10);

      // 验证输入（先检查是否为有效数字）
      if (!Number.isFinite(minInterval) || !Number.isFinite(perMinute) ||
          !Number.isFinite(perHour) || !Number.isFinite(perDay)) {
        throw new Error('请输入有效的数字');
      }
      if (minInterval < 1 || minInterval > 60) {
        throw new Error('最小间隔必须在 1-60 秒之间');
      }
      if (perMinute < 1 || perMinute > 60) {
        throw new Error('每分钟上限必须在 1-60 之间');
      }
      if (perHour < 1 || perHour > 300) {
        throw new Error('每小时上限必须在 1-300 之间');
      }
      if (perDay < 1 || perDay > 2000) {
        throw new Error('每日上限必须在 1-2000 之间');
      }

      // 逻辑校验
      if (perMinute > perHour) {
        throw new Error('每分钟上限不能大于每小时上限');
      }
      if (perHour > perDay) {
        throw new Error('每小时上限不能大于每日上限');
      }

      var newCfg = {
        guard: {
          minInterval: minInterval * 1000,
          perMinute: perMinute,
          perHour: perHour,
          perDay: perDay
        }
      };

      // 保存到 localStorage
      localStorage.setItem('claude-cn:config:v1', JSON.stringify(newCfg));

      // 通知 guard.js 重新加载配置
      if (window.__CLAUDE_CN_GUARD__ && window.__CLAUDE_CN_GUARD__.reloadConfig) {
        window.__CLAUDE_CN_GUARD__.reloadConfig();
      }

      closeSettingsModal();

      if (window.__CLAUDE_CN_GUARD__ && window.__CLAUDE_CN_GUARD__.toast) {
        window.__CLAUDE_CN_GUARD__.toast('设置已保存并生效', 'ok', 'settings');
      }

      // 立即更新面板显示
      update();
    } catch (e) {
      if (window.__CLAUDE_CN_GUARD__ && window.__CLAUDE_CN_GUARD__.toast) {
        window.__CLAUDE_CN_GUARD__.toast('保存失败：' + e.message, 'err', 'settings-error');
      }
    }
  }

  function bindModalEvents() {
    if (!settingsModal) return;

    // 关闭按钮
    var btnClose = settingsModal.querySelector('.cn-modal-close');
    btnClose.addEventListener('click', closeSettingsModal);

    // 取消按钮
    var btnCancel = settingsModal.querySelector('.cn-btn-cancel');
    btnCancel.addEventListener('click', closeSettingsModal);

    // 保存按钮
    var btnSave = settingsModal.querySelector('.cn-btn-save');
    btnSave.addEventListener('click', saveSettings);

    // 点击遮罩关闭
    var overlay = settingsModal.querySelector('.cn-modal-overlay');
    overlay.addEventListener('click', closeSettingsModal);

    // ESC 键关闭
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && settingsModal && settingsModal.style.display === 'block') {
        closeSettingsModal();
      }
    });
  }

  // ============== 启动更新循环 ==============
  function startUpdateLoop() {
    update(true);
    // 倒计时仍需 1s 轮询，但它只更新一个文本节点，开销极小
    countdownTimer = setInterval(function() {
      if (window.__CLAUDE_CN_GUARD__ && window.__CLAUDE_CN_GUARD__.getStats) {
        var stats = window.__CLAUDE_CN_GUARD__.getStats();
        updateCountdown(stats.nextWait);
      }
    }, 1000);
  }

  function stopUpdateLoop() {
    if (countdownTimer) {
      clearInterval(countdownTimer);
      countdownTimer = 0;
    }
  }

  // ============== 初始化 ==============
  function init() {
    panel = createPanel();
    document.body.appendChild(panel);
    makeDraggable(panel);
    bindEvents();
    startUpdateLoop();
  }

  // ============== 暴露接口 ==============
  Object.defineProperty(window, '__CLAUDE_CN_PANEL__', {
    value: {
      update: update,
      pause: function () { paused = true; },
      resume: function () { paused = false; pauseUntil = 0; },
      version: '0.3.0'
    },
    enumerable: false, configurable: true, writable: false
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }

  console.info('[claude-cn] panel ready (v0.3)');
})();

