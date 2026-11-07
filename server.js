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

const { Room } = require('./lib/engine');

const VERSION = '1.0.0';
const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const STATE_FILE = path.join(DATA_DIR, 'rooms.json');

const MAX_BODY = 64 * 1024;
const SSE_PING_MS = 20000;
const TICK_MS = 1000;
const IDLE_ROOM_MS = 2 * 60 * 60 * 1000;
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
        if (room.players.size > 0) rooms.set(room.id, room);
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
    const player = room.addPlayer(name);
    rooms.set(id, room);
    room.log(`房间 ${id} 已创建`);
    markDirty();
    return { ok: true, roomId: id, playerId: player.id, token: player.token };
  },

  async join(body) {
    if (rateLimited('join', 30)) throw userError('操作太频繁，请稍后再试');
    if (totalPlayerCount() >= MAX_TOTAL_PLAYERS) throw userError('服务器人数已满，请稍后再试');
    const room = getRoomOrThrow(body.roomId);
    if (room.players.size >= 15) throw userError('房间已满（最多 15 人）');
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
    const player = room.addPlayer(body.name);
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
    if (room.players.size === 0) {
      rooms.delete(room.id);
      streams.delete(room.id);
    } else {
      broadcast(room);
    }
    return { ok: true };
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

  /** 观战：不占座位，看公共信息（开牌后才能看到牌），不能操作 */
  async watch(body) {
    if (rateLimited('watch', 20)) throw userError('操作太频繁，请稍后再试');
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
        maxPlayers: 15,
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
    broadcast(room);
    return { ok: true };
  },

  async leave(body) {
    const { room, player } = authPlayer(body);
    room.removePlayer(player.id);
    markDirty();
    if (room.players.size === 0) {
      rooms.delete(room.id);
      streams.delete(room.id);
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
      maxPlayers: 15,
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
        createPinRequired: !!loadSettings().createPin
      });      return;
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
      const idle = room.connectedCount() === 0 && now - room.updatedAt > IDLE_ROOM_MS;
      if (idle) {
        rooms.delete(id);
        streams.delete(id);
        console.log(`[gc] 清理空闲房间 ${id}`);
      }
    } catch (e) {
      /* ignore */
    }
  }
  rateBuckets.clear();
  saveState(false);
}, 10000);

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
  } catch (e) {
    /* ignore */
  }
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
