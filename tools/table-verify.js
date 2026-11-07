'use strict';

/**
 * =============================================================================
 *  table-verify.js —— 炸金花网页版 · 牌桌 UI 自动化验收工具
 * =============================================================================
 * 面向「椭圆牌桌 / 15 座位 / 抢庄 UI」前端重构的验收脚本。
 *
 * 用法：
 *   node tools/table-verify.js [baseUrl] [模式]
 *     smoke   默认。起服(若无)→ 2 / 6 / 15 人局（14 人机）各走一遍完整流程
 *     layout  只做布局检查：建房→加人机→开局到 playing，不打完整下注局
 *   baseUrl 缺省 http://127.0.0.1:18081。不带 baseUrl 且该端口没有服务时，
 *   脚本会自己 `PORT=18081 node server.js` 起服，结束时杀掉并删除 data/rooms.json。
 *
 * 每组人数 × 三档视口（320 / 375 / 480）断言：
 *   a. 无横向滚动     documentElement.scrollWidth - clientWidth <= 0
 *   b. 座位无重叠     所有 .seat 的 rect 两两比较，两轴穿透深度都 > 4px 才算真重叠
 *                     （<4px 视为边框/阴影误差，允许）
 *   c. 座位数量正确   .seat 数量 + 我的座位（#my-seat / .my-seat）=== 玩家数
 *   d. 抢庄流程       phase=bidding 后：不抢/抢庄按钮存在、倒计时文案存在，
 *                     真人用 CDP 点按钮；随后 phase=playing 且庄家徽标/信息出现
 *   e. 完整一局       （仅 smoke）真人轮到即弃牌，人机自驱动，到 phase=showdown：
 *                     winners 非空、所有玩家 net 合计 === 0
 *
 * 截图：%TEMP%\table-verify\<人数>p-<宽度>.png
 * 退出码：全部断言通过 0；任何断言失败 1。
 *
 * 实现说明：
 *   - 只依赖 Node 24 自带 fetch / WebSocket，零 npm 依赖。
 *   - Edge 无头浏览器 + CDP（结构抄自 tools/ui-check.js）。
 *   - 房间流程：HTTP 建房(pin) → 浏览器 UI 加入成为玩家 → 临时房主退出（房主转给
 *     浏览器玩家）→ POST /api/addBot 加人机 → POST /api/start → 抢庄 → 打完。
 *   - 临时文件（截图 / Edge profile）全部放 %TEMP%。
 */

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

/* ---------------------------------------------------------------- 参数解析 */

const argv = process.argv.slice(2);
let BASE = '';
let MODE = 'smoke';
for (const a of argv) {
  if (/^https?:\/\//i.test(a)) BASE = a.replace(/\/+$/, '');
  else if (a === 'smoke' || a === 'layout') MODE = a;
  else {
    console.error('未知参数: ' + a);
    console.error('用法: node tools/table-verify.js [baseUrl] [smoke|layout]');
    process.exit(2);
  }
}
if (!BASE) BASE = 'http://127.0.0.1:18081';

const ROOT = path.join(__dirname, '..');
const SHOT_DIR = path.join(os.tmpdir(), 'table-verify');
const EDGE =
  process.env.EDGE_PATH ||
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const WIDTHS = [320, 375, 480];
const HEIGHT_FOR = { 320: 640, 375: 812, 480: 854 };
const GROUPS = [2, 6, 15];
const OVERLAP_TOLERANCE = 4;          // px，两轴穿透深度都超过才算真重叠
const SHOWDOWN_TIMEOUT_MS = 240000;   // 15 人机局最宽打完时限

let failures = 0;
let totalChecks = 0;
let serverProc = null;      // 本脚本起的服务进程（外部服务为 null）
let edgeProc = null;
let edgeProfile = '';
let cdp = null;
let cleaning = false;
const DEBUG_PORT = 9300 + Math.floor(Math.random() * 400); // Edge CDP 调试端口

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 断言打印：✓/✗，并累计失败数 */
function check(name, ok, detail) {
  totalChecks += 1;
  if (!ok) failures += 1;
  const line = '  ' + (ok ? '✓ ' : '✗ ') + name + (ok ? '' : ' —— ' + String(detail || ''));
  console.log(line);
  return ok;
}

function info(text) {
  console.log('  ' + text);
}

/* ---------------------------------------------------------------- HTTP 工具 */

async function postJSON(p, body) {
  const res = await fetch(BASE + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  });
  return res.json();
}

async function getJSON(p) {
  const res = await fetch(BASE + p);
  return res.json();
}

/** 读创建口令：data/settings.json 的 createPin，缺省 7749（服务器 CREATE_PIN/设置都覆盖） */
function readCreatePin() {
  try {
    const t = fs
      .readFileSync(path.join(ROOT, 'data', 'settings.json'), 'utf8')
      .replace(/^\uFEFF/, '');
    const j = JSON.parse(t);
    const p = String((j && j.createPin) || '').trim();
    if (/^\d{3,8}$/.test(p)) return p;
  } catch (e) {
    /* 未设置就按默认 */
  }
  return '7749';
}

async function probeHealth() {
  try {
    const res = await fetch(BASE + '/api/health');
    const j = await res.json();
    return j && j.ok ? j : null;
  } catch (e) {
    return null;
  }
}

const stateOf = (sess) =>
  getJSON(
    '/api/state?roomId=' + sess.roomId +
    '&playerId=' + encodeURIComponent(sess.playerId) +
    '&token=' + encodeURIComponent(sess.token)
  );

async function waitUntil(fn, timeout, interval) {
  const end = Date.now() + (timeout || 10000);
  while (Date.now() < end) {
    try {
      if (await fn()) return true;
    } catch (e) {
      /* 轮询中允许失败 */
    }
    await sleep(interval || 250);
  }
  return false;
}

async function waitPhase(sess, phase, timeout) {
  const end = Date.now() + (timeout || 15000);
  let last = '';
  let lastErr = '';
  while (Date.now() < end) {
    try {
      const st = await stateOf(sess);
      if (st && st.ok) {
        last = st.phase;
        if (st.phase === phase) return st;
      }
    } catch (e) {
      lastErr = e.message; // 瞬时网络/服务抖动：继续轮询直到超时
    }
    await sleep(300);
  }
  throw new Error(
    '等待 phase=' + phase + ' 超时（最后 phase=' + last + (lastErr ? ' · 最后错误=' + lastErr : '') + '）'
  );
}

/* ---------------------------------------------------------------- CDP 客户端 */

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.consoleErrors = [];
    ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch (e) {
        return;
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
        return;
      }
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        this.consoleErrors.push(
          (msg.params.args || []).map((a) => a.value || a.description || '').join(' ')
        );
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails || {};
        this.consoleErrors.push(
          '未捕获异常: ' + ((d.exception && d.exception.description) || d.text || 'unknown')
        );
      }
    });
  }

  send(method, params) {
    const id = ++this.id;
    const p = params || {};
    return new Promise((resolve, reject) => {
      if (this.ws.readyState !== 1) return reject(new Error('WebSocket 未连接'));
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params: p }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('CDP 超时: ' + method));
        }
      }, 20000);
    });
  }

  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true
    });
    if (r.exceptionDetails) {
      throw new Error(
        '页面内执行出错: ' +
          ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) ||
            r.exceptionDetails.text)
      );
    }
    return r.result ? r.result.value : undefined;
  }

  async screenshot(file) {
    const r = await this.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false
    });
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    return file;
  }
}

async function connectTargets() {
  for (let i = 0; i < 120; i++) {
    try {
      const list = await (
        await fetch('http://127.0.0.1:' + DEBUG_PORT + '/json/list')
      ).json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch (e) {
      /* 还没起来 */
    }
    await sleep(150);
  }
  throw new Error('连不上 Edge 调试端口 ' + DEBUG_PORT);
}

function openWS(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.addEventListener('open', () => resolve(ws));
    ws.addEventListener('error', () => reject(new Error('WebSocket 连接失败')));
    setTimeout(() => reject(new Error('WebSocket 连接超时')), 10000);
  });
}

async function launchEdge(profileDir) {
  const proc = spawn(
    EDGE,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--mute-audio',
      '--remote-debugging-port=' + DEBUG_PORT,
      '--user-data-dir=' + profileDir,
      '--window-size=520,900',
      'about:blank'
    ],
    { stdio: 'ignore' }
  );
  await sleep(1200);
  return proc;
}

/* ---------------------------------------------------------------- 服务管理 */

async function ensureServer() {
  const alive = await probeHealth();
  if (alive) {
    info('✓ 复用已在线服务 ' + BASE + '（rooms=' + alive.rooms + ' players=' + alive.players + '）');
    return;
  }
  const port = new URL(BASE).port || '80';
  info('→ 起本地服务: PORT=' + port + ' node server.js');
  serverProc = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { PORT: port }),
    stdio: 'ignore'
  });
  const died = new Promise((_, reject) => {
    serverProc.once('exit', (code) =>
      reject(new Error('server.js 提前退出 code=' + code + '（端口被占用？）'))
    );
  });
  const up = waitUntil(async () => (await probeHealth()) !== null, 20000, 300);
  await Promise.race([up, died]);
  const h = await probeHealth();
  if (!h) throw new Error('服务启动失败（20s 内 /api/health 不通）');
  info('✓ 服务在线 ' + BASE);
}

/* ---------------------------------------------------------------- 视口控制 */

async function setViewport(width) {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width,
    height: HEIGHT_FOR[width] || 800,
    deviceScaleFactor: 2,
    mobile: true,
    screenOrientation: { type: 'portraitPrimary', angle: 0 }
  });
  // 前端 resize → 120ms 防抖 → layoutSeats；留足重排时间
  await sleep(900);
}

/* ---------------------------------------------------------------- 浏览器入房 */

/** 浏览器走真实 UI（?r= 预填房号 → 填昵称 → 点「加入」）加入房间，返回会话凭证 */
async function browserJoin(roomId) {
  await cdp.send('Page.navigate', { url: BASE + '/?r=' + roomId });
  // 等真正的 boot 完成信号：boot() 会把 ?r= 的房号同步填进 #join-room，
  // 且这一步在 bindHome/bindTable 之后 —— 该值出现即代表事件已绑定。
  // （只看 #screen-home 可见会撞上"HTML 尚在解析、JS 还没 boot"的竞态）
  const booted = await waitUntil(
    () =>
      cdp.eval(
        "(() => { const j = document.getElementById('join-room');" +
          " return !!j && j.value === '" + roomId + "'; })()"
      ),
    12000,
    200
  );
  if (!booted) throw new Error('首页没有渲染完成（#join-room 未被 ?r= 预填）');

  // 填昵称 + 点「加入」，带重试（防重构后按钮短暂禁用/弹窗打断）
  let joined = false;
  let lastDiag = '';
  for (let attempt = 0; attempt < 3 && !joined; attempt++) {
    await cdp.eval(
      "(() => { const el = document.getElementById('nickname'); if (!el) return 'no-input';" +
        " el.value = '验收员'; el.dispatchEvent(new Event('input', { bubbles: true })); return el.value; })()"
    );
    await cdp.eval(
      "(() => { const b = document.getElementById('btn-join'); if (!b) return 'no-btn'; b.click(); return 'clicked'; })()"
    );
    joined = await waitUntil(
      () =>
        cdp.eval(
          "(() => { const s = document.getElementById('screen-table');" +
            " const r = document.getElementById('room-id');" +
            " return !!s && !s.hidden && !!r && r.textContent.trim() === '" +
            roomId +
            "'; })()"
        ),
      6000,
      250
    );
    if (!joined) {
      lastDiag = await cdp.eval(
        '(() => {' +
          " const g = (id) => { const el = document.getElementById(id); return el ? (el.value != null ? el.value : el.textContent) : '(无)'; };" +
          ' const toasts = Array.prototype.slice.call(document.querySelectorAll(".toast")).map(function (t) {' +
          '   return (t.textContent || "").trim(); });' +
          ' return JSON.stringify({' +
          "  screenTable: (function () { const s = document.getElementById('screen-table'); return s ? !s.hidden : null; })()," +
          '  roomField: g("join-room"), nick: g("nickname"), toasts: toasts }); })()'
      );
      await sleep(800);
    }
  }
  if (!joined) throw new Error('浏览器 UI 加入房间失败（牌桌界面未出现）· 页面状态: ' + lastDiag);

  // 从 localStorage 读会话（app.js: zjh.sessions.v1 -> { roomId: {roomId,playerId,token} }）
  const stored = await cdp.eval(
    '(() => { const out = []; for (let i = 0; i < localStorage.length; i++) {' +
      ' const k = localStorage.key(i); out.push([k, localStorage.getItem(k)]); }' +
      ' return JSON.stringify(out); })()'
  );
  let sess = null;
  for (const pair of JSON.parse(stored)) {
    const k = pair[0];
    const v = pair[1];
    if (k !== 'zjh.sessions.v1' || !v) continue;
    try {
      const all = JSON.parse(v);
      const s = all && all[roomId];
      if (s && s.playerId && s.token) sess = { roomId, playerId: s.playerId, token: s.token };
    } catch (e) {
      /* 非 JSON，跳过 */
    }
  }
  if (!sess) throw new Error('未在 localStorage 找到浏览器会话凭证');
  return sess;
}

/* ---------------------------------------------------------------- 建房 / 加人 */

/** 每组房间配置：抢庄模式 + 快节奏（真人弃牌后人机很快打完） */
function roomConfig() {
  return {
    ante: 10,
    initialChips: 1000,
    baseStake: 10,
    maxStake: 30,
    maxPot: 300,
    seeMultiplier: 2,
    turnSeconds: 0,      // 不限时，全靠人机自驱动 + 真人主动弃牌
    autoRebuy: true,
    autoNext: false,     // 结算后停住，方便断言
    dealerBid: true,     // 抢庄模式（本工具的核心验收点之一）
    bidSeconds: 10,
    special235: false,
    autoNextSeconds: 8
  };
}

/** 建房 → 浏览器加入 → 临时房主退出 → 加人机，返回 { roomId, B } */
async function setupRoom(n) {
  const cr = await postJSON('/api/create', {
    name: '开房助手',
    pin: readCreatePin(),
    config: roomConfig()
  });
  if (!cr.ok) throw new Error('建房失败: ' + (cr.error || '?') + '（口令=' + readCreatePin() + '）');
  const roomId = cr.roomId;
  const host = { roomId, playerId: cr.playerId, token: cr.token };

  const B = await browserJoin(roomId);

  const lv = await postJSON('/api/leave', host);
  if (!lv.ok) throw new Error('临时房主退出失败: ' + (lv.error || '?'));

  for (let i = 0; i < n - 1; i++) {
    const r = await postJSON('/api/addBot', {
      roomId,
      playerId: B.playerId,
      token: B.token
    });
    if (!r.ok) throw new Error('第 ' + (i + 1) + ' 个人机加入失败: ' + (r.error || '?'));
  }

  const st = await stateOf(B);
  if (!st.ok) throw new Error('取房间状态失败: ' + (st.error || '?'));
  if ((st.players || []).length !== n) {
    throw new Error('人数不符: ' + (st.players || []).length + '/' + n);
  }
  if (st.hostId !== B.playerId) throw new Error('房主未转移给浏览器玩家');
  const bots = (st.players || []).filter((p) => p.isBot).length;
  info('房间 ' + roomId + ' 就绪：' + n + ' 人（真人 1 + 人机 ' + bots + '）· dealerBid=true');
  return { roomId, B };
}

/* ---------------------------------------------------------------- 布局检查 */

/** 在当前视口做 a/b/c 三项检查并截图；返回是否全部通过 */
async function layoutChecks(width, n) {
  const expr =
    '(() => {' +
    ' const de = document.documentElement;' +
    ' const overflow = de.scrollWidth - de.clientWidth;' +
    ' const seats = Array.prototype.slice.call(document.querySelectorAll(".seat"));' +
    ' const rects = [];' +
    ' for (let i = 0; i < seats.length; i++) {' +
    '   const r = seats[i].getBoundingClientRect();' +
    '   if (r.width > 1 && r.height > 1) rects.push({ pid: seats[i].getAttribute("data-pid") || ("#" + i), x: r.left, y: r.top, w: r.width, h: r.height });' +
    ' }' +
    ' const T = ' + OVERLAP_TOLERANCE + ';' +
    ' const pairs = [];' +
    ' const shallow = [];' +
    ' for (let a = 0; a < rects.length; a++) for (let b = a + 1; b < rects.length; b++) {' +
    '   const A = rects[a], B2 = rects[b];' +
    '   const ox = Math.min(A.x + A.w, B2.x + B2.w) - Math.max(A.x, B2.x);' +
    '   const oy = Math.min(A.y + A.h, B2.y + B2.h) - Math.max(A.y, B2.y);' +
    '   if (ox > 0 && oy > 0) {' +
    '     const tag = (A.pid || a) + "~" + (B2.pid || b) + "(" + Math.round(ox) + "x" + Math.round(oy) + ")";' +
    '     if (ox > T && oy > T) pairs.push(tag); else shallow.push(tag);' +
    '   }' +
    ' }' +
    ' const myEl = document.getElementById("my-seat") || document.querySelector(".my-seat");' +
    ' let myOverlap = 0;' +
    ' if (myEl) { const m = myEl.getBoundingClientRect();' +
    '   if (m.width > 1 && m.height > 1) for (let i = 0; i < rects.length; i++) {' +
    '     const R = rects[i];' +
    '     const ox = Math.min(m.left + m.width, R.x + R.w) - Math.max(m.left, R.x);' +
    '     const oy = Math.min(m.top + m.height, R.y + R.h) - Math.max(m.top, R.y);' +
    '     if (ox > T && oy > T) myOverlap++;' +
    '   } }' +
    ' return JSON.stringify({ overflow: overflow, seatCount: seats.length, hasMySeat: !!myEl, pairs: pairs, shallow: shallow, myOverlap: myOverlap });' +
    '})()';

  const r = JSON.parse(await cdp.eval(expr));
  const total = r.seatCount + (r.hasMySeat ? 1 : 0);
  const seatDesc = '.seat=' + r.seatCount + (r.hasMySeat ? ' + my-seat=1' : ' + my-seat=无') +
    ' → 共' + total + '/' + n;

  const f1 = check('[' + width + 'px] a.无横向滚动 (溢出 ' + r.overflow + 'px)', r.overflow <= 0);
  const shallowNote = (r.shallow && r.shallow.length)
    ? '；边框级浅重叠(<=' + OVERLAP_TOLERANCE + 'px) ' + r.shallow.length + ' 对: ' + r.shallow.slice(0, 6).join(', ')
    : '';
  const f2 = check(
    '[' + width + 'px] b.座位无重叠 (' + r.pairs.length + ' 对',
    r.pairs.length === 0,
    r.pairs.slice(0, 6).join(', ') +
      (r.myOverlap ? '；另有 my-seat 与座位重叠 ' + r.myOverlap + ' 对（参考项）' : '') +
      shallowNote
  );
  const f3 = check('[' + width + 'px] c.座位数量 ' + seatDesc, total === n);
  const shot = path.join(SHOT_DIR, n + 'p-' + width + '.png');
  try {
    await cdp.screenshot(shot);
    info('📸 ' + shot);
  } catch (e) {
    check('[' + width + 'px] 截图', false, e.message);
  }
  return f1 && f2 && f3;
}

/* ---------------------------------------------------------------- 抢庄检查 */

/** d 抢庄流程：控件/倒计时断言 → 真人 CDP 点「不抢」→ 等定庄 */
async function biddingChecks(B) {
  await sleep(500); // 让 SSE 状态先铺到 DOM

  const bidInfo = JSON.parse(
    await cdp.eval(
      '(() => {' +
      ' const ids = ["bid-bar","bid-strip","bid-count","bid-status","btn-bid-pass","btn-bid-grab","btn-bid-look","act-look"];' +
      ' const o = {};' +
      ' for (let i = 0; i < ids.length; i++) { const el = document.getElementById(ids[i]);' +
      '   o[ids[i]] = el ? { hidden: !!el.hidden, disabled: !!el.disabled, text: (el.textContent || "").trim().slice(0, 30) } : null; }' +
      ' const bar = document.getElementById("bid-bar");' +
      ' o.btns = bar ? Array.prototype.slice.call(bar.querySelectorAll("button")).map(function (b) {' +
      '   return { id: b.id, text: (b.textContent || "").trim(), hidden: !!b.hidden, disabled: !!b.disabled }; }) : [];' +
      ' o.barHTML = bar ? bar.outerHTML.replace(/\\s+/g, " ").slice(0, 480) : "(无 #bid-bar)";' +
      ' const strip = document.getElementById("bid-strip");' +
      ' const cnt = document.getElementById("bid-count");' +
      ' o.countdownOk = !!(strip && !strip.hidden && cnt && /^\\d+$/.test((cnt.textContent || "").trim()));' +
      ' o.countdownText = strip && !strip.hidden ? (strip.textContent || "").trim().slice(0, 30) : "";' +
      ' return JSON.stringify(o); })()'
    )
  );

  const btns = (bidInfo.btns || []).filter((b) => !b.hidden && !b.disabled);
  const hasPass = btns.some((b) => /不抢|pass/i.test(b.id + ' ' + b.text));
  const hasGrab = btns.some((b) => /抢庄|grab/i.test(b.id + ' ' + b.text) && !/不抢/.test(b.text));
  check(
    'd1.抢庄控件存在（不抢 + 抢庄，#act-look 之外）',
    hasPass && hasGrab,
    '实际按钮: ' + JSON.stringify(bidInfo.btns)
  );
  check(
    'd2.抢庄倒计时文案 (' + (bidInfo.countdownText || '无') + ')',
    bidInfo.countdownOk,
    'bid-strip=' + (bidInfo['bid-strip'] ? JSON.stringify(bidInfo['bid-strip']) : '缺失')
  );
  info('↳ 抢庄区实际 DOM（供人工核对）: ' + bidInfo.barHTML);

  // 真人用 CDP 点「不抢」（优先 #btn-bid-pass，退化为找文本，再退化为抢庄弹窗）
  let clicked = '';
  for (let i = 0; i < 8 && !clicked; i++) {
    const st = await stateOf(B);
    if (!st.ok || st.phase !== 'bidding') break;
    if (st.myBid != null) {
      clicked = 'already';
      break;
    }
    const r1 = await cdp.eval(
      '(() => { let b = document.getElementById("btn-bid-pass");' +
        ' if (!b || b.hidden || b.disabled) {' +
        '   const bar = document.getElementById("bid-bar"); b = null;' +
        '   if (bar) { const list = Array.prototype.slice.call(bar.querySelectorAll("button")).filter(function (x) {' +
        '     return !x.hidden && !x.disabled && /不抢/.test(x.textContent || ""); }); b = list[0] || null; } }' +
        ' if (!b || b.hidden || b.disabled) return "no-btn"; b.click(); return "clicked"; })()'
    );
    if (r1 === 'clicked') {
      clicked = 'pass';
      break;
    }
    const r2 = await cdp.eval(
      '(() => { const b = document.getElementById("btn-bid-grab");' +
        ' if (!b || b.hidden || b.disabled) return "no-btn"; b.click(); return "clicked"; })()'
    );
    if (r2 === 'clicked') {
      const r3 = await waitUntil(
        () =>
          cdp.eval(
            '(() => { const m = document.getElementById("modal-root");' +
              ' return !!(m && !m.hidden && m.querySelector(".opt-btn[data-bid]")); })()'
          ),
        3000,
        200
      );
      if (r3) {
        await cdp.eval(
          '(() => { const m = document.getElementById("modal-root");' +
            ' const b = m.querySelector(".opt-btn[data-bid]"); if (!b) return "no"; b.click(); return "clicked"; })()'
        );
        clicked = 'grab-modal';
      }
      break;
    }
    await sleep(450);
  }

  const st = await stateOf(B);
  const bidSet = st.ok && (st.myBid != null || st.phase !== 'bidding');
  check(
    'd3.真人 CDP 点击抢庄按钮生效 (方式=' + (clicked || '未点上') +
      ' myBid=' + (st.ok ? st.myBid : '?') + ')',
    clicked !== '' && bidSet,
    '服务端状态: phase=' + (st.ok ? st.phase : '?') + ' myBid=' + (st.ok ? st.myBid : '?')
  );

  // 若残留弹窗（比如走了抢庄弹窗分支）按 Esc 关掉
  await cdp.eval(
    '(() => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));' +
      ' const m = document.getElementById("modal-root"); return m && !m.hidden ? "open" : "closed"; })()'
  );

  await waitPhase(B, 'playing', 20000);
}

/** d4：phase=playing 后庄家徽标/庄家信息出现 */
async function dealerChecks() {
  await sleep(400);
  const d = JSON.parse(
    await cdp.eval(
      '(() => {' +
      ' const name = document.getElementById("stat-dealer");' +
      ' const avatar = document.getElementById("dealer-avatar");' +
      ' const row = document.querySelector(".center-dealer");' +
      ' return JSON.stringify({' +
      '  name: name ? (name.textContent || "").trim() : null,' +
      '  avatarVisible: !!avatar && !avatar.hidden,' +
      '  centerRowVisible: !!row && !row.hidden,' +
      '  seatDealer: document.querySelectorAll(".seat.dealer-seat").length,' +
      '  badgeDealer: document.querySelectorAll(".badge.dealer").length,' +
      '  myDealer: !!document.querySelector("#my-seat.dealer, .my-seat.dealer") }); })()'
    )
  );
  const ok =
    d.name && d.name !== '—' &&
    (d.avatarVisible || d.seatDealer > 0 || d.badgeDealer > 0 || d.myDealer);
  check(
    'd4.定庄后庄家徽标/庄家信息出现 (庄家=' + d.name + ')' ,
    ok,
    JSON.stringify(d)
  );
}

/* ---------------------------------------------------------------- 打完整局 */

/** 真人轮到就用 CDP 点弃牌（含二次确认）；返回是否点击成功 */
async function foldViaUI() {
  const clicked = await cdp.eval(
    '(() => { const b = document.getElementById("act-fold");' +
      ' if (!b || b.hidden || b.disabled) return "no"; b.click(); return "clicked"; })()'
  );
  if (clicked !== 'clicked') return false;
  // 二次确认弹窗
  const hasModal = await waitUntil(
    () =>
      cdp.eval(
        '(() => { const m = document.getElementById("modal-root");' +
          ' return !!(m && !m.hidden && m.querySelector("[data-ans=\\"1\\"]")); })()'
      ),
    3000,
    200
  );
  if (hasModal) {
    await cdp.eval(
      '(() => { const m = document.getElementById("modal-root");' +
        ' const b = m.querySelector("[data-ans=\\"1\\"]"); if (!b) return "no"; b.click(); return "clicked"; })()'
    );
  }
  return true;
}

/** 打完整局：真人一轮到就弃牌，人机服务端自驱动，直到 phase=showdown */
async function playHand(B) {
  const end = Date.now() + SHOWDOWN_TIMEOUT_MS;
  let uiFolds = 0;
  let httpFolds = 0;
  let badStreak = 0; // 连续取状态失败计数，防网络长期异常时死转
  while (Date.now() < end) {
    let st = null;
    try {
      st = await stateOf(B);
    } catch (e) {
      st = null;
    }
    if (!st || !st.ok) {
      badStreak += 1;
      if (badStreak > 25) throw new Error('连续取状态失败 25 次，放弃本局');
      await sleep(700);
      continue;
    }
    badStreak = 0;
    if (st.phase === 'showdown' || st.phase === 'lobby') {
      info('本局结束: phase=' + st.phase + ' · 真人弃牌 CDP=' + uiFolds + ' HTTP兜底=' + httpFolds);
      return st;
    }
    if (st.phase === 'playing' && st.turnId === st.me && !st.folded && st.inHand) {
      const ok = await foldViaUI();
      if (ok) uiFolds += 1;
      let st2 = null;
      try {
        st2 = await stateOf(B);
      } catch (e) {
        st2 = null;
      }
      const stillMine = st2 && st2.ok && st2.phase === 'playing' && st2.turnId === st2.me && !st2.folded;
      if (stillMine) {
        // UI 弃牌失败（重构中按钮可能缺失），HTTP 兜底保证牌局能走完
        try {
          await postJSON('/api/action', {
            roomId: B.roomId,
            playerId: B.playerId,
            token: B.token,
            action: 'fold',
            payload: {}
          });
          httpFolds += 1;
        } catch (e) {
          /* 下一轮重试 */
        }
      }
    }
    await sleep(600);
  }
  return null;
}

/** e：showdown 断言 winners 非空 + net 零和 */
function showdownChecks(st) {
  const winners = (st.lastResult && st.lastResult.winners) || [];
  const netSum = (st.players || []).reduce((s, p) => s + (Number(p.net) || 0), 0);
  const names = winners.map((w) => w.name + '(+' + w.amount + ')').join('、') || '无';
  check(
    'e1.到牌 phase=showdown，winners 非空 (' + names.slice(0, 80) + ')',
    st.phase === 'showdown' && winners.length > 0,
    'phase=' + st.phase + ' · lastResult=' + JSON.stringify(st.lastResult || {}).slice(0, 160)
  );
  check('e2.所有玩家 net 合计为 0（零和，Σ=' + netSum + '）', netSum === 0, 'Σnet=' + netSum);
  return winners.length > 0 && netSum === 0;
}

/* ---------------------------------------------------------------- 单组流程 */

async function runGroup(n) {
  console.log('');
  console.log('━━━━━━━━ ' + n + ' 人局 ' + (MODE === 'layout' ? '（layout：不打完整局）' : '') + '━━━━━━━━');

  const { B } = await setupRoom(n);

  const sr = await postJSON('/api/start', {
    roomId: B.roomId,
    playerId: B.playerId,
    token: B.token
  });
  if (!sr.ok) throw new Error('开局失败: ' + (sr.error || '?'));
  await waitPhase(B, 'bidding', 12000);
  info('✓ 开局 → phase=bidding（抢庄阶段）');

  await biddingChecks(B);
  await waitPhase(B, 'playing', 20000);
  await dealerChecks();

  // 三档视口布局检查 + 截图（此时在 playing 阶段，座位信息最完整）
  await sleep(600);
  const phases = [];
  for (const w of WIDTHS) {
    await setViewport(w);
    const st = await stateOf(B);
    phases.push(st.ok ? st.phase : '?');
    await layoutChecks(w, n);
  }
  if (new Set(phases).size > 1) {
    info('（提示：视口切换期间牌局阶段发生了变化 ' + phases.join('→') + '，截图内容随之不同）');
  }

  if (MODE === 'layout') {
    info('layout 模式：跳过完整一局');
    return;
  }

  const finalSt = await playHand(B);
  if (!finalSt) {
    check('e1.到牌 phase=showdown', false, '超时（' + SHOWDOWN_TIMEOUT_MS / 1000 + 's）未结算');
    return;
  }
  showdownChecks(finalSt);
}

/* ---------------------------------------------------------------- 清理 */

function killTree(proc, label) {
  if (!proc || !proc.pid) return;
  try {
    spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
  } catch (e) {
    /* ignore */
  }
  try {
    proc.kill();
  } catch (e) {
    /* ignore */
  }
  info('✓ 已停止 ' + label + ' (pid=' + proc.pid + ')');
}

async function cleanup() {
  if (cleaning) return;
  cleaning = true;
  try {
    if (cdp) {
      try {
        cdp.ws.close();
      } catch (e) {
        /* ignore */
      }
    }
    killTree(edgeProc, 'Edge');
    if (edgeProfile) {
      try {
        fs.rmSync(edgeProfile, { recursive: true, force: true });
      } catch (e) {
        /* %TEMP% 清理失败不影响结果 */
      }
    }
    if (serverProc) {
      killTree(serverProc, 'node server.js');
      await sleep(600);
      try {
        fs.rmSync(path.join(ROOT, 'data', 'rooms.json'), { force: true });
        info('✓ 已删除 data/rooms.json（防止残留测试玩家占满 150 人上限）');
      } catch (e) {
        failures += 1;
        totalChecks += 1;
        check('删除 data/rooms.json', false, e.message);
      }
    } else {
      info('⚠ 使用外部服务（' + BASE + '），未自动停服；测试产生的房间请停服后手动删除 data/rooms.json');
    }
  } finally {
    console.log('');
    console.log('════════ 汇总 ════════');
    console.log(
      '  模式 ' + MODE + ' · 断言 ' + totalChecks + ' 项 · 失败 ' + failures + ' 项'
    );
    if (cdp && cdp.consoleErrors.length) {
      console.log('  ⚠ 浏览器控制台错误 ' + cdp.consoleErrors.length + ' 条（不计入断言）:');
      for (const e of cdp.consoleErrors.slice(0, 8)) console.log('    - ' + String(e).slice(0, 220));
    }
    try {
      const shots = fs.readdirSync(SHOT_DIR).filter((f) => f.endsWith('.png'));
      console.log('  📸 截图目录: ' + SHOT_DIR + '（' + shots.length + ' 张）');
    } catch (e) {
      /* ignore */
    }
    console.log('  退出码: ' + (failures ? 1 : 0));
  }
}

/* ---------------------------------------------------------------- 主流程 */

async function main() {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  console.log('table-verify · 模式=' + MODE + ' · ' + BASE);
  console.log('组=' + GROUPS.join('/') + '人 · 视口=' + WIDTHS.join('/') + ' · 截图=' + SHOT_DIR);

  await ensureServer();

  edgeProfile = path.join(os.tmpdir(), 'zjh-table-verify-profile-' + Date.now());
  edgeProc = await launchEdge(edgeProfile);
  const target = await connectTargets();
  cdp = new CDP(await openWS(target.webSocketDebuggerUrl));
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await setViewport(WIDTHS[1]);

  for (const n of GROUPS) {
    try {
      await runGroup(n);
    } catch (e) {
      failures += 1;
      totalChecks += 1;
      check(n + '人局流程中断（致命）', false, e.message);
    }
  }
}

main()
  .catch(async (e) => {
    console.error('\n✖ 验收脚本异常: ' + (e && e.message ? e.message : e));
    failures += 1;
  })
  .finally(async () => {
    await cleanup();
    setTimeout(() => process.exit(failures ? 1 : 0), 400);
  });

process.on('SIGINT', () => {
  console.log('\n(收到中断，清理后退出)');
  cleanup().then(() => process.exit(1));
});
