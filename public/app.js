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
var AVATAR_KEY = 'zjh.avatar.v1';
var AVATARS = [
  '🐶', '🐱', '🐼', '🦊', '🐯', '🦁', '🐸', '🐵',
  '🐰', '🐨', '🐷', '🐔', '🦄', '🐙', '🦖', '🐳',
  '🎩', '👑', '🦅', '🐺', '🐹', '🐮', '🎯', '🍀'
];
  var SESS_KEY = 'zjh.sessions.v1';
  var FACTOR_KEY = 'zjh.penaltyFactor.v1';
  var CREATE_KEY = 'zjh.createConfig.v1';

  var SUIT_SYMBOL = { S: '\u2660', H: '\u2665', D: '\u2666', C: '\u2663' };
  var RANK_LABEL = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
  var MAX_SESSIONS = 8;

  var CONFIG_FIELDS = [
    { key: 'ante', label: '底分（每人底注）', def: 10, min: 1, max: 10000, step: 1 },
    { key: 'maxStake', label: '单注封顶', def: 100, min: 1, max: 100000, step: 1 },
    { key: 'maxPot', label: '总注封顶', def: 3000, min: 2, max: 10000000, step: 100 },
    { key: 'seeMultiplier', label: '看牌倍数', def: 2, min: 1, max: 4, step: 1 },
    { key: 'turnSeconds', label: '思考秒数', def: 45, min: 0, max: 600, step: 5 },
    { key: 'dealerBid', label: '抢庄模式', type: 'bool', def: false },
    { key: 'bidSeconds', label: '抢庄秒数', def: 10, min: 3, max: 60, step: 1 },
    { key: 'sessionHands', label: '每轮局数(0=不限)', def: 0, min: 0, max: 200, step: 1 },
    { key: 'baoziBonus', label: '豹子奖励(每人)', def: 0, min: 0, max: 10000, step: 10 },
    { key: 'shunjinBonus', label: '顺金奖励(每人)', def: 0, min: 0, max: 10000, step: 10 },
    { key: 'showAllAtEnd', label: '每局结束亮出所有牌', type: 'bool', def: true },
    { key: 'special235', label: '235 通杀', type: 'bool', def: false },
    { key: 'autoNext', label: '自动开下一局', type: 'bool', def: false },
    { key: 'autoNextSeconds', label: '自动开局等待(秒)', def: 8, min: 3, max: 120, step: 1 }
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
  var seatMode = 'normal';       // 座位尺寸档位：normal / compact / mini
  var seatPosMap = {};           // pid -> {x,y}：layoutSeats 输出，供桌面筹码定位
  var seatLayoutTimer = null;    // 尺寸变化后重排座位的防抖计时器
  var dealerBannerTimer = null;  // 定庄提示条淡出计时器
  var lastDealerBannerKey = '';  // 避免重复弹「庄家：xxx」

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
    if (name === 'table') {
      startTicker();
      setTimeout(fitStage, 60);
    } else {
      stopTicker();
    }
    if (name === 'home') startRoomListPolling();
    else stopRoomListPolling();
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

  function isImageAvatar(a) {
    return /^data:image\/(png|jpeg|webp);base64,/.test(String(a || ''));
  }

  function readAvatar() {
    var a = lsGet(AVATAR_KEY, '');
    if (isImageAvatar(a) && a.length <= 26000) return a;
    return AVATARS.indexOf(a) >= 0 ? a : '';
  }

  /** 把头像画到某个元素上：表情用文字，相册图用背景图 */
  function paintAvatar(el, avatar, name, id) {
    if (!el) return;
    if (isImageAvatar(avatar)) {
      el.textContent = '';
      el.style.backgroundImage = 'url("' + avatar + '")';
      el.style.backgroundSize = 'cover';
      el.style.backgroundPosition = 'center';
    } else {
      el.textContent = avatar || initialOf(name);
      el.style.backgroundImage = '';
      el.style.background = avatarBg(name || '', id || '');
    }
  }

  function applyAvatarBtn() {
    var btn = $('btn-avatar');
    if (!btn) return;
    var a = readAvatar();
    if (isImageAvatar(a)) {
      btn.textContent = '';
      btn.style.backgroundImage = 'url("' + a + '")';
      btn.style.backgroundSize = 'cover';
      btn.style.backgroundPosition = 'center';
      btn.classList.add('has');
    } else if (a) {
      btn.textContent = a;
      btn.style.backgroundImage = '';
      btn.classList.add('has');
    } else {
      btn.textContent = '👤';
      btn.style.backgroundImage = '';
      btn.classList.remove('has');
    }
  }

  /** 相册图：压缩成 128×128 JPEG（必要时再降一档），控制在 ~16KB 内 */
  function compressAvatarFile(file, cb) {
    if (!file || !/^image\//.test(file.type)) {
      toast('请选择图片文件', 'err');
      return;
    }
    var reader = new FileReader();
    reader.onload = function () {
      var img = new Image();
      img.onload = function () {
        var tries = [{ size: 128, q: 0.72 }, { size: 96, q: 0.6 }, { size: 80, q: 0.5 }];
        var i = 0;
        (function next() {
          var t = tries[i++];
          var canvas = document.createElement('canvas');
          canvas.width = t.size;
          canvas.height = t.size;
          var ctx = canvas.getContext('2d');
          // cover 裁剪居中
          var s = Math.min(img.width, img.height);
          var sx = (img.width - s) / 2;
          var sy = (img.height - s) / 2;
          ctx.drawImage(img, sx, sy, s, s, 0, 0, t.size, t.size);
          var url = canvas.toDataURL('image/jpeg', t.q);
          if (url.length <= 24000 || i >= tries.length) {
            cb(url);
          } else {
            next();
          }
        })();
      };
      img.onerror = function () { toast('这张图片读不了，换一张试试', 'err'); };
      img.src = String(reader.result || '');
    };
    reader.onerror = function () { toast('读取图片失败', 'err'); };
    reader.readAsDataURL(file);
  }

  /** 头像选择器：表情 + 从手机相册选图 */
  function openAvatarPicker(onPick) {
    var html = '<div class="avatar-preview-row">' +
      '<span class="avatar-preview" id="avatar-preview"></span>' +
      '<button type="button" class="btn btn-primary btn-small" id="btn-avatar-file">📷 从手机相册选图</button>' +
      '</div>' +
      '<div class="avatar-grid">';
    for (var i = 0; i < AVATARS.length; i++) {
      html += '<button type="button" class="avatar-opt" data-av="' + AVATARS[i] + '">' + AVATARS[i] + '</button>';
    }
    html += '</div><input type="file" id="avatar-file-input" accept="image/*" hidden>' +
      '<div class="modal-btns">' +
      '<button type="button" class="btn btn-ghost" data-reset="1">用名字首字</button>' +
      '<button type="button" class="btn btn-ghost" data-close="1">取消</button></div>';
    var root = showModal(html, { title: '选择头像' });

    var preview = root.querySelector('#avatar-preview');
    var paintPreview = function (av) {
      if (!preview) return;
      if (isImageAvatar(av)) {
        preview.textContent = '';
        preview.style.backgroundImage = 'url("' + av + '")';
        preview.style.backgroundSize = 'cover';
        preview.style.backgroundPosition = 'center';
      } else {
        preview.style.backgroundImage = '';
        preview.textContent = av || '👤';
      }
    };
    paintPreview(readAvatar());

    var pick = function (av) {
      lsSet(AVATAR_KEY, av);
      applyAvatarBtn();
      closeModal();
      if (onPick) onPick(av);
      else toast(av ? '头像已选择' : '已改回名字首字头像', 'ok');
    };

    var opts = root.querySelectorAll('.avatar-opt');
    for (var k = 0; k < opts.length; k++) {
      (function (btn) {
        btn.addEventListener('click', function () { pick(btn.getAttribute('data-av')); });
      })(opts[k]);
    }

    var fileBtn = root.querySelector('#btn-avatar-file');
    var fileInput = root.querySelector('#avatar-file-input');
    if (fileBtn && fileInput) {
      fileBtn.addEventListener('click', function () {
        try { fileInput.click(); } catch (e) { /* ignore */ }
      });
      fileInput.addEventListener('change', function () {
        var f = fileInput.files && fileInput.files[0];
        if (!f) return;
        compressAvatarFile(f, function (url) {
          paintPreview(url);
          pick(url);
        });
      });
    }

    var reset = root.querySelector('[data-reset]');
    if (reset) {
      reset.addEventListener('click', function () { pick(''); });
    }
  }

  function restoreNickname() {
    var nick = lsGet(NICK_KEY, '');
    if (nick) $('nickname').value = nick;
    applyAvatarBtn();
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
    musicStop();
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
    lastDealerBannerKey = '';
    seatMode = 'normal';
    if (dealerBannerTimer) {
      clearTimeout(dealerBannerTimer);
      dealerBannerTimer = null;
    }
    var bannerHome = $('dealer-banner');
    if (bannerHome) { bannerHome.hidden = true; bannerHome.className = 'dealer-banner'; }
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
    // 每次回首页都按"我保存过的配置"重填建房表单（房间内保存过的规则也会带出来）
    var advForm = $('create-adv');
    if (advForm) buildConfigForm(advForm, loadCreateConfig(), false);
    startRoomListPolling();
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
    lastDealerBannerKey = '';
    seatMode = 'normal';
    if (dealerBannerTimer) {
      clearTimeout(dealerBannerTimer);
      dealerBannerTimer = null;
    }
    var banner0 = $('dealer-banner');
    if (banner0) { banner0.hidden = true; banner0.className = 'dealer-banner'; }
    showScreen('table');
    showConn('连接中…');
    connected = false;
    updateMusicBtn();
    musicStart();
    openStream();
  }

  /** 观战模式：隐藏自己的操作区，显示观战横幅（由 renderMyArea 读取 state.spectating） */

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
    var sitOut = !!($('create-sitout') && $('create-sitout').checked);
    api('/api/create', { name: name, config: cfg, pin: pin, avatar: readAvatar(), sitOut: sitOut }).then(function (res) {
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
    var pinField = $('join-pin-field');
    var password = pinField && !pinField.hidden
      ? digits($('join-pin').value).slice(0, 8)
      : '';
    busy = true;
    var btn = $('btn-join');
    btn.disabled = true;
    api('/api/join', { roomId: rid, name: name, password: password, avatar: readAvatar() }).then(function (res) {
      busy = false;
      btn.disabled = false;
      if (!res || !res.ok) {
        // 需要密码：展开密码输入框并聚焦
        if (res && res.code === 'ROOM_PASSWORD_REQUIRED') {
          if (pinField) pinField.hidden = false;
          var pe = $('join-pin');
          if (pe) {
            try { pe.scrollIntoView({ block: 'center' }); } catch (e) { /* ignore */ }
            pe.focus();
          }
        }
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

  /** 用户输完房号后探测一下有没有房间密码，有就提前展开输入框 */
  function probeRoomPin() {
    var rid = digits($('join-room').value).slice(0, 6);
    if (rid.length !== 6) return;
    fetch('/api/roomInfo?roomId=' + encodeURIComponent(rid), { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var field = $('join-pin-field');
        if (field && d && d.ok && d.exists && d.hasJoinPin && digits($('join-room').value).slice(0, 6) === rid) {
          field.hidden = false;
        } else if (field) {
          field.hidden = true;
          var inp = $('join-pin');
          if (inp) inp.value = '';
        }
      })
      .catch(function () { /* 探测失败不影响正常加入 */ });
  }

  function saveRoomPin() {
    if (!session || busy) return;
    var input = $('room-pin-input');
    var val = digits(input ? input.value : '').slice(0, 8);
    if (val && (val.length < 4)) {
      toast('密码需 4~8 位数字', 'err');
      return;
    }
    busy = true;
    var btn = $('btn-save-room-pin');
    if (btn) btn.disabled = true;
    api('/api/setRoomPin', {
      roomId: session.roomId,
      playerId: session.playerId,
      token: session.token,
      password: val
    }).then(function (res) {
      busy = false;
      if (btn) btn.disabled = false;
      if (!res || !res.ok) {
        toast((res && res.error) || '保存失败', 'err');
        return;
      }
      if (input) input.value = '';
      toast(val ? '房间密码已设置' : '已取消房间密码', 'ok');
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

    // 房间被关闭（没有真人了 / 人都退出 / 空闲超时）
    src.addEventListener('closed', function (ev) {
      if (src !== es) return;
      var reason = '';
      try { reason = (JSON.parse(ev.data) || {}).reason || ''; } catch (e) { reason = ''; }
      handleSessionInvalid(reason ? '房间已关闭：' + reason : '房间已关闭');
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
    var bidding = st.phase === 'bidding';
    // 抢庄阶段用 bidDeadline，下注阶段用 turnDeadline；都和服务端 serverNow 成对使用
    clock.deadline = Number(bidding ? st.bidDeadline : st.turnDeadline) || 0;
    clock.serverNow = Number(st.serverNow) || Date.now();
    clock.localAt = Date.now();
    clock.bidding = bidding;
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

  /* ------------------------------------------------- 椭圆牌桌：头像与座位定位 */

  /** 筹码短格式：1.2w / 3.4k 之类，避免座位里数字太长 */
  function fmtChips(n) {
    n = Math.round(Number(n) || 0);
    var abs = Math.abs(n);
    if (abs >= 10000) {
      var w = Math.round(n / 1000) / 10;
      return String(w) + 'w';
    }
    return String(n);
  }

  /** 头像取昵称首字；「人机·阿福」这类取 · 后面的字 */
  function initialOf(name) {
    var s = String(name == null ? '' : name);
    var dot = s.indexOf('\u00b7');
    if (dot >= 0 && s.length > dot + 1) s = s.slice(dot + 1);
    var first = s.charAt(0);
    if (first >= '\ud800' && first <= '\udbff') first = s.substr(0, 2);
    return first || '?';
  }

  /** 由名字/ID 派生一个稳定的头像底色（纯 CSS 渐变，无图片） */
  function avatarBg(name, pid) {
    var h = 0;
    var s = String(pid || '') + '|' + String(name || '');
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
    var h2 = (h + 26) % 360;
    return 'linear-gradient(140deg, hsl(' + h + ', 44%, 44%), hsl(' + h2 + ', 50%, 25%))';
  }

  /** 由对手人数决定座位尺寸档位（人数越多越小，保证 375px 不重叠） */
  function seatModeFor(n) {
    if (n <= 8) return 'normal';
    if (n <= 11) return 'compact';
    return 'mini';
  }

  /** 上半椭圆弧的角度跨度（度）：人越多越往两侧压一点，避免挤在顶部 */
  function spanFor(n) {
    if (n <= 2) return 180;
    if (n <= 4) return 200;
    if (n <= 6) return 214;
    if (n <= 8) return 226;
    if (n <= 11) return 234;
    return 244;
  }

  /**
   * 核心定位函数：把除"我"以外的玩家均匀摆到上半椭圆弧（左 → 顶 → 右）。
   * 人数 ≥ 9 时用内外两圈交错（相邻座位半径不同），再跑一遍"碰撞松弛"：
   * 任意两个座位只要矩形相交，就沿穿透较小的方向互相推开，并夹在牌桌区内。
   * 这样 2~15 人、375/320 宽都能保证不重叠。
   */
  function layoutSeats() {
    var stage = $('table-stage');
    var wrap = $('seats');
    if (!stage || !wrap) return;
    var seats = wrap.querySelectorAll('.seat');
    var n = seats.length;
    if (!n) return;

    var W = stage.clientWidth || 0;
    var H = stage.clientHeight || 0;
    if (!W || !H) return;

    var sw = seats[0].offsetWidth || 60;
    var sh = seats[0].offsetHeight || 60;
    var cx = W / 2;
    var cy = H / 2;
    var rx = Math.max(36, W / 2 - sw / 2 - 2);
    var ry = Math.max(26, H / 2 - sh / 2 - 2);

    // 竖版牌桌：对手分列左右两侧（上 → 下），我的区域在底部
    var felt = document.getElementById('table-oval');
    var feltW = felt ? felt.offsetWidth : W * 0.72;
    var leftX = Math.max(sw / 2 + 2, cx - feltW / 2 + sw * 0.16);
    var rightX = Math.min(W - sw / 2 - 2, cx + feltW / 2 - sw * 0.16);
    var topPad = sh / 2 + 6;
    var bottomPad = H - sh / 2 - 6;
    var leftN = Math.ceil(n / 2);
    var rightN = n - leftN;
    var pos = [];
    if (n === 1) {
      pos.push({ x: rightX, y: topPad + (bottomPad - topPad) * 0.32, w: sw, h: sh });
    } else {
      for (var li = 0; li < leftN; li++) {
        var ly = leftN === 1
          ? topPad + (bottomPad - topPad) * 0.5
          : topPad + (bottomPad - topPad) * (li / (leftN - 1));
        pos.push({ x: leftX, y: ly, w: sw, h: sh });
      }
      for (var ri = 0; ri < rightN; ri++) {
        var ry2 = rightN === 1
          ? topPad + (bottomPad - topPad) * 0.5
          : topPad + (bottomPad - topPad) * (ri / (rightN - 1));
        pos.push({ x: rightX, y: ry2, w: sw, h: sh });
      }
    }

    // 台面中央信息区（底池/单注/庄家）：座位不能压住它
    // 只保护「底池」大字所在区域（中央块的透明留白不算）
    var centerEl = document.querySelector('.pot-row') || $('table-center');
    var obs = null;
    if (centerEl) {
      var sRect = stage.getBoundingClientRect();
      var cRect = centerEl.getBoundingClientRect();
      if (cRect.width > 0 && cRect.height > 0) {
        obs = {
          x: cRect.left - sRect.left + cRect.width / 2,
          y: cRect.top - sRect.top + cRect.height / 2,
          w: cRect.width + 4,
          h: cRect.height + 4
        };
      }
    }

    // 碰撞松弛：最多 40 轮，两两矩形相交就推开；再避开中央信息区
    var gap = 2;
    for (var iter = 0; iter < 90; iter++) {
      var moved = false;
      for (var a1 = 0; a1 < pos.length; a1++) {
        for (var b1 = a1 + 1; b1 < pos.length; b1++) {
          var pa = pos[a1];
          var pb = pos[b1];
          var dx = pb.x - pa.x;
          var dy = pb.y - pa.y;
          var needX = (pa.w + pb.w) / 2 + gap - Math.abs(dx);
          var needY = (pa.h + pb.h) / 2 + gap - Math.abs(dy);
          if (needX > 0 && needY > 0) {
            if (needX <= needY) {
              var pushX = needX / 2 + 0.4;
              var sx = dx === 0 ? (a1 % 2 ? 1 : -1) : (dx > 0 ? 1 : -1);
              pa.x -= pushX * sx;
              pb.x += pushX * sx;
            } else {
              var pushY = needY / 2 + 0.4;
              var sy = dy === 0 ? (a1 % 2 ? 1 : -1) : (dy > 0 ? 1 : -1);
              pa.y -= pushY * sy;
              pb.y += pushY * sy;
            }
            moved = true;
          }
        }
      }
      if (obs) {
        for (var oi = 0; oi < pos.length; oi++) {
          var po = pos[oi];
          var odx = po.x - obs.x;
          var ody = po.y - obs.y;
          var needOX = (po.w + obs.w) / 2 + 1 - Math.abs(odx);
          var needOY = (po.h + obs.h) / 2 + 1 - Math.abs(ody);
          if (needOX > 0 && needOY > 0) {
            if (needOX <= needOY) {
              po.x += (needOX + 0.4) * (odx >= 0 ? 1 : -1);
            } else {
              po.y += (needOY + 0.4) * (ody >= 0 ? 1 : -1);
            }
            moved = true;
          }
        }
      }
      // 夹在牌桌区内（座位要完整可见）
      for (var k = 0; k < pos.length; k++) {
        var p = pos[k];
        if (p.x - p.w / 2 < 1) p.x = p.w / 2 + 1;
        if (p.x + p.w / 2 > W - 1) p.x = W - p.w / 2 - 1;
        if (p.y - p.h / 2 < 1) p.y = p.h / 2 + 1;
        if (p.y + p.h / 2 > H - 1) p.y = H - p.h / 2 - 1;
      }
      if (!moved) break;
    }

    for (var m = 0; m < n; m++) {
      seats[m].style.transform =
        'translate(-50%,-50%) translate(' +
        (Math.round(pos[m].x * 10) / 10) + 'px,' + (Math.round(pos[m].y * 10) / 10) + 'px)';
      var pidKey = seats[m].getAttribute('data-pid');
      if (pidKey) seatPosMap[pidKey] = { x: pos[m].x, y: pos[m].y };
    }
    if (state) layoutBetChips(state);
  }

  function scheduleSeatLayout() {
    if (seatLayoutTimer) return;
    seatLayoutTimer = setTimeout(function () {
      seatLayoutTimer = null;
      layoutSeats();
    }, 120);
  }

  /** 定庄后短暂显示「庄家：xxx」，2 秒淡出 */
  function showDealerBanner(name) {
    var el = $('dealer-banner');
    if (!el || !name) return;
    el.textContent = '庄家：' + name;
    el.hidden = false;
    el.className = 'dealer-banner';
    void el.offsetWidth;
    el.className = 'dealer-banner show';
    if (dealerBannerTimer) clearTimeout(dealerBannerTimer);
    dealerBannerTimer = setTimeout(function () {
      el.className = 'dealer-banner';
      dealerBannerTimer = setTimeout(function () {
        el.hidden = true;
      }, 320);
    }, 2000);
  }

  var showcaseTimer = null;

  /** 每局结束：提示所有牌已亮出，牌桌停留展示一会儿 */
  function showShowcaseBanner() {
    var el = $('showcase-banner');
    if (!el) return;
    el.textContent = '本局结束 · 所有人的牌已亮出';
    el.hidden = false;
    el.className = 'showcase-banner';
    void el.offsetWidth;
    el.className = 'showcase-banner show';
    if (showcaseTimer) clearTimeout(showcaseTimer);
    showcaseTimer = setTimeout(function () {
      el.className = 'showcase-banner';
      showcaseTimer = setTimeout(function () { el.hidden = true; }, 320);
    }, 3200);
  }

  /* ------------------------------------------------- 桌面筹码与动作提示 */

  /** 每个下注 > 0 的玩家，在桌面上其座位与台心之间摆放筹码堆 */
  function layoutBetChips(st) {
    var stage = $('table-stage');
    var layer = $('bet-chip-layer');
    if (!stage || !layer || !st) return;
    var players = st.players || [];
    var mid = meId();
    var W = stage.clientWidth || 0;
    var H = stage.clientHeight || 0;
    if (!W || !H) return;

    var wanted = {};
    var slot = 0;
    for (var i = 0; i < players.length; i++) {
      var p = players[i];
      if (!(p.bet > 0)) continue;
      var x, y;
      if (p.id === mid) {
        x = W / 2;
        y = H - 16;
      } else if (seatPosMap[p.id]) {
        x = seatPosMap[p.id].x * 0.68 + W / 2 * 0.32;
        y = seatPosMap[p.id].y * 0.68 + H / 2 * 0.32;
      } else {
        x = W / 2 + (slot % 2 ? 46 : -46);
        y = H / 2;
        slot++;
      }
      wanted[p.id] = { x: Math.round(x), y: Math.round(y), amt: p.bet };
    }

    var nodes = layer.querySelectorAll('.bet-chip');
    for (var j = 0; j < nodes.length; j++) {
      var nid = nodes[j].getAttribute('data-pid');
      if (!wanted[nid]) nodes[j].parentNode.removeChild(nodes[j]);
    }
    for (var key in wanted) {
      if (!Object.prototype.hasOwnProperty.call(wanted, key)) continue;
      var w = wanted[key];
      var el = layer.querySelector('.bet-chip[data-pid="' + key + '"]');
      if (!el) {
        el = document.createElement('div');
        el.className = 'bet-chip';
        el.setAttribute('data-pid', key);
        el.innerHTML = '<i class="chip-ico"></i><b></b>';
        layer.appendChild(el);
      }
      el.style.left = w.x + 'px';
      el.style.top = w.y + 'px';
      var bEl = el.querySelector('b');
      if (bEl) bEl.textContent = fmtChips(w.amt);
    }
  }

  /** 动作气泡：挂在对应座位上方，比聊天气泡更醒目（按动作类型着色） */
  function popActionBubble(pid, cls, text) {
    var seat = document.querySelector('.seat[data-pid="' + pid + '"]');
    var host = seat || $('my-area');
    if (!host) return;
    var old = host.querySelector('.action-pop');
    if (old && old.parentNode) old.parentNode.removeChild(old);

    var b = document.createElement('div');
    b.className = 'action-pop ' + cls;
    b.textContent = text;
    host.appendChild(b);
    void b.offsetWidth;
    b.className += ' show';
    setTimeout(function () {
      b.className = 'action-pop ' + cls + ' hide';
      setTimeout(function () {
        if (b.parentNode) b.parentNode.removeChild(b);
      }, 240);
    }, 2400);
  }

  var lastActionT = -1;

  /** 从日志增量里解析别人的动作，在牌桌上弹提示（跟注/加注/弃牌/比牌/全下） */
  function handleActions(st) {
    var logs = st.logs || [];
    if (lastActionT < 0) {
      // 首次渲染：只记录基线，不回放历史
      lastActionT = logs.length ? logs[logs.length - 1].t : 0;
      return;
    }
    var maxT = lastActionT;
    for (var i = 0; i < logs.length; i++) {
      var L = logs[i];
      if (!L || L.t <= lastActionT) continue;
      if (L.t > maxT) maxT = L.t;
      var text = String(L.text || '');
      var m, pid = null, cls = '', label = '', say = '';
      if ((m = text.match(/^(.{1,12}?) 看牌了/))) {
        pid = pidByName(st, m[1]);
        cls = 'pop-look';
        label = '看牌';
        say = m[1] + ' 已看牌';
      } else if ((m = text.match(/^(.{1,12}?) 跟注 (\d+)/))) {
        pid = pidByName(st, m[1]);
        cls = 'pop-call';
        label = '跟注 ' + m[2];
        say = m[1] + ' 押注 ' + m[2];
      } else if ((m = text.match(/^(.{1,12}?) 加注到 (\d+)（下注 (\d+)）/))) {
        pid = pidByName(st, m[1]);
        cls = 'pop-raise';
        label = '加注到 ' + m[2];
        say = m[1] + ' 押注 ' + m[3];
      } else if ((m = text.match(/^(.{1,12}?) 加注到 (\d+)/))) {
        pid = pidByName(st, m[1]);
        cls = 'pop-raise';
        label = '加注到 ' + m[2];
        say = m[1] + ' 押注 ' + m[2];
      } else if ((m = text.match(/^(.{1,12}?) 孤注一掷/))) {
        pid = pidByName(st, m[1]);
        cls = 'pop-allin';
        label = '孤注一掷';
        say = m[1] + ' 全下';
      } else if ((m = text.match(/^(.{1,12}?) 约 .+? 比牌/))) {
        pid = pidByName(st, m[1]);
        cls = 'pop-compare';
        label = '比牌';
        say = m[1] + ' 比牌';
      } else if ((m = text.match(/^(.{1,12}?) 超时/))) {
        pid = pidByName(st, m[1]);
        cls = 'pop-timeout';
        label = '超时弃牌';
        say = m[1] + ' 超时弃牌';
      } else if ((m = text.match(/^(.{1,12}?) 弃牌/))) {
        pid = pidByName(st, m[1]);
        cls = 'pop-fold';
        label = '弃牌';
        say = m[1] + ' 弃牌';
      }
      if (pid && label) {
        popActionBubble(pid, cls, label);
        // 欢乐斗地主风格音效
        if (cls === 'pop-call') sfx('bet');
        else if (cls === 'pop-raise' || cls === 'pop-allin') sfx('raise');
        else if (cls === 'pop-fold' || cls === 'pop-timeout') sfx('fold');
        else if (cls === 'pop-compare') sfx('compare');
        else if (cls === 'pop-look') sfx('click');
      }
      // 语音播报：XX 已看牌 / XX 押注 20 / XX 弃牌…
      if (say) speakQueued(say);
    }
    lastActionT = maxT;
  }

  function pidByName(st, name) {
    var ps = st.players || [];
    for (var i = 0; i < ps.length; i++) if (ps[i].name === name) return ps[i].id;
    return null;
  }

  /* ------------------------------------------------------- 实时牌局 / 观战 */

  var roomsTimer = null;

  function loadRoomList() {
    var pin = readCreatePin();
    var box = $('rooms-list');
    if (!box) return;
    // 观战权限：只有知道创建口令的自己人能看到牌局列表
    if (!pin) {
      box.innerHTML = '';
      var pLock = document.createElement('p');
      pLock.className = 'tips';
      pLock.textContent = '输入「创建口令」后才能查看牌局列表（避免外人围观）';
      box.appendChild(pLock);
      return;
    }
    var url = '/api/rooms?pin=' + encodeURIComponent(pin);
    fetch(url, { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var empty = $('rooms-empty');
        if (!d || !d.ok) {
          box.innerHTML = '';
          var p = document.createElement('p');
          p.className = 'tips';
          p.textContent = (d && d.code === 'PIN_REQUIRED')
            ? '口令不对，或这台服务器没设置可看列表的口令'
            : ((d && d.error) ? d.error : '暂时读不到房间列表');
          box.appendChild(p);
          return;
        }
        if (empty) empty.hidden = true;
        var rooms = d.rooms || [];
        box.innerHTML = '';
        if (!rooms.length) {
          var p2 = document.createElement('p');
          p2.className = 'tips';
          p2.textContent = '现在没有进行中的牌局。创建一间房，朋友进来就能玩。';
          box.appendChild(p2);
          return;
        }
        for (var i = 0; i < rooms.length; i++) {
          box.appendChild(buildRoomRow(rooms[i]));
        }
      })
      .catch(function () {
        box.innerHTML = '';
        var p3 = document.createElement('p');
        p3.className = 'tips';
        p3.textContent = '连不上服务器';
        box.appendChild(p3);
      });
  }

  function buildRoomRow(r) {
    var row = document.createElement('div');
    row.className = 'room-row';

    var info = document.createElement('div');
    info.className = 'room-info';
    var no = document.createElement('b');
    no.className = 'room-no mono';
    no.textContent = r.roomId;
    info.appendChild(no);

    var meta = document.createElement('span');
    meta.className = 'room-meta';
    var phaseText = r.phase === 'bidding' ? '抢庄中' : (r.phase === 'playing' ? '进行中' : (r.phase === 'showdown' ? '结算中' : '大厅'));
    meta.textContent = r.players + '/' + (r.maxPlayers || 8) + '人 · ' + phaseText +
      (r.phase !== 'lobby' ? ' · 第' + r.handNo + '局 · 底池' + r.pot : '') +
      (r.hasJoinPin ? ' · 有密码' : '');
    info.appendChild(meta);
    row.appendChild(info);

    var actions = document.createElement('div');
    actions.className = 'room-actions';

    var watchBtn = document.createElement('button');
    watchBtn.className = 'btn btn-ghost btn-small';
    watchBtn.type = 'button';
    watchBtn.textContent = '观战';
    watchBtn.addEventListener('click', function () { doWatch(r.roomId); });
    actions.appendChild(watchBtn);

    row.appendChild(actions);
    return row;
  }

  function startRoomListPolling() {
    stopRoomListPolling();
    loadRoomList();
    roomsTimer = setInterval(function () {
      if (currentScreen === 'home') loadRoomList();
    }, 3000);
  }

  function stopRoomListPolling() {
    if (roomsTimer) {
      clearInterval(roomsTimer);
      roomsTimer = null;
    }
  }

  function doWatch(roomId) {
    if (busy) return;
    var pin = readCreatePin();
    if (!pin) {
      toast('需要创建口令才能观战', 'err');
      return;
    }
    var name = String($('nickname').value || '').trim() || '观众';
    var pinField = $('join-pin-field');
    var password = pinField && !pinField.hidden ? digits($('join-pin').value).slice(0, 8) : '';
    busy = true;
    api('/api/watch', { roomId: roomId, name: name, password: password, pin: pin }).then(function (res) {
      busy = false;
      if (!res || !res.ok) {
        if (res && res.code === 'ROOM_PASSWORD_REQUIRED' && pinField) {
          pinField.hidden = false;
          toast('这个房间需要密码，请先输入房间密码', 'err');
        } else {
          toast((res && res.error) || '观战失败', 'err');
        }
        return;
      }
      lsSet(NICK_KEY, name);
      enterRoom({
        roomId: res.roomId,
        playerId: res.playerId,
        token: res.token,
        name: name,
        spectating: true
      });
    });
  }

  /* ------------------------------------ 借分 / 玩家详情 / 比牌亮牌 / 自适应 */

  var lastCompareAt = 0;
  var loanBarSig = '';
  var compareTimer = null;
  var fitTimer = null;

  /** 自适应：按屏幕可用高度设置牌桌高度 */
  function fitStage() {
    var stage = $('table-stage');
    if (!stage) return;
    var topbar = document.querySelector('.topbar');
    var footer = document.querySelector('.bottom-bar');
    var myArea = $('my-area');
    var vh = window.innerHeight || 800;
    var used = (topbar ? topbar.offsetHeight : 0) +
      (footer ? footer.offsetHeight : 0) +
      (myArea ? myArea.offsetHeight : 0);
    var h = Math.max(300, Math.min(vh - used - 8, 720));
    stage.style.height = h + 'px';
    scheduleSeatLayout();
  }

  function scheduleFit() {
    if (fitTimer) clearTimeout(fitTimer);
    fitTimer = setTimeout(function () {
      fitTimer = null;
      fitStage();
    }, 220);
  }

  /** 借分请求条：待处理的借分（我借给别人 / 别人借给我） */
  function renderLoanBar(st) {
    var bar = $('loan-bar');
    if (!bar) return;
    var me = meId();
    var pending = [];
    var loans = st.loans || [];
    for (var i = 0; i < loans.length; i++) {
      var l = loans[i];
      if (l.status === 'pending' && (l.to === me || l.from === me)) pending.push(l);
    }
    var sig = pending.map(function (l) { return l.id; }).join('|');
    if (sig === loanBarSig) return;
    loanBarSig = sig;
    if (!pending.length) {
      bar.hidden = true;
      bar.innerHTML = '';
      return;
    }
    var html = '';
    for (var k = 0; k < pending.length; k++) {
      var p = pending[k];
      if (p.to === me) {
        html += '<div class="loan-item">💰 <b>' + esc(p.fromName) + '</b> 想借 <b>' + esc(p.amount) + '</b> 分给你' +
          ' <button class="btn btn-primary btn-small" data-loan="accept" data-id="' + esc(p.id) + '">同意</button>' +
          ' <button class="btn btn-ghost btn-small" data-loan="decline" data-id="' + esc(p.id) + '">拒绝</button></div>';
      } else {
        html += '<div class="loan-item">⏳ 已向 <b>' + esc(p.toName) + '</b> 借 <b>' + esc(p.amount) + '</b> 分，等对方同意' +
          ' <button class="btn btn-ghost btn-small" data-loan="decline" data-id="' + esc(p.id) + '">撤回</button></div>';
      }
    }
    bar.innerHTML = html;
    bar.hidden = false;
    var btns = bar.querySelectorAll('[data-loan]');
    for (var b = 0; b < btns.length; b++) {
      (function (btn) {
        btn.addEventListener('click', function () {
          btn.disabled = true;
          api('/api/loan', {
            roomId: session.roomId,
            playerId: session.playerId,
            token: session.token,
            op: btn.getAttribute('data-loan'),
            loanId: btn.getAttribute('data-id')
          }).then(function (res) {
            btn.disabled = false;
            if (!res || !res.ok) toast((res && res.error) || '操作失败', 'err');
            else if (btn.getAttribute('data-loan') === 'accept') toast('借分已到账', 'ok');
          });
        });
      })(btns[b]);
    }
  }

  /** 比牌亮牌：比牌双方都能看到彼此的牌 */
  function renderCompare(st) {
    var panel = $('compare-panel');
    if (!panel) return;
    var c = st.myCompare;
    if (!c || c.at === lastCompareAt) return;
    lastCompareAt = c.at;
    var me = meId();
    var mine = c.a === me ? c.aCards : c.bCards;
    var theirs = c.a === me ? c.bCards : c.aCards;
    var otherName = c.a === me ? c.bName : c.aName;
    var iWin = c.winner === me;
    var html = '<div class="cp-title ' + (iWin ? 'win' : 'lose') + '">' +
      (iWin ? '🎉 比牌：你赢了' : '💧 比牌：你输了') + '</div>' +
      '<div class="cp-row"><span class="cp-who">你</span>' + cardListHtml(mine) + '</div>' +
      '<div class="cp-row"><span class="cp-who">' + esc(otherName) + '</span>' + cardListHtml(theirs) + '</div>' +
      '<button id="btn-close-compare" class="btn btn-ghost btn-small" type="button">知道了</button>';
    panel.innerHTML = html;
    panel.hidden = false;
    panel.className = 'compare-panel show';
    var closeBtn = panel.querySelector('#btn-close-compare');
    if (closeBtn) closeBtn.addEventListener('click', function () { panel.hidden = true; });
    if (compareTimer) clearTimeout(compareTimer);
    compareTimer = setTimeout(function () { panel.hidden = true; }, 10000);
  }

  function cardListHtml(cards) {
    var h = '';
    for (var i = 0; i < cards.length; i++) h += miniCardHtml(cards[i]);
    return h;
  }

  /** 点击座位：查看对方筹码 / 净分 / 战绩，并且可以借分 */
  function openPlayerDetail(pid) {
    var st = state;
    if (!st) return;
    var p = findPlayer(st, pid);
    if (!p) return;
    var me = findPlayer(st, meId());
    var ante = (st.config && st.config.ante) || 10;
    var myChips = me ? me.chips : 0;
    var stat = p.stats || { hands: 0, wins: 0, best: 0 };
    var isSelf = meId() === p.id;

    var html = '<div class="pd-head">' + esc(p.name) + '</div>';
    html += '<div class="pd-grid">';
    html += '<span>积分</span><b class="' + (p.net > 0 ? 'pd-pos' : (p.net < 0 ? 'pd-neg' : '')) + '">' + fmtSigned(p.net) + '</b>';
    html += '<span>本局下注</span><b>' + esc(p.bet || 0) + '</b>';
    html += '<span>战绩</span><b>' + esc(stat.hands) + ' 局 / ' + esc(stat.wins) + ' 胜 · 最大赢池 ' + esc(stat.best) + '</b>';
    html += '</div>';

    if (isSelf) {
      html += '<button class="btn btn-ghost" id="pd-avatar" type="button">换头像</button>';
    }
    html += '<div class="modal-btns"><button type="button" class="btn btn-ghost" data-close="1">关闭</button></div>';

    var root = showModal(html, { title: isSelf ? '我的信息' : '玩家信息' });
    var avatarBtn = root.querySelector('#pd-avatar');
    if (avatarBtn) {
      avatarBtn.addEventListener('click', function () {
        closeModal();
        openAvatarPicker(function (av) {
          if (!session) return;
          api('/api/avatar', {
            roomId: session.roomId,
            playerId: session.playerId,
            token: session.token,
            avatar: av
          }).then(function (res) {
            if (!res || !res.ok) toast((res && res.error) || '换头像失败', 'err');
            else toast('头像已更新', 'ok');
          });
        });
      });
    }
    var lendBtn = root.querySelector('#pd-lend');
    if (lendBtn) {
      lendBtn.addEventListener('click', function () {
        closeModal();
        chooseLoanAmount('lend', p.id, p.name);
      });
    }
    var borrowBtn = root.querySelector('#pd-borrow');
    if (borrowBtn) {
      borrowBtn.addEventListener('click', function () {
        closeModal();
        chooseLoanAmount('borrow', p.id, p.name);
      });
    }
  }

  function chooseLoanAmount(direction, otherId, otherName) {
    var opts = [100, 200, 500, 1000];
    var label = direction === 'lend'
      ? ('借给「' + otherName + '」多少分？对方同意后才到账')
      : ('向「' + otherName + '」借多少分？对方同意后才到账');
    var html = '<p class="tips">' + esc(label) + '</p><div class="opt-list">';
    for (var i = 0; i < opts.length; i++) {
      html += '<button type="button" class="opt-btn" data-amt="' + opts[i] + '">' +
        '<span class="opt-main">' + opts[i] + ' 分</span></button>';
    }
    html += '</div><div class="modal-btns"><button type="button" class="btn btn-ghost" data-close="1">取消</button></div>';
    var root = showModal(html, { title: '借分金额' });
    var btns = root.querySelectorAll('.opt-btn');
    for (var k = 0; k < btns.length; k++) {
      (function (btn) {
        btn.addEventListener('click', function () {
          var amt = Number(btn.getAttribute('data-amt'));
          closeModal();
          postLoan(direction, otherId, amt);
        });
      })(btns[k]);
    }
  }

  function postLoan(direction, otherId, amount) {
    var body = {
      roomId: session.roomId,
      playerId: session.playerId,
      token: session.token,
      op: 'propose',
      amount: amount
    };
    if (direction === 'lend') body.to = otherId;
    else body.from = otherId;
    api('/api/loan', body).then(function (res) {
      if (!res || !res.ok) toast((res && res.error) || '借分失败', 'err');
      else toast('已发出借分请求，等对方同意', 'ok');
    });
  }

  /* ------------------------------------------------------------------ 渲染 */

  /* ------------------------------------------------------- 快捷聊天 */

  var lastChatSeq = 0;
  var CHAT_QUICK = ['快点啦~', '哈哈', '稳住，能赢', '不敢跟了', '好牌！', '发牌吧', '走了走了', '再来一局'];

  function handleChat(st) {
    var list = st.chat || [];
    for (var i = 0; i < list.length; i++) {
      var m = list[i];
      if (m.seq > lastChatSeq) {
        lastChatSeq = m.seq;
        showChatBubble(m.id, m.text);
        var who = null;
        for (var k = 0; k < (st.players || []).length; k++) {
          if (st.players[k].id === m.id) { who = st.players[k].name; break; }
        }
        speakChat(who || m.name, m.text, m.id === meId());
      }
    }
    if (st.chatSeq != null && st.chatSeq < lastChatSeq) lastChatSeq = st.chatSeq; // 重连后序列回卷
  }

  function showChatBubble(pid, text) {
    var seat = document.querySelector('.seat[data-pid="' + pid + '"]');
    var host = seat || $('my-area');
    if (!host) return;
    // 移除该座位旧气泡
    var old = host.querySelector('.chat-bubble');
    if (old && old.parentNode) old.parentNode.removeChild(old);

    var b = document.createElement('div');
    b.className = 'chat-bubble';
    b.textContent = text;
    b.title = '点一下再听一次';
    b.addEventListener('click', function () {
      speakText(text, true); // 手动点气泡：强制念一次（不受 900ms 限制）
    });
    host.appendChild(b);
    // 强制重排后加动画类
    void b.offsetWidth;
    b.className += ' show';
    setTimeout(function () {
      b.className = 'chat-bubble hide';
      setTimeout(function () {
        if (b.parentNode) b.parentNode.removeChild(b);
      }, 260);
    }, 2600);
  }

  function openChatDialog() {
    var html = '';
    // 语音播报开关（程序自动念消息，不是录音）
    html += '<div class="voice-row">' +
      '<span class="voice-label">🔈 语音播报：程序自动念出聊天消息</span>' +
      '<button id="chat-voice-toggle" class="btn btn-ghost btn-small" type="button">' +
      (voiceOn ? '已开启' : '已关闭') + '</button>' +
      '</div>';
    html += '<div class="chat-quick">';
    for (var i = 0; i < CHAT_QUICK.length; i++) {
      html += '<button type="button" class="btn btn-ghost chat-q" data-t="' + esc(CHAT_QUICK[i]) + '">' + esc(CHAT_QUICK[i]) + '</button>';
    }
    html += '</div>';
    html += '<div class="chat-input-row">' +
      '<input id="chat-input" class="input" type="text" maxlength="30" placeholder="说点什么（30 字内）" enterkeyhint="send">' +
      '<button id="chat-send" class="btn btn-primary" type="button">发送</button>' +
      '</div>';

    var root = showModal(html, { title: '发言' });
    var voiceBtn = root.querySelector('#chat-voice-toggle');
    if (voiceBtn) {
      voiceBtn.addEventListener('click', function () {
        voiceOn = !voiceOn;
        lsSet(VOICE_KEY, voiceOn ? '1' : '0');
        voiceBtn.textContent = voiceOn ? '已开启' : '已关闭';
        if (voiceOn) {
          if (!voiceSupported()) { toast('这台设备的浏览器不支持语音朗读', 'err'); return; }
          speakText('语音播报已开启', true);
        } else {
          try { window.speechSynthesis.cancel(); } catch (e) { /* ignore */ }
          toast('语音播报已关闭', 'ok');
        }
      });
    }
    var input = root.querySelector('#chat-input');
    var send = function (text) {
      text = String(text || '').trim();
      if (!text) return;
      closeModal();
      sendChat(text);
    };

    var btns = root.querySelectorAll('.chat-q');
    for (var k = 0; k < btns.length; k++) {
      (function (btn) {
        btn.addEventListener('click', function () { send(btn.getAttribute('data-t')); });
      })(btns[k]);
    }
    var sendBtn = root.querySelector('#chat-send');
    if (sendBtn) sendBtn.addEventListener('click', function () { send(input.value); });
    if (input) {
      input.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter') { ev.preventDefault(); send(input.value); }
      });
      setTimeout(function () { try { input.focus(); } catch (e) { /* ignore */ } }, 80);
    }
  }

  function sendChat(text) {
    if (!session) return;
    api('/api/chat', {
      roomId: session.roomId,
      playerId: session.playerId,
      token: session.token,
      text: text
    }).then(function (res) {
      if (!res || !res.ok) toast((res && res.error) || '发送失败', 'err');
    });
  }

  /* ------------------------------------------------------- 轮到你了提醒 */

  var soundOn = (function () {
    try { return lsGet('zjh.sound', '1') === '1'; } catch (e) { return true; }
  })();
  var audioCtx = null;
  var titleFlash = null;
  var lastTurnAlertPid = null;

  function primeAudio() {
    // 浏览器自动播放策略：需要在用户手势里初始化 AudioContext
    if (audioCtx) return;
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (AC) audioCtx = new AC();
    } catch (e) { audioCtx = null; }
  }

  function beep() {
    if (!soundOn) return;
    primeAudio();
    if (!audioCtx) return;
    try {
      if (audioCtx.state === 'suspended') audioCtx.resume();
      var osc = audioCtx.createOscillator();
      var gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.12, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.28);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start();
      osc.stop(audioCtx.currentTime + 0.3);
    } catch (e) { /* ignore */ }
  }

  function startTitleFlash() {
    if (titleFlash) return;
    var baseTitle = document.title;
    var on = false;
    titleFlash = setInterval(function () {
      on = !on;
      document.title = on ? '【轮到你了】' : baseTitle;
    }, 800);
  }

  function stopTitleFlash() {
    if (titleFlash) {
      clearInterval(titleFlash);
      titleFlash = null;
      document.title = document.title.replace(/^【轮到你了】/, '') || document.title;
    }
  }

  function handleTurnAlert(st) {
    var mid = meId();
    var myTurn = !!(st.phase === 'playing' && st.turnId && st.turnId === mid);
    if (myTurn && lastTurnAlertPid !== st.turnId) {
      lastTurnAlertPid = st.turnId;
      beep();
      try { if (navigator.vibrate) navigator.vibrate([80, 60, 80]); } catch (e) { /* ignore */ }
      startTitleFlash();
    } else if (!myTurn && lastTurnAlertPid) {
      lastTurnAlertPid = null;
      stopTitleFlash();
    }
    if (st.phase !== 'playing') stopTitleFlash();
  }

  function updateSoundBtn() {
    var b = $('btn-sound');
    if (b) b.textContent = soundOn ? '🔊' : '🔇';
  }

  /* ------------------------------------------------ 背景音乐（Web Audio 合成） */

  var MUSIC_KEY = 'zjh.music.v1';
  var musicOn = lsGet(MUSIC_KEY, '1') !== '0';
  var mCtx = null;
  var mGain = null;
  var mTimer = null;
  var mNextTime = 0;
  var mStep = 0;
  var M_TEMPO = 112;
  var M_STEP_DUR = 60 / M_TEMPO / 4; // 十六分音符
  var M_TOTAL = 64;                  // 4 小节 × 16 步
  var M_KICK = null;
  var M_HAT = null;

  // 和弦（每小节一个）：Am - F - C - G，五声音阶旋律
  var M_CHORDS = [
    { bass: 45, pad: [57, 60, 64] }, // Am
    { bass: 41, pad: [53, 57, 60] }, // F
    { bass: 48, pad: [55, 60, 64] }, // C
    { bass: 43, pad: [50, 55, 59] }  // G
  ];
  var M_MELODY = [
    // Am
    69, null, 72, null, 76, null, 74, null, 72, null, 69, null, null, null, null, null,
    // F
    69, null, 72, null, 77, null, 76, null, 72, null, 69, null, null, null, null, null,
    // C
    72, null, 76, null, 79, null, 76, null, 74, null, 72, null, null, null, null, null,
    // G
    74, null, 71, null, 74, null, 79, null, 76, null, 74, null, null, null, null, null
  ];

  function mNoteFreq(midi) {
    return 440 * Math.pow(2, (midi - 69) / 12);
  }

  function ensureMusicCtx() {
    if (mCtx) return true;
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      mCtx = new AC();
      mGain = mCtx.createGain();
      mGain.gain.value = 0.0001;
      mGain.connect(mCtx.destination);
      // 软一点的总音色
      var lp = mCtx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 3200;
      mGain.disconnect();
      mGain.connect(lp);
      lp.connect(mCtx.destination);
      // 预生成噪声（hihat 用）
      var len = Math.floor(mCtx.sampleRate * 0.06);
      var buf = mCtx.createBuffer(1, len, mCtx.sampleRate);
      var data = buf.getChannelData(0);
      for (var i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
      M_HAT = buf;
      M_KICK = true;
    } catch (e) {
      mCtx = null;
      return false;
    }
    return true;
  }

  function mTone(t, midi, gainVal, dur, type) {
    try {
      var osc = mCtx.createOscillator();
      var g = mCtx.createGain();
      osc.type = type || 'triangle';
      osc.frequency.value = mNoteFreq(midi);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(gainVal, t + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      osc.connect(g);
      g.connect(mGain);
      osc.start(t);
      osc.stop(t + dur + 0.02);
    } catch (e) { /* ignore */ }
  }

  function mPad(t, notes) {
    for (var i = 0; i < notes.length; i++) {
      (function (midi) {
        try {
          var osc = mCtx.createOscillator();
          var g = mCtx.createGain();
          osc.type = 'sine';
          osc.frequency.value = mNoteFreq(midi);
          g.gain.setValueAtTime(0.0001, t);
          g.gain.linearRampToValueAtTime(0.022, t + 0.5);
          g.gain.exponentialRampToValueAtTime(0.0001, t + 2.4);
          osc.connect(g);
          g.connect(mGain);
          osc.start(t);
          osc.stop(t + 2.5);
        } catch (e) { /* ignore */ }
      })(notes[i] + 12);
    }
  }

  function mKick(t) {
    try {
      var osc = mCtx.createOscillator();
      var g = mCtx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(120, t);
      osc.frequency.exponentialRampToValueAtTime(48, t + 0.16);
      g.gain.setValueAtTime(0.085, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
      osc.connect(g);
      g.connect(mGain);
      osc.start(t);
      osc.stop(t + 0.22);
    } catch (e) { /* ignore */ }
  }

  function mHat(t) {
    if (!M_HAT) return;
    try {
      var src = mCtx.createBufferSource();
      src.buffer = M_HAT;
      var hp = mCtx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 6500;
      var g = mCtx.createGain();
      g.gain.setValueAtTime(0.014, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
      src.connect(hp);
      hp.connect(g);
      g.connect(mGain);
      src.start(t);
    } catch (e) { /* ignore */ }
  }

  /** 调度一步（16 分音符）：和弦垫底 + 拨弦旋律 + 轻打击 */
  function mScheduleStep(step, t) {
    var bar = Math.floor(step / 16) % 4;
    var inBar = step % 16;
    var chord = M_CHORDS[bar];
    // 每拍底鼓（欢乐斗地主那种“咚 咚 咚咚”的节奏）
    if (inBar % 4 === 0) {
      mKick(t);
    }
    if (inBar === 0) {
      mPad(t, chord.pad);
      mTone(t, chord.bass, 0.05, 1.2, 'sine');
    }
    if (inBar === 8) {
      mTone(t, chord.bass - 12, 0.035, 0.8, 'sine');
    }
    // 八分音符沙锤
    if (inBar % 2 === 1) mHat(t);
    // 反拍加个轻巧的“嗒”
    if (inBar === 4 || inBar === 12) mHat(t);
    var note = M_MELODY[step];
    if (note != null) mTone(t, note, 0.045, 0.35, 'triangle');
  }

  function mScheduleLoop() {
    if (!mCtx) return;
    var ahead = mCtx.currentTime + 0.35;
    while (mNextTime < ahead) {
      mScheduleStep(mStep, mNextTime);
      mStep = (mStep + 1) % M_TOTAL;
      mNextTime += M_STEP_DUR;
    }
  }

  function musicStart() {
    if (!musicOn) return;
    if (!ensureMusicCtx()) return;
    try {
      if (mCtx.state === 'suspended') mCtx.resume();
      if (mGain) {
        mGain.gain.cancelScheduledValues(mCtx.currentTime);
        mGain.gain.setValueAtTime(Math.max(0.0001, mGain.gain.value), mCtx.currentTime);
        mGain.gain.linearRampToValueAtTime(0.1, mCtx.currentTime + 1.4);
      }
      if (!mTimer) {
        mNextTime = mCtx.currentTime + 0.08;
        mTimer = setInterval(mScheduleLoop, 90);
        mScheduleLoop();
      }
    } catch (e) { /* ignore */ }
  }

  function musicStop() {
    if (mTimer) {
      clearInterval(mTimer);
      mTimer = null;
    }
    if (mCtx && mGain) {
      try {
        mGain.gain.cancelScheduledValues(mCtx.currentTime);
        mGain.gain.setValueAtTime(mGain.gain.value, mCtx.currentTime);
        mGain.gain.linearRampToValueAtTime(0.0001, mCtx.currentTime + 0.5);
      } catch (e) { /* ignore */ }
    }
  }

  function updateMusicBtn() {
    var b = $('btn-music');
    if (b) {
      b.textContent = musicOn ? '🎵' : '🔇';
      b.style.opacity = musicOn ? '1' : '.55';
    }
  }

  function toggleMusic() {
    musicOn = !musicOn;
    lsSet(MUSIC_KEY, musicOn ? '1' : '0');
    updateMusicBtn();
    if (musicOn) {
      if (currentScreen === 'table') musicStart();
      else musicStart();
    } else {
      musicStop();
    }
    toast(musicOn ? '背景音乐已开启' : '背景音乐已关闭', 'ok');
  }

  // 调试/验收用：查看音乐状态（不影响功能）
  /* ------------------------------------------ 音效（欢乐斗地主风格） */

  var sfxCtx2 = null;
  var sfxGain2 = null;
  var sfxHatBuf = null;

  function sfxInit() {
    if (sfxCtx2) return true;
    if (!soundOn) return false;
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      sfxCtx2 = new AC();
      sfxGain2 = sfxCtx2.createGain();
      sfxGain2.gain.value = 0.3;
      sfxGain2.connect(sfxCtx2.destination);
      var len = Math.floor(sfxCtx2.sampleRate * 0.08);
      var buf = sfxCtx2.createBuffer(1, len, sfxCtx2.sampleRate);
      var d = buf.getChannelData(0);
      for (var i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
      sfxHatBuf = buf;
    } catch (e) {
      sfxCtx2 = null;
      return false;
    }
    return true;
  }

  function sfxTone(freq, dur, type, vol, when) {
    if (!sfxInit()) return;
    try {
      if (sfxCtx2.state === 'suspended') sfxCtx2.resume();
      var t = (when || 0) + sfxCtx2.currentTime;
      var o = sfxCtx2.createOscillator();
      var g = sfxCtx2.createGain();
      o.type = type || 'triangle';
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol, t + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g);
      g.connect(sfxGain2);
      o.start(t);
      o.stop(t + dur + 0.03);
    } catch (e) { /* ignore */ }
  }

  function sfxNoise(dur, vol, highpass) {
    if (!sfxInit() || !sfxHatBuf) return;
    try {
      if (sfxCtx2.state === 'suspended') sfxCtx2.resume();
      var src = sfxCtx2.createBufferSource();
      src.buffer = sfxHatBuf;
      var f = sfxCtx2.createBiquadFilter();
      f.type = highpass ? 'highpass' : 'bandpass';
      f.frequency.value = highpass ? 2800 : 900;
      var g = sfxCtx2.createGain();
      var t = sfxCtx2.currentTime;
      g.gain.setValueAtTime(vol, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      src.connect(f);
      f.connect(g);
      g.connect(sfxGain2);
      src.start(t);
    } catch (e) { /* ignore */ }
  }

  /** 音效总入口：click/deal/bet/raise/fold/compare/turn/win/lose */
  function sfx(name) {
    if (!soundOn) return;
    if (!sfxInit()) return;
    try {
      switch (name) {
        case 'click':
          sfxTone(1150, 0.045, 'square', 0.05);
          break;
        case 'deal':
          sfxTone(520, 0.06, 'triangle', 0.11, 0);
          sfxTone(660, 0.06, 'triangle', 0.11, 0.06);
          sfxTone(820, 0.07, 'triangle', 0.11, 0.12);
          break;
        case 'bet':
          sfxNoise(0.05, 0.12);
          sfxTone(900, 0.05, 'square', 0.05, 0.02);
          break;
        case 'raise':
          sfxNoise(0.05, 0.12);
          sfxTone(700, 0.06, 'square', 0.06, 0.02);
          sfxTone(1050, 0.07, 'square', 0.06, 0.08);
          break;
        case 'fold':
          sfxNoise(0.12, 0.1, true);
          sfxTone(320, 0.12, 'sine', 0.07);
          break;
        case 'compare':
          sfxTone(180, 0.16, 'sine', 0.16);
          sfxNoise(0.08, 0.14);
          sfxTone(1000, 0.05, 'square', 0.06, 0.05);
          break;
        case 'turn':
          sfxTone(880, 0.1, 'square', 0.06);
          sfxTone(1320, 0.12, 'square', 0.05, 0.1);
          break;
        case 'win':
          sfxTone(523, 0.13, 'triangle', 0.13, 0);
          sfxTone(659, 0.13, 'triangle', 0.13, 0.1);
          sfxTone(784, 0.13, 'triangle', 0.13, 0.2);
          sfxTone(1047, 0.18, 'triangle', 0.14, 0.3);
          break;
        case 'lose':
          sfxTone(392, 0.15, 'sine', 0.1, 0);
          sfxTone(330, 0.15, 'sine', 0.1, 0.1);
          sfxTone(262, 0.2, 'sine', 0.1, 0.2);
          break;
        default:
          break;
      }
    } catch (e) { /* ignore */ }
  }

  window.__zjhMusic = function () {
    return {
      on: musicOn,
      hasCtx: !!mCtx,
      ctxState: mCtx ? mCtx.state : 'none',
      scheduling: !!mTimer,
      step: mStep
    };
  };

  /* ------------------------------------------------ 聊天语音播报（程序 TTS） */

  var VOICE_KEY = 'zjh.voice.v1';
  var voiceOn = lsGet(VOICE_KEY, '1') !== '0';
  var voiceLastAt = 0;
  var voiceZh = null;
  var voicePrimed = false;

  function voicePick() {
    try {
      var vs = window.speechSynthesis ? window.speechSynthesis.getVoices() : [];
      for (var i = 0; i < vs.length; i++) {
        if (/^zh/i.test(vs[i].lang || '')) return vs[i];
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  function voiceSupported() {
    return !!(window.speechSynthesis && window.SpeechSynthesisUtterance);
  }

  /** 用系统 TTS 念一句话（程序音色，不是录音） */
  /* 语音队列：多人连续操作时排队播报，不互相打断 */
  var speechQueue = [];
  var speechSpeaking = false;
  var speechLog = [];

  function speechDrain() {
    if (speechSpeaking || !speechQueue.length || !voiceSupported()) return;
    var t = speechQueue.shift();
    try {
      speechSpeaking = true;
      var u = new window.SpeechSynthesisUtterance(t);
      u.lang = 'zh-CN';
      u.rate = 1.12;
      u.pitch = 1.05;
      u.volume = 0.95;
      if (!voiceZh) voiceZh = voicePick();
      if (voiceZh) u.voice = voiceZh;
      u.onend = function () { speechSpeaking = false; setTimeout(speechDrain, 40); };
      u.onerror = function () { speechSpeaking = false; setTimeout(speechDrain, 40); };
      window.speechSynthesis.speak(u);
      window.__zjhVoice = {
        on: voiceOn,
        last: t,
        at: Date.now(),
        supported: true,
        voices: (window.speechSynthesis.getVoices() || []).length
      };
      speechLog.push(t);
      if (speechLog.length > 12) speechLog.shift();
    } catch (e) {
      speechSpeaking = false;
    }
  }

  /** 排队念一句（游戏动作公告用） */
  function speakQueued(text) {
    if (!voiceOn || !voiceSupported()) return false;
    if (typeof document !== 'undefined' && document.hidden) return false;
    var t = String(text || '').trim();
    if (!t) return false;
    if (speechQueue.length >= 5) speechQueue.shift(); // 丢弃最旧的，避免积压
    speechQueue.push(t.slice(0, 40));
    speechDrain();
    return true;
  }

  function speakText(text, force) {
    if (!voiceSupported()) return false;
    if (!voiceOn && !force) return false;
    if (typeof document !== 'undefined' && document.hidden) return false;
    var t = String(text || '').trim();
    if (!t) return false;
    if (force) {
      // 点气泡重听：立刻打断当前朗读
      try {
        window.speechSynthesis.cancel();
        speechSpeaking = false;
        speechQueue = [];
      } catch (e) { /* ignore */ }
      voiceLastAt = Date.now();
      try {
        var u = new window.SpeechSynthesisUtterance(t.slice(0, 40));
        u.lang = 'zh-CN';
        u.rate = 1.12;
        u.pitch = 1.05;
        u.volume = 0.95;
        if (!voiceZh) voiceZh = voicePick();
        if (voiceZh) u.voice = voiceZh;
        window.speechSynthesis.speak(u);
        window.__zjhVoice = { on: voiceOn, last: t, at: Date.now(), supported: true, voices: (window.speechSynthesis.getVoices() || []).length };
        return true;
      } catch (e) {
        return false;
      }
    }
    return speakQueued(t);
  }

  function speakChat(name, text, isMe) {
    if (!voiceOn) return;
    var t = String(text || '').trim();
    if (!t) return;
    speakText(isMe ? t : (name ? name + '说：' + t : t));
  }

  window.__zjhVoiceState = function () {
    return {
      on: voiceOn,
      supported: voiceSupported(),
      voices: (window.speechSynthesis ? (window.speechSynthesis.getVoices() || []).length : 0),
      last: (window.__zjhVoice || {}).last || '',
      log: speechLog.slice(-10),
      speaking: !!(window.speechSynthesis && window.speechSynthesis.speaking)
    };
  };

  function render(st) {
    var prevPhase = lastPhase;
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
    renderBots(st);

    if (st.phase === 'showdown') renderResult(st);
    else hideResult();

    renderSeats(st);
    renderMyArea(st);
    renderLogs(st);
    renderBottom(st);
    renderLoanBar(st);
    renderCompare(st);
    handleChat(st);
    handleActions(st);
    handleTurnAlert(st);
    scheduleFit();
    tick();

    // 抢庄刚结束、进入下注阶段：台面中央闪一下「庄家：xxx」
    if (st.phase === 'playing' && prevPhase === 'bidding' && st.dealerId) {
      var dealerPlayer = findPlayer(st, st.dealerId);
      var bannerKey = String(st.handNo || '') + '|' + st.dealerId + '|' + (st.updatedAt || '');
      if (dealerPlayer && bannerKey !== lastDealerBannerKey) {
        lastDealerBannerKey = bannerKey;
        showDealerBanner(dealerPlayer.name);
      }
    }

    // 每局结束：亮牌提示 + 牌桌停留展示
    if (st.phase === 'showdown' && prevPhase !== 'showdown') {
      if (st.config && st.config.showAllAtEnd) showShowcaseBanner();
    }

    if (phaseChanged) {
      // 音效：发牌 / 赢 / 输（欢乐斗地主风格）
      if (!st.spectating) {
        if (st.phase === 'showdown' && prevPhase !== 'showdown') {
          var iWonFx = ((st.lastResult && st.lastResult.winners) || []).some(function (w) { return w.id === meId(); });
          sfx(iWonFx ? 'win' : 'lose');
        } else if ((st.phase === 'playing' || st.phase === 'bidding') && (prevPhase === 'lobby' || prevPhase === 'showdown')) {
          sfx('deal');
        }
      }
      try {
        if (st.phase === 'showdown') {
          // 开启「每局结束亮出所有牌」时，停留在牌桌看大家亮牌；否则滚到结算面板
          if (st.config && st.config.showAllAtEnd) {
            var stage = $('table-stage');
            if (stage && stage.scrollIntoView) {
              try { stage.scrollIntoView({ block: 'start', behavior: 'smooth' }); } catch (e) { /* ignore */ }
            }
          } else {
            var resultPanel = $('panel-result');
            if (resultPanel && resultPanel.scrollIntoView) {
              resultPanel.scrollIntoView({ block: 'start' });
            }
          }
        } else {
          var main = $('table-main');
          if (main) main.scrollTop = 0;
        }
      } catch (e) { /* ignore */ }
    }
    // 座位尺寸/档位切换后布局可能还没稳定，下一帧再校准一次
    scheduleSeatLayout();
  }

  function renderHeader(st) {
    var players = st.players || [];
    var online = 0;
    for (var i = 0; i < players.length; i++) if (players[i].connected) online++;
    var maxPlayers = st.maxPlayers || 8;

    $('room-id').textContent = st.roomId || (session && session.roomId) || '------';
    $('online-text').textContent = online + '/' + maxPlayers + ' 在线';

    var phaseText = st.phase === 'lobby'
      ? '大厅'
      : st.phase === 'bidding'
        ? '抢庄'
        : st.phase === 'showdown' ? '结算' : '进行中';
    var tag = $('phase-tag');
    tag.textContent = phaseText;
    tag.className = 'phase-tag ' + (st.phase || '');

    // 台面中央：底池/单注/局数/庄家头像
    $('center-phase').textContent = st.phase === 'lobby'
      ? '等待开局 · ' + players.length + '/' + maxPlayers
      : st.phase === 'bidding'
        ? '抢庄中'
        : st.phase === 'showdown' ? '本局结束' : '下注中';

    // 结算阶段服务端已把 pot 清零，顶栏/台面显示本局最终底池
    var potShow = st.pot;
    if (st.phase === 'showdown' && st.lastResult && st.lastResult.pot != null) potShow = st.lastResult.pot;
    $('stat-pot').textContent = String(potShow != null ? potShow : 0);
    $('stat-stake').textContent = String(st.stake != null ? st.stake : 0);
    var sessionTarget = (st.config && st.config.sessionHands) || 0;
    $('stat-hand').textContent = sessionTarget > 0
      ? String(st.handNo || 0) + '/' + sessionTarget
      : String(st.handNo || 0);

    var dealer = null;
    for (var j = 0; j < players.length; j++) {
      if (players[j].isDealer) { dealer = players[j]; break; }
    }
    $('stat-dealer').textContent = dealer ? dealer.name : '—';
    var dealerAvatar = $('dealer-avatar');
    if (dealerAvatar) {
      dealerAvatar.hidden = !dealer;
      if (dealer) $('dealer-initial').textContent = initialOf(dealer.name);
    }
    var dealerRow = document.querySelector('.center-dealer');
    if (dealerRow) dealerRow.hidden = !dealer && (st.phase === 'lobby' || st.phase === 'bidding');

    // 台面边缘呼吸光：下注阶段跟着当前回合；抢庄阶段是蓝色脉冲
    var oval = $('table-oval');
    if (oval) {
      var ovalCls = 'table-oval';
      if (st.phase === 'playing' && st.turnId) ovalCls += ' turn-glow';
      else if (st.phase === 'bidding') ovalCls += ' bidding-glow';
      oval.className = ovalCls;
    }

    // 抢庄倒计时条
    var bidding = st.phase === 'bidding';
    var bidStrip = $('bid-strip');
    if (bidStrip) {
      bidStrip.hidden = !bidding;
      if (bidding) {
        var remBid = remainingMs();
        $('bid-count').textContent = String(remBid == null ? 0 : Math.max(0, Math.ceil(remBid / 1000)));
      }
    }
  }

  function seatBadges(p, st) {
    var list = [];
    if (p.isDealer) list.push({ cls: 'dealer', text: '庄' });
    if (p.isBot) list.push({ cls: 'bot', text: '人机' });
    if (p.isHost) list.push({ cls: 'host', text: '房主' });

    // 出牌顺序位次（从当前行动者开始算；顺序变化会自动重排）
    if (st.phase === 'playing') {
      var order = st.turnOrder || [];
      var oi = order.indexOf(p.id);
      if (oi >= 0) list.push({ cls: 'ord', text: String(oi + 1) });
    }
    // 选择本局观战（不参与）的玩家
    if (p.sitOut) list.push({ cls: 'sitout', text: '观战' });

    // 抢庄阶段：先显示每个人实时选择（抢xN 蓝色 / 不抢 灰色 / 待选）
    if (st.phase === 'bidding') {
      if (p.bid == null) list.push({ cls: 'waiting', text: '待选' });
      else if (p.bid === 0) list.push({ cls: 'pass', text: '不抢' });
      else list.push({ cls: 'grab', text: '抢庄' });
    }

    if (st.phase === 'lobby') {
      list.push({ cls: 'waiting', text: '等待中' });
    } else if (st.phase === 'showdown') {
      if (p.folded) list.push({ cls: 'folded', text: '已弃牌' });
      else if (p.allIn) list.push({ cls: 'allin', text: '全下' });
      else if (p.inHand) list.push({ cls: 'show', text: '开牌' });
      else list.push({ cls: 'waiting', text: '等待中' });
    } else if (p.folded) {
      list.push({ cls: 'folded', text: '已弃牌' });
    } else if (p.allIn) {
      list.push({ cls: 'allin', text: '全下' });
    } else if (!p.inHand) {
      list.push({ cls: 'waiting', text: '等待中' });
    } else if (p.seen) {
      list.push({ cls: 'seen', text: '已看牌' });
    } else {
      list.push({ cls: 'meng', text: '闷牌' });
    }

    if (!p.connected && !p.isBot) list.push({ cls: 'offline', text: '离线' });
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

  /** 对手座位：头像圈 + 昵称 + 筹码/本局 + 状态徽标，由 layoutSeats 摆到椭圆弧上 */
  function renderSeats(st) {
    var wrap = $('seats');
    wrap.innerHTML = '';
    turnSeatEl = null;

    var players = st.players || [];
    var mid = meId();
    var opps = [];
    for (var i = 0; i < players.length; i++) {
      if (players[i].id !== mid) opps.push(players[i]);
    }

    var n = opps.length;
    seatMode = seatModeFor(n);
    wrap.className = 'seats mode-' + seatMode;

    for (var k = 0; k < n; k++) {
      var p = opps[k];
      var seat = document.createElement('div');
      var cls = 'seat';
      if (p.isTurn) { cls += ' turn'; turnSeatEl = seat; }
      if (p.folded) cls += ' folded';
      if (p.allIn) cls += ' allin';
      if (!p.connected && !p.isBot) cls += ' offline';
      if (p.isDealer) cls += ' dealer-seat';
      if (st.phase === 'playing' && !p.inHand) cls += ' idle';
      if (st.phase === 'bidding' && p.bid == null) cls += ' undecided';
      seat.className = cls;
      seat.setAttribute('data-pid', p.id);

      // 头像圈（首字 + 纯 CSS 渐变），轮到时外面套一圈倒计时进度弧
      var av = document.createElement('div');
      av.className = 'seat-avatar';
      var ring = document.createElement('i');
      ring.className = 'turn-ring';
      av.appendChild(ring);
      var face = document.createElement('span');
      face.className = 'avatar-face';
      paintAvatar(face, p.avatar, p.name, p.id);
      av.appendChild(face);
      var sec = document.createElement('i');
      sec.className = 'seat-sec';
      sec.textContent = '…';
      av.appendChild(sec);
      seat.appendChild(av);

      // 昵称
      var nameEl = document.createElement('div');
      nameEl.className = 'seat-name';
      nameEl.textContent = p.name || '玩家';
      seat.appendChild(nameEl);

      // 筹码 + 本局下注
      var nums = document.createElement('div');
      nums.className = 'seat-nums';
      var chipsEl = document.createElement('span');
      chipsEl.className = 'chips net ' + (p.net > 0 ? 'pos' : (p.net < 0 ? 'neg' : ''));
      chipsEl.textContent = fmtSigned(p.net);
      nums.appendChild(chipsEl);
      if (st.phase !== 'lobby') {
        var betEl = document.createElement('span');
        betEl.className = 'bet';
        betEl.textContent = '·' + fmtChips(p.bet || 0);
        nums.appendChild(betEl);
      }
      seat.appendChild(nums);

      // 状态徽标
      var badges = document.createElement('div');
      badges.className = 'seat-badges';
      var badgeList = seatBadges(p, st);
      for (var b = 0; b < badgeList.length; b++) {
        var bi = document.createElement('span');
        bi.className = 'badge ' + badgeList[b].cls;
        bi.textContent = badgeList[b].text;
        badges.appendChild(bi);
      }
      seat.appendChild(badges);

      // 结算阶段：把每个人的牌亮在座位上（停留展示）
      if (st.phase === 'showdown' && p.cards && p.cards.length === 3) {
        var sc = document.createElement('div');
        sc.className = 'seat-cards';
        for (var ci = 0; ci < p.cards.length; ci++) {
          sc.innerHTML += miniCardHtml(p.cards[ci]);
        }
        seat.appendChild(sc);
      }

      // 点击座位：查看对方信息 / 借分
      (function (pid) {
        seat.addEventListener('click', function () { openPlayerDetail(pid); });
      })(p.id);

      wrap.appendChild(seat);
    }

    // 立即测量并定位（座位数变化时尤其重要）
    layoutSeats();
  }

  function renderMyArea(st) {
    var inLobby = st.phase === 'lobby';
    var me = findPlayer(st, meId());

    // 观战模式：隐藏「我的牌区」，显示观战横幅
    var banner = $('spectator-banner');
    if (st.spectating) {
      if (banner) {
        banner.hidden = false;
        var sc = $('spectator-count');
        if (sc) sc.textContent = String(st.spectatorCount || 1);
      }
      var myArea = $('my-area');
      if (myArea) myArea.classList.add('spectating');
      return;
    }
    if (banner) banner.hidden = true;
    var myAreaEl = $('my-area');
    if (myAreaEl) myAreaEl.classList.remove('spectating');

    // 我的座位信息（始终显示；大厅也显示，方便看自己筹码）
    if (me) {
      $('my-name').textContent = me.name || '我';
      paintAvatar($('my-avatar-face'), st.myAvatar, me.name, me.id);
      var myChipsEl = $('my-chips');
      if (myChipsEl) {
        myChipsEl.textContent = fmtSigned(me.net);
        myChipsEl.className = 'my-net ' + (me.net > 0 ? 'pos' : (me.net < 0 ? 'neg' : 'zero'));
      }
      $('my-bet').textContent = fmtChips(me.bet || 0);
      var myNet = $('my-net');
      myNet.textContent = fmtSigned(me.net);
      myNet.className = 'my-net ' + (me.net > 0 ? 'pos' : (me.net < 0 ? 'neg' : 'zero'));

      var myBadges = $('my-badges');
      myBadges.innerHTML = '';
      var mb = seatBadges(me, st);
      for (var i = 0; i < mb.length; i++) {
        var bi = document.createElement('span');
        bi.className = 'badge ' + mb[i].cls;
        bi.textContent = mb[i].text;
        myBadges.appendChild(bi);
      }

      var myTurn = !!(st.phase === 'playing' && st.turnId === me.id);
      var orderEl = $('my-order');
      if (orderEl) {
        if (st.phase === 'playing' && st.myTurnIndex >= 0) {
          var total = (st.turnOrder || []).length || 0;
          orderEl.textContent = (st.myTurnIndex + 1) + (total > 1 ? '/' + total : '');
          orderEl.className = 'my-order' + (myTurn ? ' now' : '');
        } else {
          orderEl.textContent = '-';
          orderEl.className = 'my-order';
        }
      }
      $('my-seat').className = 'my-seat' +
        (myTurn ? ' turn' : '') +
        (me.isDealer && st.phase !== 'lobby' ? ' dealer' : '') +
        (me.folded ? ' folded' : '') +
        (me.allIn ? ' allin' : '') +
        (!me.connected && !me.isBot ? ' offline' : '');
      if (!myTurn) {
        var mySec = $('my-sec');
        if (mySec) mySec.textContent = '…';
      }
    }

    // 大厅还没发牌，隐藏"我的牌"（保留我的座位信息）
    $('my-cards-block').hidden = inLobby;
    var cards = (st.myCards && st.myCards.length === 3) ? st.myCards : null;

    if (!inLobby) {
      var sig = (cards ? cards.map(function (c) { return c.id; }).join('|') : 'BACK') +
        '#' + st.phase + '#' + (st.inHand ? 1 : 0) + '#' + (st.mySeen ? 1 : 0);
      if (sig !== mySig) {
        mySig = sig;
        buildMyCards(cards);
      }
    }

    var nameEl = $('my-hand-name');
    if (st.myHandName) {
      nameEl.textContent = st.myHandName;
      nameEl.hidden = false;
    } else if (st.mySeen && (st.phase === 'playing' || st.phase === 'bidding')) {
      nameEl.textContent = '已看牌';
      nameEl.hidden = false;
    } else {
      nameEl.hidden = true;
    }

    var hint = '';
    if (st.phase === 'lobby') {
      hint = '等待开局 · 房主可在下方设置规则';
    } else if (st.phase === 'bidding') {
      if (!st.inHand) hint = '本局未参与 · 等待定庄';
      else if (st.myBid == null) hint = '抢庄阶段 · 先看牌，再选「不抢」或「抢庄」';
      else if (st.myBid === 0) hint = '已选「不抢」· 等待其他玩家';
      else hint = '已选「抢庄」· 等待其他玩家';
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

  /* ------------------------------------------------------------- 人机管理 */

  var botsSig = '';

  function renderBots(st) {
    var panel = $('panel-bots');
    if (!panel) return;
    var inLobby = st.phase === 'lobby' || st.phase === 'showdown';
    panel.hidden = !inLobby;
    if (!inLobby) {
      botsSig = '';
      return;
    }

    var isHost = st.hostId === meId();
    var players = st.players || [];
    var bots = [];
    var humans = 0;
    for (var i = 0; i < players.length; i++) {
      if (players[i].isBot) bots.push(players[i]);
      else humans++;
    }

    var sig = JSON.stringify([bots.map(function (b) { return b.id + ':' + b.name; }), isHost]);
    if (sig === botsSig) {
      // 只更新按钮可用态
      var addBtn = $('btn-add-bot');
      if (addBtn) addBtn.disabled = !isHost || players.length >= (st.maxPlayers || 8) || busy;
      var cnt = $('bots-count');
      if (cnt) cnt.textContent = players.length + '/' + (st.maxPlayers || 8) + ' 个座位';
      return;
    }
    botsSig = sig;

    var list = $('bots-list');
    if (list) {
      list.innerHTML = '';
      if (!bots.length) {
        var empty = document.createElement('p');
        empty.className = 'tips';
        empty.textContent = '还没有人机。点下方按钮添加，一个人也能开局。';
        list.appendChild(empty);
      }
      for (var k = 0; k < bots.length; k++) {
        (function (bot) {
          var row = document.createElement('div');
          row.className = 'bot-row';
          var name = document.createElement('span');
          name.className = 'bot-name';
          name.textContent = bot.name;
          row.appendChild(name);
          if (isHost) {
            var del = document.createElement('button');
            del.className = 'btn btn-ghost btn-small';
            del.type = 'button';
            del.textContent = '移除';
            del.addEventListener('click', function () {
              doRemoveBot(bot.id, bot.name);
            });
            row.appendChild(del);
          }
          list.appendChild(row);
        })(bots[k]);
      }
    }

    var addBtn2 = $('btn-add-bot');
    if (addBtn2) {
      addBtn2.disabled = !isHost || players.length >= (st.maxPlayers || 8);
      addBtn2.textContent = isHost ? '+ 添加人机' : '只有房主能添加人机';
    }
    var cnt2 = $('bots-count');
    if (cnt2) cnt2.textContent = players.length + '/' + (st.maxPlayers || 8) + ' 个座位';
    var hint = $('bots-hint');
    if (hint) {
      hint.textContent = humans <= 1 ? '一个人也能玩：加人机开局吧' : '人机会自动出牌，适合凑人数';
    }
  }

  function doAddBot() {
    if (!session || busy) return;
    busy = true;
    var btn = $('btn-add-bot');
    if (btn) btn.disabled = true;
    api('/api/addBot', {
      roomId: session.roomId,
      playerId: session.playerId,
      token: session.token
    }).then(function (res) {
      busy = false;
      if (btn && !btn.hidden) btn.disabled = false;
      if (!res || !res.ok) {
        toast((res && res.error) || '添加人机失败', 'err');
      }
      // 成功后由 SSE 推送新状态，无需本地处理
    });
  }

  function doRemoveBot(botId, botName) {
    if (!session || busy) return;
    busy = true;
    api('/api/removeBot', {
      roomId: session.roomId,
      playerId: session.playerId,
      token: session.token,
      target: botId
    }).then(function (res) {
      busy = false;
      if (!res || !res.ok) {
        toast((res && res.error) || '移除人机失败', 'err');
      }
    });
  }

  /* ------------------------------------------------------------- 大厅设置 */

  function renderLobby(st) {
    var isHost = st.hostId === meId();
    if (!isHost) configDirty = false;
    var cfg = st.config || DEFAULT_CONFIG;
    var locked = (st.handNo || 0) > 0; // 首局开始后规则锁定
    var sig = JSON.stringify(cfg) + '|' + (isHost ? 'H' : 'G') + '|' + (locked ? 'L' : 'U');
    if (!configDirty && sig !== configSig) {
      configSig = sig;
      buildConfigForm($('config-form'), cfg, !isHost || locked);
    }
    $('btn-save-config').hidden = !isHost || locked;
    var resetBtn = $('btn-reset-scores');
    if (resetBtn) resetBtn.hidden = !isHost;
    $('config-lock').textContent = locked
      ? '牌局已开始，设置已锁定'
      : (isHost ? '你是房主，可修改后保存' : '只有房主可修改，你可以先看看');

    // 房间密码状态（明文永不下发，只显示"已设置/未设置"）
    var pinState = $('room-pin-state');
    if (pinState) pinState.textContent = st.hasJoinPin ? '已设置密码' : '未设置密码';
    var pinInput = $('room-pin-input');
    var pinBtn = $('btn-save-room-pin');
    if (pinInput) {
      pinInput.disabled = !isHost;
      pinInput.placeholder = isHost ? '4~8 位数字，留空=取消密码' : '只有房主可修改';
    }
    if (pinBtn) {
      pinBtn.hidden = !isHost;
      pinBtn.disabled = busy;
    }
    var lockNote = $('room-pin-lock');
    if (lockNote) lockNote.hidden = isHost;
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
      // 记住这套规则：下次建房自动带入
      lsSet(CREATE_KEY, JSON.stringify(cfg));
      toast('设置已保存（下次建房自动带入）', 'ok');
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
    var sig = (r.at || 0) + '#' + (r.handNo || 0) + '#' + (r.reason || '') + '#' + netSig + '#' + (st.revealWinner ? 1 : 0);
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
    // 豹子 / 顺金 喜钱
    var bns = r.bonuses || [];
    for (var bi2 = 0; bi2 < bns.length; bi2++) {
      var bn = bns[bi2];
      html += '<div class="bonus-line">🎁 ' + esc(bn.name) + ' 开出' + esc(bn.type) +
        ' · 喜钱 <b>+' + esc(bn.total) + '</b> <i>（每人 ' + esc(bn.perPlayer) + '）</i></div>';
    }
    html += '</div>';

    // ---- 个人输赢横幅 + 弃牌/观战提示 ----
    var meNow = findPlayer(st, meId());
    var myAmount = null;
    for (var wq = 0; wq < winners.length; wq++) {
      if (meNow && winners[wq].id === meNow.id) myAmount = winners[wq].amount;
    }
    if (!st.spectating) {
      if (myAmount != null) {
        html += '<div class="my-result win">🎉 你赢了 <b>+' + esc(myAmount) + '</b></div>';
      } else if (meNow && meNow.folded) {
        html += '<div class="my-result folded">🙂 你已弃牌，继续观战本局…</div>';
      } else if (meNow) {
        html += '<div class="my-result lose">😢 本局你输了</div>';
      }
    } else {
      html += '<div class="my-result watch">👁 观战中 · 等待本局结束</div>';
    }

    // ---- 弃牌获胜：赢家可选择公布牌面 ----
    if (r.singleWin && meNow && winners[0] && winners[0].id === meNow.id && !(st.config && st.config.showAllAtEnd)) {
      if (st.revealWinner) {
        html += '<div class="reveal-choice done">✅ 你已公布牌面</div>';
      } else {
        html += '<div class="reveal-choice">' +
          '<span>这局是靠别人弃牌赢的，要公布你的牌吗？</span>' +
          '<button id="btn-reveal-win" class="btn btn-primary btn-small" type="button">公布我的牌</button>' +
          '</div>';
      }
    }

    // ---- 每轮局数打满：本房间不能再开下一局，要新开房间 ----
    if (r.sessionOver) {
      var targetHands = (st.config && st.config.sessionHands) || 0;
      html += '<div class="session-over">' +
        '<div class="session-title">🏁 本轮 ' + esc(targetHands || r.handNo) + ' 局已打完</div>' +
        '<div class="session-sub">本房间不能再开下一局，请新开房间继续</div>' +
        '<div class="session-btns">' +
        '<button id="btn-new-room" class="btn btn-primary" type="button">新开房间</button>' +
        '<button id="btn-finish-round" class="btn btn-ghost" type="button">离开</button>' +
        '</div></div>';
    }

    // ---- 房主：重置所有人积分（从 0 开始）----
    if (!r.sessionOver && st.hostId === meId() && !st.spectating) {
      html += '<div class="auto-toggle"><span>积分想从 0 重新算？</span>' +
        '<button id="btn-reset-scores-result" class="btn btn-ghost btn-small" type="button">重置所有人积分</button></div>';
    }

    // ---- 自动连开开关（房主可见，让入口更显眼） ----
    if (!r.sessionOver && st.hostId === meId() && !st.spectating) {
      var autoOn = !!(st.config && st.config.autoNext);
      if (autoOn) {
        html += '<div class="auto-toggle"><span>自动开下一局：开</span>' +
          '<button id="btn-toggle-auto" class="btn btn-ghost btn-small" type="button">关闭</button></div>';
      } else {
        html += '<div class="auto-toggle"><span>每局都要手动点「下一局」？</span>' +
          '<button id="btn-toggle-auto" class="btn btn-primary btn-small" type="button">开启自动连开</button></div>';
      }
    }

    // ---- 自动连开倒计时（服务端排定 nextHandAt） ----
    if (st.nextHandAt) {
      html += '<div class="auto-next" id="auto-next-bar">' +
        '<span id="auto-next-text">准备自动开下一局…</span>' +
        '<button id="btn-pause-auto" class="btn btn-ghost btn-small" type="button">先别开</button>' +
        '</div>';
    }

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
          allIn: !!entry.allIn,
          folded: !!entry.folded,
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
          (row.folded ? '<i class="folded-tag">弃牌</i>' : '') +
          (row.allIn ? '<i class="allin-tag">全下</i>' : '') +
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

    // 累计积分榜（含战绩：局数/胜局/最大赢池）
    var sorted = players.slice().sort(function (a, b) { return (b.net || 0) - (a.net || 0); });
    var deltaById = {};
    var dl = r.deltas || [];
    for (var di = 0; di < dl.length; di++) deltaById[dl[di].id] = dl[di].delta;
    html += '<div class="sec-title">累计积分榜</div>';
    html += '<table class="rank-table"><thead><tr>' +
      '<th></th><th>玩家</th><th>积分</th><th>本局</th><th>战绩</th></tr></thead><tbody>';
    for (var k = 0; k < sorted.length; k++) {
      var sp = sorted[k];
      var netCls = sp.net > 0 ? 'pos' : (sp.net < 0 ? 'neg' : 'zero');
      var stt = sp.stats || { hands: 0, wins: 0, best: 0 };
      var sttText = stt.hands + '局/' + stt.wins + '胜' + (stt.best > 0 ? '·赢' + stt.best : '');
      var dlt = deltaById[sp.id] != null ? deltaById[sp.id] : null;
      var dltCls = dlt > 0 ? 'pos' : (dlt < 0 ? 'neg' : 'zero');
      html += '<tr' + (sp.id === meId() ? ' class="mine"' : '') + '>';
      html += '<td class="rank-no">' + (k + 1) + '</td>';
      html += '<td class="rank-name">' + esc(sp.name) +
        (sp.id === meId() ? '<i class="me-tag">我</i>' : '') + '</td>';
      html += '<td class="rank-net ' + netCls + '">' + esc(fmtSigned(sp.net)) + '</td>';
      html += '<td class="rank-delta ' + dltCls + '">' + (dlt == null ? '—' : esc(fmtSigned(dlt))) + '</td>';
      html += '<td class="rank-stats">' + esc(sttText) + '</td>';
      html += '</tr>';
    }
    html += '</tbody></table>';

    // 每一轮（设置了几局一轮）打完后的输赢总结
    var rs = r.roundSummary;
    if (rs && rs.length) {
      html += '<div class="sec-title">本轮输赢总结</div>';
      html += '<table class="rank-table round-table"><thead><tr>' +
        '<th></th><th>玩家</th><th>本轮输赢</th><th>积分</th></tr></thead><tbody>';
      for (var ri = 0; ri < rs.length; ri++) {
        var rp = rs[ri];
        var rCls = rp.delta > 0 ? 'pos' : (rp.delta < 0 ? 'neg' : 'zero');
        html += '<tr' + (rp.id === meId() ? ' class="mine"' : '') + '>';
        html += '<td class="rank-no">' + (ri + 1) + '</td>';
        html += '<td class="rank-name">' + esc(rp.name) + (rp.id === meId() ? '<i class="me-tag">我</i>' : '') + '</td>';
        html += '<td class="rank-net ' + rCls + '">' + esc(fmtSigned(rp.delta)) + '</td>';
        html += '<td class="rank-net ' + (rp.net > 0 ? 'pos' : (rp.net < 0 ? 'neg' : 'zero')) + '">' + esc(fmtSigned(rp.net)) + '</td>';
        html += '</tr>';
      }
      html += '</tbody></table>';
    }

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

    // 自动连开：绑定「先别开」并立即刷新倒计时
    var pauseBtn = panel.querySelector('#btn-pause-auto');
    if (pauseBtn) {
      pauseBtn.addEventListener('click', function () {
        if (!session || busy) return;
        pauseBtn.disabled = true;
        api('/api/pauseAuto', {
          roomId: session.roomId,
          playerId: session.playerId,
          token: session.token
        }).then(function (res) {
          if (!res || !res.ok) {
            pauseBtn.disabled = false;
            toast((res && res.error) || '取消失败', 'err');
          } else {
            toast('已取消自动开局', 'ok');
          }
        });
      });
    }
    updateAutoNextText();

    // 弃牌获胜：公布牌
    var revealBtn = panel.querySelector('#btn-reveal-win');
    if (revealBtn) {
      revealBtn.addEventListener('click', function () {
        revealBtn.disabled = true;
        api('/api/reveal', {
          roomId: session.roomId,
          playerId: session.playerId,
          token: session.token
        }).then(function (res) {
          if (!res || !res.ok) {
            revealBtn.disabled = false;
            toast((res && res.error) || '公布失败', 'err');
          } else {
            toast('已公布牌面', 'ok');
          }
        });
      });
    }

    // 本轮打满：新开房间 / 离开
    var newRoomBtn = panel.querySelector('#btn-new-room');
    if (newRoomBtn) {
      newRoomBtn.addEventListener('click', function () { startNewRoom(); });
    }
    var finishBtn = panel.querySelector('#btn-finish-round');
    if (finishBtn) {
      finishBtn.addEventListener('click', function () { doExit(); });
    }
    var resetResultBtn = panel.querySelector('#btn-reset-scores-result');
    if (resetResultBtn) {
      resetResultBtn.addEventListener('click', function () { doResetScores(); });
    }

    // 自动连开快捷开关
    var toggleBtn = panel.querySelector('#btn-toggle-auto');    if (toggleBtn) {
      toggleBtn.addEventListener('click', function () {
        toggleBtn.disabled = true;
        var cfg = {};
        var cur = (state && state.config) || {};
        for (var k in cur) if (Object.prototype.hasOwnProperty.call(cur, k)) cfg[k] = cur[k];
        cfg.autoNext = !cfg.autoNext;
        api('/api/config', {
          roomId: session.roomId,
          playerId: session.playerId,
          token: session.token,
          config: cfg
        }).then(function (res) {
          if (!res || !res.ok) {
            toggleBtn.disabled = false;
            toast((res && res.error) || '设置失败', 'err');
          } else {
            toast(cfg.autoNext ? '已开启自动连开' : '已关闭自动连开', 'ok');
          }
        });
      });
    }
  }

  /** 自动连开倒计时文案（用服务端 nextHandAt 与本机时间差做相对估算） */
  function updateAutoNextText() {
    var el = document.getElementById('auto-next-text');
    if (!el || !state || !state.nextHandAt) return;
    var st = state;
    var left = Math.max(0, Math.round((st.nextHandAt - st.serverNow) / 1000 - (Date.now() - clock.localAt) / 1000));
    el.textContent = left > 0 ? (left + ' 秒后自动开下一局') : '正在开下一局…';
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
    var allinOpt = null;
    for (var i = 0; i < opts.length; i++) {
      var o = opts[i];
      if (!o) continue;
      if (o.type === 'call') callOpt = o;
      else if (o.type === 'raise') raiseOpt = o;
      else if (o.type === 'compare') compareOpt = o;
      else if (o.type === 'fold') foldOpt = o;
      else if (o.type === 'allin') allinOpt = o;
    }

    // 出现「孤注一掷」时 6 个按钮排一行，避免换行
    var actionsEl = $('action-btns');
    if (actionsEl) {
      if (allinOpt) actionsEl.classList.add('six');
      else actionsEl.classList.remove('six');
    }

    var canLook = !!st.canLook;
    var seen = !!st.mySeen;

    updateAct($('act-look'), busy || !canLook,
      seen ? '已看' : '看',
      seen ? '已看牌' : '看牌');

    var allinBtn = $('act-allin');
    if (allinBtn) allinBtn.hidden = !allinOpt;
    updateAct(allinBtn, busy || !allinOpt,
      '全',
      allinOpt ? ('全下' + allinOpt.cost) : '不可用');

    var raiseSub = '—';
    if (raiseOpt && raiseOpt.raises && raiseOpt.raises.length) {
      raiseSub = '到 ' + raiseOpt.raises[raiseOpt.raises.length - 1].to;
    }
    updateAct($('act-compare'), busy || !compareOpt,
      '比',
      compareOpt ? ('比牌 ' + compareOpt.cost) : '不可用');

    updateAct($('act-fold'), busy || !foldOpt, '弃', '弃牌');

    // 筹码下注条：跟注 + 各加注档位（按底分/单注推导）
    renderChips(st, callOpt, raiseOpt);
    var baseEl = $('base-score-val');
    if (baseEl) baseEl.textContent = String((st.config && st.config.ante) || 0);
  }

  /** 筹码按钮：跟注额 + 加注档位，点一下直接下注 */
  function renderChips(st, callOpt, raiseOpt) {
    var bar = $('chip-bar');
    var row = $('chip-row');
    if (!bar || !row) return;
    var ante = Number((st.config && st.config.ante) || 10);
    var maxStake = Number((st.config && st.config.maxStake) || 100);
    var stake = Number(st.stake || ante);
    var seeMult = Number((st.config && st.config.seeMultiplier) || 2);
    var me = findPlayer(st, meId());
    var myChips = me ? me.chips : 0;
    // 筹码档位按底分倍数：底分×2 / ×4 / ×8 / ×16（不超过单注封顶，且必须大于当前单注）
    var levels = [];
    var v = ante * 2;
    for (var li = 0; li < 4; li++) {
      if (v > stake && v <= maxStake) {
        var cost = st.mySeen ? v * seeMult : v;
        if (myChips >= cost) levels.push(v);
      }
      v *= 2;
    }
    var show = st.phase === 'playing' && st.inHand && !st.folded &&
      !st.allIn && (callOpt || levels.length);
    if (!show) {
      bar.hidden = true;
      return;
    }
    bar.hidden = false;
    var html = '';
    if (callOpt) {
      html += '<button class="chip chip-call" type="button" data-chip="call">' +
        '<b>' + esc(callOpt.cost) + '</b><i>跟注</i></button>';
    }
    for (var lv = 0; lv < levels.length; lv++) {
      html += '<button class="chip chip-raise' + (lv > 0 ? ' chip-raise-2' : '') + '"' +
        ' type="button" data-chip="raise" data-to="' + esc(levels[lv]) + '">' +
        '<b>' + esc(levels[lv]) + '</b><i>加到</i></button>';
    }
    row.innerHTML = html;
    var btns = row.querySelectorAll('[data-chip]');
    for (var k = 0; k < btns.length; k++) {
      (function (btn) {
        btn.addEventListener('click', function () {
          if (busy) return;
          var kind = btn.getAttribute('data-chip');
          if (kind === 'call') {
            if (!optionOf('call')) { toast('现在不能跟注', 'err'); return; }
            postAction('call', {});
          } else {
            var to = Number(btn.getAttribute('data-to'));
            if (!to) return;
            postAction('raise', { to: to });
          }
        });
      })(btns[k]);
    }
  }

  /** 抢庄阶段的底部区：两个大按钮 + 「已选择」状态；看牌按钮始终可用（canLook） */
  function updateBidUI(st) {
    var status = $('bid-status');
    var btns = $('bid-btns');
    var passBtn = $('btn-bid-pass');
    var grabBtn = $('btn-bid-grab');
    var lookBtn = $('btn-bid-look');

    var inHand = !!st.inHand;
    var myBid = st.myBid;
    var pending = 0;
    var players = st.players || [];
    for (var i = 0; i < players.length; i++) {
      if (players[i].inHand && !players[i].folded && players[i].bid == null) pending++;
    }

    if (status) {
      status.className = 'bid-status';
      if (!inHand) {
        status.textContent = '本局未参与 · 等待定庄';
      } else if (myBid == null) {
        if (busy) {
          status.textContent = '提交中…';
        } else {
          status.textContent = '请选择：抢庄 或不抢';
        }
      } else {
        status.className = 'bid-status choice';
        var label = myBid === 0 ? '已选择：不抢' : '已选择：抢庄';
        if (pending > 0) {
          status.textContent = label + ' · 等待其他玩家（还剩 ' + pending + ' 人未选）…';
        } else {
          status.textContent = label + ' · 正在定庄…';
        }
      }
    }

    if (btns) btns.hidden = !(inHand && myBid == null);
    if (passBtn) passBtn.disabled = busy || !inHand || myBid != null;
    if (grabBtn) grabBtn.disabled = busy || !inHand || myBid != null;

    if (lookBtn) {
      lookBtn.disabled = busy || !st.canLook;
      lookBtn.textContent = st.mySeen ? '已看牌' : '看牌';
    }
  }

  function renderBottom(st) {
    var actions = $('action-btns');
    var primary = $('btn-bottom');
    var bidBar = $('bid-bar');

    // 本局参与 / 观战切换（只能在局间操作）
    var sitBtn = $('btn-sitout');
    if (sitBtn) {
      var canSwitch = !st.spectating && (st.phase === 'lobby' || st.phase === 'showdown');
      sitBtn.hidden = !canSwitch;
      sitBtn.textContent = st.mySitOut ? '参与' : '观战';
      sitBtn.title = st.mySitOut ? '点击重新参与游戏' : '点击本局观战（不参与）';
    }

    // 观战者没有任何操作权
    if (st.spectating) {
      if (actions) actions.hidden = true;
      if (primary) primary.hidden = true;
      if (bidBar) bidBar.hidden = true;
      var tt = $('turn-text');
      if (tt) tt.textContent = '观战中 · 只能看，不能出牌';
      var cc = $('turn-count');
      if (cc) cc.hidden = true;
      return;
    }
    var tipText = '';
    var mid = meId();
    var myTurn = !!(st.turnId && st.turnId === mid);
    var turnPlayer = findPlayer(st, st.turnId);
    var countEl = $('turn-count');
    countEl.hidden = true;

    if (st.phase === 'bidding') {
      actions.hidden = true;
      primary.hidden = true;
      if (bidBar) bidBar.hidden = false;
      updateBidUI(st);
      if (!st.inHand) tipText = '本局未参与 · 抢庄中';
      else if (st.myBid == null) tipText = '抢庄中 · 请选择是否抢庄';
      else tipText = '已选择 · 等待其他玩家…';
    } else {
      if (bidBar) bidBar.hidden = true;
      if (st.phase === 'playing') {
        actions.hidden = false;
        primary.hidden = true;
        actions.className = 'action-btns' + (myTurn ? ' active' : '');

        if (!st.inHand) tipText = '本局未参与，等待下一局';
        else if (st.folded) tipText = '你已弃牌，等待本局结束';
        else if (st.allIn) tipText = '孤注一掷中 · 等开牌';
        else if (myTurn) tipText = '轮到你操作';
        else if (turnPlayer) tipText = '等待 ' + turnPlayer.name + ' 操作';
        else tipText = '等待中';
      } else if (st.phase === 'showdown') {
        actions.hidden = true;
        primary.hidden = false;
        var roundOver = !!(st.lastResult && st.lastResult.sessionOver);
        primary.disabled = busy;
        primary.textContent = roundOver ? '新开房间（本轮已结束）' : '下一局';
        tipText = roundOver ? '本轮局数已打完 · 本房间不能再开，请新开房间' : '本局结束 · 准备下一局';
      } else {
        actions.hidden = true;
        primary.hidden = false;
        var n = (st.players || []).length;
        var enough = n >= 2;
        primary.disabled = busy || !enough;
        primary.textContent = enough ? '开始游戏' : ('等待玩家（' + n + '/2）');
        tipText = (st.hostId === mid ? '你是房主' : '等待房主开局') + ' · ' + n + ' 人在房间';
      }
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
    if (st.phase === 'showdown' && st.nextHandAt) updateAutoNextText();
    var rem = remainingMs();
    var countEl = $('turn-count');
    var tip = $('turn-text');

    // 抢庄阶段：台面上方倒计时
    if (st.phase === 'bidding') {
      var bidSec = rem == null ? 0 : Math.max(0, Math.ceil(rem / 1000));
      var bidCount = $('bid-count');
      if (bidCount) bidCount.textContent = String(bidSec);
      if (countEl) countEl.hidden = true;
      if (tip) {
        if (bidSec <= 3) tip.classList.add('urgent');
        else tip.classList.remove('urgent');
      }
      if (st.myBid == null) updateBidUI(st);
      return;
    }

    var total = ((st.config && st.config.turnSeconds) || 0) * 1000;
    var showCount = st.phase === 'playing' && st.turnDeadline > 0 && rem != null;

    if (showCount) {
      var sec = Math.max(0, Math.ceil(rem / 1000));
      var pctNum = total > 0 ? Math.max(0, Math.min(1, rem / total)) : 0;
      countEl.textContent = sec + 's';
      countEl.hidden = false;
      if (turnSeatEl) {
        var ring = turnSeatEl.querySelector('.turn-ring');
        if (ring) ring.style.setProperty('--p', String(pctNum));
        var secNode = turnSeatEl.querySelector('.seat-sec');
        if (secNode) secNode.textContent = sec + 's';
      }
      // 我的回合：我的头像圈也走进度
      var mySeat = $('my-seat');
      if (mySeat && mySeat.className.indexOf('turn') >= 0) {
        var myRing = mySeat.querySelector('.my-turn-ring');
        if (myRing) myRing.style.setProperty('--p', String(pctNum));
        var mySec = $('my-sec');
        if (mySec) mySec.textContent = sec + 's';
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
      if (state.phase === 'bidding') updateBidUI(state);
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

  /** 抢庄阶段：提交选择（0=不抢，1~4=倍数），结果由 SSE 推送回来 */
  function doBid(bid) {
    if (!session || busy) return;
    postAction('bid', { bid: bid });
  }

  /* 抢庄不再带倍数：点「抢庄」直接提交（保留空函数兼容旧引用） */
  function openBidGrab() {
    doBid(1);
  }

  function doAllin() {
    var opt = optionOf('allin');
    if (!opt) { toast('现在不能孤注一掷', 'err'); return; }
    confirmDialog({
      title: '孤注一掷',
      message: '把剩下的 ' + opt.cost + ' 分全部押上，留在牌局里直到开牌。确定吗？',
      okText: '全下'
    }).then(function (ok) {
      if (ok) postAction('allin', {});
    });
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
            message: '与 ' + target.name + ' 比牌，需下注 ' + cost + ' 分，输的人直接出局。确定吗？',
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

  function doResetScores() {
    if (!session || busy) return;
    confirmDialog({
      title: '重置所有人积分',
      message: '所有人积分归 0、战绩清零（牌局进行中不能重置）。确定吗？',
      okText: '重置',
      danger: true
    }).then(function (ok) {
      if (!ok) return;
      busy = true;
      api('/api/resetScores', {
        roomId: session.roomId,
        playerId: session.playerId,
        token: session.token
      }).then(function (res) {
        busy = false;
        if (!res || !res.ok) toast((res && res.error) || '重置失败', 'err');
        else toast('积分已全部归 0', 'ok');
      });
    });
  }

  function doStart() {
    if (!session || busy) return;
    // 本轮局数已打完：不能再开下一局，直接新开房间
    if (state && state.lastResult && state.lastResult.sessionOver) {
      startNewRoom();
      return;
    }
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

  /** 本轮打满后：退出当前房间，按保存的配置新开一间 */
  function startNewRoom() {
    if (!session || busy) return;
    var s = session;
    var name = String($('nickname').value || lsGet(NICK_KEY, '') || '').trim();
    busy = true;
    var go = function () {
      closeStream();
      session = null;
      state = null;
      var cfg = loadCreateConfig();
      api('/api/create', {
        name: name,
        config: cfg,
        pin: readCreatePin(),
        avatar: readAvatar()
      }).then(function (res) {
        busy = false;
        if (!res || !res.ok) {
          toast((res && res.error) || '新开房间失败', 'err');
          showHome({});
          return;
        }
        lsSet(CREATE_KEY, JSON.stringify(cfg));
        enterRoom({ roomId: res.roomId, playerId: res.playerId, token: res.token, name: name });
      }, function () {
        busy = false;
        toast('连不上服务器，新开房间失败', 'err');
        showHome({});
      });
    };
    api('/api/leave', { roomId: s.roomId, playerId: s.playerId, token: s.token })
      .then(go, go);
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
    $('btn-save-create-config').addEventListener('click', function () {
      var cfg = readFormConfig($('create-adv'));
      lsSet(CREATE_KEY, JSON.stringify(cfg));
      toast('已保存你的默认配置，下次开房自动带入', 'ok');
    });
    $('btn-join').addEventListener('click', doJoin);
    $('btn-watch-join').addEventListener('click', function () {
      var rid = digits($('join-room').value).slice(0, 6);
      if (!rid || rid.length !== 6) { toast('请输入 6 位数字房号', 'err'); return; }
      doWatch(rid);
    });
    $('btn-sitout').addEventListener('click', function () {
      if (!session || !state || busy) return;
      var btn = $('btn-sitout');
      btn.disabled = true;
      api('/api/sitOut', {
        roomId: session.roomId,
        playerId: session.playerId,
        token: session.token,
        sitOut: !state.mySitOut
      }).then(function (res) {
        btn.disabled = false;
        if (!res || !res.ok) toast((res && res.error) || '切换失败', 'err');
        else toast(res.sitOut ? '已切换为观战：本局不参与' : '已重新参与游戏', 'ok');
      });
    });
    $('btn-refresh-rooms').addEventListener('click', loadRoomList);
    $('btn-resume').addEventListener('click', doResume);
    $('btn-avatar').addEventListener('click', function () { openAvatarPicker(); });

    $('join-room').addEventListener('input', function () {
      var v = digits(this.value).slice(0, 6);
      if (v !== this.value) this.value = v;
      updateResumeBox();
      if (v.length === 6) probeRoomPin();
    });

    $('nickname').addEventListener('change', function () {
      var v = String(this.value || '').replace(/\s+/g, ' ').replace(/^ | $/g, '').slice(0, 12);
      this.value = v;
      if (v) lsSet(NICK_KEY, v);
    });

    // 边输入边记住昵称：下次打开网站自动填好
    $('nickname').addEventListener('input', function () {
      var v = String(this.value || '').replace(/\s+/g, ' ').replace(/^ | $/g, '').slice(0, 12);
      if (v) lsSet(NICK_KEY, v);
    });

    // 建房高级设置：改了就记住，下次建房自动带入
    var advForm = $('create-adv');
    if (advForm) {
      var saveAdv = function () {
        try { lsSet(CREATE_KEY, JSON.stringify(readFormConfig(advForm))); } catch (e) { /* ignore */ }
      };
      advForm.addEventListener('input', saveAdv);
      advForm.addEventListener('change', saveAdv);
    }

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
    $('btn-reset-scores').addEventListener('click', doResetScores);
    $('btn-add-bot').addEventListener('click', doAddBot);
    $('btn-save-room-pin').addEventListener('click', saveRoomPin);

    // 抢庄阶段操作
    $('btn-bid-pass').addEventListener('click', function () {
      if (this.disabled) return;
      doBid(0);
    });
    $('btn-bid-grab').addEventListener('click', function () {
      if (this.disabled) return;
      doBid(1);
    });
    $('btn-bid-look').addEventListener('click', function () {
      if (this.disabled) return;
      doLook();
    });
    $('join-pin').addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') { ev.preventDefault(); doJoin(); }
    });
    $('btn-chat').addEventListener('click', openChatDialog);
    $('btn-music').addEventListener('click', toggleMusic);
    $('btn-sound').addEventListener('click', function () {
      soundOn = !soundOn;
      try { lsSet('zjh.sound', soundOn ? '1' : '0'); } catch (e) { /* ignore */ }
      updateSoundBtn();
      toast(soundOn ? '提醒已开：轮到你会响铃/震动' : '提醒已关', 'ok');
      if (soundOn) { primeAudio(); beep(); }
    });
    updateSoundBtn();

    $('act-look').addEventListener('click', function () {
      if ($('act-look').disabled) return;
      doLook();
    });
    // 点击自己的信息条：查看自己的筹码/净分（也支持借分入口）
    $('my-seat').addEventListener('click', function () {
      if (state) openPlayerDetail(meId());
    });
    $('act-compare').addEventListener('click', function () {
      if ($('act-compare').disabled) return;
      doCompare();
    });
    $('act-allin').addEventListener('click', function () {
      var b = $('act-allin');
      if (b.hidden || b.disabled) return;
      doAllin();
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

    // 屏幕旋转 / 宽度变化后重排座位，并让牌桌自适应屏幕
    window.addEventListener('resize', function () {
      fitStage();
      scheduleSeatLayout();
    });
    window.addEventListener('orientationchange', function () {
      setTimeout(function () { fitStage(); scheduleSeatLayout(); }, 200);
    });

    window.addEventListener('online', function () {
      if (session && !connected) scheduleVerify(500);
    });

    window.addEventListener('offline', function () {
      if (session) showConn('连接中…（网络已断开）');
    });

    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') {
        if (session && !connected) scheduleVerify(300);
        if (session) musicStart();
      } else {
        musicStop();
        try { if (window.speechSynthesis) window.speechSynthesis.cancel(); } catch (e) { /* ignore */ }
      }
    });

    // 第一次点击时预热语音合成（iOS 需要用户手势后才允许朗读）
    document.addEventListener('click', function () {
      if (!voiceOn || voicePrimed || !voiceSupported()) return;
      voicePrimed = true;
      try {
        window.speechSynthesis.resume();
        var u = new window.SpeechSynthesisUtterance(' ');
        u.volume = 0.01;
        u.lang = 'zh-CN';
        window.speechSynthesis.speak(u);
      } catch (e) { /* ignore */ }
    }, { passive: true });

    // 按钮点击音效（欢乐斗地主风格），同时预热音效上下文
    document.addEventListener('click', function (ev) {
      var el = ev.target;
      while (el && el !== document) {
        if (el.tagName === 'BUTTON') {
          sfx('click');
          break;
        }
        el = el.parentNode;
      }
    }, true);
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
    updateMusicBtn();
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
