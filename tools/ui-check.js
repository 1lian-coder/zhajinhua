'use strict';

/**
 * 用 CDP 驱动 Edge 无头浏览器，在真实 375px 手机视口下走完一整局并截图。
 * 目的：验证前端在手机尺寸下能正常渲染、能真正点完一局、控制台无报错。
 *
 * 前置：先启动服务（默认 8099）：  set PORT=8099 && node server.js
 * 运行：node tools/ui-check.js [baseUrl] [outDir]
 *
 * 只依赖 Node 24 自带的 fetch / WebSocket，不需要 npm 安装任何东西。
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BASE = process.argv[2] || 'http://127.0.0.1:8099';
const OUT_DIR = process.argv[3] || path.join(os.tmpdir(), 'zjh-shots');
const BOT_COUNT = Math.max(1, Math.min(5, Number(process.env.BOTS || 2)));
const BOT_NAMES = ['小李', '老王', '小张', '阿花', '大刘'];
const EDGE =
  process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const DEBUG_PORT = 9300 + Math.floor(Math.random() * 400);
const VIEW = { width: 375, height: 812 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- CDP 客户端

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.events = [];
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
      this.events.push(msg);
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        this.consoleErrors.push(
          (msg.params.args || []).map((a) => a.value || a.description || '').join(' ')
        );
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails || {};
        this.consoleErrors.push(
          `未捕获异常: ${(d.exception && d.exception.description) || d.text || 'unknown'}`
        );
      }
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      if (this.ws.readyState !== 1) return reject(new Error('WebSocket 未连接'));
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 超时: ${method}`));
        }
      }, 15000);
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
    const r = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    return file;
  }
}

async function connectTargets() {
  for (let i = 0; i < 120; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch (e) {
      /* 还没起来 */
    }
    await sleep(150);
  }
  throw new Error('连不上 Edge 调试端口');
}

function openWS(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.addEventListener('open', () => resolve(ws));
    ws.addEventListener('error', (e) => reject(new Error('WebSocket 连接失败')));
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
      `--remote-debugging-port=${DEBUG_PORT}`,
      `--user-data-dir=${profileDir}`,
      '--window-size=800,900',
      'about:blank'
    ],
    { stdio: 'ignore' }
  );
  await sleep(1200);
  return proc;
}

// ---------------------------------------------------------------- HTTP 工具

async function post(p, body) {
  const res = await fetch(BASE + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return res.json();
}

async function getJSON(p) {
  const res = await fetch(BASE + p);
  return res.json();
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

// ---------------------------------------------------------------- 主流程

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const health = await getJSON('/api/health');
  console.log(`✓ 服务在线 ${BASE} (rooms=${health.rooms})`);

  const profileDir = path.join(os.tmpdir(), 'zjh-edge-profile-' + Date.now());
  const edge = await launchEdge(profileDir);
  const target = await connectTargets();
  const cdp = new CDP(await openWS(target.webSocketDebuggerUrl));

  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: VIEW.width,
    height: VIEW.height,
    deviceScaleFactor: 2,
    mobile: true,
    screenOrientation: { type: 'portraitPrimary', angle: 0 }
  });

  const shots = [];
  const shot = async (name) => {
    const f = path.join(OUT_DIR, name + '.png');
    await cdp.screenshot(f);
    shots.push(f);
    console.log(`  📸 ${name}.png`);
    return f;
  };

  // ---- 首页 ----
  await cdp.send('Page.navigate', { url: BASE + '/' });
  await sleep(1200);

  const viewport = await cdp.eval('window.innerWidth + "x" + window.innerHeight');
  console.log(`✓ 视口 ${viewport}（目标 375x812）`);

  const homeVisible = await cdp.eval(
    '(() => { const s = document.getElementById("screen-home"); return !!s && !s.hidden; })()'
  );
  if (!homeVisible) throw new Error('首页没有显示');

  // 横向溢出检查
  const overflow = await cdp.eval(
    'document.documentElement.scrollWidth - document.documentElement.clientWidth'
  );
  console.log(`  scrollWidth 溢出量: ${overflow}px ${overflow > 0 ? '✖ 有横向滚动' : '✓ 无横向滚动'}`);

  // 填昵称
  await cdp.eval(`(() => {
    const el = document.getElementById('nickname');
    el.value = '测试玩家';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return el.value;
  })()`);

  // 如果服务器设置了创建口令，自动填上（读 data/settings.json）
  let createPin = '';
  try {
    const st = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', 'data', 'settings.json'), 'utf8')
    );
    if (st && st.createPin) createPin = String(st.createPin);
  } catch (e) { /* 没设置口令 */ }
  if (createPin) {
    const r = await cdp.eval(`(() => {
      const f = document.getElementById('pin-field');
      const el = document.getElementById('create-pin');
      if (f && el) {
        f.hidden = false;
        el.value = '${createPin}';
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return 'pin-filled';
      }
      return 'no-field';
    })()`);
    console.log(`  创建口令: ${r}`);
  }

  await sleep(300);
  await shot('01-home');

  // ---- 创建房间 ----
  await cdp.eval('document.getElementById("btn-create").click()');
  await sleep(1500);

  const tableVisible = await cdp.eval(
    '(() => { const s = document.getElementById("screen-table"); return !!s && !s.hidden; })()'
  );
  if (!tableVisible) throw new Error('创建房间后没有进入牌桌');

  const roomId = await cdp.eval('document.getElementById("room-id").textContent.trim()');
  if (!/^\d{6}$/.test(roomId)) throw new Error('房号显示异常: ' + roomId);
  console.log(`✓ 创建房间 ${roomId}`);

  // 读取页面里存的会话（房主 token）
  const stored = await cdp.eval(`(() => {
    const out = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      out.push([k, localStorage.getItem(k)]);
    }
    return JSON.stringify(out);
  })()`);

  // app.js 把所有房间的会话存在一个对象里：{ "807037": { roomId, playerId, token } }
  const findSession = (o) => {
    if (!o || typeof o !== 'object') return null;
    if (o.token && o.playerId) return o;
    for (const v of Object.values(o)) {
      const r = findSession(v);
      if (r) return r;
    }
    return null;
  };
  let hostSession = null;
  for (const [k, v] of JSON.parse(stored)) {
    try {
      const found = findSession(JSON.parse(v));
      if (found && found.roomId === roomId) {
        hostSession = found;
        break;
      }
    } catch (e) {
      /* 非 JSON，跳过 */
    }
  }
  if (!hostSession) throw new Error('页面里没找到会话凭证，无法自动化后续步骤');
  console.log(`✓ 读取到房主会话 playerId=${hostSession.playerId}`);

  await sleep(400);
  await shot('02-lobby');

  // ---- 房间密码 & 自动连开：UI 元素与真实设置 ----
  {
    const pinUi = await cdp.eval(`(() => {
      const input = document.getElementById('room-pin-input');
      const btn = document.getElementById('btn-save-room-pin');
      const state = document.getElementById('room-pin-state');
      const cfgForm = document.getElementById('config-form');
      return JSON.stringify({
        pinInput: !!input,
        pinBtn: !!btn,
        pinState: state ? state.textContent.trim() : '',
        hasAutoNextField: !!(cfgForm && cfgForm.querySelector('[data-key="autoNext"]')),
        hasAutoNextSecField: !!(cfgForm && cfgForm.querySelector('[data-key="autoNextSeconds"]'))
      });
    })()`);
    const pu = JSON.parse(pinUi);
    if (!pu.pinInput || !pu.pinBtn || !pu.hasAutoNextField || !pu.hasAutoNextSecField) {
      throw new Error('房间密码/自动连开 UI 缺失: ' + pinUi);
    }
    console.log('✓ 房间密码 + 自动连开 配置项已渲染');

    // 真实设置房间密码，并确认状态文案变化
    const setPin = await cdp.eval(`(() => {
      const input = document.getElementById('room-pin-input');
      const btn = document.getElementById('btn-save-room-pin');
      if (!input || !btn) return 'no-el';
      input.value = '8642';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      btn.click();
      return 'clicked';
    })()`);
    await sleep(1200);
    const pinAfter = await cdp.eval(
      `document.getElementById('room-pin-state').textContent.trim()`
    );
    console.log(`  房间密码按钮: ${setPin} → 状态: ${pinAfter}`);
    if (pinAfter.indexOf('已设置') < 0) throw new Error('设置房间密码后状态未更新: ' + pinAfter);

    const st = await getJSON(
      `/api/state?roomId=${roomId}&playerId=${hostSession.playerId}&token=${hostSession.token}`
    );
    if (st.hasJoinPin !== true) throw new Error('服务端没记录房间密码');
    if (JSON.stringify(st).indexOf('8642') >= 0) throw new Error('状态泄露了房间密码明文');
    console.log('✓ 房间密码真实生效（服务端 hasJoinPin=true，明文不下发）');

    // 清掉密码，方便后面用 HTTP 机器人加入
    await post('/api/setRoomPin', {
      roomId,
      playerId: hostSession.playerId,
      token: hostSession.token,
      password: ''
    });
    await sleep(600);
  }

  // ---- 两个机器人玩家 ----
  const bots = [];
  for (const name of BOT_NAMES.slice(0, BOT_COUNT)) {
    const r = await post('/api/join', { roomId, name });
    if (!r.ok) throw new Error('机器人加入失败: ' + r.error);
    bots.push({ name, roomId, playerId: r.playerId, token: r.token });
  }
  console.log(`✓ ${bots.length} 个机器人已加入`);

  // ---- 人机面板：真实点击"添加人机"按钮，验证 UI 与徽标 ----
  {
    const added = await cdp.eval(`(() => {
      const panel = document.getElementById('panel-bots');
      if (!panel || panel.hidden) return 'panel-hidden';
      const btn = document.getElementById('btn-add-bot');
      if (!btn) return 'no-btn';
      if (btn.disabled) return 'btn-disabled';
      btn.click();
      return 'clicked';
    })()`);
    await sleep(900);
    const botState = await cdp.eval(`(() => {
      const seats = [...document.querySelectorAll('.seat')];
      const botSeats = seats.filter(s => s.textContent.includes('人机'));
      const panel = document.getElementById('panel-bots');
      const rows = [...(document.querySelectorAll('#bots-list .bot-row') || [])];
      return JSON.stringify({
        panelHidden: panel ? panel.hidden : null,
        botSeatCount: botSeats.length,
        botRows: rows.length,
        hasRemoveBtn: !!document.querySelector('#bots-list .bot-row button')
      });
    })()`);
    const bs = JSON.parse(botState);
    if (added !== 'clicked') {
      console.log(`  (人机面板点击异常: ${added}，继续用 HTTP 机器人)`);
    } else {
      const okUI = bs.botSeatCount >= 1 && bs.botRows >= 1;
      console.log(
        okUI
          ? `✓ 人机面板可用：点添加后出现 ${bs.botSeatCount} 个人机座位、${bs.botRows} 行管理列表${bs.hasRemoveBtn ? '、可移除' : ''}`
          : `✗ 人机 UI 异常: ${botState}`
      );
      if (!okUI) throw new Error('人机 UI 渲染异常: ' + botState);
      await shot('02b-bot-added');
    }
  }

  // 把封顶调小，让它尽快开牌，方便看到结算界面
  const cfg = await post('/api/config', {
    roomId,
    playerId: hostSession.playerId,
    token: hostSession.token,
    config: { ante: 10, baseStake: 10, maxStake: 100, maxPot: 120 + 60 * bots.length + 120, seeMultiplier: 2, turnSeconds: 0 }
  });
  if (!cfg.ok) console.log('  (配置调整失败，用默认值继续)');
  else console.log('✓ 已把总注封顶调到 300，便于快速开牌');

  await sleep(500);

  // ---- 开始游戏 ----
  await cdp.eval(`(() => {
    const b = document.getElementById('btn-bottom');
    if (b && !b.hidden) { b.click(); return 'clicked'; }
    return 'btn-hidden';
  })()`);
  await sleep(1200);

  // ---- 走完这一局 ----
  const rng = mulberry32(4242);
  let acted = 0;
  let tableShotDone = false;
  let lookedShotDone = false;

  const hostStateOf = async () =>
    getJSON(
      `/api/state?roomId=${roomId}&playerId=${hostSession.playerId}&token=${hostSession.token}`
    );

  for (let step = 0; step < 200; step++) {
    const st = await hostStateOf();
    if (!st.ok) throw new Error('取状态失败: ' + st.error);
    if (st.phase !== 'playing') break;

    // 用服务端 turnId 判断该谁动，而不是靠按钮可见性
    const myTurn = st.turnId === hostSession.playerId;

    if (myTurn) {
      if (!tableShotDone) {
        await sleep(300);
        await shot('03-table-my-turn');
        tableShotDone = true;
      }
      // 先看牌
      const looked = await cdp.eval(`(() => {
        const b = document.getElementById('act-look');
        if (b && !b.hidden && !b.disabled) { b.click(); return 'looked'; }
        return 'no-look';
      })()`);
      if (looked === 'looked') {
        await sleep(900);
        if (!lookedShotDone) {
          await shot('04-after-look');
          lookedShotDone = true;
        }
      }

      // 跟注：新界面用筹码按钮（.chip[data-chip="call"]）
      const called = await cdp.eval(`(() => {
        const b = document.querySelector('#chip-row .chip[data-chip="call"]');
        if (b && !b.disabled) { b.click(); return 'called'; }
        return 'no-call';
      })()`);
      await sleep(700);

      if (called !== 'called') {
        // 跟不了就弃牌：点按钮 + 处理二次确认
        await cdp.eval(`(() => {
          const b = document.getElementById('act-fold');
          if (b && !b.disabled) { b.click(); return 'fold'; }
          return 'no-fold';
        })()`);
        await sleep(600);
        const modalInfo = await cdp.eval(`(() => {
          const m = document.getElementById('modal-root');
          if (!m || m.hidden) return 'no-modal';
          const btns = [...m.querySelectorAll('button')].map(b => b.textContent.trim());
          return JSON.stringify(btns);
        })()`);
        if (modalInfo !== 'no-modal') {
          const clicked = await cdp.eval(`(() => {
            const m = document.getElementById('modal-root');
            const btns = [...m.querySelectorAll('button')];
            // 优先点带主色样式的确认按钮
            const primary = btns.find(b => /btn-primary/.test(b.className)) || btns[btns.length - 1];
            if (primary) { primary.click(); return 'confirmed'; }
            return 'no-btn';
          })()`);
          console.log(`  (弃牌确认弹窗按钮: ${modalInfo} → ${clicked})`);
          await sleep(700);
        }
      }
      acted++;
      continue;
    }

    // 机器人回合
    const turn = st.turnId;
    const bot = bots.find((b) => b.playerId === turn);
    if (!bot) {
      // 既不是页面玩家也不是已知机器人 —— 等状态刷新
      await sleep(400);
      continue;
    }
    const botState = await getJSON(
      `/api/state?roomId=${roomId}&playerId=${bot.playerId}&token=${bot.token}`
    );
    const opts = botState.myOptions || [];
    const by = {};
    for (const o of opts) by[o.type] = o;

    const r = rng();
    let action = 'fold';
    let payload = {};
    if (by.call && r < 0.8) action = 'call';
    else if (by.compare && by.compare.targets && by.compare.targets.length) {
      action = 'compare';
      payload = { target: by.compare.targets[0].id };
    } else if (by.call) action = 'call';
    else action = 'fold';

    const res = await post('/api/action', {
      roomId,
      playerId: bot.playerId,
      token: bot.token,
      action,
      payload
    });
    if (!res.ok) {
      await post('/api/action', {
        roomId,
        playerId: bot.playerId,
        token: bot.token,
        action: 'fold',
        payload: {}
      });
    }
    acted++;
    await sleep(250);
  }

  const final = await getJSON(
    `/api/state?roomId=${roomId}&playerId=${bots[0].playerId}&token=${bots[0].token}`
  );
  console.log(`✓ 本局走完，phase=${final.phase}，共 ${acted} 次操作`);

  // ---- 新功能 DOM 检查 ----
  {
    const ui = await cdp.eval(`(() => {
      const chatBtn = document.getElementById('btn-chat');
      const soundBtn = document.getElementById('btn-sound');
      const allinBtn = document.getElementById('act-allin');
      const statsCol = document.querySelector('#panel-result .rank-stats');
      const thead = document.querySelector('#panel-result .rank-table thead');
      const allinBadge = document.querySelector('.seat .badge.allin, #panel-result .allin-tag');
      return JSON.stringify({
        chatBtn: !!chatBtn,
        soundBtn: !!soundBtn,
        allinBtnExists: !!allinBtn,
        statsColInResult: !!statsCol,
        statsText: statsCol ? statsCol.textContent.trim() : '',
        theadHasZhanJi: !!(thead && thead.textContent.indexOf('战绩') >= 0),
        allinSeenSomewhere: !!allinBadge
      });
    })()`);    const u = JSON.parse(ui);
    console.log('  新功能 DOM: ' + ui);
    if (!u.chatBtn || !u.soundBtn || !u.allinBtnExists || !u.statsColInResult || !u.theadHasZhanJi) {
      throw new Error('新功能 UI 元素缺失: ' + ui);
    }
    console.log('✓ 聊天按钮/声音开关/孤注一掷按钮/战绩列 均已渲染');
  }


  await sleep(900);
  await cdp.eval('window.scrollTo(0, 0)');
  await shot('05-result');

  // 结算页滚动到底部再补一张（看积分榜/惩罚换算）
  await cdp.eval(`(() => {
    const el = document.querySelector('#table-main') || document.scrollingElement;
    if (el) el.scrollTop = el.scrollHeight;
    window.scrollTo(0, document.body.scrollHeight);
    return 'scrolled';
  })()`);
  await sleep(600);
  await shot('06-result-bottom');

  // ---- 控制台报错 ----
  console.log('');
  if (cdp.consoleErrors.length) {
    console.log(`✖ 控制台有 ${cdp.consoleErrors.length} 条错误：`);
    for (const e of cdp.consoleErrors.slice(0, 10)) console.log('   - ' + e.slice(0, 300));
  } else {
    console.log('✓ 控制台无错误');
  }

  const overflow2 = await cdp.eval(
    'document.documentElement.scrollWidth - document.documentElement.clientWidth'
  );
  console.log(`✓ 牌桌页横向溢出: ${overflow2}px`);

  console.log('\n截图目录: ' + OUT_DIR);
  for (const s of shots) console.log('  ' + s);

  cdp.ws.close();
  try {
    edge.kill();
  } catch (e) {
    /* ignore */
  }

  if (cdp.consoleErrors.length) process.exitCode = 1;
}

main()
  .then(() => {
    setTimeout(() => process.exit(process.exitCode || 0), 300);
  })
  .catch((e) => {
    console.error('\n✖ 前端自动化检查失败:', e.message);
    setTimeout(() => process.exit(1), 300);
  });
