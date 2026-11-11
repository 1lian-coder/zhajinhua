'use strict';
// 修复：结算界面「正在亮牌…」不自动变「准备下一局」（缺少重绘触发 + 时钟基准）
const fs = require('fs');
const p = 'public/app.js';
let s = fs.readFileSync(p, 'utf8');

// 1) 用服务端时间对齐判断闸门是否开启 + 定时重绘
s = s.replace(
  "          var hrs = st.handReady || { total: 0, readyCount: 0, waiters: [], gateAt: 0, deadline: 0 };\n          var gateOpen = hrs.gateAt && Date.now() >= hrs.gateAt;",
  "          var hrs = st.handReady || { total: 0, readyCount: 0, waiters: [], gateAt: 0, deadline: 0 };\n" +
  "          var nowSrv = (clock.serverNow || Date.now()) + (Date.now() - (clock.localAt || Date.now()));\n" +
  "          var gateOpen = hrs.gateAt ? nowSrv >= hrs.gateAt : false;\n" +
  "          if (hrs.gateAt && !gateOpen) {\n" +
  "            // 亮牌停留还没结束：到点自动重绘，让「准备下一局」按时出现\n" +
  "            if (gateRenderTimer) clearTimeout(gateRenderTimer);\n" +
  "            gateRenderTimer = setTimeout(function () {\n" +
  "              gateRenderTimer = null;\n" +
  "              if (state && state.phase === 'showdown') renderBottom(state);\n" +
  "            }, Math.max(30, hrs.gateAt - nowSrv + 60));\n" +
  "          }"
);

// 2) gateRenderTimer 变量声明
if (s.indexOf('var gateRenderTimer') < 0) {
  s = s.replace(
    '  var compareTimer = null;',
    '  var compareTimer = null;\n  var gateRenderTimer = null; // 亮牌停留结束后自动重绘结算按钮'
  );
}

// 3) 结算阶段每秒刷新准备倒计时文案
s = s.replace(
  "    if (st.phase === 'showdown' && st.nextRoundAt) updateNextRoundCount();",
  "    if (st.phase === 'showdown' && st.nextRoundAt) updateNextRoundCount();\n" +
  "    if (st.phase === 'showdown' && st.handReady && st.handReady.deadline) {\n" +
  "      var nowSrv2 = (clock.serverNow || Date.now()) + (Date.now() - (clock.localAt || Date.now()));\n" +
  "      var leftSec = Math.max(0, Math.ceil((st.handReady.deadline - nowSrv2) / 1000));\n" +
  "      var tipEl = $('turn-text');\n" +
  "      if (tipEl && st.handReady.gateAt && nowSrv2 >= st.handReady.gateAt && !st.mySitOut) {\n" +
  "        var mineReady = !(st.handReady.waiters || []).some(function (w) { return w.id === meId(); });\n" +
  "        if (!mineReady) {\n" +
  "          tipEl.textContent = (st.handReady.readyCount || 0) + '/' + (st.handReady.total || 0) + ' 已准备 · ' + leftSec + ' 秒后自动开始';\n" +
  "        }\n" +
  "      }\n" +
  "    }"
);

fs.writeFileSync(p, s, 'utf8');
console.log('结算按钮重绘修复完成');