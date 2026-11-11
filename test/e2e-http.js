'use strict';

/**
 * 端到端测试：真起动 server.js，通过 HTTP 模拟 4 个玩家打完多局。
 * 目的：验证 HTTP 层、状态推送、并发动作、整套流程不会崩。
 *
 * 运行：node test/e2e-http.js
 */

const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');

const PORT = 18000 + Math.floor(Math.random() * 2000);
const BASE = `http://127.0.0.1:${PORT}`;
const HANDS = 12;

let child = null;
let stdout = '';

function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const r = http.request(
      BASE + p,
      {
        method,
        timeout: 8000,
        headers: data
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
          : {}
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch (e) {
            reject(new Error(`响应不是 JSON: ${Buffer.concat(chunks).toString('utf8').slice(0, 200)}`));
          }
        });
      }
    );
    r.on('error', reject);
    r.on('timeout', () => r.destroy(new Error('请求超时')));
    if (data) r.write(data);
    r.end();
  });
}

const get = (p) => req('GET', p);
const post = (p, b) => req('POST', p, b);

/**
 * 申请加入 + 等房主批准（房间默认需要房主审批）
 * host: 房主会话（含 roomId/playerId/token）
 * 返回正式会话 { roomId, playerId, token, name }
 */
async function hostReady(host) {
  // 测试里把开局倒计时设为 0，避免每次等 10 秒
  const cur = (await get(`/api/state?roomId=${host.roomId}&playerId=${host.playerId}&token=${host.token}`)) || {};
  const cfg = Object.assign({}, cur.config || {}, { startCountdown: 0 });
  await post('/api/config', { ...host, config: cfg });
  await post('/api/ready', { ...host, ready: true });
}

async function joinApproved(host, name, password) {
  const r = await post('/api/requestJoin', { roomId: host.roomId, name, password });
  if (!r.ok) throw new Error('申请加入失败: ' + (r.error || r.code || ''));
  if (!r.pending) return { roomId: r.roomId, playerId: r.playerId, token: r.token, name };
  const ok = await post('/api/approveJoin', {
    roomId: host.roomId,
    playerId: host.playerId,
    token: host.token,
    joinId: r.joinId
  });
  if (!ok.ok) throw new Error('房主同意失败: ' + (ok.error || ''));
  const st = await post('/api/joinStatus', { roomId: host.roomId, joinId: r.joinId });
  if (!st.ok || st.status !== 'approved' || !st.playerId) {
    throw new Error('审批状态异常: ' + JSON.stringify(st));
  }
  const sess = { roomId: host.roomId, playerId: st.playerId, token: st.playerToken, name };
  // 测试里新玩家直接准备好，避免每个用例都要点准备
  await post('/api/ready', { ...sess, ready: true });
  return sess;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function startServer() {
  child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      ZJH_MAX_ROOMS: '12', // 压低房间上限，方便测试"房间已满"（限频先于上限触发）
      ZJH_KEEP_ROOM_MS: '0' // 测试里不保留空房间，避免房间堆积
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', (d) => {
    stdout += d.toString();
  });
  child.stderr.on('data', (d) => {
    stdout += d.toString();
  });

  for (let i = 0; i < 100; i++) {
    try {
      const h = await get('/api/health');
      if (h.ok) return h;
    } catch (e) {
      /* 还没起来 */
    }
    await sleep(100);
  }
  throw new Error('服务端启动超时\n' + stdout);
}

function stopServer() {
  if (child && !child.killed) {
    try {
      child.kill('SIGTERM');
    } catch (e) {
      /* ignore */
    }
  }
}

/** 检查 SSE 能连上并立刻收到 state */
function checkSSE(roomId, playerId, token) {
  return new Promise((resolve, reject) => {
    const url = `${BASE}/api/events?roomId=${roomId}&playerId=${playerId}&token=${token}`;
    const r = http.get(url, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`SSE 状态码 ${res.statusCode}`));
        return;
      }
      const ct = res.headers['content-type'] || '';
      if (!ct.includes('text/event-stream')) {
        reject(new Error(`SSE Content-Type 错误: ${ct}`));
        return;
      }
      let buf = '';
      const timer = setTimeout(() => {
        res.destroy();
        reject(new Error('SSE 3 秒内没收到 state'));
      }, 3000);
      res.on('data', (chunk) => {
        buf += chunk.toString();
        if (buf.includes('event: state')) {
          clearTimeout(timer);
          res.destroy();
          resolve(true);
        }
      });
      res.on('error', () => {});
    });
    r.on('error', reject);
  });
}

/** 打开一条 SSE 并保持，返回状态码（用于测连接上限） */
function sseStatus(roomId, playerId, token) {
  return new Promise((resolve) => {
    const url = `${BASE}/api/events?roomId=${roomId}&playerId=${playerId}&token=${token}`;
    const r = http.get(url, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        resolve(res.statusCode);
        return;
      }
      // 收到首帧后再算"占住一条连接"
      res.once('data', () => {});
      resolve(200);
    });
    r.on('error', () => resolve(0));
  });
}

async function getState(sess) {
  return get(
    `/api/state?roomId=${sess.roomId}&playerId=${sess.playerId}&token=${sess.token}`
  );
}

function chooseAction(st, rng) {
  const opts = st.myOptions || [];
  const by = {};
  for (const o of opts) by[o.type] = o;
  const r = rng();

  if (by.look && r < 0.3) return ['look', {}];
  if (by.compare && r < 0.5) {
    const ts = by.compare.targets;
    const t = ts[Math.floor(rng() * ts.length)];
    return ['compare', { target: t.id }];
  }
  if (by.raise && r < 0.68) {
    const rs = by.raise.raises;
    const pick = rs[Math.floor(rng() * rs.length)];
    return ['raise', { to: pick.to }];
  }
  if (by.call && r < 0.95) return ['call', {}];
  return ['fold', {}];
}

async function main() {
  const rng = mulberry32(778899);

  // ---- 口令场景：先写一个测试口令，结束后恢复 ----
  const settingsFile = path.join(__dirname, '..', 'data', 'settings.json');
  let prevSettings = null;
  try {
    prevSettings = fs.readFileSync(settingsFile, 'utf8');
  } catch (e) { /* 原本没有 */ }
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  fs.writeFileSync(settingsFile, JSON.stringify({ createPin: '2468' }));
  main.restoreSettings = () => {
    try {
      if (prevSettings === null) fs.unlinkSync(settingsFile);
      else fs.writeFileSync(settingsFile, prevSettings);
    } catch (e) { /* ignore */ }
  };

  const health = await startServer();
  console.log(`✓ 服务启动 port=${PORT} version=${health.version}`);

  // 0) 口令开关与健康检查
  if (health.createPinRequired !== true) throw new Error('health 应该报告 createPinRequired=true');
  console.log('✓ 健康检查报告了创建口令已启用');

  let noPin = await post('/api/create', { name: '无口令' });
  if (noPin.ok || noPin.code !== 'PIN_REQUIRED') {
    throw new Error('没带口令竟然能建房: ' + JSON.stringify(noPin));
  }
  let badPin = await post('/api/create', { name: '错口令', pin: '1111' });
  if (badPin.ok) throw new Error('错口令竟然能建房');
  console.log('✓ 无口令/错口令建房被拒（code=' + noPin.code + '）');

  // 7) 单人 + 人机：放在最前面跑（后面的限频/房间上限测试会占掉创建额度）
  {
    const solo = await post('/api/create', { name: '独狼玩家', pin: '2468' });
    if (!solo.ok) throw new Error('单人建房失败: ' + solo.error);
    const sRoom = solo.roomId;
    const sSess = { roomId: sRoom, playerId: solo.playerId, token: solo.token };

    const b1 = await post('/api/addBot', { ...sSess });
    const b2 = await post('/api/addBot', { ...sSess });
    if (!b1.ok || !b2.ok) throw new Error('添加人机失败: ' + (b1.error || b2.error));
    if (!b1.isBot || !b1.name.includes('人机')) throw new Error('人机标识/名字不对: ' + JSON.stringify(b1));
    console.log(`✓ 单人添加 2 个人机（${b1.name} / ${b2.name}）`);

    const st = await getState(sSess);
    if (st.players.length !== 3) throw new Error('人机没进房间');
    if (!st.players.some((p) => p.isBot)) throw new Error('isBot 没下发到前端状态');

    // 总注封顶调小，让一局快点结束
    await post('/api/config', {
      ...sSess,
      config: { ante: 10, baseStake: 10, maxStake: 100, maxPot: 300, seeMultiplier: 2, turnSeconds: 0 }
    });

    await hostReady(sSess);
  const started = await post('/api/start', { ...sSess });
    if (!started.ok) throw new Error('单人+人机开局失败: ' + started.error);

    // 真人开局就弃牌，人机自己互打（服务端 botTick 自动驱动）
    let soloActions = 0;
    let soloGuard = 0;
    let soloDone = false;
    const soloDeadline = Date.now() + 120000;
    while (Date.now() < soloDeadline && soloGuard++ < 600) {
      const s = await getState(sSess);
      if (!s.ok) throw new Error('单人局取状态失败: ' + s.error);
      if (s.phase !== 'playing') {
        soloDone = s.phase === 'showdown';
        break;
      }
      if (s.turnId === sSess.playerId) {
        await post('/api/action', { ...sSess, action: 'fold', payload: {} });
        soloActions++;
      } else {
        await sleep(500);
      }
    }

    if (!soloDone) {
      const s = await getState(sSess);
      throw new Error(`单人+人机对局没打完（phase=${s.phase}，guard=${soloGuard}）`);
    }
    const soloFinal = await getState(sSess);
    if (!soloFinal.lastResult || soloFinal.lastResult.winners.length === 0) {
      throw new Error('单人局没有结算结果');
    }
    const soloNet = soloFinal.players.reduce((a, p) => a + p.net, 0);
    if (soloNet !== 0) throw new Error('含人机的账目不零和: ' + soloNet);
    if (soloFinal.pot !== 0) throw new Error('单人局结算后底池未清零');

    const botId = soloFinal.players.find((p) => p.isBot).id;
    const rm = await post('/api/removeBot', { ...sSess, target: botId });
    if (!rm.ok) throw new Error('移除人机失败: ' + rm.error);
    const afterRm = await getState(sSess);
    if (afterRm.players.length !== 2) throw new Error('移除人机后人数不对');
    if (afterRm.players.some((p) => p.id === botId)) throw new Error('人机没被移除');
    console.log(`✓ 单人 + 2 人机打完整局（真人弃牌 ${soloActions} 次，人机自动互打）并移除人机`);
  }

  // 1) 带口令建房 + 加入（加入不需要口令）
  const created = await post('/api/create', { name: '阿强', pin: '2468' });
  if (!created.ok) throw new Error('带口令建房失败: ' + created.error);
  const roomId = created.roomId;
  console.log(`✓ 带口令创建房间 ${roomId}`);

  const sessions = [{ roomId, playerId: created.playerId, token: created.token, name: '阿强' }];
  for (const name of ['小李', '老王', '小张']) {
    const s = await joinApproved(sessions[0], name);
    sessions.push(s);
  }
  console.log(`✓ ${sessions.length} 名玩家加入`);

  // 主房间规则在大厅阶段一次设定（开局后设置会锁定）
  {
    const mainCfg = await post('/api/config', {
      ...sessions[0],
      config: { ante: 10, initialChips: 5000, baseStake: 10, maxStake: 100, maxPot: 3000, seeMultiplier: 2, turnSeconds: 0, autoRebuy: true }
    });
    if (!mainCfg.ok) throw new Error('主房间配置失败: ' + mainCfg.error);
  }

  // 1z) 快捷聊天：发送、下发、限频
  {
    const c1 = await post('/api/chat', { ...sessions[0], text: '  快点啦  ' });
    if (!c1.ok) throw new Error('聊天发送失败: ' + c1.error);
    const s = await getState(sessions[1]);
    const last = (s.chat || [])[s.chat.length - 1];
    if (!last || last.text !== '快点啦' || last.id !== sessions[0].playerId) {
      throw new Error('聊天没下发: ' + JSON.stringify(last));
    }
    // 3 秒窗口内第 3 条被限频
    const f1 = await post('/api/chat', { ...sessions[0], text: 'a' });
    const f2 = await post('/api/chat', { ...sessions[0], text: 'b' });
    if (f1.ok && f2.ok) throw new Error('聊天限频没生效');
    console.log('✓ 快捷聊天可用（含限频）');
    await sleep(3100);
  }

  // 1y) 孤注一掷：独立房间（开局后配置锁定，所以先配置再开局）
  {
    const allinCreated = await post('/api/create', { name: '全下房主', pin: '2468' });
    if (!allinCreated.ok) throw new Error('全下房间创建失败: ' + allinCreated.error);
    const arRoom = allinCreated.roomId;
    const arSessions = [{ roomId: arRoom, playerId: allinCreated.playerId, token: allinCreated.token }];
    for (const nm of ['全下乙', '全下丙', '全下丁']) {
      arSessions.push(await joinApproved(arSessions[0], nm));
    }
    const cfg2 = await post('/api/config', {
      ...arSessions[0],
      config: { ante: 10, initialChips: 40, baseStake: 10, maxStake: 100, maxPot: 99999, seeMultiplier: 2, turnSeconds: 0, autoRebuy: false }
    });
    if (!cfg2.ok) throw new Error('调小初始筹码失败: ' + cfg2.error);
    await hostReady(arSessions[0]);
    await post('/api/start', { ...arSessions[0] });

    // 找到筹码不足跟注的人，直接让所有人轮到就行动，直到某个人 chips < callCost 时全下
    let allinDone = false;
    let g2 = 0;
    while (!allinDone && g2++ < 200) {
      const s = await getState(arSessions[0]);
      if (s.phase !== 'playing') break;
      const turnSess = arSessions.find((x) => x.playerId === s.turnId);
      if (!turnSess) break;
      const ts = await getState(turnSess);
      const allinOpt = (ts.myOptions || []).find((o) => o.type === 'allin');
      if (allinOpt) {
        const r = await post('/api/action', { ...turnSess, action: 'allin', payload: {} });
        if (!r.ok) throw new Error('全下失败: ' + r.error);
        allinDone = true;
        break;
      }
      const callOpt = (ts.myOptions || []).find((o) => o.type === 'call');
      const r = await post('/api/action', {
        ...turnSess,
        action: callOpt ? 'call' : 'fold',
        payload: {}
      });
      if (!r.ok) break;
    }

    // 全下后：要么直接开牌，要么继续到别人行动；等它自然结束
    let g3 = 0;
    let phase = (await getState(arSessions[0])).phase;
    while (phase === 'playing' && g3++ < 200) {
      const s = await getState(arSessions[0]);
      phase = s.phase;
      if (phase !== 'playing') break;
      const turnSess = arSessions.find((x) => x.playerId === s.turnId);
      if (!turnSess) break;
      const ts = await getState(turnSess);
      const pick = (ts.myOptions || []).find((o) => o.type === 'call') ||
                  (ts.myOptions || []).find((o) => o.type === 'allin') ||
                  (ts.myOptions || []).find((o) => o.type === 'fold');
      const r = await post('/api/action', { ...turnSess, action: pick.type, payload: {} });
      if (!r.ok) break;
    }

    const fin = await getState(arSessions[0]);
    if (fin.phase !== 'showdown') throw new Error('全下场景没走到结算: ' + fin.phase);
    const netSum2 = fin.players.reduce((a, p) => a + p.net, 0);
    if (netSum2 !== 0) throw new Error('全下结算后账目不零和: ' + netSum2);
    for (const p of fin.players) {
      if (p.chips < 0) throw new Error(p.name + ' 筹码为负: ' + p.chips);
    }
    for (const p of fin.players) {
      if (!p.stats || !p.stats.hands) throw new Error(p.name + ' 没有战绩统计');
    }
    console.log('✓ 孤注一掷整局跑通（零和、无负筹码），战绩已累计');

    for (const s of arSessions) await post('/api/leave', s);
  }

  // 1x) 房间密码：设置后无密码/错密码不能进，对的能进；不泄露明文
  {
    const pinRoom = await post('/api/create', { name: '房主甲', pin: '2468' });
    if (!pinRoom.ok) throw new Error('建房失败: ' + pinRoom.error);
    const pr = { roomId: pinRoom.roomId, playerId: pinRoom.playerId, token: pinRoom.token };

    const setR = await post('/api/setRoomPin', { ...pr, password: '1234' });
    if (!setR.ok) throw new Error('设房间密码失败: ' + setR.error);

    const info = await get(`/api/roomInfo?roomId=${pr.roomId}`);
    if (info.hasJoinPin !== true) throw new Error('roomInfo 没报告 hasJoinPin');

    const noPw = await post('/api/requestJoin', { roomId: pr.roomId, name: '无密码者' });
    if (noPw.ok || noPw.code !== 'ROOM_PASSWORD_REQUIRED') {
      throw new Error('无密码竟然进房了: ' + JSON.stringify(noPw));
    }
    const badPw = await post('/api/requestJoin', { roomId: pr.roomId, name: '错密码者', password: '9999' });
    if (badPw.ok) throw new Error('错密码竟然进房了');

    const goodPw = await joinApproved(pr, '对密码者', '1234');
    if (!goodPw.playerId) throw new Error('正确密码进不去');

    // 状态下发不能出现明文密码
    const v = await get(`/api/state?roomId=${pr.roomId}&playerId=${pr.playerId}&token=${pr.token}`);
    if (v.hasJoinPin !== true) throw new Error('state 没下发 hasJoinPin');
    if (JSON.stringify(v).indexOf('"1234"') >= 0) throw new Error('状态里泄露了房间密码明文');

    // 清除密码后可直接加入
    await post('/api/setRoomPin', { ...pr, password: '' });
    const afterClear = await joinApproved(pr, '清除后加入');
    if (!afterClear.playerId) throw new Error('取消密码后仍进不去');

    console.log('✓ 房间密码：无密码/错密码被拒（code=ROOM_PASSWORD_REQUIRED），正确密码可进，明文不泄露');

    // 清理这个临时房间
    await post('/api/leave', pr);
    await sleep(3100); // 让创建限频窗口过去
  }

  // 1w) 自动连开：开启后结算到点自动开下一局
  {
    const anRoom = await post('/api/create', {
      name: '自动连开房主',
      pin: '2468',
      config: { ante: 10, initialChips: 1000, baseStake: 10, maxStake: 100, maxPot: 60, seeMultiplier: 2, turnSeconds: 0, autoNext: true, autoNextSeconds: 3 }
    });
    if (!anRoom.ok) throw new Error('建房失败: ' + anRoom.error);
    const ar = { roomId: anRoom.roomId, playerId: anRoom.playerId, token: anRoom.token };
    // 加一个人机保证 ≥2 人
    const anBot = await post('/api/addBot', { ...ar });
    if (!anBot.ok) throw new Error('加人机失败: ' + anBot.error);

    await hostReady(ar);
    await post('/api/start', { ...ar });
    // 一路弃牌/跟注把这一局打完
    let g = 0;
    let settled = false;
    while (g++ < 60) {
      const s = await getState(ar);
      if (s.phase !== 'playing') { settled = true; break; }
      if (s.turnId === ar.playerId) {
        await post('/api/action', { ...ar, action: 'fold', payload: {} });
      } else {
        await sleep(700); // 等人机
      }
    }
    if (!settled) throw new Error('自动连开房的第一局没打完');

    const afterFirst = await getState(ar);
    if (afterFirst.phase !== 'showdown') throw new Error('应处于结算阶段');
    if (!afterFirst.nextHandAt) throw new Error('开启自动连开后应排定 nextHandAt');

    // 等它自动开下一局
    let autoStarted = false;
    const dl = Date.now() + 30000;
    while (Date.now() < dl) {
      const s = await getState(ar);
      if (s.phase === 'playing' && s.handNo >= 2) { autoStarted = true; break; }
      await sleep(400);
    }
    if (!autoStarted) throw new Error('自动连开没有生效（30 秒内没自动开第二局）');
    console.log('✓ 自动连开生效：第 1 局结算后排定，3 秒后自动开始第 2 局');

    // 清理自动连开房间，免得占满房间上限
    await post('/api/leave', ar);
    await sleep(3100); // 让创建限频窗口过去
  }

  // 2) 房间信息 & 身份校验
  const info = await get(`/api/roomInfo?roomId=${roomId}`);
  if (!info.exists || info.players !== 4) throw new Error('房间信息错误: ' + JSON.stringify(info));

  const bad = await get(`/api/state?roomId=${roomId}&playerId=${sessions[0].playerId}&token=deadbeef`);
  if (bad.ok) throw new Error('错误 token 竟然通过了鉴权');
  console.log('✓ 鉴权正常（错误 token 被拒）');

  // 3) 非房主不能改设置
  const cfgFail = await post('/api/config', {
    roomId,
    playerId: sessions[1].playerId,
    token: sessions[1].token,
    config: { ante: 999 }
  });
  if (cfgFail.ok) throw new Error('非房主竟然能改设置');
  console.log('✓ 非房主改设置被拒');

  // 4) SSE 连通性
  await checkSSE(roomId, sessions[0].playerId, sessions[0].token);
  console.log('✓ SSE 推送正常');

  // 4b) SSE 同玩家连接数上限（最多 3 个页面）
  {
    const results = await Promise.all(
      [1, 2, 3, 4].map((i) => sseStatus(roomId, sessions[1].playerId, sessions[1].token))
    );
    const ok200 = results.filter((c) => c === 200).length;
    const rejected = results.filter((c) => c === 503).length;
    if (ok200 !== 3 || rejected !== 1) {
      throw new Error(`SSE 连接上限不对: ${results.join(',')}`);
    }
    console.log('✓ SSE 同一玩家最多 3 条连接（第 4 条被拒）');
  }

  // 4c) 创建频率限制：3 秒窗口内第 6 次创建被拒
  {
    await sleep(3100); // 等上一个窗口过期
    let throttled = false;
    for (let i = 0; i < 8; i++) {
      const r = await post('/api/create', { name: 'flood' + i, pin: '2468' });
      if (!r.ok && /太频繁/.test(r.error)) {
        throttled = true;
        break;
      }
    }
    if (!throttled) throw new Error('创建限频没有生效');
    console.log('✓ 创建房间限频生效（防脚本刷爆内存）');
  }

  // 4d) 房间总数上限
  {
    await sleep(3100);
    let fullHit = false;
    const capSessions = [];
    // 每轮最多建 4 个（低于限频阈值 5 次/3 秒），轮间等窗口过期
    for (let round = 0; round < 5 && !fullHit; round++) {
      for (let i = 0; i < 4; i++) {
        const r = await post('/api/create', { name: 'cap' + round + i, pin: '2468' });
        if (!r.ok && /房间已满/.test(r.error)) {
          fullHit = true;
          break;
        }
        if (r.ok) capSessions.push({ roomId: r.roomId, playerId: r.playerId, token: r.token });
      }
      if (!fullHit) await sleep(3100);
    }
    if (!fullHit) throw new Error('房间数上限没有生效');
    console.log('✓ 房间总数上限生效（防内存耗尽）');
    // 清理这些占位房间，释放名额给后面的用例（离开后无真人自动关闭）
    for (const s of capSessions) await post('/api/leave', s);
    await sleep(300);
  }

  // 5) 连打多局
  let handsPlayed = 0;
  let totalActions = 0;

  for (let h = 0; h < HANDS; h++) {
    await hostReady(sessions[0]);
    const started = await post('/api/start', {
      roomId,
      playerId: sessions[0].playerId,
      token: sessions[0].token
    });
    if (!started.ok) {
      // 筹码耗尽等导致开不了局，正常收尾
      console.log(`  第 ${h + 1} 局未能开始: ${started.error}`);
      break;
    }

    let guard = 0;
    while (true) {
      if (guard++ > 400) throw new Error('牌局卡住，超过 400 次循环');

      const st = await getState(sessions[0]);
      if (!st.ok) throw new Error('取状态失败: ' + st.error);
      if (st.phase !== 'playing') break;

      if (!st.turnId) throw new Error('playing 状态下没有 turnId');

      const turnSeat = st.players.find((p) => p.id === st.turnId);
      const sess = sessions.find((s) => s.playerId === st.turnId);
      if (!sess) throw new Error('找不到当前回合玩家');

      const turnState = await getState(sess);
      const [action, payload] = chooseAction(turnState, rng);

      let res = await post('/api/action', {
        roomId,
        playerId: sess.playerId,
        token: sess.token,
        action,
        payload
      });
      totalActions++;

      if (!res.ok) {
        // 兜底改弃牌，验证不会死循环
        res = await post('/api/action', {
          roomId,
          playerId: sess.playerId,
          token: sess.token,
          action: 'fold',
          payload: {}
        });
        if (!res.ok) throw new Error(`${turnSeat.name} 弃牌也失败: ${res.error}`);
        totalActions++;
      }
    }

    const after = await getState(sessions[0]);
    if (after.phase !== 'showdown') {
      throw new Error(`第 ${h + 1} 局没有正常结算，phase=${after.phase}`);
    }
    if (!after.lastResult || !Array.isArray(after.lastResult.winners) || after.lastResult.winners.length === 0) {
      throw new Error(`第 ${h + 1} 局没有结果`);
    }
    if (after.pot !== 0) throw new Error(`第 ${h + 1} 局结算后底池不为 0: ${after.pot}`);

    const netSum = after.players.reduce((a, p) => a + p.net, 0);
    if (netSum !== 0) throw new Error(`第 ${h + 1} 局净分合计不为 0: ${netSum}`);

    for (const p of after.players) {
      if (p.chips < 0) throw new Error(`${p.name} 筹码为负: ${p.chips}`);
    }

    handsPlayed++;
  }

  const final = await getState(sessions[0]);
  const finalNet = final.players.reduce((a, p) => a + p.net, 0);
  if (finalNet !== 0) throw new Error('最终净分合计不为 0');

  console.log(`✓ 完成 ${handsPlayed} 局，共 ${totalActions} 次操作，无异常`);
  console.log(
    '  积分：' + final.players.map((p) => `${p.name} ${p.net >= 0 ? '+' : ''}${p.net}`).join(' / ')
  );

  // 6) 离开房间
  const left = await post('/api/leave', {
    roomId,
    playerId: sessions[3].playerId,
    token: sessions[3].token
  });
  if (!left.ok) throw new Error('离开房间失败: ' + left.error);
  const afterLeave = await getState(sessions[0]);
  if (afterLeave.players.length !== 3) throw new Error('离开后人数不对');
  console.log('✓ 退出房间正常');

  // 6z) 房间自动关闭：只剩人机 / 人都走了
  {
    const rc = await post('/api/create', { name: '会关房的人', pin: '2468' });
    if (!rc.ok) throw new Error('关房测试建房失败: ' + rc.error);
    const rs = { roomId: rc.roomId, playerId: rc.playerId, token: rc.token };
    await post('/api/addBot', { ...rs });
    await post('/api/addBot', { ...rs });
    const before = await post('/api/info', { roomId: rs.roomId });
    if (!before.exists) throw new Error('建房后房间应该存在');
    // 房主退出 → 只剩人机 → 立即关闭
    await post('/api/leave', { ...rs });
    await sleep(300);
    const after = await post('/api/info', { roomId: rs.roomId });
    if (after.exists) throw new Error('只剩人机的房间应该自动关闭');
    console.log('✓ 只剩人机的房间自动关闭');

    // 两人房间，都退出 → 关闭
    const r2 = await post('/api/create', { name: '甲', pin: '2468' });
    const s1 = { roomId: r2.roomId, playerId: r2.playerId, token: r2.token };
    const s2 = await joinApproved(s1, '乙');
    await post('/api/leave', s1);
    const mid = await post('/api/info', { roomId: r2.roomId });
    if (!mid.exists) throw new Error('还有一个人时房间不该关闭');
    await post('/api/leave', s2);
    await sleep(300);
    const gone = await post('/api/info', { roomId: r2.roomId });
    if (gone.exists) throw new Error('人都退出的房间应该自动关闭');
    console.log('✓ 人都退出后房间自动关闭');
  }

  console.log('\n══ 端到端测试全部通过 ══\n');
}

main()
  .then(() => {
    main.restoreSettings();
    stopServer();
    setTimeout(() => process.exit(0), 200);
  })
  .catch((e) => {
    console.error('\n✖ 端到端测试失败:', e.message);
    if (stdout) console.error('--- 服务端输出 ---\n' + stdout);
    main.restoreSettings();
    stopServer();
    setTimeout(() => process.exit(1), 200);
  });
