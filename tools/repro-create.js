'use strict';

/**
 * 复现用户报告的 bug：输入昵称 → 点创建房间没反应 → 高级设置点不开
 * 通过公网隧道地址跑，完整还原用户路径。
 *
 * 用法: node tools/repro-create.js <baseUrl>
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BASE = process.argv[2] || 'http://127.0.0.1:8080';
const OUT = path.join(os.tmpdir(), 'zjh-repro');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const DEBUG_PORT = 9500 + Math.floor(Math.random() * 300);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    this.consoleErrors = []; this.requests = [];
    ws.addEventListener('message', (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
        return;
      }
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error')
        this.consoleErrors.push((m.params.args || []).map(a => a.value || a.description || '').join(' '));
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails || {};
        this.consoleErrors.push('未捕获: ' + ((d.exception && d.exception.description) || d.text));
      }
      if (m.method === 'Network.requestWillBeSent')
        this.requests.push({ url: m.params.request.url, method: m.params.request.method });
      if (m.method === 'Network.responseReceived') {
        const r = m.params.response;
        if (r.status >= 400) this.consoleErrors.push('HTTP ' + r.status + ' ' + r.url);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      if (this.ws.readyState !== 1) return reject(new Error('ws closed'));
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP timeout: ' + method)); } }, 12000);
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('页面执行出错: ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text));
    return r.result ? r.result.value : undefined;
  }
  async shot(name) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    const f = path.join(OUT, name + '.png');
    fs.writeFileSync(f, Buffer.from(r.data, 'base64'));
    console.log('  [shot] ' + f);
  }
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const profile = path.join(os.tmpdir(), 'zjh-repro-profile-' + Date.now());
  const edge = spawn(EDGE, ['--headless=new','--disable-gpu','--no-first-run','--disable-extensions',
    `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${profile}`, '--window-size=800,900','about:blank'], { stdio: 'ignore' });
  await sleep(1200);

  let target = null;
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
      target = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
      if (target) break;
    } catch (e) {}
    await sleep(150);
  }
  if (!target) throw new Error('连不上调试端口');

  const ws = await new Promise((res, rej) => {
    const w = new WebSocket(target.webSocketDebuggerUrl);
    w.addEventListener('open', () => res(w));
    w.addEventListener('error', () => rej(new Error('ws fail')));
    setTimeout(() => rej(new Error('ws timeout')), 8000);
  });
  const cdp = new CDP(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Network.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 2, mobile: true });

  console.log('打开: ' + BASE);
  await cdp.send('Page.navigate', { url: BASE + '/' });
  await sleep(1800);

  // ---- 第 1 步：高级设置能不能点开 ----
  console.log('\n--- 步骤1: 点高级设置 ---');
  const advBefore = await cdp.eval(`(() => {
    const adv = document.getElementById('create-adv');
    const btn = document.getElementById('btn-adv');
    return JSON.stringify({ advHidden: adv ? adv.hidden : 'no-el', btnExists: !!btn, btnDisabled: btn ? btn.disabled : null });
  })()`);
  console.log('  点击前: ' + advBefore);
  await cdp.eval(`document.getElementById('btn-adv').click()`);
  await sleep(600);
  const advAfter = await cdp.eval(`(() => {
    const adv = document.getElementById('create-adv');
    return JSON.stringify({ advHidden: adv.hidden, childCount: adv.children.length });
  })()`);
  console.log('  点击后: ' + advAfter);
  const advWorks = JSON.parse(advAfter).advHidden === false;
  console.log('  高级设置 ' + (advWorks ? '✓ 能展开' : '✗ 展不开'));

  // 收起，避免影响后面
  if (advWorks) { await cdp.eval(`document.getElementById('btn-adv').click()`); await sleep(300); }

  // ---- 第 2 步：输入昵称 ----
  console.log('\n--- 步骤2: 输入昵称 ---');
  // 模拟真实键盘输入（会经过 input 事件）
  await cdp.send('Input.insertText', { text: '测试员' });
  await sleep(500);
  // Input.insertText 焦点可能不对，直接用事件兜底并报告两种状态
  const nickState = await cdp.eval(`(() => {
    const el = document.getElementById('nickname');
    const btn = document.getElementById('btn-create');
    return JSON.stringify({ value: el.value, createDisabled: btn.disabled, activeEl: document.activeElement && document.activeElement.id });
  })()`);
  console.log('  输入后: ' + nickState);

  // ---- 第 3 步：点创建房间 ----
  console.log('\n--- 步骤3: 点创建房间 ---');
  await cdp.shot('before-create');
  const createResult = await cdp.eval(`(async () => {
    const btn = document.getElementById('btn-create');
    btn.click();
    await new Promise(r => setTimeout(r, 2500));
    const table = document.getElementById('screen-table');
    const home = document.getElementById('screen-home');
    const toast = document.getElementById('toast-root');
    const conn = document.getElementById('conn-bar');
    const roomId = document.getElementById('room-id');
    return JSON.stringify({
      tableVisible: table && !table.hidden,
      homeVisible: home && !home.hidden,
      toastText: toast ? toast.textContent.trim().slice(0, 80) : '',
      connVisible: conn ? !conn.hidden : null,
      roomId: roomId ? roomId.textContent.trim() : ''
    });
  })()`);
  console.log('  点击后: ' + createResult);
  const parsed = JSON.parse(createResult);
  await cdp.shot('after-create');

  console.log('\n--- 网络请求 (' + cdp.requests.length + ' 个) ---');
  for (const r of cdp.requests.slice(0, 10)) console.log('  ' + r.method + ' ' + r.url.replace(BASE, ''));

  console.log('\n--- 控制台/网络错误 (' + cdp.consoleErrors.length + ' 条) ---');
  for (const e of cdp.consoleErrors.slice(0, 10)) console.log('  ✗ ' + e.slice(0, 300));

  console.log('\n========== 结论 ==========');
  console.log('高级设置可用: ' + advWorks);
  console.log('创建后进入牌桌: ' + parsed.tableVisible);
  console.log('创建后停在首页: ' + parsed.homeVisible);
  console.log('Toast 提示: ' + (parsed.toastText || '(无)'));

  cdp.ws.close();
  try { edge.kill(); } catch (e) {}
  setTimeout(() => process.exit(0), 300);
}

main().catch(e => { console.error('复现脚本失败:', e.message); process.exit(1); });
