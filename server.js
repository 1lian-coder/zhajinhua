'use strict';

/**
 * 炸金花网页版 —— 零依赖 HTTP + SSE 服务端
 *
 *   node server.js            # 默认 http://0.0.0.0:8080
 *   PORT=3000 node server.js
 *
 * 设计要点：
 * - 不用 socket.io / express，只用 Node 内置模块；不需要 npm install，不会有依赖漏洞或版本漂移。
 * - 实时推送用 SSE：一条长连接，浏览器自动重连，穿透各种代理都比 WebSocket 稳。
 * - 房间状态全内存 + 定时落盘（data/rooms.json），进程重启不丢房间。
 * - 所有入口 try/catch，任何异常都不会让进程退出。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const os = require('os');

const { Room, MAX_PLAYERS } = require('./lib/engine');

const VERSION = '1.0.0';
const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const STATE_FILE = path.join(DATA_DIR, 'rooms.json');
const PLAYERS_FILE = path.join(DATA_DIR, 'players.json'); // 按昵称累计积分
const HISTORY_FILE = path.join(DATA_DIR, 'history.json'); // 历史牌局（最近 500 局）

const MAX_BODY = 64 * 1024;
const SSE_PING_MS = 20000;
const TICK_MS = 1000;
const IDLE_ROOM_MS = 2 * 60 * 60 * 1000; // 有连接但长时间无操作的兜底
const NOBODY_GRACE_MS = Number(process.env.ZJH_IDLE_CLOSE_MS) || 10 * 60 * 1000; // 页面上没人后多久解散房间（10 分钟，避免切后台丢房间）
const GC_INTERVAL_MS = Number(process.env.ZJH_GC_MS) || 10000;
const SAVE_DEBOUNCE_MS = 2000;
const RATE_WINDOW_MS = 3000;
const RATE_MAX = 60;

/** @type {Map<string, Room>} */
const rooms = new Map();
/** @type {Map<string, Map<string, Set<http.ServerResponse>>>} */
const streams = new Map();
/** @type {Map<string, {count:number, ts:number}>} */
const rateBuckets = new Map();

let dirty = false;
let lastSave = 0;
const startedAt = Date.now();
const BUILD_VER = String(startedAt); // 静态资源缓存版本：每次重启/部署都会变

// ---------------------------------------------------------------- 工具

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

// ------------------------------------------------ 服务器语音合成（荷官音色）
// 优先用微软 Edge 神经语音（普通话女声，接近荷官播报），失败时回退 espeak-ng。
const TTS_CACHE = new Map(); // text -> { buf, mime }
const TTS_CACHE_MAX = 300;
const TTS_VOICE = process.env.ZJH_TTS_VOICE || 'zh-CN-XiaoxiaoNeural';
const TTS_VER = 'p1'; // 语音版本：换音色/修复后 +1，客户端缓存随之失效
const FALLBACK_TTL_MS = 60 * 1000; // 旧音兜底缓存 1 分钟后重试荷官音
const ttsBuckets = new Map();

function ttsAllow(ip) {
  const now = Date.now();
  const arr = (ttsBuckets.get(ip) || []).filter((t) => now - t < 60000);
  if (arr.length >= 120) {
    ttsBuckets.set(ip, arr);
    return false;
  }
  arr.push(now);
  ttsBuckets.set(ip, arr);
  return true;
}

function sanitizeTtsText(raw) {
  let t = String(raw || '');
  t = t.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (t.length > 60) t = t.slice(0, 60);
  return t;
}

/** 微软 Edge 神经语音：更适合“荷官播报”，返回 mp3 */
function synthEdge(text) {
  return new Promise((resolve, reject) => {
    const tmp = path.join(os.tmpdir(), 'zjh-edge-' + crypto.randomBytes(6).toString('hex') + '.mp3');
    let child;
    const cleanup = () => {
      fs.unlink(tmp, () => { /* ignore */ });
    };
    try {
      child = spawn('edge-tts', ['--voice', TTS_VOICE, '--rate=+12%', '--text', text, '--write-media', tmp], {
        stdio: ['ignore', 'ignore', 'pipe']
      });
    } catch (e) {
      reject(e);
      return;
    }
    let done = false;
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    const finish = (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (err) {
        cleanup();
        reject(err);
        return;
      }
      fs.readFile(tmp, (readErr, buf) => {
        cleanup();
        if (!readErr && buf && buf.length > 200) resolve({ buf, mime: 'audio/mpeg' });
        else reject(new Error('edge 空音频'));
      });
    };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (e) { /* ignore */ }
      finish(new Error('edge tts timeout'));
    }, 15000);
    child.on('error', (err) => finish(err));
    child.on('close', (code) => {
      if (code === 0) finish(null);
      else finish(new Error('edge exit ' + code + (stderr ? ': ' + stderr.slice(0, 100) : '')));
    });
  });
}

/** espeak-ng 兜底：写临时 wav 再读 */
function synthEspeak(text) {
  return new Promise((resolve, reject) => {
    const tmp = path.join(os.tmpdir(), 'zjh-tts-' + crypto.randomBytes(6).toString('hex') + '.wav');
    let child;
    const cleanup = () => {
      fs.unlink(tmp, () => { /* ignore */ });
    };
    try {
      child = spawn('espeak-ng', ['-v', 'cmn', '-s', '150', '-p', '55', '-w', tmp, '--stdin'], {
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch (e) {
      reject(e);
      return;
    }
    let done = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (err) {
        cleanup();
        reject(err);
        return;
      }
      fs.readFile(tmp, (readErr, buf) => {
        cleanup();
        if (!readErr && buf && buf.length > 200) resolve({ buf, mime: 'audio/wav' });
        else reject(new Error('espeak 空音频'));
      });
    };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (e) { /* ignore */ }
      finish(new Error('espeak tts timeout'));
    }, 8000);
    child.on('error', (err) => finish(err));
    child.on('close', (code) => {
      if (code === 0) finish(null);
      else finish(new Error('espeak exit ' + code));
    });
    try {
      child.stdin.write(text + '\n');
      child.stdin.end();
    } catch (e) { /* ignore */ }
  });
}

/* ---------------- Piper 本地神经语音（优先：不联网、约 0.3~0.5 秒/句） ---------------- */
const PIPER_BIN = process.env.PIPER_BIN || '/opt/zhajinhua/tools/piper/piper/piper';
const PIPER_MODEL = process.env.PIPER_MODEL || '/opt/zhajinhua/tools/piper/voices/zh_CN-huayan-medium.onnx';
const PIPER_DIR = process.env.PIPER_OUT_DIR || '/tmp/zjh-piper-out';
const piperQueue = [];
let piperProc = null;

function ensurePiper() {
  if (piperProc) return piperProc;
  try {
    if (!fs.existsSync(PIPER_BIN)) return null;
    fs.mkdirSync(PIPER_DIR, { recursive: true });
    const p = spawn(PIPER_BIN, ['--model', PIPER_MODEL, '--output_dir', PIPER_DIR], {
      cwd: path.dirname(PIPER_BIN),
      env: Object.assign({}, process.env, { LD_LIBRARY_PATH: path.dirname(PIPER_BIN) + ':' + (process.env.LD_LIBRARY_PATH || '') }),
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let buf = '';
    p.stdout.on('data', (d) => {
      buf += d.toString();
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!/\.wav$/.test(line)) continue;
        const task = piperQueue.shift();
        if (!task) continue;
        fs.readFile(line, (err, data) => {
          fs.unlink(line, () => { /* ignore */ });
          if (err || !data || data.length < 100) task.reject(new Error('piper 读取失败'));
          else task.resolve({ buf: data, mime: 'audio/wav' });
        });
      }
    });
    p.stderr.on('data', () => { /* 忽略日志 */ });
    p.on('error', () => {
      piperProc = null;
    });
    p.on('exit', () => {
      piperProc = null;
      while (piperQueue.length) {
        const t = piperQueue.shift();
        try { t.reject(new Error('piper 退出')); } catch (e) { /* ignore */ }
      }
    });
    piperProc = p;
    return piperProc;
  } catch (e) {
    piperProc = null;
    return null;
  }
}

/** 交给常驻 piper 合成一句，返回 { buf, mime: 'audio/wav' } */
function piperSpeak(text) {
  return new Promise((resolve, reject) => {
    const proc = ensurePiper();
    if (!proc) {
      reject(new Error('piper 不可用'));
      return;
    }
    const task = { resolve, reject, done: false };
    piperQueue.push(task);
    const timer = setTimeout(() => {
      if (task.done) return;
      task.done = true;
      const i = piperQueue.indexOf(task);
      if (i >= 0) piperQueue.splice(i, 1);
      reject(new Error('piper 超时'));
      try { proc.kill('SIGKILL'); } catch (e) { /* ignore */ }
      piperProc = null;
    }, 5000);
    const wrap = (fn) => (v) => {
      if (task.done) return;
      task.done = true;
      clearTimeout(timer);
      fn(v);
    };
    task.resolve = wrap(resolve);
    task.reject = wrap(reject);
    try {
      proc.stdin.write(text + '\n');
    } catch (e) {
      task.reject(e);
    }
  });
}
/** 合成顺序：本地 Piper（最快）→ Edge 云端（更好听，重试两次）→ espeak（兜底） */
async function synthSpeech(text) {
  try {
    const r = await piperSpeak(text);
    return { buf: r.buf, mime: r.mime, fallback: false, engine: 'piper', ts: Date.now() };
  } catch (piperErr) {
    // 本地合成不可用时再走云端
    if (!global.__piperWarned) {
      global.__piperWarned = true;
      console.error('[tts] piper 不可用，改用云端语音:', piperErr && piperErr.message);
    }
  }
  let edgeErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await synthEdge(text);
      return { buf: r.buf, mime: r.mime, fallback: false, engine: 'edge', ts: Date.now() };
    } catch (e) {
      edgeErr = e;
      if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }
  console.error('[tts] piper/edge 都失败，临时回退 espeak:', text, edgeErr && edgeErr.message);
  const es = await synthEspeak(text);
  return { buf: es.buf, mime: es.mime, fallback: true, engine: 'espeak', ts: Date.now() };
}

/* ---- 串行合成队列：同一时间只跑一个合成，避免 edge-tts 并发超时 ---- */
const ttsTasks = [];
let ttsRunning = false;

function pumpTts() {
  if (ttsRunning || !ttsTasks.length) return;
  ttsRunning = true;
  const task = ttsTasks.shift();
  synthSpeech(task.text)
    .then((entry) => task.resolve(entry))
    .catch((err) => task.reject(err))
    .finally(() => {
      ttsRunning = false;
      setImmediate(pumpTts);
    });
}

function synthQueued(text, priority) {
  return new Promise((resolve, reject) => {
    if (priority) ttsTasks.unshift({ text, resolve, reject });
    else ttsTasks.push({ text, resolve, reject });
    pumpTts();
  });
}

function ttsCacheKey(text) {
  return TTS_VER + '|' + text;
}

function cachePut(text, entry) {
  if (TTS_CACHE.size >= TTS_CACHE_MAX) {
    const first = TTS_CACHE.keys().next().value;
    if (first !== undefined) TTS_CACHE.delete(first);
  }
  TTS_CACHE.set(ttsCacheKey(text), entry);
}

/* ---- 预生成：玩家进房时热身“XX 已看牌/已弃牌”，让播报几乎即时 ---- */
const prefetchQueue = [];
let prefetchBusy = false;

function prefetchTts(texts) {
  if (ttsTasks.length > 40) return;
  for (const t of texts) {
    const text = sanitizeTtsText(t);
    if (!text || TTS_CACHE.has(ttsCacheKey(text))) continue;
    if (prefetchQueue.includes(text)) continue;
    if (prefetchQueue.length >= 300) break;
    prefetchQueue.push(text);
  }
  prefetchNext();
}

function prefetchNext() {
  if (prefetchBusy || !prefetchQueue.length) return;
  prefetchBusy = true;
  const text = prefetchQueue.shift();
  if (TTS_CACHE.has(ttsCacheKey(text))) {
    prefetchBusy = false;
    setImmediate(prefetchNext);
    return;
  }
  synthQueued(text, false).then((entry) => {
    cachePut(text, entry);
    if (prefetchQueue.length || true) console.log('[tts] 预生成完成:', text);
  }).catch((err) => {
    console.error('[tts] 预生成失败:', text, err && err.message ? err.message : err);
  }).finally(() => {
    prefetchBusy = false;
    setImmediate(prefetchNext);
  });
}

function prefetchTurnVoice(room) {
  try {
    if (!room || room.phase !== 'playing' || !room.turnId) return;
    const p = room.players.get(room.turnId);
    if (!p) return;
    const cost = room.callCost(p);
    const texts = [p.name + ' 押注 ' + cost, p.name + ' 已弃牌', p.name + ' 已比牌'];
    if (!p.seen) texts.push(p.name + ' 已看牌');
    prefetchTts(texts);
  } catch (e) { /* ignore */ }
}

function warmBetVoice(room) {
  try {
    const ante = Number(room.config && room.config.ante) || 10;
    const texts = [];
    for (const p of room.players.values()) {
      if (!p.inHand) continue;
      texts.push(p.name + ' 押注 ' + ante);
      texts.push(p.name + ' 押注 ' + (ante * 2));
    }
    prefetchTts(texts);
  } catch (e) { /* ignore */ }
}

function warmPlayerVoice(name) {
  const n = sanitizeTtsText(name);
  if (!n) return;
  prefetchTts([n + ' 已看牌', n + ' 已弃牌', n + ' 已比牌']);
}

function sendTts(res, entry) {
  res.writeHead(200, {
    'Content-Type': entry.mime,
    'Content-Length': entry.buf.length,
    // 荷官音正常缓存；espeak 兜底不缓存，避免以后一直听到旧音
    'Cache-Control': entry.fallback ? 'no-store' : 'public, max-age=86400'
  });
  res.end(entry.buf);
}

async function handleTts(req, res, params) {
  const text = sanitizeTtsText(params.get('text'));
  if (!text) {
    json(res, 400, { ok: false, error: '缺少文字' });
    return;
  }
  const cacheKey = ttsCacheKey(text);
  const cached = TTS_CACHE.get(cacheKey);
  if (cached && !(cached.fallback && Date.now() - cached.ts > FALLBACK_TTL_MS)) {
    sendTts(res, cached);
    return;
  }
  const ip = (req.socket && req.socket.remoteAddress) || 'unknown';
  if (!ttsAllow(ip)) {
    json(res, 429, { ok: false, error: '语音请求太频繁，稍后自动重试' });
    return;
  }
  try {
    const entry = await synthQueued(text, true);
    cachePut(text, entry);
    sendTts(res, entry);
  } catch (err) {
    console.error('[tts] 合成失败:', err && err.message ? err.message : err);
    json(res, 500, { ok: false, error: '语音合成失败' });
  }
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(parsed && typeof parsed === 'object' ? parsed : {});
      } catch (e) {
        reject(new Error('请求格式错误'));
      }
    });
    req.on('error', reject);
  });
}

function rateLimited(key, max = RATE_MAX) {
  const now = Date.now();
  const b = rateBuckets.get(key);
  if (!b || now - b.ts > RATE_WINDOW_MS) {
    rateBuckets.set(key, { count: 1, ts: now });
    return false;
  }
  b.count += 1;
  if (b.count > max) return true;
  return false;
}

// ---- 公网防护：资源上限（防止恶意刷房间/刷连接把进程拖垮）----
const MAX_ROOMS = Number(process.env.ZJH_MAX_ROOMS) || 50;
const MAX_TOTAL_PLAYERS = Number(process.env.ZJH_MAX_PLAYERS) || 150;
const SSE_MAX_PER_PLAYER = 3;   // 同一玩家最多并开几个页面
const SSE_MAX_TOTAL = 300;      // 全服 SSE 连接上限

function totalPlayerCount() {
  let n = 0;
  for (const r of rooms.values()) n += r.players.size;
  return n;
}

function sseTotalCount() {
  let n = 0;
  for (const byPlayer of streams.values()) {
    for (const set of byPlayer.values()) n += set.size;
  }
  return n;
}

function genRoomId() {
  for (let i = 0; i < 50; i++) {
    const id = String(crypto.randomInt(100000, 1000000));
    if (!rooms.has(id)) return id;
  }
  return String(Date.now()).slice(-6);
}

/** 造一个"用户可见的已知错误"，避免被当成未预期异常打印堆栈 */
function userError(message, code) {
  const err = new Error(message);
  err.isGameError = true;
  if (code) err.appCode = code;
  return err;
}

function markDirty() {
  dirty = true;
}

// ---------------------------------------------------------------- 落盘

/* -------------------------------------------------- 战绩/积分持久化（按昵称） */

let playerStats = {};   // name -> { net, hands, wins, best, updatedAt }
let handHistory = [];   // 最近牌局 [{ at, roomId, handNo, reason, pot, players: [{name, delta, net}] }]
let recordDirty = false;
let recordSaveAt = 0;
const RECORD_SAVE_MS = 1500;
const HISTORY_MAX = 500;

function loadRecords() {
  try {
    if (fs.existsSync(PLAYERS_FILE)) {
      const raw = JSON.parse(fs.readFileSync(PLAYERS_FILE, 'utf8'));
      if (raw && typeof raw === 'object') playerStats = raw;
    }
    if (fs.existsSync(HISTORY_FILE)) {
      const raw = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
      if (Array.isArray(raw)) handHistory = raw.slice(-HISTORY_MAX);
    }
    console.log('[load] 历史战绩 ' + Object.keys(playerStats).length + ' 人 / ' + handHistory.length + ' 局');
  } catch (e) {
    console.error('[load] 战绩读取失败:', e.message);
  }
}

function saveRecords(force) {
  const now = Date.now();
  if (!force && !recordDirty) return;
  if (!force && now - recordSaveAt < RECORD_SAVE_MS) return;
  recordSaveAt = now;
  recordDirty = false;
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp1 = PLAYERS_FILE + '.tmp';
    fs.writeFileSync(tmp1, JSON.stringify(playerStats));
    fs.renameSync(tmp1, PLAYERS_FILE);
    const tmp2 = HISTORY_FILE + '.tmp';
    fs.writeFileSync(tmp2, JSON.stringify(handHistory.slice(-HISTORY_MAX)));
    fs.renameSync(tmp2, HISTORY_FILE);
  } catch (e) {
    console.error('[save] 战绩落盘失败:', e.message);
  }
}

function ensureStat(name) {
  const key = String(name || '').slice(0, 20);
  if (!key) return null;
  if (!playerStats[key]) playerStats[key] = { net: 0, hands: 0, wins: 0, best: 0, updatedAt: 0 };
  return playerStats[key];
}

/** 一局结算后：累计到玩家档案 + 追加历史（同一局只记一次） */
function maybeRecordHand(room) {
  try {
    if (!room || room.phase !== 'showdown' || !room.lastResult) return;
    const r = room.lastResult;
    const key = room.id + '#' + (r.handNo || 0) + '#' + (r.at || 0);
    if (room._recordedKey === key) return;
    room._recordedKey = key;
    const deltas = r.deltas || [];
    if (!deltas.length) return;
    const at = Date.now();
    const entry = {
      at,
      roomId: room.id,
      handNo: r.handNo || room.handNo || 0,
      reason: r.reason || '',
      pot: r.pot != null ? r.pot : 0,
      players: []
    };
    for (const d of deltas) {
      const st = ensureStat(d.name);
      if (st) {
        st.net = (Number(st.net) || 0) + (Number(d.delta) || 0);
        st.hands = (Number(st.hands) || 0) + 1;
        if ((Number(d.delta) || 0) > 0) st.wins = (Number(st.wins) || 0) + 1;
        if ((Number(d.delta) || 0) > (Number(st.best) || 0)) st.best = Number(d.delta) || 0;
        st.updatedAt = at;
      }
      entry.players.push({ name: d.name, delta: d.delta, net: d.net });
    }
    handHistory.push(entry);
    if (handHistory.length > HISTORY_MAX) handHistory = handHistory.slice(-HISTORY_MAX);
    recordDirty = true;
    saveRecords(false);
  } catch (e) {
    console.error('[record] 记录失败:', e.message);
  }
}

/** 查询某人历史 */
function getHistory(name, limit) {
  const key = String(name || '').slice(0, 20);
  const st = key && playerStats[key] ? playerStats[key] : null;
  const lim = Math.max(1, Math.min(50, Number(limit) || 20));
  const hands = [];
  for (let i = handHistory.length - 1; i >= 0 && hands.length < lim; i--) {
    const h = handHistory[i];
    const mine = (h.players || []).find((p) => p.name === key);
    if (!mine) continue;
    hands.push({
      at: h.at,
      roomId: h.roomId,
      handNo: h.handNo,
      reason: h.reason,
      pot: h.pot,
      delta: mine.delta,
      net: mine.net,
      players: (h.players || []).map((p) => ({ name: p.name, delta: p.delta }))
    });
  }
  return {
    ok: true,
    name: key,
    cumulative: st ? { net: st.net, hands: st.hands, wins: st.wins, best: st.best, updatedAt: st.updatedAt } : { net: 0, hands: 0, wins: 0, best: 0, updatedAt: 0 },
    hands
  };
}

function saveState(force) {
  const now = Date.now();
  if (!force && (!dirty || now - lastSave < SAVE_DEBOUNCE_MS)) return;
  lastSave = now;
  dirty = false;
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const payload = {
      savedAt: now,
      version: VERSION,
      rooms: [...rooms.values()].map((r) => r.toJSON())
    };
    const tmp = STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(payload));
    fs.renameSync(tmp, STATE_FILE);
  } catch (e) {
    console.error('[save] 落盘失败:', e.message);
  }
}

function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    for (const r of raw.rooms || []) {
      try {
        const room = Room.fromJSON(r);
    if (room.players.size > 0) {
      room.hadSSE = true; // 从磁盘恢复的房间：页面上没人就按宽限时间解散
      rooms.set(room.id, room);
    }
      } catch (e) {
        console.error('[load] 跳过损坏房间:', e.message);
      }
    }
    console.log(`[load] 恢复 ${rooms.size} 个房间`);
  } catch (e) {
    console.error('[load] 状态文件读取失败:', e.message);
  }
}

// ---------------------------------------------------------------- SSE 广播

function broadcast(room) {
  if (!room) return;
  maybeRecordHand(room);
  prefetchTurnVoice(room);
  markDirty();
  const byPlayer = streams.get(room.id);
  if (!byPlayer || byPlayer.size === 0) return;

  for (const [pid, set] of byPlayer) {
    let data;
    try {
      data = JSON.stringify(room.serialize(pid));
    } catch (e) {
      console.error('[broadcast] 序列化失败:', e.message);
      continue;
    }
    const frame = `event: state\ndata: ${data}\n\n`;
    for (const res of set) {
      try {
        res.write(frame);
      } catch (e) {
        /* 连接已断，close 事件会清理 */
      }
    }
  }
}

function unregisterStream(roomId, pid, res) {
  const byPlayer = streams.get(roomId);
  if (!byPlayer) return;
  const set = byPlayer.get(pid);
  if (set) {
    set.delete(res);
    if (set.size === 0) byPlayer.delete(pid);
  }
  if (byPlayer.size === 0) streams.delete(roomId);

  const room = rooms.get(roomId);
  if (room) {
    const p = room.getPlayer(pid);
    const stillOpen = streams.get(roomId) && streams.get(roomId).get(pid);
    if (p && !stillOpen) {
      p.connected = false;
      p.lastSeen = Date.now();
      broadcast(room);
    } else if (!p) {
      // 观战者离线
      const s = room.spectators.get(pid);
      if (s && !stillOpen) {
        s.connected = false;
        broadcast(room);
      }
    }
  }
}

// ---------------------------------------------------------------- 静态文件

/** 页面上还有多少人（连接中的真人 + 观战者；人机不算） */
function liveCount(room) {
  let n = 0;
  for (const p of room.players.values()) if (!p.isBot && p.connected) n++;
  for (const s of room.spectators.values()) if (s.connected) n++;
  return n;
}

/** 房间里还有几个真人（人机不算） */
function humansIn(room) {
  let n = 0;
  for (const p of room.players.values()) if (!p.isBot) n++;
  return n;
}

/** 关闭房间：先通知所有 SSE 连接（前端会退回首页），再删除房间 */
function closeRoom(room, reason) {
  const byPlayer = streams.get(room.id);
  if (byPlayer) {
    for (const set of byPlayer.values()) {
      for (const res of set) {
        try {
          res.write(`event: closed\ndata: ${JSON.stringify({ reason })}\n\n`);
          res.end();
        } catch (e) {
          /* ignore */
        }
      }
    }
    streams.delete(room.id);
  }
  rooms.delete(room.id);
  console.log(`[room] 关闭房间 ${room.id}：${reason}`);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json'
};

function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath.split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';

  const target = path.resolve(PUBLIC_DIR, '.' + rel);
  if (target !== PUBLIC_DIR && !target.startsWith(PUBLIC_DIR + path.sep)) {
    json(res, 403, { ok: false, error: '禁止访问' });
    return;
  }

  fs.stat(target, (err, stat) => {
    if (err || !stat.isFile()) {
      // 单页应用兜底：非静态资源路径回首页
      if (!path.extname(target)) {
        return serveFile(path.join(PUBLIC_DIR, 'index.html'), res);
      }
      json(res, 404, { ok: false, error: '页面不存在' });
      return;
    }
    serveFile(target, res);
  });
}

function serveFile(file, res) {
  if (path.basename(file) === 'index.html') {
    fs.readFile(file, 'utf8', (err, html) => {
      if (err) {
        json(res, 404, { ok: false, error: '页面不存在' });
        return;
      }
      const out = html.split('__VER__').join(BUILD_VER);
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Content-Length': Buffer.byteLength(out)
      });
      res.end(out);
    });
    return;
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      json(res, 404, { ok: false, error: '页面不存在' });
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'Content-Length': buf.length
    });
    res.end(buf);
  });
}

// ---------------------------------------------------------------- 业务处理

function getRoomOrThrow(roomId) {
  const room = rooms.get(String(roomId || ''));
  if (!room) throw new Error('房间不存在或已过期');
  return room;
}

function authPlayer(body) {
  const room = getRoomOrThrow(body.roomId);
  const p = room.auth(String(body.playerId || ''), String(body.token || ''));
  if (!p) throw new Error('身份验证失败，请重新加入房间');
  return { room, player: p };
}

// ---------------------------------------------------------------- 创建口令

/**
 * 创建口令的两种来源（设置后，创建房间必须带正确口令；加入房间不受影响）：
 *   1) 环境变量 CREATE_PIN（云平台部署用，口令不落仓库）
 *   2) data/settings.json 的 createPin（本地用 set-pin.bat 写）
 * 环境变量优先。每次都重新读，改口令不用重启服务（环境变量除外）。
 */
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
let settingsCache = { mtime: 0, data: {} };

function loadSettings() {
  // 1) 环境变量优先（云平台）
  const envPin = String(process.env.CREATE_PIN || '').trim();
  if (/^\d{3,8}$/.test(envPin)) {
    return { createPin: envPin };
  }

  // 2) 本地配置文件
  // 文件极小，直接每次读，避免任何缓存边界问题
  try {
    // 剥掉可能存在的 UTF-8 BOM（PowerShell 5.1 写文件会带，JSON.parse 遇到会失败）
    const text = fs
      .readFileSync(SETTINGS_FILE, 'utf8')
      .replace(/^\uFEFF/, '');
    const raw = JSON.parse(text);
    settingsCache = { data: raw && typeof raw === 'object' ? raw : {} };
  } catch (e) {
    // 解析失败时提醒一下，方便发现问题；文件不存在属正常不刷屏
    if (fs.existsSync(SETTINGS_FILE)) {
      console.error('[settings] settings.json 解析失败，按未设置口令处理:', e.message);
    }
    settingsCache = { data: {} };
  }
  const pin = settingsCache.data ? String(settingsCache.data.createPin || '').trim() : '';
  return {
    createPin: /^\d{3,8}$/.test(pin) ? pin : ''
  };
}

// 口令防爆破：全局错误计数，10 分钟窗口内最多错 15 次
const pinFails = [];
function recordPinFail() {
  const now = Date.now();
  while (pinFails.length && now - pinFails[0] > 10 * 60 * 1000) pinFails.shift();
  pinFails.push(now);
}
function pinLocked() {
  const now = Date.now();
  while (pinFails.length && now - pinFails[0] > 10 * 60 * 1000) pinFails.shift();
  return pinFails.length >= 15;
}

function checkCreatePin(body) {
  const { createPin } = loadSettings();
  if (!createPin) return; // 未设置口令，任何人都能创建
  if (pinLocked()) throw new Error('口令错误次数太多，请 10 分钟后再试');
  const given = String((body && body.pin) || '').trim();
  if (given !== createPin) {
    recordPinFail();
    const err = new Error(given ? '创建口令不正确' : '需要创建口令');
    err.appCode = 'PIN_REQUIRED';
    throw err;
  }
}

const api = {
  async create(body) {
    // 公开接口必须有频率限制，否则可被脚本刷爆内存
    if (rateLimited('create', 5)) throw userError('创建太频繁了，请几秒后再试');
    if (rooms.size >= MAX_ROOMS) throw userError('服务器房间已满，请稍后再试');
    checkCreatePin(body);
    const name = body.name;
    const id = genRoomId();
    const room = new Room(id, body.config);
    const player = room.addPlayer(name, { avatar: body.avatar, sitOut: !!body.sitOut });
    rooms.set(id, room);
    room.log(`房间 ${id} 已创建`);
    warmPlayerVoice(player.name);
    markDirty();
    return { ok: true, roomId: id, playerId: player.id, token: player.token };
  },

  async join(body) {
    if (rateLimited('join', 30)) throw userError('操作太频繁，请稍后再试');
    if (totalPlayerCount() >= MAX_TOTAL_PLAYERS) throw userError('服务器人数已满，请稍后再试');
    const room = getRoomOrThrow(body.roomId);
    if (room.players.size >= MAX_PLAYERS) throw userError(`房间已满（最多 ${MAX_PLAYERS} 人）`);
    // 房间密码校验（防猜：全局计数，10 分钟窗口 20 次）
    if (room.joinPin) {
      if (pinLocked()) throw userError('密码错误次数太多，请 10 分钟后再试');
      if (!room.checkJoinPin(body.password)) {
        recordPinFail();
        throw userError(
          String(body.password || '') ? '房间密码不正确' : '这个房间需要密码',
          'ROOM_PASSWORD_REQUIRED'
        );
      }
    }
    const player = room.addPlayer(body.name, { avatar: body.avatar });
    warmPlayerVoice(player.name);
    markDirty();
    broadcast(room);
    return { ok: true, roomId: room.id, playerId: player.id, token: player.token };
  },

  /** 房主添加人机（大厅/结算阶段） */
  async addBot(body) {
    const { room, player } = authPlayer(body);
    if (room.hostId !== player.id) throw userError('只有房主可以添加人机');
    if (room.phase === 'playing') throw userError('牌局进行中不能添加人机，等本局结束');
    const bot = room.addBot(body.name);
    markDirty();
    broadcast(room);
    return { ok: true, playerId: bot.id, name: bot.name, isBot: true };
  },

  /** 房主移除人机（大厅/结算阶段） */
  async removeBot(body) {
    const { room, player } = authPlayer(body);
    if (room.hostId !== player.id) throw userError('只有房主可以移除人机');
    if (room.phase === 'playing') throw userError('牌局进行中不能移除人机，等本局结束');
    const target = room.getPlayer(String(body.target || ''));
    if (!target || !target.isBot) throw userError('只能移除人机玩家');
    const name = target.name;
    room.removePlayer(target.id);
    room.log(`房主移除了人机 ${name}`);
    markDirty();
    if (humansIn(room) === 0) {
      closeRoom(room, '房间里没有真人了');
    } else {
      broadcast(room);
    }
    return { ok: true };
  },

  /** 本局参与 / 观战切换（局间有效） */
  async sitOut(body) {
    const { room, player } = authPlayer(body);
    const val = room.setSitOut(player.id, !!body.sitOut);
    markDirty();
    broadcast(room);
    return { ok: true, sitOut: val };
  },

  /** 房主重置所有人积分/战绩（局间） */
  async resetScores(body) {
    const { room, player } = authPlayer(body);
    room.resetScores(player.id);
    markDirty();
    broadcast(room);
    return { ok: true };
  },

  /** 换座位（大厅/结算阶段；空位可坐，出牌顺序按座位） */
  async setSeat(body) {
    const { room, player } = authPlayer(body);
    room.setSeat(player.id, body.seat);
    markDirty();
    broadcast(room);
    return { ok: true };
  },

  /** 设置头像（表情，服务端白名单校验） */
  async avatar(body) {
    const { room, player } = authPlayer(body);
    const avatar = room.setAvatar(player.id, body.avatar);
    markDirty();
    broadcast(room);
    return { ok: true, avatar };
  },

  async rejoin(body) {
    const { room, player } = authPlayer(body);
    player.connected = true;
    broadcast(room);
    return { ok: true, roomId: room.id, playerId: player.id, token: player.token };
  },

  async action(body) {
    const { room, player } = authPlayer(body);
    if (rateLimited(player.id)) throw new Error('操作太快了，请稍等');
    room.act(player.id, body.action, body.payload || {});
    broadcast(room);
    return { ok: true };
  },

  async look(body) {
    const { room, player } = authPlayer(body);
    room.look(player.id);
    broadcast(room);
    return { ok: true };
  },

  /** 快捷聊天 */
  async chat(body) {
    const { room, player } = authPlayer(body);
    if (rateLimited('chat:' + player.id, 2)) throw userError('说太快啦，歇一下');
    room.addChat(player.id, body.text);
    broadcast(room);
    return { ok: true };
  },

  async config(body) {
    const { room, player } = authPlayer(body);
    room.setConfig(body.config, player.id);
    broadcast(room);
    return { ok: true, config: room.config };
  },

  /** 观战：不占座位，看公共信息（开牌后才能看到牌），不能操作。
   *  服务器设了创建口令时，观战也需要口令——只有知道口令的人能看牌局 */
  async watch(body) {
    if (rateLimited('watch', 20)) throw userError('操作太频繁，请稍后再试');
    const settings = loadSettings();
    if (settings.createPin && String(body.pin || '').trim() !== settings.createPin) {
      throw userError('需要口令才能观战', 'PIN_REQUIRED');
    }
    const room = getRoomOrThrow(body.roomId);
    if (room.joinPin) {
      if (pinLocked()) throw userError('密码错误次数太多，请 10 分钟后再试');
      if (!room.checkJoinPin(body.password)) {
        recordPinFail();
        throw userError(
          String(body.password || '') ? '房间密码不正确' : '这个房间需要密码',
          'ROOM_PASSWORD_REQUIRED'
        );
      }
    }
    const s = room.addSpectator(body.name);
    markDirty();
    broadcast(room);
    return { ok: true, roomId: room.id, playerId: s.id, token: s.token, spectating: true };
  },

  /** 观战大厅：列出进行中的房间（服务器设了创建口令时，需要口令才能看列表） */
  async rooms(body) {
    const settings = loadSettings();
    if (settings.createPin && String(body.pin || '').trim() !== settings.createPin) {
      throw userError('需要口令才能查看房间列表', 'PIN_REQUIRED');
    }
    const list = [];
    for (const r of rooms.values()) {
      list.push({
        roomId: r.id,
        players: r.players.size,
        maxPlayers: MAX_PLAYERS,
        spectators: r.spectators.size,
        phase: r.phase,
        handNo: r.handNo,
        pot: r.pot,
        stake: r.stake,
        hasJoinPin: !!r.joinPin
      });
    }
    list.sort((a, b) => b.players - a.players);
    return { ok: true, rooms: list };
  },

  /** 借分：propose（发起）/ accept（同意）/ decline（拒绝）。双方都要同意才生效。
   *  propose 支持两种方向：body.to = 借给谁（我当出借方），body.from = 向谁借（我当借款方） */
  async loan(body) {
    const { room, player } = authPlayer(body);
    const op = String(body.op || '');
    let loan;
    if (op === 'propose') {
      const to = String(body.to || '');
      const from = String(body.from || '');
      if (to) {
        loan = room.proposeLoan(player.id, to, body.amount);
      } else if (from) {
        loan = room.proposeLoan(from, player.id, body.amount);
      } else {
        throw userError('请指定借分对象');
      }
    } else if (op === 'accept') {
      loan = room.acceptLoan(String(body.loanId || ''), player.id);
    } else if (op === 'decline') {
      loan = room.declineLoan(String(body.loanId || ''), player.id);
    } else {
      throw userError('未知的借分操作');
    }
    markDirty();
    broadcast(room);
    return { ok: true, loan };
  },

  /** 弃牌获胜后，赢家公布自己的牌 */
  async reveal(body) {
    const { room, player } = authPlayer(body);
    room.revealWin(player.id);
    broadcast(room);
    return { ok: true };
  },

  /** 房主设置/清除房间加入密码 */
  async setRoomPin(body) {
    const { room, player } = authPlayer(body);
    const pin = room.setJoinPin(player.id, body.password);
    markDirty();
    broadcast(room);
    return { ok: true, hasJoinPin: !!pin };
  },

  /** 取消本局的自动连开 */
  async pauseAuto(body) {
    const { room, player } = authPlayer(body);
    room.pauseAutoNext(player.id);
    broadcast(room);
    return { ok: true };
  },

  async start(body) {
    const { room, player } = authPlayer(body);
    if (room.phase === 'lobby') room.startHand(player.id);
    else if (room.phase === 'showdown') room.nextHand(player.id);
    else throw new Error('本局还没结束');
    warmBetVoice(room);
    markDirty();
    broadcast(room);
    return { ok: true };
  },

  async leave(body) {
    const { room, player } = authPlayer(body);
    room.removePlayer(player.id);
    markDirty();
    if (humansIn(room) === 0) {
      closeRoom(room, '人都退出了');
    } else {
      broadcast(room);
    }
    return { ok: true };
  },

  async info(body) {
    const room = rooms.get(String(body.roomId || ''));
    if (!room) return { ok: true, exists: false };
    return {
      ok: true,
      exists: true,
      roomId: room.id,
      players: room.players.size,
      maxPlayers: MAX_PLAYERS,
      phase: room.phase,
      host: (room.players.get(room.hostId) || {}).name || null,
      hasJoinPin: !!room.joinPin
    };
  }
};

// ---------------------------------------------------------------- SSE

function handleEvents(req, res, query) {
  const roomId = String(query.get('roomId') || '');
  const pid = String(query.get('playerId') || '');
  const token = String(query.get('token') || '');

  const room = rooms.get(roomId);
  if (!room || !room.auth(pid, token)) {
    json(res, 401, { ok: false, error: '房间或身份无效' });
    return;
  }

  // ------------------------------------------------------------------
  // 连接数上限必须在 writeHead 之前检查：一旦响应头发出（200 + SSE），
  // 就无法再改回 503，客户端会收到一条"假成功"的死连接。
  // ------------------------------------------------------------------
  const existing = streams.get(roomId) && streams.get(roomId).get(pid);
  if (existing && existing.size >= SSE_MAX_PER_PLAYER) {
    json(res, 503, { ok: false, error: '打开的页面太多了，请先关掉旧标签页' });
    return;
  }
  if (sseTotalCount() >= SSE_MAX_TOTAL) {
    json(res, 503, { ok: false, error: '服务器连接已满，请稍后再试' });
    return;
  }

  room.hadSSE = true;
  // 玩家或观战者都可能连 SSE：观战者不在 players 里
  const player = room.getPlayer(pid);
  const spectator = player ? null : room.spectators.get(pid);
  if (player) {
    player.connected = true;
    player.lastSeen = Date.now();
  } else if (spectator) {
    spectator.connected = true;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  try {
    req.socket.setTimeout(0);
    req.socket.setNoDelay(true);
    req.socket.setKeepAlive(true);
  } catch (e) {
    /* ignore */
  }

  let byPlayer = streams.get(roomId);
  if (!byPlayer) {
    byPlayer = new Map();
    streams.set(roomId, byPlayer);
  }
  let set = byPlayer.get(pid);
  if (!set) {
    set = new Set();
    byPlayer.set(pid, set);
  }
  set.add(res);

  res.write('retry: 3000\n\n');
  try {
    res.write(`event: state\ndata: ${JSON.stringify(room.serialize(pid))}\n\n`);
  } catch (e) {
    /* ignore */
  }

  const cleanup = () => {
    unregisterStream(roomId, pid, res);
  };
  req.on('close', cleanup);
  req.on('aborted', cleanup);
  res.on('error', cleanup);

  broadcast(room);
}

// ---------------------------------------------------------------- 路由

const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch (e) {
    json(res, 400, { ok: false, error: '无效请求' });
    return;
  }

  const pathname = url.pathname;

  try {
    if (pathname === '/api/health') {
      let playerCount = 0;
      for (const r of rooms.values()) playerCount += r.players.size;
      json(res, 200, {
        ok: true,
        version: VERSION,
        rooms: rooms.size,
        players: playerCount,
        uptime: Math.floor((Date.now() - startedAt) / 1000),
        createPinRequired: !!loadSettings().createPin,
        ttsVoice: TTS_VOICE,
        ttsVer: TTS_VER
      });      return;
    }

    // 服务器语音合成兜底（浏览器没有 TTS 时用）
    if (pathname === '/api/tts') {
      handleTts(req, res, url.searchParams);
      return;
    }

    // 历史战绩（按昵称累计）
    if (pathname === '/api/history') {
      const q = url.searchParams;
      const name = String(q.get('name') || '').trim();
      if (!name) {
        json(res, 400, { ok: false, error: '缺少昵称' });
        return;
      }
      json(res, 200, getHistory(name, q.get('limit')));
      return;
    }

    if (pathname === '/api/events') {
      handleEvents(req, res, url.searchParams);
      return;
    }

    // 轮询兜底：某些环境（企业代理/老浏览器）SSE 不可用时前端可降级为 1s 轮询
    if (pathname === '/api/state') {
      const q = url.searchParams;
      const room = rooms.get(String(q.get('roomId') || ''));
      if (!room) {
        json(res, 200, { ok: false, error: '房间不存在或已过期' });
        return;
      }
      const p = room.auth(String(q.get('playerId') || ''), String(q.get('token') || ''));
      if (!p) {
        json(res, 200, { ok: false, error: '身份验证失败，请重新加入房间' });
        return;
      }
      json(res, 200, { ok: true, ...room.serialize(p.id) });
      return;
    }

    if (pathname === '/api/rooms') {
      const result = await api.rooms({ pin: url.searchParams.get('pin') || '' });
      json(res, 200, result);
      return;
    }

    if (pathname === '/api/roomInfo') {
      const result = await api.info({ roomId: url.searchParams.get('roomId') });
      json(res, 200, result);
      return;
    }

    if (pathname.startsWith('/api/')) {
      const name = pathname.slice(5);
      const handler = api[name];
      if (!handler) {
        json(res, 404, { ok: false, error: '接口不存在' });
        return;
      }
      if (req.method !== 'POST') {
        json(res, 405, { ok: false, error: '请用 POST' });
        return;
      }
      const body = await readBody(req);
      const result = await handler(body);
      json(res, 200, result);
      return;
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      serveStatic(req, res, pathname);
      return;
    }

    json(res, 405, { ok: false, error: '不支持的请求方式' });
  } catch (e) {
    const msg = (e && e.message) || '服务器内部错误';
    const isKnown = !!((e && e.isGameError) || (e && e.appCode));
    if (!isKnown) {
      console.error(`[api] ${pathname} 处理失败:`, e && e.stack ? e.stack : e);
    }
    try {
      const out = { ok: false, error: msg };
      if (e && e.appCode) out.code = e.appCode;
      json(res, 200, out);
    } catch (e2) {
      /* 响应已发出 */
    }
  }
});

// ---------------------------------------------------------------- 定时任务

const tickTimer = setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    try {
      if (room.botTick(now)) {
        broadcast(room);
        continue;
      }
      if (room.tick(now)) broadcast(room);
    } catch (e) {
      console.error('[tick] 房间', room.id, '异常:', e.message);
    }
  }
}, TICK_MS);

const pingTimer = setInterval(() => {
  for (const byPlayer of streams.values()) {
    for (const set of byPlayer.values()) {
      for (const res of set) {
        try {
          res.write('event: ping\ndata: 1\n\n');
        } catch (e) {
          /* ignore */
        }
      }
    }
  }
}, SSE_PING_MS);

const gcTimer = setInterval(() => {
  const now = Date.now();
  for (const [id, room] of rooms) {
    try {
      // 没有真人（只剩人机 / 人都走了）立即关闭
      if (humansIn(room) === 0) {
        closeRoom(room, '没有真人，自动关闭');
        continue;
      }
      // 页面上已经没有人（关掉网页/断线）：等一小会儿就解散
      if (room.hadSSE && liveCount(room) === 0) {
        if (!room._nobodySince) room._nobodySince = now;
        else if (now - room._nobodySince >= NOBODY_GRACE_MS) {
          closeRoom(room, '页面上没有人了，房间解散');
          continue;
        }
      } else {
        room._nobodySince = 0;
      }
      const idle = room.connectedCount() === 0 && now - room.updatedAt > IDLE_ROOM_MS;
      if (idle) {
        closeRoom(room, '空闲超时');
      }
    } catch (e) {
      /* ignore */
    }
  }
  rateBuckets.clear();
  saveState(false);
  saveRecords(false);
}, GC_INTERVAL_MS);

// ---------------------------------------------------------------- 进程兜底

process.on('uncaughtException', (err) => {
  console.error('[uncaughtException] 已捕获，进程继续运行:', err && err.stack ? err.stack : err);
});
process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection] 已捕获，进程继续运行:', err);
});

function shutdown(signal) {
  console.log(`\n[shutdown] 收到 ${signal}，保存状态后退出`);
  try {
    saveState(true);
    saveRecords(true);
  } catch (e) {
    /* ignore */
  }
  try { if (piperProc) piperProc.kill('SIGKILL'); } catch (e) { /* ignore */ }
  clearInterval(tickTimer);
  clearInterval(pingTimer);
  clearInterval(gcTimer);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

server.on('clientError', (err, socket) => {
  try {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  } catch (e) {
    /* ignore */
  }
});

loadState();
loadRecords();
setTimeout(() => {
  piperSpeak('语音播报已开启').then((r) => {
    cachePut('语音播报已开启', { buf: r.buf, mime: r.mime, fallback: false, engine: 'piper', ts: Date.now() });
    console.log('[tts] piper 就绪');
  }).catch((e) => console.error('[tts] piper 预热失败:', e && e.message));
}, 1500);

server.listen(PORT, HOST, () => {
  const pkg = (() => {
    try {
      return require('./package.json').version;
    } catch (e) {
      return VERSION;
    }
  })();

  let lanIps = [];
  try {
    const os = require('os');
    const isPrivate = (ip) =>
      /^192\.168\./.test(ip) ||
      /^10\./.test(ip) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
    const candidates = [];
    for (const list of Object.values(os.networkInterfaces())) {
      for (const ni of list || []) {
        if (ni.family !== 'IPv4' || ni.internal) continue;
        // 排除 169.254.x.x（链路本地/APIPA，朋友访问不到）
        if (ni.address.startsWith('169.254.')) continue;
        candidates.push(ni.address);
      }
    }
    // 私有网段优先，其余排后面
    lanIps = candidates.sort((a, b) => (isPrivate(b) ? 1 : 0) - (isPrivate(a) ? 1 : 0));
  } catch (e) {
    /* ignore */
  }

  console.log('');
  console.log('  ♠ ♥ 炸金花 · 网页版  v' + pkg);
  console.log('  ─────────────────────────────────────────');
  console.log(`  本机访问    http://127.0.0.1:${PORT}`);
  if (lanIps.length) {
    console.log(`  同一 WiFi   http://${lanIps[0]}:${PORT}`);
  }
  console.log('  异地好友    双击 share.bat 生成公网地址');
  console.log('  停止服务    Ctrl + C');
  console.log('');
});


module.exports = { server, rooms };
