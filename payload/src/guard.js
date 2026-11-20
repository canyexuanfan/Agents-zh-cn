/* Claude Desktop CN - guard.js
 * 反风控守护（v0.3）
 * 红线：不改任何请求、不改 UA、不改响应体、不持久化任何会话凭据。
 * 本模块：
 *   B1 发送防抖（捕获 click / Enter，吞掉重复事件）
 *   B3 响应只读监听（fetch 包一层，只读 status，原样返回）
 *   B4 四档限流（minInterval / perMinute / perHour / perDay）
 *   B5 大文本粘贴提示（toast）
 *   localStorage 持久化历史时间戳
 */
(function () {
  'use strict';

  if (window.__CLAUDE_CN_GUARD__) return;

  // 默认配置（可被 localStorage 中的 claude-cn:config:v1 覆盖）
  var CFG = {
    minInterval: 3000,   // 两条之间至少 3s
    perMinute: 6,        // 1 分钟内最多 6 条
    perHour: 30,         // 1 小时内最多 30 条
    perDay: 200,         // 1 天内最多 200 条
    bigPasteChars: 10000,
    toastDuration: 3500
  };

  // 加载用户配置（如果存在）
  function loadUserConfig() {
    try {
      var raw = localStorage.getItem('claude-cn:config:v1');
      if (raw) {
        var userCfg = JSON.parse(raw);
        if (userCfg.guard) {
          // 强制校验数字类型，防止注入非数字内容
          for (var k in CFG) {
            if (userCfg.guard.hasOwnProperty(k)) {
              var val = Number(userCfg.guard[k]);
              if (!isNaN(val) && val > 0) CFG[k] = val;
            }
          }
        }
      }
    } catch (e) {
      console.warn('[claude-cn] guard config load failed:', e);
    }
  }
  loadUserConfig();

  // ============== localStorage 历史管理 ==============
  var HISTORY_KEY = 'claude-cn:history:v1';

  function loadHistory() {
    try {
      var raw = localStorage.getItem(HISTORY_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      console.warn('[claude-cn] history load failed:', e);
      return [];
    }
  }

  function saveHistory(arr) {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(arr));
      // 触发自定义事件，通知 panel 更新
      window.dispatchEvent(new CustomEvent('claude-cn:guard-update'));
    } catch (e) {
      console.warn('[claude-cn] history save failed:', e);
    }
  }

  function cleanHistory(history, now) {
    // 清理 24h 之前的记录
    var cut = now - 86400000;
    if (history.length === 0 || history[history.length - 1] < cut) return [];
    // 寻找第一个大于 cut 的索引
    var idx = 0;
    while (idx < history.length && history[idx] < cut) idx++;
    return idx > 0 ? history.slice(idx) : history;
  }

  // ============== 统计引擎 (单次遍历) ==============
  function calculateStats(history, now) {
    var stats = {
      inMinute: [],
      inHour: [],
      inDay: history // 历史本身已清理为 24h 内
    };
    var mCut = now - 60000;
    var hCut = now - 3600000;
    
    for (var i = history.length - 1; i >= 0; i--) {
      var t = history[i];
      if (t >= mCut) stats.inMinute.unshift(t);
      if (t >= hCut) stats.inHour.unshift(t);
      else break; // 历史是递增的，一旦小于 hCut 就不必再往前看了
    }
    return stats;
  }

  // ============== 时间格式化 ==============
  function formatTime(sec) {
    if (sec < 60) return sec + ' 秒';
    if (sec < 3600) return Math.ceil(sec / 60) + ' 分钟';
    return Math.ceil(sec / 3600) + ' 小时';
  }

  // ============== Toast ==============
  function ensureToastRoot() {
    var r = document.getElementById('__cn_toast_root');
    if (r) return r;
    r = document.createElement('div');
    r.id = '__cn_toast_root';
    r.style.cssText = [
      'position:fixed', 'right:16px', 'bottom:16px', 'z-index:2147483647',
      'display:flex', 'flex-direction:column', 'gap:8px',
      'font-family:system-ui,"Microsoft YaHei",sans-serif',
      'pointer-events:none'
    ].join(';');
    document.body.appendChild(r);
    return r;
  }
  // 去抖：相同 key 500ms 内不重复弹
  var lastToastAt = {};
  function toast(msg, kind, key) {
    try {
      var k = key || (kind + ':' + msg);
      var now = Date.now();
      if (lastToastAt[k] && now - lastToastAt[k] < 500) return;
      lastToastAt[k] = now;
      var r = ensureToastRoot();
      var el = document.createElement('div');
      var bg = kind === 'warn' ? '#b45309' : kind === 'err' ? '#b91c1c' : '#1f2937';
      el.style.cssText = [
        'background:' + bg, 'color:#fff', 'padding:10px 14px', 'border-radius:8px',
        'font-size:13px', 'box-shadow:0 4px 16px rgba(0,0,0,.25)',
        'max-width:360px', 'opacity:0', 'transition:opacity .2s',
        'pointer-events:auto'
      ].join(';');
      el.textContent = '[CN] ' + msg;
      r.appendChild(el);
      requestAnimationFrame(function () { el.style.opacity = '1'; });
      setTimeout(function () {
        el.style.opacity = '0';
        setTimeout(function () { el.remove(); }, 250);
      }, CFG.toastDuration);
    } catch (e) { /* noop */ }
  }

  // ============== B1 + B4 四档限流引擎 ==============
  // 设计：
  //   - shouldBlock 检查四档：minInterval / perMinute / perHour / perDay
  //   - 用户按下发送 → pendingLock=true（短暂锁），防止连点
  //   - 真实 fetch 命中发送 endpoint → recordSend() 更新历史 + 写 localStorage
  //   - 1500ms 内 fetch 未到达 → 自动释放 pendingLock，避免死锁
  var lastSendAt = 0;
  var pendingLock = false;
  var pendingTimer = 0;
  var sessionTurns = 0;
  var SESSION_WARN_AT = 50;

  function shouldBlock() {
    if (!guardEnabled) return { blocked: false };
    if (isPaused()) return { blocked: false };
    if (pendingLock) return { blocked: true, reason: 'pending' };

    var now = Date.now();
    var history = loadHistory();
    history = cleanHistory(history, now);
    var stats = calculateStats(history, now);

    // 检查 minInterval
    if (history.length > 0) {
      var lastTs = history[history.length - 1];
      var elapsed = now - lastTs;
      if (elapsed < CFG.minInterval) {
        var wait = Math.ceil((CFG.minInterval - elapsed) / 1000);
        return { blocked: true, reason: 'minInterval', wait: wait };
      }
    }

    // 检查 perMinute
    if (stats.inMinute.length >= CFG.perMinute) {
      var oldestInMinute = stats.inMinute[0];
      var wait = Math.ceil((60000 - (now - oldestInMinute)) / 1000);
      return {
        blocked: true, reason: 'perMinute', wait: wait,
        current: stats.inMinute.length, limit: CFG.perMinute
      };
    }

    // 检查 perHour
    if (stats.inHour.length >= CFG.perHour) {
      var oldestInHour = stats.inHour[0];
      var wait = Math.ceil((3600000 - (now - oldestInHour)) / 1000);
      return {
        blocked: true, reason: 'perHour', wait: wait,
        current: stats.inHour.length, limit: CFG.perHour
      };
    }

    // 检查 perDay
    if (history.length >= CFG.perDay) {
      var oldestInDay = history[0];
      var wait = Math.ceil((86400000 - (now - oldestInDay)) / 1000);
      return {
        blocked: true, reason: 'perDay', wait: wait,
        current: history.length, limit: CFG.perDay
      };
    }

    return { blocked: false };
  }

  function setPending() {
    pendingLock = true;
    clearTimeout(pendingTimer);
    pendingTimer = setTimeout(function () { pendingLock = false; }, 1500);
  }

  function recordSend() {
    if (!guardEnabled) return; // 禁用守护时不记录历史

    lastSendAt = Date.now();
    pendingLock = false;
    clearTimeout(pendingTimer);

    var history = loadHistory();
    history.push(Date.now());
    history = cleanHistory(history, Date.now());
    saveHistory(history);

    sessionTurns++;
    if (sessionTurns === SESSION_WARN_AT) {
      toast('本轮对话已达 ' + SESSION_WARN_AT + ' 轮，建议开启新对话以降低风控风险', 'warn', 'session-warn');
    } else if (sessionTurns > SESSION_WARN_AT && sessionTurns % 10 === 0) {
      toast('当前 ' + sessionTurns + ' 轮，强烈建议新建对话', 'warn', 'session-warn');
    }

    // 通知 panel 更新（如果存在）
    if (window.__CLAUDE_CN_PANEL__ && window.__CLAUDE_CN_PANEL__.update) {
      window.__CLAUDE_CN_PANEL__.update();
    }
  }

  function getBlockMessage(result) {
    if (result.reason === 'pending') {
      return '请等待上一条消息发送完成';
    } else if (result.reason === 'minInterval') {
      return '发送过快，请等待 ' + result.wait + ' 秒';
    } else if (result.reason === 'perMinute') {
      return '已达分钟上限（' + result.current + '/' + result.limit + '），请等待 ' + result.wait + ' 秒';
    } else if (result.reason === 'perHour') {
      return '已达小时上限（' + result.current + '/' + result.limit + '），请等待 ' + formatTime(result.wait);
    } else if (result.reason === 'perDay') {
      return '已达今日上限（' + result.current + '/' + result.limit + '），请等待 ' + formatTime(result.wait);
    }
    return '发送受限，请稍候';
  }

  function isSendButton(el) {
    if (!el || el.nodeType !== 1) return false;
    var aria = (el.getAttribute && el.getAttribute('aria-label')) || '';
    var tid = (el.getAttribute && el.getAttribute('data-testid')) || '';
    var txt = (el.textContent || '').trim().toLowerCase();
    if (/^stop/i.test(aria) || /stop/i.test(tid)) return false; // 排除停止按钮
    if (/send|发送/i.test(aria)) return true;
    if (/send/i.test(tid)) return true;
    if (txt === 'send' || txt === '发送') return true;
    return false;
  }

  document.addEventListener('click', function (e) {
    var el = e.target;
    while (el && el !== document.body) {
      if (el.tagName === 'BUTTON' && isSendButton(el)) {
        var result = shouldBlock();
        if (result.blocked) {
          e.stopImmediatePropagation();
          e.preventDefault();
          toast(getBlockMessage(result), 'warn', 'rate-limit');
        } else {
          setPending(); // 放行：进入 pending，等 fetch 到来
        }
        return;
      }
      el = el.parentElement;
    }
  }, true);

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing || e.keyCode === 229) return;
    var t = e.target;
    if (!t) return;
    var editable = t.tagName === 'TEXTAREA' || t.isContentEditable;
    if (!editable) return;
    var result = shouldBlock();
    if (result.blocked) {
      e.stopImmediatePropagation();
      e.preventDefault();
      toast(getBlockMessage(result), 'warn', 'rate-limit');
    } else {
      setPending();
    }
  }, true);

  // ============== B3 响应只读监听 ==============
  // 关键：只读 response.status，绝不消费 body，绝不修改任何东西。
  // 同时承担 B1 的"真正发出请求"的 record 时机
  // 区分两类接口：
  //   - SEND_API：真正提交一条消息，命中即 recordSend()
  //   - WATCH_API：仅监视 429/403 等状态码，不影响节流
  function getSendKind(url, method) {
    if (!url) return null;
    var m = (method || 'GET').toUpperCase();
    // 显式排除官方 count_tokens（POST /v1/messages/count_tokens）
    if (/\/v1\/messages\/count_tokens(?:[?#]|$)/i.test(url)) return 'watch';
    // 发送消息（聊天主接口）
    // Claude.ai web：POST /api/organizations/{org}/chat_conversations/{id}/completion
    //               POST /api/append_message（旧）
    // 平台 API：     POST /v1/messages（精确匹配，不含子路径）
    //               POST /v1/complete（精确匹配）
    if (m === 'POST' && /\/api\/(organizations\/[^/]+\/chat_conversations\/[^/]+\/completion|append_message)(?:[?#]|$)/i.test(url)) {
      return 'send';
    }
    if (m === 'POST' && /\/v1\/(messages|complete)(?:[?#]|$)/i.test(url)) {
      return 'send';
    }
    // 仅监视错误码（包含所有聊天相关，但不算 send）
    if (/\/api\/(chat_conversations|completion|append_message)/i.test(url)) return 'watch';
    if (/\/v1\/(messages|complete)/i.test(url)) return 'watch';
    return null;
  }
  try {
    var origFetch = window.fetch;
    if (typeof origFetch === 'function' && !origFetch.__cn_wrapped__) {
      var wrapped = function () {
        // 提取 URL/method（不读 body，不修改）
        var sendKind = null;
        try {
          var arg0 = arguments[0];
          var arg1 = arguments[1] || {};
          var url = '', method = 'GET';

          if (typeof arg0 === 'string') {
            url = arg0;
            method = arg1.method || 'GET';
          } else if (arg0 && typeof arg0 === 'object') {
            // 处理 Request 对象或 URL 对象
            url = arg0.url || (arg0.toString ? arg0.toString() : '');
            method = arg0.method || arg1.method || 'GET';
          }
          sendKind = getSendKind(url, method);
          if (sendKind === 'send') recordSend();
        } catch (_) {}

        var p = origFetch.apply(this, arguments);
        p.then(function (res) {
          try {
            if (!res) return;
            var s = res.status;
            var url = (res.url || '') + '';
            // 只对聊天相关接口提示
            if (!getSendKind(url, 'POST') && !getSendKind(url, 'GET')) return;
            if (s === 429) {
              var ra = res.headers && res.headers.get && res.headers.get('retry-after');
              // retry-after 可能是秒数或 HTTP-date
              var hint = '';
              if (ra) {
                if (/^\d+$/.test(ra)) hint = '，建议 ' + ra + 's 后重试';
                else { var d = Date.parse(ra); if (d) hint = '，建议 ' + Math.max(1, Math.ceil((d - Date.now())/1000)) + 's 后重试'; }
              } else { hint = '，建议稍候再试'; }
              toast('触发频控 429' + hint, 'err', '429');
            } else if (s === 403) {
              toast('403：请求被拒（可能是权限或风控）', 'err', '403');
            } else if (s === 401) {
              toast('401：会话失效，请重新登录', 'err', '401');
            } else if (s >= 500 && s < 600) {
              toast('服务端 ' + s + '，稍后重试', 'warn', '5xx');
            }
          } catch (_) {}
        }).catch(function () {});
        return p;
      };
      wrapped.__cn_wrapped__ = true;
      window.fetch = wrapped;
    }
  } catch (e) {
    console.warn('[claude-cn] guard fetch wrap failed:', e);
  }

  // ============== B5 大文本粘贴提示 ==============
  document.addEventListener('paste', function (e) {
    try {
      var cd = e.clipboardData || window.clipboardData;
      if (!cd) return;
      var text = cd.getData('text');
      if (text && text.length >= CFG.bigPasteChars) {
        toast('粘贴 ' + text.length + ' 字符：建议分段或上传为文件', 'warn', 'bigpaste');
      }
    } catch (_) {}
  }, true);

  // ============== 启用/禁用接口 ==============
  var guardEnabled = true;
  var pausedUntil = 0; // 暂停截止时间戳
  try {
    var moduleState = localStorage.getItem('claude-cn:modules:v1');
    if (moduleState) {
      var parsed = JSON.parse(moduleState);
      guardEnabled = parsed.guard !== false;
    }
  } catch (e) {}

  function enableGuard() {
    guardEnabled = true;
    console.info('[claude-cn] guard enabled');
  }

  function disableGuard() {
    guardEnabled = false;
    console.info('[claude-cn] guard disabled');
  }

  function isGuardEnabled() {
    return guardEnabled;
  }

  function pauseGuard(durationMs) {
    pausedUntil = Date.now() + durationMs;
    console.info('[claude-cn] guard paused for ' + Math.ceil(durationMs / 1000) + 's');
  }

  function resumeGuard() {
    pausedUntil = 0;
    console.info('[claude-cn] guard resumed');
  }

  function isPaused() {
    if (pausedUntil === 0) return false;
    if (Date.now() >= pausedUntil) {
      pausedUntil = 0;
      return false;
    }
    return true;
  }

  // ============== 暴露接口 ==============
  function reloadConfig() {
    loadUserConfig();
    console.info('[claude-cn] guard config reloaded');
    window.dispatchEvent(new CustomEvent('claude-cn:guard-update'));
  }

  function getStats() {
    var now = Date.now();
    var history = loadHistory();
    history = cleanHistory(history, now);
    var stats = calculateStats(history, now);

    var inDay = history.length;
    var inHour = stats.inHour.length;
    var inMinute = stats.inMinute.length;

    // 计算下次可发倒计时（秒）
    var nextWait = 0;
    if (history.length > 0) {
      var lastTs = history[history.length - 1];
      nextWait = Math.max(0, Math.ceil((CFG.minInterval - (now - lastTs)) / 1000));
    }

    return {
      day: { current: inDay, limit: CFG.perDay },
      hour: { current: inHour, limit: CFG.perHour },
      minute: { current: inMinute, limit: CFG.perMinute },
      nextWait: nextWait
    };
  }

  Object.defineProperty(window, '__CLAUDE_CN_GUARD__', {
    value: {
      cfg: CFG,
      version: '0.3.0',
      toast: toast,
      reloadConfig: reloadConfig,
      getStats: getStats,
      loadHistory: loadHistory,
      saveHistory: saveHistory,
      enable: enableGuard,
      disable: disableGuard,
      isEnabled: isGuardEnabled,
      pause: pauseGuard,
      resume: resumeGuard,
      isPaused: isPaused
    },
    enumerable: false, configurable: true, writable: false
  });
  console.info('[claude-cn] guard ready (v0.3 四档限流)');
})();
