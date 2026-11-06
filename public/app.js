/* =========================================================================
 * 炸金花 · 前端逻辑（原生 JS，零依赖、零构建）
 *
 *  - 身份：localStorage 保存 { roomId, playerId, token }，刷新自动 /api/rejoin
 *  - 实时：EventSource('/api/events?...') 监听 state 事件
 *  - 动作：fetch POST /api/action
 *  - 倒计时：只用 turnDeadline - serverNow 做基准，再减去本地流逝时间
 *  - 牌：服务端只给"自己看过的牌"，未看牌时 myCards 为 null，必须显示牌背
 * ========================================================================= */
(function () {
  'use strict';

  /* ------------------------------------------------------------------ 常量 */

  var NICK_KEY = 'zjh.nickname.v1';
  var SESS_KEY = 'zjh.sessions.v1';
  var FACTOR_KEY = 'zjh.penaltyFactor.v1';
  var CREATE_KEY = 'zjh.createConfig.v1';

  var SUIT_SYMBOL = { S: '\u2660', H: '\u2665', D: '\u2666', C: '\u2663' };
  var RANK_LABEL = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
  var MAX_SESSIONS = 8;

  var CONFIG_FIELDS = [
    { key: 'ante', label: '底注', def: 10, min: 1, max: 10000, step: 1 },
    { key: 'initialChips', label: '初始筹码', def: 1000, min: 100, max: 1000000, step: 100 },
    { key: 'baseStake', label: '初始单注', def: 10, min: 1, max: 10000, step: 1 },
    { key: 'maxStake', label: '单注封顶', def: 100, min: 1, max: 100000, step: 1 },
    { key: 'maxPot', label: '总注封顶', def: 3000, min: 2, max: 10000000, step: 100 },
    { key: 'seeMultiplier', label: '看牌倍数', def: 2, min: 1, max: 4, step: 1 },
    { key: 'turnSeconds', label: '思考秒数', def: 45, min: 0, max: 600, step: 5 },
    { key: 'special235', label: '235 通杀', type: 'bool', def: false },
    { key: 'autoRebuy', label: '自动补筹码', type: 'bool', def: true }
  ];

  var DEFAULT_CONFIG = {};
  (function () {
    for (var i = 0; i < CONFIG_FIELDS.length; i++) DEFAULT_CONFIG[CONFIG_FIELDS[i].key] = CONFIG_FIELDS[i].def;
  })();

  /* ------------------------------------------------------------------ 小工具 */

  function $(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function digits(s) {
    return String(s == null ? '' : s).replace(/[^0-9]/g, '');
  }

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }

  function fmtClock(t) {
    var d = new Date(Number(t) || Date.now());
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }

  function fmtSigned(n) {
    var v = Number(n) || 0;
    if (v > 0) return '+' + v;
    return String(v);
  }

  function fmtAmount(n) {
    var v = Math.round((Number(n) || 0) * 10) / 10;
    return String(v);
  }

  function rankLabel(r) { return RANK_LABEL[r] || String(r); }

  function isRedSuit(s) { return s === 'H' || s === 'D'; }

  /* --------------------------------------------------------------- 本地存储 */

  function lsGet(key, fallback) {
    try {
      var v = localStorage.getItem(key);
      return v == null ? fallback : v;
    } catch (e) { return fallback; }
  }

  function lsSet(key, val) {
    try { localStorage.setItem(key, val); } catch (e) { /* 隐私模式忽略 */ }
  }

  function lsGetJSON(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      if (!raw) return fallback;
      var obj = JSON.parse(raw);
      return obj == null ? fallback : obj;
    } catch (e) { return fallback; }
  }

  function readSessions() {
    var obj = lsGetJSON(SESS_KEY, null);
    return obj && typeof obj === 'object' ? obj : {};
  }

  function getSession(roomId) {
    if (!roomId) return null;
    var all = readSessions();
    var s = all[String(roomId)];
    if (!s || !s.playerId || !s.token) return null;
    return s;
  }

  function latestSession() {
    var all = readSessions();
    var best = null;
    for (var k in all) {
      if (!Object.prototype.hasOwnProperty.call(all, k)) continue;
      var s = all[k];
      if (!s || !s.playerId || !s.token) continue;
      if (!best || (s.at || 0) > (best.at || 0)) best = s;
    }
    return best;
  }

  function saveSession(sess) {
    if (!sess || !sess.roomId || !sess.playerId || !sess.token) return;
    var all = readSessions();
    all[String(sess.roomId)] = {
      roomId: String(sess.roomId),
      playerId: String(sess.playerId),
      token: String(sess.token),
      name: sess.name ? String(sess.name) : '',
      at: Date.now()
    };
    var keys = [];
    for (var k in all) if (Object.prototype.hasOwnProperty.call(all, k)) keys.push(k);
    if (keys.length > MAX_SESSIONS) {
      keys.sort(function (a, b) { return (all[a].at || 0) - (all[b].at || 0); });
      for (var i = 0; i < keys.length - MAX_SESSIONS; i++) delete all[keys[i]];
    }
    lsSet(SESS_KEY, JSON.stringify(all));
  }

  function dropSession(roomId) {
    if (!roomId) return;
    var all = readSessions();
    delete all[String(roomId)];
    lsSet(SESS_KEY, JSON.stringify(all));
  }

  /* --------------------------------------------------------------- 运行状态 */

  var state = null;              // 最新 State
  var session = null;            // { roomId, playerId, token, name }
  var es = null;                 // EventSource
  var connected = false;         // SSE 是否已连上
  var busy = false;              // 请求中（防连点）
  var currentScreen = 'home';
  var clock = { deadline: 0, serverNow: 0, localAt: 0 };
  var tickTimer = null;
  var verifyTimer = null;
  var verifyBusy = false;
  var lastOptions = [];
  var mySig = '';
  var myWasRevealed = false;
  var configSig = '';
  var configDirty = false;
  var resultSig = '';
  var logsSig = '';
  var turnSeatEl = null;
  var penaltyFactor = 1;
  var modalDismiss = null;
  var lastPhase = '';

  /* --------------------------------------------------------------- HTTP 封装 */

  function api(path, body, timeoutMs) {
    var opts = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
      credentials: 'same-origin',
      cache: 'no-store'
    };
    var controller = null;
    var timer = null;
    if (typeof AbortController === 'function') {
      try {
        controller = new AbortController();
        opts.signal = controller.signal;
      } catch (e) { controller = null; }
    }
    var req;
    try {
      req = fetch(path, opts);
    } catch (e) {
      return Promise.resolve({ ok: false, error: '网络连接失败，请检查网络后重试', netError: true });
    }
    if (controller) {
      timer = setTimeout(function () {
        try { controller.abort(); } catch (e) { /* ignore */ }
      }, timeoutMs || 12000);
    }
    return req.then(function (res) {
      return res.json().catch(function () {
        return { ok: false, error: '服务器返回异常（' + res.status + '）' };
      });
    }, function (err) {
      if (err && err.name === 'AbortError') return { ok: false, error: '请求超时，请重试', netError: true };
      return { ok: false, error: '网络连接失败，请检查网络后重试', netError: true };
    }).then(function (result) {
      if (timer) clearTimeout(timer);
      return result;
    });
  }

  /* ------------------------------------------------------------------ Toast */

  function toast(msg, type) {
    var root = $('toast-root');
    if (!root || !msg) return;
    var el = document.createElement('div');
    el.className = 'toast' + (type ? ' ' + type : '');
    el.textContent = String(msg);
    root.appendChild(el);
    while (root.children.length > 3) root.removeChild(root.firstChild);
    setTimeout(function () {
      el.className += ' hide';
      setTimeout(function () {
        if (el.parentNode) el.parentNode.removeChild(el);
      }, 220);
    }, 2400);
  }

  /* ------------------------------------------------------------- 断线提示条 */

  function showConn(text) {
    $('conn-text').textContent = text || '连接中…';
    $('conn-bar').hidden = false;
  }

  function hideConn() {
    $('conn-bar').hidden = true;
  }

  /* ------------------------------------------------------------------ 弹层 */

  function showModal(html, opts) {
    opts = opts || {};
    var root = $('modal-root');
    root.hidden = false;
    root.innerHTML =
      '<div class="modal-mask" data-close="1"></div>' +
      '<div class="modal-card" role="dialog" aria-modal="true">' +
        '<div class="modal-head"><h3>' + esc(opts.title || '') + '</h3>' +
        '<button type="button" class="modal-x" data-close="1" aria-label="关闭">\u00d7</button></div>' +
        '<div class="modal-body">' + html + '</div>' +
      '</div>';
    modalDismiss = typeof opts.onDismiss === 'function' ? opts.onDismiss : closeModal;
    var closers = root.querySelectorAll('[data-close="1"]');
    for (var i = 0; i < closers.length; i++) {
      closers[i].addEventListener('click', function (ev) {
        ev.preventDefault();
        if (modalDismiss) modalDismiss();
      });
    }
    return root;
  }

  function closeModal() {
    var root = $('modal-root');
    if (!root) return;
    root.hidden = true;
    root.innerHTML = '';
    modalDismiss = null;
  }

  function confirmDialog(opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var html =
        '<p class="confirm-msg">' + esc(opts.message || '') + '</p>' +
        '<div class="modal-btns">' +
          '<button type="button" class="btn btn-ghost" data-ans="0">取消</button>' +
          '<button type="button" class="btn ' + (opts.danger ? 'btn-danger' : 'btn-primary') + '" data-ans="1">' +
            esc(opts.okText || '确定') +
          '</button>' +
        '</div>';
      var root = showModal(html, {
        title: opts.title || '确认',
        onDismiss: function () {
          closeModal();
          resolve(false);
        }
      });
      var btns = root.querySelectorAll('[data-ans]');
      for (var i = 0; i < btns.length; i++) {
        (function (btn) {
          btn.addEventListener('click', function (ev) {
            ev.preventDefault();
            var yes = btn.getAttribute('data-ans') === '1';
            closeModal();
            resolve(yes);
          });
        })(btns[i]);
      }
    });
  }

  /* -------------------------------------------------------------- 复制工具 */

  function legacyCopy(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', 'readonly');
      ta.style.position = 'fixed';
      ta.style.top = '0';
      ta.style.left = '-9999px';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { ta.setSelectionRange(0, String(text).length); } catch (e) { /* ignore */ }
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      document.body.removeChild(ta);
      return !!ok;
    } catch (e) {
      return false;
    }
  }

  function copyText(text) {
    return new Promise(function (resolve) {
      var canClipboard = false;
      try {
        canClipboard = !!(navigator.clipboard && navigator.clipboard.writeText) &&
          (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1');
      } catch (e) { canClipboard = false; }

      if (!canClipboard) {
        resolve(legacyCopy(text));
        return;
      }
      navigator.clipboard.writeText(text).then(function () {
        resolve(true);
      }, function () {
        resolve(legacyCopy(text));
      });
    });
  }

  function copyWithFallback(text, okMsg) {
    copyText(text).then(function (ok) {
      if (ok) {
        toast(okMsg || '已复制', 'ok');
        return;
      }
      var root = showModal(
        '<p class="confirm-msg">自动复制失败，请长按选中下面的内容手动复制：</p>' +
        '<input class="input" readonly value="' + esc(text) + '">' +
        '<div class="modal-btns"><button type="button" class="btn btn-ghost" data-close="1">关闭</button></div>',
        { title: '手动复制' }
      );
      var input = root.querySelector('input');
      if (input) {
        try { input.focus(); input.select(); } catch (e) { /* ignore */ }
      }
    });
  }

  /* ------------------------------------------------------------ 屏幕切换 */

  function showScreen(name) {
    currentScreen = name;
    $('screen-home').hidden = name !== 'home';
    $('screen-table').hidden = name !== 'table';
    if (name === 'table') startTicker();
    else stopTicker();
  }

  function setUrlRoom(roomId) {
    try {
      var url = location.pathname;
      if (roomId) url += '?r=' + encodeURIComponent(roomId);
      history.replaceState(null, '', url);
    } catch (e) { /* ignore */ }
  }

  function roomFromUrl() {
    var m = /[?&]r=([^&#]*)/.exec(location.search || '');
    if (!m) return '';
    var rid = digits(decodeURIComponent(m[1])).slice(0, 6);
    return rid;
  }

  /* ---------------------------------------------------------------- 首页 */

  function restoreNickname() {
    var nick = lsGet(NICK_KEY, '');
    if (nick) $('nickname').value = nick;
  }

  function requireNickname() {
    var v = String($('nickname').value || '').replace(/\s+/g, ' ').replace(/^ | $/g, '').slice(0, 12);
    if (!v) {
      toast('请先填写昵称', 'err');
      $('nickname').focus();
      return null;
    }
    $('nickname').value = v;
    lsSet(NICK_KEY, v);
    return v;
  }

  function loadCreateConfig() {
    var saved = lsGetJSON(CREATE_KEY, null);
    var cfg = {};
    for (var i = 0; i < CONFIG_FIELDS.length; i++) {
      var f = CONFIG_FIELDS[i];
      var raw = saved && saved[f.key] != null ? saved[f.key] : f.def;
      if (f.type === 'bool') {
        cfg[f.key] = !!raw;
      } else {
        var n = Number(raw);
        cfg[f.key] = isFinite(n) ? n : f.def;
      }
    }
    return cfg;
  }

  function buildConfigForm(container, cfg, disabled) {
    if (!container) return;
    container.innerHTML = '';
    for (var i = 0; i < CONFIG_FIELDS.length; i++) {
      var f = CONFIG_FIELDS[i];
      var wrap = document.createElement('label');
      wrap.className = 'field';
      var cap = document.createElement('span');
      cap.className = 'field-label';
      cap.textContent = f.label;
      var input = document.createElement('input');
      input.setAttribute('data-key', f.key);
      if (f.type === 'bool') {
        wrap.className = 'field switch-field';
        input.type = 'checkbox';
        input.className = 'switch';
        input.checked = !!cfg[f.key];
        wrap.appendChild(cap);
        wrap.appendChild(input);
      } else {
        input.type = 'number';
        input.className = 'input';
        input.setAttribute('inputmode', 'numeric');
        if (f.min != null) input.setAttribute('min', String(f.min));
        if (f.max != null) input.setAttribute('max', String(f.max));
        if (f.step != null) input.setAttribute('step', String(f.step));
        input.value = String(cfg[f.key] != null ? cfg[f.key] : f.def);
        wrap.appendChild(cap);
        wrap.appendChild(input);
      }
      if (disabled) {
        input.disabled = true;
        input.setAttribute('aria-disabled', 'true');
      }
      container.appendChild(wrap);
    }
  }

  function readFormConfig(container) {
    var cfg = {};
    for (var i = 0; i < CONFIG_FIELDS.length; i++) {
      var f = CONFIG_FIELDS[i];
      var el = container ? container.querySelector('[data-key="' + f.key + '"]') : null;
      if (!el) {
        cfg[f.key] = DEFAULT_CONFIG[f.key];
        continue;
      }
      if (f.type === 'bool') {
        cfg[f.key] = !!el.checked;
      } else {
        var n = Number(el.value);
        cfg[f.key] = isFinite(n) ? Math.round(n) : DEFAULT_CONFIG[f.key];
      }
    }
    return cfg;
  }

  function toggleAdvanced() {
    var adv = $('create-adv');
    var open = adv.hidden;
    adv.hidden = !open;
    $('btn-adv').setAttribute('aria-expanded', open ? 'true' : 'false');
    $('adv-arrow').textContent = open ? '\u25b4' : '\u25be';
  }

  function updateResumeBox() {
    var rid = digits($('join-room').value).slice(0, 6);
    var sess = rid ? getSession(rid) : latestSession();
    $('resume-box').hidden = !sess;
    if (sess) $('resume-room').textContent = sess.roomId;
  }

  function showHome(opts) {
    opts = opts || {};
    closeStream();
    if (verifyTimer) {
      clearTimeout(verifyTimer);
      verifyTimer = null;
    }
    session = null;
    state = null;
    busy = false;
    mySig = '';
    myWasRevealed = false;
    configSig = '';
    configDirty = false;
    resultSig = '';
    logsSig = '';
    lastPhase = '';
    showScreen('home');
    hideConn();

    var rid = opts.roomId || '';
    if (rid) {
      $('join-room').value = rid;
      $('join-box').classList.add('highlight');
    } else {
      $('join-room').value = '';
      $('join-box').classList.remove('highlight');
    }
    setUrlRoom(rid);
    updateResumeBox();
    if (opts.toast) toast(opts.toast, opts.toastType || '');
    if (opts.focusJoin) {
      setTimeout(function () {
        try { $('join-room').focus(); } catch (e) { /* ignore */ }
      }, 80);
    }
  }

  /* ------------------------------------------------------------ 进入房间 */

  function enterRoom(sess) {
    session = sess;
    saveSession(sess);
    setUrlRoom(sess.roomId);
    $('room-id').textContent = sess.roomId;
    $('my-cards').innerHTML = '';
    mySig = '';
    myWasRevealed = false;
    configSig = '';
    configDirty = false;
    resultSig = '';
    logsSig = '';
    lastOptions = [];
    busy = false;
    lastPhase = '';
    showScreen('table');
    showConn('连接中…');
    connected = false;
    openStream();
  }

  function resumeRoom(sess, rid) {
    if (!sess) {
      showHome({ roomId: rid || '' });
      return;
    }
    session = sess;
    $('room-id').textContent = sess.roomId;
    showScreen('table');
    showConn('连接中…');
    $('turn-text').textContent = '正在恢复牌局…';
    api('/api/rejoin', {
      roomId: sess.roomId,
      playerId: sess.playerId,
      token: sess.token
    }).then(function (res) {
      if (res && res.ok) {
        enterRoom({
          roomId: res.roomId || sess.roomId,
          playerId: res.playerId || sess.playerId,
          token: res.token || sess.token,
          name: sess.name || ''
        });
        return;
      }
      if (res && res.netError) {
        showHome({
          roomId: sess.roomId,
          toast: '网络不稳定，未能自动回到牌桌，可稍后点「继续进入」重试',
          toastType: 'err'
        });
        return;
      }
      dropSession(sess.roomId);
      showHome({
        roomId: sess.roomId,
        toast: (res && res.error) || '房间已失效，请重新加入',
        toastType: 'err'
      });
    });
  }

  /* ------------------------------------------------------------- 创建/加入 */

  function doCreate() {
    if (busy) return;
    var name = requireNickname();
    if (!name) return;
    var cfg = readFormConfig($('create-adv'));
    var pin = readCreatePin();
    var pinField = $('pin-field');
    if (pinField && !pinField.hidden && !pin) {
      toast('这个服务器需要创建口令，请先输入口令', 'err');
      $('create-pin').focus();
      return;
    }
    busy = true;
    var btn = $('btn-create');
    btn.disabled = true;
    api('/api/create', { name: name, config: cfg, pin: pin }).then(function (res) {
      busy = false;
      btn.disabled = false;
      if (!res || !res.ok) {
        if (res && res.code === 'PIN_REQUIRED') {
          showPinField();
          var pe = $('create-pin');
          if (pe) pe.focus();
        }
        toast((res && res.error) || '创建房间失败', 'err');
        return;
      }
      lsSet(CREATE_KEY, JSON.stringify(cfg));
      enterRoom({
        roomId: res.roomId,
        playerId: res.playerId,
        token: res.token,
        name: name
      });
    });
  }

  function doJoin() {
    if (busy) return;
    var name = requireNickname();
    if (!name) return;
    var rid = digits($('join-room').value).slice(0, 6);
    $('join-room').value = rid;
    if (rid.length !== 6) {
      toast('请输入 6 位数字房号', 'err');
      $('join-room').focus();
      return;
    }
    busy = true;
    var btn = $('btn-join');
    btn.disabled = true;
    api('/api/join', { roomId: rid, name: name }).then(function (res) {
      busy = false;
      btn.disabled = false;
      if (!res || !res.ok) {
        toast((res && res.error) || '加入房间失败', 'err');
        return;
      }
      enterRoom({
        roomId: res.roomId,
        playerId: res.playerId,
        token: res.token,
        name: name
      });
    });
  }

  function doResume() {
    if (busy) return;
    var rid = digits($('join-room').value).slice(0, 6);
    var sess = rid ? getSession(rid) : latestSession();
    if (!sess) {
      toast('没有可以恢复的房间', 'err');
      return;
    }
    resumeRoom(sess, sess.roomId);
  }

  /* ---------------------------------------------------------------- SSE */

  function openStream() {
    closeStream();
    if (!session) return;
    var url = '/api/events?roomId=' + encodeURIComponent(session.roomId) +
      '&playerId=' + encodeURIComponent(session.playerId) +
      '&token=' + encodeURIComponent(session.token);
    var src;
    try {
      src = new EventSource(url);
    } catch (e) {
      showConn('连接中…');
      scheduleVerify(2000);
      return;
    }
    es = src;

    src.addEventListener('state', function (ev) {
      if (src !== es) return;
      connected = true;
      hideConn();
      var st = null;
      try { st = JSON.parse(ev.data); } catch (e) { st = null; }
      if (!st) return;
      applyState(st);
    });

    src.addEventListener('ping', function () {
      if (src !== es) return;
      connected = true;
      hideConn();
    });

    src.onopen = function () {
      if (src !== es) return;
      connected = true;
      hideConn();
    };

    src.onerror = function () {
      if (src !== es) return;
      connected = false;
      showConn('连接中…');
      scheduleVerify(2500);
    };
  }

  function closeStream() {
    if (es) {
      try {
        es.onopen = null;
        es.onerror = null;
        es.close();
      } catch (e) { /* ignore */ }
      es = null;
    }
    connected = false;
  }

  function scheduleVerify(delay) {
    if (verifyTimer || !session || verifyBusy) return;
    verifyTimer = setTimeout(function () {
      verifyTimer = null;
      verifySession();
    }, delay || 2500);
  }

  function verifySession() {
    if (!session || verifyBusy) return;
    verifyBusy = true;
    var s = session;
    api('/api/rejoin', {
      roomId: s.roomId,
      playerId: s.playerId,
      token: s.token
    }).then(function (res) {
      verifyBusy = false;
      if (!session || session !== s) return;
      if (res && res.ok) {
        if (!es || es.readyState === 2) openStream();
        else if (es.readyState === 0) connected = false;
        return;
      }
      if (res && res.netError) {
        scheduleVerify(4000);
        return;
      }
      handleSessionInvalid((res && res.error) || '房间已失效，请重新加入');
    }, function () {
      verifyBusy = false;
      scheduleVerify(4000);
    });
  }

  function handleSessionInvalid(msg) {
    var rid = session ? session.roomId : '';
    if (session) dropSession(session.roomId);
    closeStream();
    if (verifyTimer) {
      clearTimeout(verifyTimer);
      verifyTimer = null;
    }
    session = null;
    state = null;
    busy = false;
    showHome({ roomId: rid, toast: msg, toastType: 'err' });
  }

  /* ------------------------------------------------------------- 状态应用 */

  function applyState(st) {
    state = st;
    clock.deadline = Number(st.turnDeadline) || 0;
    clock.serverNow = Number(st.serverNow) || Date.now();
    clock.localAt = Date.now();
    if (currentScreen !== 'table') showScreen('table');
    if (st.roomId) $('room-id').textContent = st.roomId;
    render(st);
  }

  function meId() {
    if (state && state.me) return state.me;
    if (session) return session.playerId;
    return '';
  }

  function findPlayer(st, pid) {
    if (!st || !pid) return null;
    var list = st.players || [];
    for (var i = 0; i < list.length; i++) if (list[i].id === pid) return list[i];
    return null;
  }

  /** 剩余毫秒：服务端基准差值 - 本地已流逝时间（绝不用本机时钟直接减 deadline） */
  function remainingMs() {
    if (!state || !clock.deadline) return null;
    var elapsed = Date.now() - clock.localAt;
    var rem = clock.deadline - clock.serverNow - elapsed;
    if (rem < 0) rem = 0;
    return rem;
  }

  /* ------------------------------------------------------------------ 渲染 */

  function render(st) {
    var phaseChanged = st.phase !== lastPhase;
    lastPhase = st.phase;

    renderHeader(st);

    $('panel-lobby').hidden = st.phase !== 'lobby';
    if (st.phase === 'lobby') {
      renderLobby(st);
    } else {
      configDirty = false;
      configSig = '';
    }

    if (st.phase === 'showdown') renderResult(st);
    else hideResult();

    renderSeats(st);
    renderMyArea(st);
    renderLogs(st);
    renderBottom(st);
    tick();

    if (phaseChanged) {
      try {
        if (st.phase === 'showdown') {
          var resultPanel = $('panel-result');
          if (resultPanel && resultPanel.scrollIntoView) {
            resultPanel.scrollIntoView({ block: 'start' });
          }
        } else {
          var main = $('table-main');
          if (main) main.scrollTop = 0;
        }
      } catch (e) { /* ignore */ }
    }
  }

  function renderHeader(st) {
    var players = st.players || [];
    var online = 0;
    for (var i = 0; i < players.length; i++) if (players[i].connected) online++;

    $('room-id').textContent = st.roomId || (session && session.roomId) || '------';
    $('online-text').textContent = online + '/' + (st.maxPlayers || 6) + ' 在线';

    var phaseText = st.phase === 'lobby' ? '大厅' : (st.phase === 'showdown' ? '结算' : '进行中');
    var tag = $('phase-tag');
    tag.textContent = phaseText;
    tag.className = 'phase-tag ' + (st.phase || '');

    // 结算阶段服务端已把 pot 清零，顶栏显示本局最终底池
    var potShow = st.pot;
    if (st.phase === 'showdown' && st.lastResult && st.lastResult.pot != null) potShow = st.lastResult.pot;
    $('stat-pot').textContent = String(potShow != null ? potShow : 0);
    $('stat-stake').textContent = String(st.stake != null ? st.stake : 0);
    $('stat-hand').textContent = String(st.handNo || 0);

    var dealer = null;
    for (var j = 0; j < players.length; j++) {
      if (players[j].isDealer) { dealer = players[j]; break; }
    }
    $('stat-dealer').textContent = dealer ? dealer.name : '—';
  }

  function seatBadges(p, st) {
    var list = [];
    if (p.isDealer) list.push({ cls: 'dealer', text: '庄' });
    if (p.isHost) list.push({ cls: 'host', text: '房主' });

    if (st.phase === 'lobby') {
      list.push({ cls: 'waiting', text: '等待中' });
    } else if (st.phase === 'showdown') {
      if (p.folded) list.push({ cls: 'folded', text: '已弃牌' });
      else if (p.inHand) list.push({ cls: 'show', text: '开牌' });
      else list.push({ cls: 'waiting', text: '等待中' });
    } else if (p.folded) {
      list.push({ cls: 'folded', text: '已弃牌' });
    } else if (!p.inHand) {
      list.push({ cls: 'waiting', text: '等待中' });
    } else if (p.seen) {
      list.push({ cls: 'seen', text: '已看牌' });
    } else {
      list.push({ cls: 'meng', text: '闷牌' });
    }

    if (!p.connected) list.push({ cls: 'offline', text: '离线' });
    return list;
  }

  function seatStat(label, value) {
    var wrap = document.createElement('span');
    wrap.className = 'seat-stat';
    var em = document.createElement('em');
    em.textContent = label;
    var b = document.createElement('b');
    b.textContent = String(value == null ? 0 : value);
    wrap.appendChild(em);
    wrap.appendChild(b);
    return wrap;
  }

  function renderSeats(st) {
    var wrap = $('seats');
    wrap.innerHTML = '';
    turnSeatEl = null;

    var players = st.players || [];
    var mid = meId();
    for (var i = 0; i < players.length; i++) {
      var p = players[i];
      var seat = document.createElement('div');
      var cls = 'seat';
      if (p.id === mid) cls += ' me';
      if (p.isTurn) { cls += ' turn'; turnSeatEl = seat; }
      if (p.folded) cls += ' folded';
      if (!p.connected) cls += ' offline';
      if (st.phase === 'playing' && !p.inHand) cls += ' idle';
      seat.className = cls;
      seat.setAttribute('data-pid', p.id);

      // 第一行：昵称 + 徽标
      var top = document.createElement('div');
      top.className = 'seat-top';
      var nameEl = document.createElement('span');
      nameEl.className = 'seat-name';
      nameEl.textContent = p.name || '玩家';
      if (p.id === mid) {
        var meTag = document.createElement('i');
        meTag.className = 'me-tag';
        meTag.textContent = '我';
        nameEl.appendChild(meTag);
      }
      top.appendChild(nameEl);

      var badges = document.createElement('span');
      badges.className = 'seat-badges';
      var badgeList = seatBadges(p, st);
      for (var b = 0; b < badgeList.length; b++) {
        var bi = document.createElement('span');
        bi.className = 'badge ' + badgeList[b].cls;
        bi.textContent = badgeList[b].text;
        badges.appendChild(bi);
      }
      top.appendChild(badges);
      seat.appendChild(top);

      // 第二行：筹码 / 本局下注
      var midRow = document.createElement('div');
      midRow.className = 'seat-mid';
      midRow.appendChild(seatStat(st.phase === 'lobby' ? '底注' : '本局', p.bet));
      midRow.appendChild(seatStat('筹码', p.chips));
      seat.appendChild(midRow);

      // 第三行：净分 + 倒计时秒数
      var bottom = document.createElement('div');
      bottom.className = 'seat-bottom';
      var netEl = document.createElement('span');
      netEl.className = 'seat-net ' + (p.net > 0 ? 'pos' : (p.net < 0 ? 'neg' : 'zero'));
      netEl.textContent = '净分 ' + fmtSigned(p.net);
      bottom.appendChild(netEl);
      if (p.isTurn && st.turnDeadline > 0) {
        var sec = document.createElement('span');
        sec.className = 'turn-sec';
        sec.textContent = '…';
        bottom.appendChild(sec);
      }
      seat.appendChild(bottom);

      // 已公开的牌（结算 / 自己看过的牌只在"我的牌"区展示）
      if (p.cards && p.cards.length === 3 && p.id !== mid) {
        var cardsRow = document.createElement('div');
        cardsRow.className = 'seat-cards';
        for (var c = 0; c < p.cards.length; c++) cardsRow.appendChild(buildMiniCard(p.cards[c]));
        seat.appendChild(cardsRow);
      } else if (st.phase === 'playing' && p.inHand && !p.folded && p.id !== mid) {
        var backsRow = document.createElement('div');
        backsRow.className = 'seat-cards';
        for (var k = 0; k < 3; k++) backsRow.appendChild(buildMiniBack());
        seat.appendChild(backsRow);
      }

      // 当前回合进度条
      if (p.isTurn && st.turnDeadline > 0) {
        var bar = document.createElement('div');
        bar.className = 'turn-bar';
        var fill = document.createElement('i');
        bar.appendChild(fill);
        seat.appendChild(bar);
      }

      wrap.appendChild(seat);
    }

    // 大厅里把空位画出来，方便拉人
    if (st.phase === 'lobby') {
      var total = st.maxPlayers || 6;
      var emptyCount = total - players.length;
      if (emptyCount < 0) emptyCount = 0;
      for (var e = 0; e < emptyCount; e++) {
        var emptySeat = document.createElement('div');
        emptySeat.className = 'seat empty';
        var t = document.createElement('span');
        t.className = 'empty-txt';
        t.textContent = '空位';
        emptySeat.appendChild(t);
        wrap.appendChild(emptySeat);
      }
    }
  }

  function renderMyArea(st) {
    // 大厅阶段还没有发牌，不显示"我的牌"区域
    var inLobby = st.phase === 'lobby';
    $('my-area').hidden = inLobby;
    if (inLobby) return;

    var cards = (st.myCards && st.myCards.length === 3) ? st.myCards : null;
    var sig = (cards ? cards.map(function (c) { return c.id; }).join('|') : 'BACK') +
      '#' + st.phase + '#' + (st.inHand ? 1 : 0) + '#' + (st.mySeen ? 1 : 0);

    if (sig !== mySig) {
      mySig = sig;
      buildMyCards(cards);
    }

    var nameEl = $('my-hand-name');
    if (st.myHandName) {
      nameEl.textContent = st.myHandName;
      nameEl.hidden = false;
    } else if (st.mySeen && st.phase === 'playing') {
      nameEl.textContent = '已看牌';
      nameEl.hidden = false;
    } else {
      nameEl.hidden = true;
    }

    var hint = '';
    if (st.phase === 'lobby') {
      hint = '等待开局 · 房主可在下方设置规则';
    } else if (st.phase === 'showdown') {
      hint = cards ? '本局已结束，牌面见下方结算' : '本局已结束，见下方结算';
    } else if (!st.inHand) {
      hint = '你未参与本局，等待下一局';
    } else if (st.folded) {
      hint = '你已弃牌，等待本局结束';
    } else if (st.mySeen) {
      hint = '已看牌 · 跟注 / 加注按 ' + ((st.config && st.config.seeMultiplier) || 2) + ' 倍下注';
    } else {
      hint = '闷牌中 · 点「看牌」翻开（看牌后下注翻倍）';
    }
    $('my-hint').textContent = hint;
    $('my-area').className = 'my-area' +
      (st.mySeen && st.phase !== 'lobby' ? ' seen' : '') +
      (st.folded ? ' out' : '');
  }

  function buildMyCards(cards) {
    var box = $('my-cards');
    box.innerHTML = '';
    var faceUp = !!cards;
    var animate = faceUp && !myWasRevealed;
    for (var i = 0; i < 3; i++) {
      box.appendChild(buildCard(cards ? cards[i] : null, faceUp, animate ? i : -1));
    }
    myWasRevealed = faceUp;
  }

  function cornerEl(rank, suit, bottom) {
    var c = document.createElement('span');
    c.className = 'pc-corner' + (bottom ? ' br' : '');
    var r = document.createElement('span');
    r.className = 'r';
    r.textContent = rank;
    var s = document.createElement('span');
    s.className = 's';
    s.textContent = suit;
    c.appendChild(r);
    c.appendChild(s);
    return c;
  }

  function buildCard(card, faceUp, delayIndex) {
    var el = document.createElement('div');
    el.className = 'pcard';
    var inner = document.createElement('div');
    inner.className = 'pcard-inner';
    var back = document.createElement('div');
    back.className = 'pcard-back';
    var face = document.createElement('div');
    face.className = 'pcard-face';

    if (card) {
      if (isRedSuit(card.s)) face.className += ' red';
      var sym = SUIT_SYMBOL[card.s] || '';
      var rk = rankLabel(card.r);
      face.appendChild(cornerEl(rk, sym, false));
      face.appendChild(cornerEl(rk, sym, true));
      var center = document.createElement('span');
      center.className = 'pc-center';
      center.textContent = sym;
      face.appendChild(center);
    }

    inner.appendChild(back);
    inner.appendChild(face);
    el.appendChild(inner);

    if (faceUp) {
      if (delayIndex >= 0) {
        (function (node, d) {
          setTimeout(function () { node.classList.add('flipped'); }, 90 + d * 130);
        })(el, delayIndex);
      } else {
        el.classList.add('flipped');
      }
    }
    return el;
  }

  function buildMiniCard(card) {
    var el = document.createElement('span');
    el.className = 'mini-card' + (isRedSuit(card.s) ? ' red' : '');
    var r = document.createElement('span');
    r.className = 'mini-r';
    r.textContent = rankLabel(card.r);
    var s = document.createElement('span');
    s.className = 'mini-s';
    s.textContent = SUIT_SYMBOL[card.s] || '';
    el.appendChild(r);
    el.appendChild(s);
    return el;
  }

  function buildMiniBack() {
    var el = document.createElement('span');
    el.className = 'mini-card back';
    return el;
  }

  function miniCardHtml(card) {
    return '<span class="mini-card' + (isRedSuit(card.s) ? ' red' : '') + '">' +
      '<span class="mini-r">' + esc(rankLabel(card.r)) + '</span>' +
      '<span class="mini-s">' + esc(SUIT_SYMBOL[card.s] || '') + '</span>' +
      '</span>';
  }

  /* ------------------------------------------------------------- 大厅设置 */

  function renderLobby(st) {
    var isHost = st.hostId === meId();
    if (!isHost) configDirty = false;
    var cfg = st.config || DEFAULT_CONFIG;
    var sig = JSON.stringify(cfg) + '|' + (isHost ? 'H' : 'G');
    if (!configDirty && sig !== configSig) {
      configSig = sig;
      buildConfigForm($('config-form'), cfg, !isHost);
    }
    $('btn-save-config').hidden = !isHost;
    $('config-lock').textContent = isHost ? '你是房主，可修改后保存' : '只有房主可修改，你可以先看看';
    $('config-msg').textContent = '';
  }

  function saveConfig() {
    if (!session || !state || busy) return;
    var cfg = readFormConfig($('config-form'));
    busy = true;
    $('btn-save-config').disabled = true;
    api('/api/config', {
      roomId: session.roomId,
      playerId: session.playerId,
      token: session.token,
      config: cfg
    }).then(function (res) {
      busy = false;
      $('btn-save-config').disabled = false;
      if (!res || !res.ok) {
        toast((res && res.error) || '保存失败', 'err');
        return;
      }
      configDirty = false;
      configSig = '';
      toast('设置已保存', 'ok');
      if (state) render(state);
    });
  }

  /* ---------------------------------------------------------------- 结算 */

  function hideResult() {
    var panel = $('panel-result');
    if (!panel.hidden) {
      panel.hidden = true;
      panel.innerHTML = '';
    }
    resultSig = '';
  }

  function renderResult(st) {
    var panel = $('panel-result');
    panel.hidden = false;

    var r = st.lastResult || {};
    var players = st.players || [];
    var netSig = '';
    for (var i = 0; i < players.length; i++) netSig += players[i].id + ':' + players[i].net + ',';
    var sig = (r.at || 0) + '#' + (r.handNo || 0) + '#' + (r.reason || '') + '#' + netSig;
    if (sig === resultSig) return;
    resultSig = sig;

    var winners = r.winners || [];
    var pot = r.pot != null ? r.pot : 0;
    var html = '';

    html += '<div class="result-hero">';
    html += '<div class="result-cap">第 ' + esc(r.handNo || st.handNo || 0) + ' 局结算</div>';
    html += '<div class="result-reason">' + esc(r.reason || '本局结束') + '</div>';
    html += '<div class="result-pot"><span>底池</span><b>' + esc(pot) + '</b></div>';
    if (winners.length) {
      html += '<div class="winner-list">';
      for (var w = 0; w < winners.length; w++) {
        html += '<span class="winner-chip">' + esc(winners[w].name) +
          ' <b>+' + esc(winners[w].amount != null ? winners[w].amount : 0) + '</b></span>';
      }
      html += '</div>';
    }
    html += '</div>';

    // 开牌情况
    var rows = [];
    var showdown = r.showdown || [];
    var wi;
    if (showdown.length) {
      for (var s = 0; s < showdown.length; s++) {
        var entry = showdown[s];
        var isWin = false;
        for (wi = 0; wi < winners.length; wi++) if (winners[wi].id === entry.id) isWin = true;
        rows.push({
          name: entry.name,
          hand: entry.hand,
          cards: entry.cards || [],
          win: isWin
        });
      }
    } else {
      for (var p = 0; p < players.length; p++) {
        var pl = players[p];
        if (!pl.cards || pl.cards.length !== 3) continue;
        var win = false;
        for (wi = 0; wi < winners.length; wi++) if (winners[wi].id === pl.id) win = true;
        rows.push({ name: pl.name, hand: pl.handName, cards: pl.cards, win: win });
      }
    }

    if (rows.length) {
      html += '<div class="sec-title">开牌情况</div><div class="reveal-list">';
      for (var q = 0; q < rows.length; q++) {
        var row = rows[q];
        html += '<div class="reveal-row' + (row.win ? ' winner' : '') + '">';
        html += '<div class="reveal-name">' + esc(row.name) +
          (row.win ? '<i class="win-tag">赢</i>' : '') + '</div>';
        html += '<div class="reveal-cards">';
        for (var c = 0; c < row.cards.length; c++) html += miniCardHtml(row.cards[c]);
        html += '</div>';
        html += '<div class="reveal-hand">' + esc(row.hand || '') + '</div>';
        html += '</div>';
      }
      html += '</div>';
    } else {
      html += '<p class="tips">本局没有开牌信息。</p>';
    }

    if (!showdown.length) {
      html += '<p class="tips">本局为弃牌获胜（未摊牌）' +
        (rows.length ? '，仅显示已亮出的手牌。' : '。') + '</p>';
    }

    // 累计积分榜
    var sorted = players.slice().sort(function (a, b) { return (b.net || 0) - (a.net || 0); });
    html += '<div class="sec-title">累计积分榜</div>';
    html += '<table class="rank-table"><tbody>';
    for (var k = 0; k < sorted.length; k++) {
      var sp = sorted[k];
      var netCls = sp.net > 0 ? 'pos' : (sp.net < 0 ? 'neg' : 'zero');
      html += '<tr' + (sp.id === meId() ? ' class="mine"' : '') + '>';
      html += '<td class="rank-no">' + (k + 1) + '</td>';
      html += '<td class="rank-name">' + esc(sp.name) +
        (sp.id === meId() ? '<i class="me-tag">我</i>' : '') + '</td>';
      html += '<td class="rank-net ' + netCls + '">' + esc(fmtSigned(sp.net)) + '</td>';
      html += '<td class="rank-chips">' + esc(sp.chips) + '</td>';
      html += '</tr>';
    }
    html += '</tbody></table>';

    // 惩罚换算
    html += '<div class="penalty">';
    html += '<div class="penalty-head"><span class="sec-title inline">惩罚换算</span></div>';
    html += '<label class="penalty-factor">1 分 = ' +
      '<input id="penalty-input" class="input penalty-input" type="number" inputmode="decimal" min="0" step="0.5" value="' +
      esc(fmtAmount(penaltyFactor)) + '"> 个惩罚</label>';
    html += '<div id="penalty-list" class="penalty-list"></div>';
    html += '<p class="tips">正数 = 该做多少个；负数 = 可以让别人做。用来算俯卧撑、深蹲之类的惩罚。</p>';
    html += '</div>';

    panel.innerHTML = html;

    var input = panel.querySelector('#penalty-input');
    if (input) {
      input.addEventListener('input', function () {
        var v = Number(input.value);
        if (!isFinite(v) || v < 0) v = 0;
        penaltyFactor = v;
        lsSet(FACTOR_KEY, String(v));
        renderPenaltyList();
      });
      input.addEventListener('change', function () {
        var v = Number(input.value);
        if (!isFinite(v) || v < 0) v = 0;
        penaltyFactor = v;
        lsSet(FACTOR_KEY, String(v));
        renderPenaltyList();
      });
    }
    renderPenaltyList();
  }

  function renderPenaltyList() {
    var box = document.querySelector('#panel-result #penalty-list');
    if (!box || !state) return;
    box.innerHTML = '';
    var players = state.players || [];
    var sorted = players.slice().sort(function (a, b) { return (b.net || 0) - (a.net || 0); });
    var total = 0;

    for (var i = 0; i < sorted.length; i++) {
      var p = sorted[i];
      var net = Number(p.net) || 0;
      var amount = Math.round(net * penaltyFactor * 10) / 10;
      var row = document.createElement('div');
      row.className = 'penalty-row';
      var name = document.createElement('span');
      name.className = 'penalty-name';
      name.textContent = p.name;
      var val = document.createElement('span');
      val.className = 'penalty-val';
      if (net > 0) {
        val.className += ' do';
        val.textContent = '做 ' + fmtAmount(amount) + ' 个';
        total += amount;
      } else if (net < 0) {
        val.className += ' pass';
        val.textContent = '可让别人做 ' + fmtAmount(-amount) + ' 个';
      } else {
        val.textContent = '免罚';
      }
      row.appendChild(name);
      row.appendChild(val);
      box.appendChild(row);
    }

    if (total > 0) {
      var sum = document.createElement('div');
      sum.className = 'penalty-sum';
      sum.textContent = '合计需做 ' + fmtAmount(total) + ' 个';
      box.appendChild(sum);
    }
  }

  /* ---------------------------------------------------------------- 日志 */

  function renderLogs(st) {
    var logs = st.logs || [];
    var last = logs.length ? (logs[logs.length - 1].t || 0) : 0;
    var sig = (st.roomId || '') + '#' + logs.length + '#' + last;
    if (sig === logsSig) return;
    logsSig = sig;

    var list = $('log-list');
    var nearBottom = true;
    try {
      nearBottom = (list.scrollHeight - list.scrollTop - list.clientHeight) < 28;
    } catch (e) { nearBottom = true; }

    list.innerHTML = '';
    for (var i = 0; i < logs.length; i++) {
      var item = logs[i] || {};
      var row = document.createElement('div');
      row.className = 'log-row';
      var time = document.createElement('span');
      time.className = 'log-time';
      time.textContent = fmtClock(item.t);
      var text = document.createElement('span');
      text.className = 'log-text';
      text.textContent = item.text == null ? '' : String(item.text);
      row.appendChild(time);
      row.appendChild(text);
      list.appendChild(row);
    }
    $('log-empty').hidden = logs.length > 0;

    if (nearBottom || logs.length <= 3) {
      list.scrollTop = list.scrollHeight;
    }
  }

  /* ------------------------------------------------------------ 操作栏 */

  function optionOf(type) {
    for (var i = 0; i < lastOptions.length; i++) {
      if (lastOptions[i] && lastOptions[i].type === type) return lastOptions[i];
    }
    return null;
  }

  function updateAct(btn, disabled, mainText, subText) {
    if (!btn) return;
    btn.disabled = !!disabled;
    var main = btn.querySelector('.act-main');
    var sub = btn.querySelector('.act-sub');
    if (main) {
      main.textContent = mainText;
      main.className = 'act-main' + (String(mainText).length > 6 ? ' tiny' : '');
    }
    if (sub && subText != null) sub.textContent = subText;
  }

  function updateActionButtons(st) {
    var opts = st.myOptions || [];
    lastOptions = opts;

    var callOpt = null;
    var raiseOpt = null;
    var compareOpt = null;
    var foldOpt = null;
    for (var i = 0; i < opts.length; i++) {
      var o = opts[i];
      if (!o) continue;
      if (o.type === 'call') callOpt = o;
      else if (o.type === 'raise') raiseOpt = o;
      else if (o.type === 'compare') compareOpt = o;
      else if (o.type === 'fold') foldOpt = o;
    }

    var canLook = !!st.canLook;
    var seen = !!st.mySeen;

    updateAct($('act-look'), busy || !canLook,
      seen ? '已看牌' : '看牌',
      seen ? '牌面已开' : '不结束回合');

    updateAct($('act-call'), busy || !callOpt,
      callOpt ? ('跟注 ' + callOpt.cost) : '跟注',
      callOpt ? '下注' : '不可用');

    var raiseSub = '不可用';
    if (raiseOpt && raiseOpt.raises && raiseOpt.raises.length) {
      raiseSub = '到 ' + raiseOpt.raises[raiseOpt.raises.length - 1].to;
    }
    updateAct($('act-raise'), busy || !raiseOpt, '加注', raiseSub);

    updateAct($('act-compare'), busy || !compareOpt,
      compareOpt ? ('比牌 ' + compareOpt.cost) : '比牌',
      compareOpt ? '输者出局' : '不可用');

    updateAct($('act-fold'), busy || !foldOpt, '弃牌', '本局结束');
  }

  function renderBottom(st) {
    var actions = $('action-btns');
    var primary = $('btn-bottom');
    var tipText = '';
    var mid = meId();
    var myTurn = !!(st.turnId && st.turnId === mid);
    var turnPlayer = findPlayer(st, st.turnId);
    var countEl = $('turn-count');
    countEl.hidden = true;

    if (st.phase === 'playing') {
      actions.hidden = false;
      primary.hidden = true;
      actions.className = 'action-btns' + (myTurn ? ' active' : '');

      if (!st.inHand) tipText = '本局未参与，等待下一局';
      else if (st.folded) tipText = '你已弃牌，等待本局结束';
      else if (myTurn) tipText = '轮到你操作';
      else if (turnPlayer) tipText = '等待 ' + turnPlayer.name + ' 操作';
      else tipText = '等待中';
    } else if (st.phase === 'showdown') {
      actions.hidden = true;
      primary.hidden = false;
      primary.disabled = busy;
      primary.textContent = '下一局';
      tipText = '本局结束 · 准备下一局';
    } else {
      actions.hidden = true;
      primary.hidden = false;
      var n = (st.players || []).length;
      var enough = n >= 2;
      primary.disabled = busy || !enough;
      primary.textContent = enough ? '开始游戏' : ('等待玩家（' + n + '/2）');
      tipText = (st.hostId === mid ? '你是房主' : '等待房主开局') + ' · ' + n + ' 人在房间';
    }

    $('turn-text').textContent = tipText;
    updateActionButtons(st);
  }

  /* -------------------------------------------------------------- 倒计时 */

  function startTicker() {
    if (tickTimer) return;
    tickTimer = setInterval(tick, 200);
  }

  function stopTicker() {
    if (tickTimer) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
  }

  function tick() {
    if (!state || currentScreen !== 'table') return;
    var st = state;
    var rem = remainingMs();
    var total = ((st.config && st.config.turnSeconds) || 0) * 1000;
    var showCount = st.phase === 'playing' && st.turnDeadline > 0 && rem != null;

    var countEl = $('turn-count');
    var tip = $('turn-text');

    if (showCount) {
      var sec = Math.max(0, Math.ceil(rem / 1000));
      countEl.textContent = sec + 's';
      countEl.hidden = false;
      if (turnSeatEl) {
        var fill = turnSeatEl.querySelector('.turn-bar i');
        if (fill) {
          var pct = total > 0 ? Math.max(0, Math.min(1, rem / total)) * 100 : 0;
          fill.style.width = pct.toFixed(2) + '%';
        }
        var secNode = turnSeatEl.querySelector('.turn-sec');
        if (secNode) secNode.textContent = sec + 's';
      }
      if (st.turnId && st.turnId === meId()) {
        if (rem <= 5000) tip.classList.add('urgent');
        else tip.classList.remove('urgent');
      } else {
        tip.classList.remove('urgent');
      }
    } else {
      countEl.hidden = true;
      if (tip) tip.classList.remove('urgent');
    }
  }

  /* -------------------------------------------------------------- 动作发送 */

  function setBusy(v) {
    busy = !!v;
    if (state) {
      updateActionButtons(state);
      // 结算/大厅的底部主按钮也要跟着恢复，否则结算状态下点「下一局」会被永久禁用
      var primary = $('btn-bottom');
      if (primary && !primary.hidden) {
        var enough = state.phase !== 'lobby' || (state.players || []).length >= 2;
        primary.disabled = busy || !enough;
      }
    }
  }

  function postAction(action, payload) {
    if (busy || !session) return;
    setBusy(true);
    api('/api/action', {
      roomId: session.roomId,
      playerId: session.playerId,
      token: session.token,
      action: action,
      payload: payload || {}
    }).then(function (res) {
      setBusy(false);
      if (!res || !res.ok) {
        toast((res && res.error) || '操作失败', 'err');
        if (!res || res.netError) scheduleVerify(1500);
        return;
      }
      if (!connected) scheduleVerify(800);
    });
  }

  /**
   * 看牌：服务端 canLook 表示"任何时候都能看"，但 /api/action 的 look 会被
   * "还没轮到你"拦截（engine.act 先判回合）；server.js 提供了不判回合的
   * POST /api/look。这里优先用 /api/look，若服务端没这个接口再退回 action。
   */
  function doLook() {
    if (busy || !session) return;
    var base = {
      roomId: session.roomId,
      playerId: session.playerId,
      token: session.token
    };
    setBusy(true);
    api('/api/look', base).then(function (res) {
      if (res && res.ok) {
        setBusy(false);
        if (!connected) scheduleVerify(800);
        return;
      }
      var msg = (res && res.error) || '';
      if (msg.indexOf('接口不存在') >= 0) {
        api('/api/action', {
          roomId: base.roomId,
          playerId: base.playerId,
          token: base.token,
          action: 'look',
          payload: {}
        }).then(function (res2) {
          setBusy(false);
          if (!res2 || !res2.ok) toast((res2 && res2.error) || '看牌失败', 'err');
        });
        return;
      }
      setBusy(false);
      toast(msg || '看牌失败', 'err');
      if (!res || res.netError) scheduleVerify(1500);
    });
  }

  function doCall() {
    if (!optionOf('call')) { toast('现在不能跟注', 'err'); return; }
    postAction('call', {});
  }

  function doRaise() {
    var opt = optionOf('raise');
    if (!opt || !opt.raises || !opt.raises.length) {
      toast('当前没有可加注的档位', 'err');
      return;
    }
    var raises = opt.raises;
    var html = '<div class="opt-list">';
    for (var i = 0; i < raises.length; i++) {
      html += '<button type="button" class="opt-btn" data-i="' + i + '">' +
        '<span class="opt-main">加注到 ' + esc(raises[i].to) + '</span>' +
        '<span class="opt-cost">需下注 ' + esc(raises[i].cost) + '</span>' +
        '</button>';
    }
    html += '</div><div class="modal-btns">' +
      '<button type="button" class="btn btn-ghost" data-close="1">取消</button></div>';

    var root = showModal(html, { title: '选择加注金额' });
    var btns = root.querySelectorAll('.opt-btn');
    for (var b = 0; b < btns.length; b++) {
      (function (btn) {
        btn.addEventListener('click', function (ev) {
          ev.preventDefault();
          var idx = Number(btn.getAttribute('data-i'));
          var target = raises[idx];
          closeModal();
          if (!target) return;
          postAction('raise', { to: target.to });
        });
      })(btns[b]);
    }
  }

  function doCompare() {
    var opt = optionOf('compare');
    if (!opt || !opt.targets || !opt.targets.length) {
      toast('当前没有可比牌的玩家', 'err');
      return;
    }
    var targets = opt.targets;
    var cost = opt.cost;
    var html = '<div class="opt-list">';
    for (var i = 0; i < targets.length; i++) {
      html += '<button type="button" class="opt-btn" data-i="' + i + '">' +
        '<span class="opt-main">与 ' + esc(targets[i].name) + ' 比牌</span>' +
        '<span class="opt-cost">需下注 ' + esc(cost) + '</span>' +
        '</button>';
    }
    html += '</div><div class="modal-btns">' +
      '<button type="button" class="btn btn-ghost" data-close="1">取消</button></div>';

    var root = showModal(html, { title: '选择比牌对象' });
    var btns = root.querySelectorAll('.opt-btn');
    for (var b = 0; b < btns.length; b++) {
      (function (btn) {
        btn.addEventListener('click', function (ev) {
          ev.preventDefault();
          var idx = Number(btn.getAttribute('data-i'));
          var target = targets[idx];
          closeModal();
          if (!target) return;
          confirmDialog({
            title: '确认比牌',
            message: '与 ' + target.name + ' 比牌，需下注 ' + cost + ' 筹码，输的人直接出局。确定吗？',
            okText: '比牌',
            danger: true
          }).then(function (ok) {
            if (ok) postAction('compare', { target: target.id });
          });
        });
      })(btns[b]);
    }
  }

  function doFold() {
    confirmDialog({
      title: '确认弃牌',
      message: '弃牌后本局已下注不退回，也不能再参与本局。确定弃牌？',
      okText: '弃牌',
      danger: true
    }).then(function (ok) {
      if (ok) postAction('fold', {});
    });
  }

  function doStart() {
    if (!session || busy) return;
    setBusy(true);
    var btn = $('btn-bottom');
    if (btn) btn.disabled = true;
    api('/api/start', {
      roomId: session.roomId,
      playerId: session.playerId,
      token: session.token
    }).then(function (res) {
      setBusy(false);
      if (!res || !res.ok) {
        toast((res && res.error) || '操作失败', 'err');
        if (state) renderBottom(state);
        return;
      }
      if (!connected) scheduleVerify(800);
    });
  }

  function doExit() {
    confirmDialog({
      title: '退出房间',
      message: '退出后本局视为弃牌，累计积分会保留。确定退出？',
      okText: '退出',
      danger: true
    }).then(function (ok) {
      if (!ok) return;
      var s = session;
      closeStream();
      if (s) dropSession(s.roomId);
      session = null;
      state = null;
      busy = false;
      if (s) {
        api('/api/leave', {
          roomId: s.roomId,
          playerId: s.playerId,
          token: s.token
        }).then(function () {
          showHome({ roomId: '', toast: '已退出房间' });
        }, function () {
          showHome({ roomId: '', toast: '已退出房间' });
        });
      } else {
        showHome({});
      }
    });
  }

  /* ---------------------------------------------------------------- 绑定 */

  function bindHome() {
    $('btn-adv').addEventListener('click', toggleAdvanced);
    $('btn-create').addEventListener('click', doCreate);
    $('btn-join').addEventListener('click', doJoin);
    $('btn-resume').addEventListener('click', doResume);

    $('join-room').addEventListener('input', function () {
      var v = digits(this.value).slice(0, 6);
      if (v !== this.value) this.value = v;
      updateResumeBox();
    });

    $('nickname').addEventListener('change', function () {
      var v = String(this.value || '').replace(/\s+/g, ' ').replace(/^ | $/g, '').slice(0, 12);
      this.value = v;
      if (v) lsSet(NICK_KEY, v);
    });

    $('nickname').addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' || ev.keyCode === 13) {
        ev.preventDefault();
        if (digits($('join-room').value).length === 6) doJoin();
        else {
          try { $('join-room').focus(); } catch (e) { /* ignore */ }
        }
      }
    });

    $('join-room').addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' || ev.keyCode === 13) {
        ev.preventDefault();
        doJoin();
      }
    });
  }

  function bindTable() {
    $('btn-room').addEventListener('click', function () {
      var rid = (state && state.roomId) || (session && session.roomId) || '';
      if (!rid) return;
      copyWithFallback(rid, '房号已复制');
    });

    $('btn-invite').addEventListener('click', function () {
      var rid = (state && state.roomId) || (session && session.roomId) || '';
      if (!rid) return;
      copyWithFallback(location.origin + '/?r=' + rid, '邀请链接已复制，发给朋友吧');
    });

    $('btn-exit').addEventListener('click', doExit);
    $('btn-bottom').addEventListener('click', doStart);
    $('btn-save-config').addEventListener('click', saveConfig);

    $('act-look').addEventListener('click', function () {
      if ($('act-look').disabled) return;
      doLook();
    });
    $('act-call').addEventListener('click', function () {
      if ($('act-call').disabled) return;
      doCall();
    });
    $('act-raise').addEventListener('click', function () {
      if ($('act-raise').disabled) return;
      doRaise();
    });
    $('act-compare').addEventListener('click', function () {
      if ($('act-compare').disabled) return;
      doCompare();
    });
    $('act-fold').addEventListener('click', function () {
      if ($('act-fold').disabled) return;
      doFold();
    });

    // 房主改设置时标脏，避免 SSE 刷新覆盖正在输入的内容
    var form = $('config-form');
    var markDirty = function () {
      if (state && state.phase === 'lobby' && session && state.hostId === meId()) configDirty = true;
      $('config-msg').textContent = '未保存';
    };
    form.addEventListener('input', markDirty);
    form.addEventListener('change', markDirty);
  }

  function bindGlobal() {
    document.addEventListener('keydown', function (ev) {
      if ((ev.key === 'Escape' || ev.keyCode === 27) && modalDismiss) {
        var fn = modalDismiss;
        fn();
      }
    });

    window.addEventListener('online', function () {
      if (session && !connected) scheduleVerify(500);
    });

    window.addEventListener('offline', function () {
      if (session) showConn('连接中…（网络已断开）');
    });

    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible' && session && !connected) scheduleVerify(300);
    });
  }

  /* ------------------------------------------------------- 服务连通性 & 口令 */

  // app.js 正常跑起来了，撤掉"页面没加载完整"的兜底横幅
  function clearDeadBanner() {
    var el = $('js-dead');
    if (el) el.hidden = true;
  }

  function checkHealth() {
    fetch('/api/health', { method: 'GET', cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (h) {
        var dead = $('srv-dead');
        if (!h || !h.ok) {
          if (dead) dead.hidden = false;
          return;
        }
        if (dead) dead.hidden = true;
        // 服务器设置了创建口令 → 首页显示口令输入框
        if (h.createPinRequired) showPinField();
      })
      .catch(function () {
        var dead = $('srv-dead');
        if (dead) dead.hidden = false;
      });
  }

  function showPinField() {
    var f = $('pin-field');
    if (f) f.hidden = false;
  }

  function readCreatePin() {
    var f = $('pin-field');
    var el = $('create-pin');
    if (!f || f.hidden || !el) return '';
    return String(el.value || '').replace(/\D/g, '').slice(0, 8);
  }

  /* ---------------------------------------------------------------- 启动 */

  function boot() {
    clearDeadBanner();
    restoreNickname();
    penaltyFactor = (function () {
      var f = Number(lsGet(FACTOR_KEY, '1'));
      return isFinite(f) && f >= 0 ? f : 1;
    })();

    buildConfigForm($('create-adv'), loadCreateConfig(), false);
    bindHome();
    bindTable();
    bindGlobal();

    checkHealth();
    showScreen('home');

    var rid = roomFromUrl();
    if (rid) {
      $('join-room').value = rid;
      $('join-box').classList.add('highlight');
      updateResumeBox();
      var sess = getSession(rid);
      if (sess) {
        resumeRoom(sess, rid);
        return;
      }
      // 没有身份记录：自动进入"加入流程"，房号已预填
      setTimeout(function () {
        try {
          var box = $('join-box');
          if (box.scrollIntoView) box.scrollIntoView({ block: 'center', behavior: 'smooth' });
        } catch (e) { /* ignore */ }
      }, 120);
      return;
    }

    updateResumeBox();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
