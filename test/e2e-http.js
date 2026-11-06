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
      ZJH_MAX_ROOMS: '12' // 压低房间上限，方便测试"房间已满"（限频先于上限触发）
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

  // 1) 带口令建房 + 加入（加入不需要口令）
  const created = await post('/api/create', { name: '阿强', pin: '2468' });
  if (!created.ok) throw new Error('带口令建房失败: ' + created.error);
  const roomId = created.roomId;
  console.log(`✓ 带口令创建房间 ${roomId}`);

  const sessions = [{ roomId, playerId: created.playerId, token: created.token, name: '阿强' }];
  for (const name of ['小李', '老王', '小张']) {
    const r = await post('/api/join', { roomId, name });
    if (!r.ok) throw new Error('加入失败: ' + r.error);
    sessions.push({ roomId, playerId: r.playerId, token: r.token, name });
  }
  console.log(`✓ ${sessions.length} 名玩家加入`);

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
    // 每轮最多建 4 个（低于限频阈值 5 次/3 秒），轮间等窗口过期
    for (let round = 0; round < 5 && !fullHit; round++) {
      for (let i = 0; i < 4; i++) {
        const r = await post('/api/create', { name: 'cap' + round + i, pin: '2468' });
        if (!r.ok && /房间已满/.test(r.error)) {
          fullHit = true;
          break;
        }
      }
      if (!fullHit) await sleep(3100);
    }
    if (!fullHit) throw new Error('房间数上限没有生效');
    console.log('✓ 房间总数上限生效（防内存耗尽）');
  }

  // 5) 连打多局
  let handsPlayed = 0;
  let totalActions = 0;

  for (let h = 0; h < HANDS; h++) {
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
