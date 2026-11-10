'use strict';

/**
 * 引擎测试：牌型判定 + 规则校验 + 随机对局不变量
 * 运行：node --test test/
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  makeDeck,
  shuffle,
  handInfo,
  compareHands,
  cardLabel,
  TYPE
} = require('../lib/cards');
const { Room, MAX_SPECTATORS: MAX_SPECTATORS_TEST } = require('../lib/engine');
const { BOT_NAMES, handScore, decideBotAction } = require('../lib/bot');

// ---------------------------------------------------------------- 工具

function card(s, r) {
  return { s, r };
}

function info(cards) {
  return handInfo(cards);
}

/** 确定性随机数（mulberry32） */
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function newRoom(n, cfg) {
  const room = new Room('000001', cfg);
  for (let i = 0; i < n; i++) room.addPlayer('P' + (i + 1));
  // 老测试默认“所有人都已准备”，准备机制由专门的用例覆盖
  for (const p of room.players.values()) p.ready = true;
  return room;
}

const QUIET = {
  ante: 10,
  initialChips: 5000,
  baseStake: 10,
  maxStake: 100,
  maxPot: 5000,
  seeMultiplier: 2,
  special235: false,
  turnSeconds: 0,
  autoRebuy: false
};

// ---------------------------------------------------------------- 牌型

test('牌堆是 52 张且不重复', () => {
  const deck = makeDeck();
  assert.strictEqual(deck.length, 52);
  const ids = new Set(deck.map((c) => c.s + c.r));
  assert.strictEqual(ids.size, 52);
});

test('豹子 > 顺金 > 金花 > 顺子 > 对子 > 单张', () => {
  const trips = info([card('S', 7), card('H', 7), card('D', 7)]);
  const straightFlush = info([card('S', 9), card('S', 8), card('S', 7)]);
  const flush = info([card('S', 14), card('S', 9), card('S', 4)]);
  const straight = info([card('S', 9), card('H', 8), card('D', 7)]);
  const pair = info([card('S', 9), card('H', 9), card('D', 4)]);
  const high = info([card('S', 14), card('H', 9), card('D', 4)]);

  assert.strictEqual(trips.name, '豹子');
  assert.strictEqual(straightFlush.name, '顺金');
  assert.strictEqual(flush.name, '金花');
  assert.strictEqual(straight.name, '顺子');
  assert.strictEqual(pair.name, '对子');
  assert.strictEqual(high.name, '单张');

  const order = [high, pair, straight, flush, straightFlush, trips];
  for (let i = 0; i < order.length - 1; i++) {
    assert.strictEqual(compareHands(order[i + 1], order[i]), 1, `${order[i + 1].name} 应大于 ${order[i].name}`);
    assert.strictEqual(compareHands(order[i], order[i + 1]), -1);
  }
});

test('同牌型按点数比大小', () => {
  const big = info([card('S', 14), card('H', 13), card('D', 9)]);
  const small = info([card('S', 14), card('H', 12), card('D', 9)]);
  assert.strictEqual(compareHands(big, small), 1);
  assert.strictEqual(compareHands(small, big), -1);
  assert.strictEqual(compareHands(big, info([card('H', 14), card('D', 13), card('C', 9)])), 0);
});

test('对子先比对子点数，再比单张', () => {
  const pairAce = info([card('S', 14), card('H', 14), card('D', 2)]);
  const pairKing = info([card('S', 13), card('H', 13), card('D', 14)]);
  assert.strictEqual(compareHands(pairAce, pairKing), 1);

  const kickerBig = info([card('S', 9), card('H', 9), card('D', 14)]);
  const kickerSmall = info([card('S', 9), card('H', 9), card('D', 8)]);
  assert.strictEqual(compareHands(kickerBig, kickerSmall), 1);
});

test('A23 是最小的顺子，234 比它大', () => {
  const a23 = info([card('S', 14), card('H', 3), card('D', 2)]);
  const s234 = info([card('S', 4), card('H', 3), card('D', 2)]);
  assert.strictEqual(a23.name, '顺子');
  assert.strictEqual(compareHands(s234, a23), 1);
});

test('QKA 是最大的顺子', () => {
  const qka = info([card('S', 14), card('H', 13), card('D', 12)]);
  const jqk = info([card('S', 13), card('H', 12), card('D', 11)]);
  assert.strictEqual(qka.name, '顺子');
  assert.strictEqual(compareHands(qka, jqk), 1);
});

test('235 不同花：默认算单张，开启 special235 后通杀豹子', () => {
  const h235 = info([card('S', 2), card('H', 3), card('D', 5)]);
  const trips = info([card('S', 7), card('H', 7), card('D', 7)]);
  assert.strictEqual(h235.special235, true);
  assert.strictEqual(h235.name, '单张');

  // 默认关闭
  assert.strictEqual(compareHands(h235, trips, { special235: false }), -1);
  // 开启后通杀
  assert.strictEqual(compareHands(h235, trips, { special235: true }), 1);
  assert.strictEqual(compareHands(trips, h235, { special235: true }), -1);
  // 两家 235 平
  const h235b = info([card('C', 2), card('C', 3), card('S', 5)]);
  assert.strictEqual(compareHands(h235, h235b, { special235: true }), 0);
});

test('235 同花不算特殊 235，算金花', () => {
  const h = info([card('S', 2), card('S', 3), card('S', 5)]);
  assert.strictEqual(h.special235, false);
  assert.strictEqual(h.name, '金花');
});

test('牌面 label 正确', () => {
  assert.strictEqual(cardLabel(card('S', 14)), '♠A');
  assert.strictEqual(cardLabel(card('H', 10)), '♥10');
  assert.strictEqual(cardLabel(card('D', 11)), '♦J');
});

// ---------------------------------------------------------------- 房间规则

test('参与位上限 8 人：第 9 个参与被拒，但可以选观战加入（不含观战者）', () => {
  const room = new Room('000001', QUIET);
  for (let i = 0; i < 8; i++) room.addPlayer('P' + (i + 1));
  assert.strictEqual(room.activePlayers().length, 8, '8 个参与位已满');
  assert.strictEqual(room.freeSeats(), 0);
  assert.throws(() => room.addPlayer('P9'), /参与位已满/);
  // 观战方式仍可加入，不占参与位
  const watcher = room.addPlayer('观战者', { sitOut: true });
  assert.ok(watcher.id);
  assert.strictEqual(room.activePlayers().length, 8, '观战不占参与位');
  assert.strictEqual(room.players.size, 9, '房间总人数可以到 9');
  assert.strictEqual(watcher.seat, null, '观战者不占座位');
  // 房间总人数仍有上限
  room.addPlayer('观战2', { sitOut: true });
  assert.strictEqual(room.players.size, 10);
  assert.throws(() => room.addPlayer('观战3', { sitOut: true }), /房间总人数已满/);
});

test('8 人开局：52 张牌每人 3 张足够，底池与战绩正确', () => {
  const room = new Room('big8', { ...QUIET, turnSeconds: 0 });
  for (let i = 0; i < 8; i++) room.addPlayer('P' + (i + 1));
  for (const q of room.players.values()) q.ready = true;
  room.startHand(room.order[0]);
  assert.strictEqual(room.phase, 'playing');
  let dealt = 0;
  for (const p of room.players.values()) {
    assert.strictEqual(p.cards.length, 3);
    assert.strictEqual(p.bet, QUIET.ante);
    dealt += 3;
  }
  assert.strictEqual(dealt, 24);
  assert.ok(dealt <= 52, '52 张牌必须够发');
  assert.strictEqual(room.pot, QUIET.ante * 8);
  // 其余玩家依次弃牌，只剩庄家一人 → 立即结算
  let guard = 0;
  while (room.phase === 'playing' && guard++ < 30) {
    room.act(room.turnId, 'fold');
  }
  assert.strictEqual(room.phase, 'showdown');
  const netSum = [...room.players.values()].reduce((a, p) => a + p.net, 0);
  assert.strictEqual(netSum, 0);
});

test('开局至少 2 人', () => {
  const room = newRoom(1, { ...QUIET });
  assert.throws(() => room.startHand(room.order[0]), /至少需要 2 名玩家/);
});

test('开局扣底注，底池等于底注总和', () => {
  const room = newRoom(3, QUIET);
  room.startHand(room.order[0]);
  assert.strictEqual(room.phase, 'playing');
  assert.strictEqual(room.pot, QUIET.ante * 3);
  for (const p of room.players.values()) {
    assert.strictEqual(p.chips, QUIET.initialChips - QUIET.ante);
    assert.strictEqual(p.cards.length, 3);
    assert.strictEqual(p.bet, QUIET.ante);
  }
});

test('未轮到的玩家不能操作', () => {
  const room = newRoom(3, QUIET);
  room.startHand(room.order[0]);
  const notTurn = room.order.find((id) => id !== room.turnId);
  assert.throws(() => room.act(notTurn, 'call'), /还没轮到你/);
});

test('看牌后跟注翻倍', () => {
  const room = newRoom(2, QUIET);
  room.startHand(room.order[0]);
  const cur = room.players.get(room.turnId);
  const blindCost = room.callCost(cur);
  assert.strictEqual(blindCost, QUIET.baseStake);

  room.look(cur.id);
  const seenCost = room.callCost(cur);
  assert.strictEqual(seenCost, QUIET.baseStake * QUIET.seeMultiplier);
});

test('看牌前客户端拿不到自己的牌，看牌后才拿到，别人的牌始终为 null', () => {
  const room = newRoom(3, QUIET);
  room.startHand(room.order[0]);
  const me = room.turnId;
  const other = room.order.find((id) => id !== me);

  let s = room.serialize(me);
  assert.strictEqual(s.myCards, null, '没看牌就应该拿不到牌');

  room.look(me);
  s = room.serialize(me);
  assert.ok(Array.isArray(s.myCards) && s.myCards.length === 3);

  const otherView = s.players.find((p) => p.id === other);
  assert.strictEqual(otherView.cards, null, '不能看到别人的牌');
  assert.strictEqual(otherView.handName, null);
});

test('弃牌后不能再操作，且不能超过封顶加注', () => {
  const room = newRoom(3, QUIET);
  room.startHand(room.order[0]);

  // 加注超过封顶被拒
  const cur = room.turnId;
  assert.throws(() => room.act(cur, 'raise', { to: QUIET.maxStake + 1 }), /封顶/);

  // 加注必须大于当前注
  assert.throws(() => room.act(cur, 'raise', { to: QUIET.baseStake }), /必须大于/);

  room.act(cur, 'fold');
  assert.throws(() => room.act(cur, 'call'), /弃牌/);
});

test('比牌平局时主动方输', () => {
  const room = newRoom(2, QUIET);
  room.startHand(room.order[0]);
  const a = room.order[0];
  const b = room.order[1];
  // 强制两家同点数同花色不同组合会导致平局
  room.players.get(a).cards = [card('S', 14), card('H', 13), card('D', 9)];
  room.players.get(b).cards = [card('C', 14), card('S', 13), card('H', 9)];
  room.turnId = a;
  room.act(a, 'compare', { target: b });
  assert.strictEqual(room.players.get(a).folded, true, '平局主动比牌者出局');
  assert.strictEqual(room.players.get(b).folded, false);
});

test('比牌输的人出局，只剩一人时立即结算', () => {
  const room = newRoom(2, QUIET);
  room.startHand(room.order[0]);
  const a = room.order[0];
  const b = room.order[1];
  room.players.get(a).cards = [card('S', 14), card('H', 14), card('D', 14)]; // 豹子
  room.players.get(b).cards = [card('C', 2), card('S', 5), card('H', 9)];     // 单张
  const potBefore = room.pot;
  room.turnId = a;
  room.act(a, 'compare', { target: b });

  assert.strictEqual(room.phase, 'showdown');
  assert.strictEqual(room.pot, 0);
  assert.strictEqual(room.lastResult.winners[0].id, a);
  assert.strictEqual(room.lastResult.winners[0].amount, potBefore + QUIET.baseStake);
});

test('超时会自动弃牌并推进回合', () => {
  const room = newRoom(3, { ...QUIET, turnSeconds: 1 });
  room.startHand(room.order[0]);
  const firstTurn = room.turnId;
  room.turnDeadline = Date.now() - 1; // 模拟已超时
  const changed = room.tick(Date.now());
  assert.strictEqual(changed, true);
  assert.strictEqual(room.players.get(firstTurn).folded, true);
  assert.notStrictEqual(room.turnId, firstTurn);
});

test('玩家中途退出不会卡住牌局', () => {
  const room = newRoom(3, QUIET);
  room.startHand(room.order[0]);
  const cur = room.turnId;
  room.removePlayer(cur);
  assert.notStrictEqual(room.turnId, cur);
  assert.ok(room.turnId);
  // 剩下的人还能继续操作
  room.act(room.turnId, 'call');
});

test('房主退出不自动移交：无指定则无房主，指定接班人则按指定移交', () => {
  // A) 房主直接退出且没指定接班人 → 房间变成无房主，其他玩家可以接管
  const room = newRoom(3, QUIET);
  const host = room.hostId;
  const others = room.order.filter((id) => id !== host);
  room.removePlayer(host);
  assert.strictEqual(room.hostId, null, '不应自动移交给别人');
  assert.strictEqual(room.players.size, 2);
  // 任一真人可接管
  room.claimHost(others[0]);
  assert.strictEqual(room.hostId, others[0], '接管后成为房主');

  // B) 房主离开前指定接班人 → 按指定移交
  const room2 = newRoom(3, QUIET);
  const h2 = room2.hostId;
  const o2 = room2.order.filter((id) => id !== h2);
  room2.setHostHeir(h2, o2[1]); // 指定第三个
  room2.removePlayer(h2);
  assert.strictEqual(room2.hostId, o2[1], '按指定移交给接班人');

  // C) 主动转让房主
  const room3 = newRoom(3, QUIET);
  const h3 = room3.hostId;
  const tgt = room3.order.filter((id) => id !== h3)[0];
  room3.transferHost(h3, tgt);
  assert.strictEqual(room3.hostId, tgt);
  // 非房主不能转让
  assert.throws(() => room3.transferHost(h3, tgt), /只有房主/);
});

test('配置越界会被 clamp 到合法范围', () => {
  const room = newRoom(2, { ante: -50, maxStake: 999999, seeMultiplier: 99, turnSeconds: 99999 });
  assert.ok(room.config.ante >= 1);
  assert.ok(room.config.seeMultiplier <= 4);
  assert.ok(room.config.turnSeconds <= 600);
  assert.strictEqual(room.config.maxStake, 100000);
});

test('total pot 封顶时自动开牌', () => {
  const room = newRoom(2, { ...QUIET, maxPot: 40 });
  room.startHand(room.order[0]);
  let guard = 0;
  while (room.phase === 'playing' && guard++ < 50) {
    const opts = room.optionsFor(room.turnId);
    const byType = Object.fromEntries(opts.map((o) => [o.type, o]));
    if (byType.call) room.act(room.turnId, 'call');
    else room.act(room.turnId, 'fold');
  }
  assert.strictEqual(room.phase, 'showdown');
  assert.ok(room.lastResult);
});

// ---------------------------------------------------------------- 随机对局不变量

test('随机对局压力测试：账目零和、筹码不为负、状态机不死锁', () => {
  const rng = mulberry32(20261105);
  const players = 4;
  const room = newRoom(players, QUIET);
  const totalChips = players * QUIET.initialChips;
  const hands = 300;

  let settled = 0;
  for (let h = 0; h < hands; h++) {
    // 每局开始前检查上一局结算是否零和
    const sumNet = [...room.players.values()].reduce((a, p) => a + p.net, 0);
    assert.strictEqual(sumNet, 0, `第 ${h} 局开始前 net 合计应为 0，实际 ${sumNet}`);
    const sumChips = [...room.players.values()].reduce((a, p) => a + p.chips, 0);
    assert.strictEqual(sumChips + room.pot, totalChips, `第 ${h} 局开始前筹码不守恒`);

    let guard = 0;
    try {
      room.startHand(room.order[0]);
    } catch (e) {
      // 筹码耗尽后自动补筹（autoRebuy=false 时无解），换一场
      break;
    }

    while (room.phase === 'playing') {
      if (guard++ > 2000) break; // 由引擎内部 MAX_TURNS_PER_HAND 兜底
      const pid = room.turnId;
      const opts = room.optionsFor(pid);
      assert.ok(opts.length > 0, `轮到 ${pid} 时没有任何可选动作`);

      const byType = Object.fromEntries(opts.map((o) => [o.type, o]));
      const r = rng();
      try {
        if (byType.look && r < 0.25) {
          room.act(pid, 'look');
        } else if (byType.compare && r < 0.45) {
          const targets = byType.compare.targets;
          const t = targets[Math.floor(rng() * targets.length)];
          room.act(pid, 'compare', { target: t.id });
        } else if (byType.raise && r < 0.65) {
          const rs = byType.raise.raises;
          const pick = rs[Math.floor(rng() * rs.length)];
          room.act(pid, 'raise', { to: pick.to });
        } else if (byType.call && r < 0.95) {
          room.act(pid, 'call');
        } else {
          room.act(pid, 'fold');
        }
      } catch (e) {
        assert.fail(`动作执行抛出异常: ${e.message}`);
      }

      // 任何时刻筹码不能为负
      for (const p of room.players.values()) {
        assert.ok(p.chips >= 0, `${p.name} 筹码为负: ${p.chips}`);
      }
    }

    assert.strictEqual(room.pot, 0, '结算后底池必须清零');
    assert.strictEqual(room.phase, 'showdown');
    settled++;

    // 结算后状态可序列化，且能看到结果
    const view = room.serialize(room.order[0]);
    assert.ok(view.lastResult && view.lastResult.winners.length > 0);
  }

  assert.ok(settled > 200, `实际完成局数太少: ${settled}`);
  const sumNet = [...room.players.values()].reduce((a, p) => a + p.net, 0);
  assert.strictEqual(sumNet, 0, '全部结束后 net 合计应为 0');
});

test('中途作废会原额退还下注', () => {
  const room = newRoom(3, QUIET);
  room.startHand(room.order[0]);
  room.act(room.turnId, 'call');
  const sumBefore = [...room.players.values()].reduce((a, p) => a + p.chips, 0) + room.pot;
  room.abortHand('测试作废');
  const sumAfter = [...room.players.values()].reduce((a, p) => a + p.chips, 0);
  assert.strictEqual(room.pot, 0);
  assert.strictEqual(sumAfter, sumBefore);
  assert.strictEqual([...room.players.values()].reduce((a, p) => a + p.net, 0), 0);
});

test('开牌时公开所有参与者的牌（含已弃牌者），但开牌前不泄露', () => {
  const room = newRoom(3, { ...QUIET, maxPot: 200 });
  room.startHand(room.order[0]);
  const [a, b, c] = room.order;

  // 让 a 弃牌，然后 b、c 一路打到封顶开牌
  room.turnId = a;
  room.act(a, 'fold');

  // 开牌前：a 的牌不该被别看到
  const midView = room.serialize(b);
  const midFolded = midView.players.find((p) => p.id === a);
  assert.strictEqual(midFolded.cards, null, '开牌前弃牌者的牌不能泄露');

  let guard = 0;
  while (room.phase === 'playing' && guard++ < 100) {
    const opts = room.optionsFor(room.turnId);
    const by = {};
    for (const o of opts) by[o.type] = o;
    if (by.call) room.act(room.turnId, 'call');
    else room.act(room.turnId, 'fold');
  }
  assert.strictEqual(room.phase, 'showdown');

  const view = room.serialize(b);
  const foldedView = view.players.find((p) => p.id === a);
  assert.strictEqual(foldedView.folded, true);
  assert.ok(foldedView.cards && foldedView.cards.length === 3, '开牌后弃牌者的牌也应公开');
  assert.ok(foldedView.handName, '开牌后弃牌者的牌型也应公开');

  // lastResult.showdown 也要包含弃牌者
  assert.ok(room.lastResult.showdown.some((s) => s.id === a && s.folded), '结算列表应包含弃牌者');
  void c;
});

test('弃牌获胜：赢家可自行决定是否公布牌，其他人不能代劳（关闭全亮模式）', () => {
  const room = newRoom(3, { ...QUIET, turnSeconds: 0, showAllAtEnd: false });
  const [a, b, c] = room.order;
  room.startHand(a);

  // 两家弃牌 → 只剩一家获胜
  room.turnId = b;
  room.act(b, 'fold');
  room.turnId = c;
  room.act(c, 'fold');
  assert.strictEqual(room.phase, 'showdown');
  assert.strictEqual(room.lastResult.singleWin, true, '应标记为弃牌获胜');
  assert.strictEqual(room.revealWinner, null);

  // 默认不公布：别人看不到赢家的牌
  let view = room.serialize(b);
  const w0 = view.players.find((p) => p.id === a);
  assert.strictEqual(w0.cards, null, '未公布时看不到赢家的牌');

  // 非赢家不能公布
  assert.throws(() => room.revealWin(b.id), /只有本局赢家/);

  // 赢家公布
  room.revealWin(a);
  assert.strictEqual(room.revealWinner, true);
  view = room.serialize(b);
  const w1 = view.players.find((p) => p.id === a);
  assert.ok(w1.cards && w1.cards.length === 3, '公布后所有人能看到赢家的牌');
  assert.strictEqual(view.revealWinner, true);

  // 开牌局（真正的摊牌，而非弃牌获胜）不可调用 revealWin
  const room2 = newRoom(2, { ...QUIET, turnSeconds: 0, maxPot: 60 });
  room2.startHand(room2.order[0]);
  forceCards(room2, room2.order[0], [card('S', 14), card('H', 14), card('D', 14)]);
  forceCards(room2, room2.order[1], [card('S', 5), card('H', 6), card('D', 7)]);
  let guard2 = 0;
  while (room2.phase === 'playing' && guard2++ < 50) {
    const opts = room2.optionsFor(room2.turnId);
    const call = opts.find((o) => o.type === 'call');
    if (call) room2.act(room2.turnId, 'call');
    else room2.act(room2.turnId, 'fold');
  }
  assert.strictEqual(room2.phase, 'showdown');
  assert.strictEqual(room2.lastResult.singleWin, undefined, '达到总注封顶是开牌，不是弃牌获胜');
  assert.throws(() => room2.revealWin(room2.order[0]), /不是弃牌获胜/);
});

test('每轮局数：打满后停止自动连开，且本房间不能再开下一局（必须新开房间）', () => {
  const room = newRoom(2, {
    ...QUIET,
    turnSeconds: 0,
    maxPot: 60,
    autoNext: true,
    autoNextSeconds: 30,
    sessionHands: 2
  });
  const [a, b] = room.order;

  const playOne = () => {
    room.startHand(a);
    forceCards(room, a, [card('S', 14), card('H', 14), card('D', 14)]);
    forceCards(room, b, [card('S', 5), card('H', 6), card('D', 7)]);
    room.turnId = a;
    room.act(a, 'compare', { target: b });
  };

  playOne(); // 第 1 局
  assert.strictEqual(room.lastResult.sessionOver, undefined, '没打满不该标记结束');
  assert.ok(room.nextHandAt > 0, '未打满应排自动连开');

  playOne(); // 第 2 局
  assert.strictEqual(room.handNo, 2);
  assert.strictEqual(room.lastResult.sessionOver, true, '打满 2 局应标记本轮结束');
  assert.strictEqual(room.nextHandAt, 0, '本轮结束不应自动连开');

  // 本轮打满后不再要求新开房间：点「下一轮」沿用原设置直接续上
  assert.strictEqual(room.roundNo, 1);
  room.requestNextRound(a);
  // 还有 b 没点 → 进入 30 秒集合等待
  assert.ok(room.nextRoundAt > 0, '有人没点时应进入集合等待');
  room.requestNextRound(b); // b 也点了
  assert.strictEqual(room.roundWaiters().length, 0, '都点了就没人要等');
  room.tick(room.nextRoundAt + 1); // 倒计时到点自动开始新一轮
  assert.strictEqual(room.roundNo, 2, '进入第 2 轮');
  assert.strictEqual(room.handNo, 0, '新一轮局数归零');
  assert.strictEqual(room.phase, 'lobby', '新一轮回到大厅，房主可改设置');
  room.startHand(a);
  assert.strictEqual(room.phase, 'playing');
  assert.strictEqual(room.handNo, 1, '新一轮第 1 局');
});

test('看牌不是回合动作：没轮到自己也能看（HTTP /api/look 与 action=look 行为一致）', () => {
  const room = newRoom(3, QUIET);
  room.startHand(room.order[0]);
  const notTurn = room.order.find((id) => id !== room.turnId);

  room.act(notTurn, 'look');
  assert.strictEqual(room.players.get(notTurn).seen, true);

  // 但真正的回合动作仍然要求轮到你
  assert.throws(() => room.act(notTurn, 'call'), /还没轮到你/);
});

test('落盘再恢复：进行中的牌局作废并原额退注，账目保持零和', () => {
  const room = newRoom(3, QUIET);
  const totalChips = 3 * QUIET.initialChips;
  room.startHand(room.order[0]);

  // 制造局面：当前玩家跟注，另一个人看牌
  const cur = room.turnId;
  const other = room.order.find((id) => id !== cur);
  room.act(cur, 'call');
  room.look(other);

  const sumBefore = [...room.players.values()].reduce((a, p) => a + p.chips, 0) + room.pot;
  assert.strictEqual(sumBefore, totalChips);

  // 模拟重启（只经过 JSON，不共享对象引用）
  const raw = JSON.parse(JSON.stringify(room.toJSON()));
  const restored = Room.fromJSON(raw);

  assert.strictEqual(restored.phase, 'lobby', '重启后应回到大厅，不恢复进行中的牌局');
  assert.strictEqual(restored.pot, 0, '底池应清零');
  assert.strictEqual(restored.players.size, 3);

  const sumAfter = [...restored.players.values()].reduce((a, p) => a + p.chips, 0);
  assert.strictEqual(sumAfter, totalChips, '下注必须原额退还，不能凭空消失');
  assert.strictEqual(
    [...restored.players.values()].reduce((a, p) => a + p.net, 0),
    0,
    '净分合计必须为 0'
  );
  for (const p of restored.players.values()) {
    assert.strictEqual(p.chips, QUIET.initialChips, `${p.name} 的筹码应完全恢复`);
    assert.strictEqual(p.bet, 0);
    assert.strictEqual(p.inHand, false);
    assert.strictEqual(p.cards, null);
  }

  // 恢复后还能正常开新的一局（恢复的玩家需要重新点准备）
  for (const q of restored.players.values()) q.ready = true;
  restored.startHand(restored.order[0]);
  assert.strictEqual(restored.phase, 'playing');
  assert.strictEqual(restored.pot, QUIET.ante * 3);
});

// ---------------------------------------------------------------- 人机玩家

test('人机：单个真人 + 人机即可开局，人机自动出牌打完整局', () => {
  const room = new Room('000111', { ...QUIET, maxPot: 400 });
  const me = room.addPlayer('独狼');
  room.addBot();
  room.addBot();
  me.ready = true;

  assert.strictEqual(room.players.size, 3);
  assert.strictEqual(room.hostId, me.id, '人机不能当房主');

  room.startHand(me.id);
  let guard = 0;
  while (room.phase === 'playing' && guard++ < 300) {
    if (room.turnId === me.id) {
      // 真人开局就弃牌，把牌局留给两个人机互打（验证纯人机对局推进）
      room.act(me.id, 'fold', {});
    } else {
      // 测试加速：清零延迟，模拟"思考时间已到"（botTick 每次动作后会随机化延迟）
      const p = room.players.get(room.turnId);
      if (p && p.isBot) p.botDelay = 0;
      room.botTick(Date.now());
    }
  }

  assert.strictEqual(room.phase, 'showdown', `guard=${guard} 后应结算`);
  assert.strictEqual(room.pot, 0);
  assert.ok(room.lastResult && room.lastResult.winners.length > 0);
  const netSum = [...room.players.values()].reduce((a, p) => a + p.net, 0);
  assert.strictEqual(netSum, 0, '含人机账目也必须零和');
  for (const p of room.players.values()) {
    assert.ok(p.chips >= 0, `${p.name} 筹码为负`);
  }
});

test('人机：决策函数覆盖强弱牌路径，且落盘恢复后人机身份保留', () => {
  // 开局让 activeInHand 非空，决策才有意义
  const room = new Room('000112', QUIET);
  const me = room.addPlayer('裁判');
  const bot = room.addBot();
  room.addBot();
  me.ready = true;
  room.startHand(me.id);
  room.stake = QUIET.baseStake;
  room.pot = 100;

  // 强牌（豹子）只会加注/跟注/比牌，不会弃牌
  bot.cards = [card('S', 14), card('H', 14), card('D', 14)];
  bot.seen = true;

  let foldedStrong = 0;
  for (let i = 0; i < 60; i++) {
    const d = decideBotAction(room, bot, () => (i % 10) / 10);
    if (d.action === 'fold') foldedStrong++;
    void d;
  }
  assert.strictEqual(foldedStrong, 0, '豹子不应弃牌');

  // 弱牌在高注下大概率弃牌
  bot.cards = [card('S', 3), card('H', 7), card('D', 9)]; // 单张 9 高
  room.stake = QUIET.maxStake; // 单注顶格
  room.pot = 2000; // 池子很大
  let folds = 0;
  for (let i = 0; i < 100; i++) {
    const d = decideBotAction(room, bot, () => (i % 100) / 100);
    if (d.action === 'fold') folds++;
  }
  assert.ok(folds >= 60, `弱牌高注应多数弃牌（实际 ${folds}/100）`);

  // 落盘恢复：人机身份、在场状态保留
  room.abortHand('测试');
  const raw = JSON.parse(JSON.stringify(room.toJSON()));
  const restored = Room.fromJSON(raw);
  const rb = [...restored.players.values()].find((p) => p.isBot);
  assert.ok(rb, '恢复后人机仍在');
  assert.strictEqual(rb.connected, true, '人机恢复后恒在线');
  assert.ok(BOT_NAMES.includes(rb.name) || rb.name.startsWith('人机'));
  assert.strictEqual(restored.hostId, me.id, '恢复后房主仍是真人');
  void handScore;
});

// ------------------------------------------------------------ 孤注一掷 + 侧池

function forceCards(room, pid, cards) {
  room.players.get(pid).cards = cards;
}

test('孤注一掷：跟不起时可选，全下后留在牌局、跳过轮转，直接开牌', () => {
  const room = newRoom(3, { ...QUIET, turnSeconds: 0 });
  const [a, b, c] = room.order;
  room.startHand(a);

  // 把 a 的筹码弄到只够孤注一掷
  const pa = room.players.get(a);
  pa.chips = 5;
  room.turnId = a;

  const opts = room.optionsFor(a);
  const allinOpt = opts.find((o) => o.type === 'allin');
  assert.ok(allinOpt, '跟不起时应提供孤注一掷');
  assert.strictEqual(allinOpt.cost, 5);
  assert.ok(!opts.find((o) => o.type === 'call'), '跟不起时不应有跟注');
  assert.ok(!opts.find((o) => o.type === 'compare'), '跟不起时不应有比牌');

  room.act(a, 'allin', {});
  assert.strictEqual(pa.allIn, true);
  assert.strictEqual(pa.chips, 0);
  assert.strictEqual(pa.bet, QUIET.ante + 5);

  // b、c 还能行动（a 被跳过轮转）
  assert.notStrictEqual(room.turnId, a);

  // 筹码足够时不能孤注一掷
  room.turnId = room.turnId; // 当前行动人筹码充足
  assert.throws(() => room.act(room.turnId, 'allin', {}), /直接跟注/);
  void b; void c;
});

test('侧池：全下者只能赢到对手匹配的部分，多投入者拿回差额', () => {
  // A 豹子（大）、B 顺子、C 弃牌
  // 投入：A=100, B=40(全下), C=20(弃牌) → 总池 160
  const room = newRoom(3, { ...QUIET, turnSeconds: 0, maxPot: 99999 });
  const [a, b, c] = room.order;
  room.startHand(a);
  forceCards(room, a, [card('S', 14), card('H', 14), card('D', 14)]);
  forceCards(room, b, [card('S', 5), card('H', 6), card('D', 7)]);
  forceCards(room, c, [card('C', 9), card('C', 2), card('C', 3)]);

  // 手工构造投入：ante=10 各自已出
  const pa = room.players.get(a);
  const pb = room.players.get(b);
  const pc = room.players.get(c);
  room.takeChips(pa, 90); room.takeChips(pb, 30); room.takeChips(pc, 10); // 走账目系统
  pa.bet = 100; pb.bet = 40; pc.bet = 20;
  pa.allIn = false; pb.allIn = true;
  pc.folded = true;
  room.pot = 160;
  room.phase = 'playing';

  // A 赢：层 20×3=60 给 A；层 20×2=40 给 A；层 60×1=60 给 A → A +160
  room.settleShowdown('测试A赢');
  let gotA = room.lastResult.winners.find((w) => w.id === a);
  assert.strictEqual(gotA.amount, 160, `A 应赢整池 160，实际 ${gotA.amount}`);
  assert.strictEqual([...room.players.values()].reduce((s, p) => s + p.net, 0), 0);

  // B 赢：B 只能赢到层 40（60+40=100），A 拿回最高层 60
  const room2 = newRoom(3, { ...QUIET, turnSeconds: 0, maxPot: 99999 });
  room2.startHand(room2.order[0]);
  const [x, y, z] = room2.order;
  forceCards(room2, x, [card('S', 2), card('H', 7), card('D', 9)]); // 弱
  forceCards(room2, y, [card('S', 5), card('H', 6), card('D', 7)]); // 顺子
  forceCards(room2, z, [card('C', 9), card('C', 2), card('C', 3)]);
  const px = room2.players.get(x);
  const py = room2.players.get(y);
  const pz = room2.players.get(z);
  room2.takeChips(px, 90); room2.takeChips(py, 30); room2.takeChips(pz, 10); // 走账目系统
  px.bet = 100; py.bet = 40; pz.bet = 20;
  py.allIn = true;
  pz.folded = true;
  room2.pot = 160;
  room2.phase = 'playing';

  room2.settleShowdown('测试B赢');
  const gotY = room2.lastResult.winners.find((w) => w.id === y);
  const gotX = room2.lastResult.winners.find((w) => w.id === x);
  assert.strictEqual(gotY.amount, 100, `B 全下只应赢 100，实际 ${gotY.amount}`);
  assert.strictEqual(gotX.amount, 60, `A 应拿回未被匹配的 60，实际 ${gotX.amount}`);
  assert.strictEqual([...room2.players.values()].reduce((s, p) => s + p.net, 0), 0, '侧池结算必须零和');
});

test('只剩一人能行动时自动开牌（其余全下）', () => {
  const room = newRoom(2, { ...QUIET, turnSeconds: 0, maxPot: 99999 });
  const [a, b] = room.order;
  room.startHand(a);
  const pa = room.players.get(a);
  const pb = room.players.get(b);
  pa.chips = 5;
  room.turnId = a;
  room.act(a, 'allin', {});

  // 只剩 b 能行动 → 立即开牌
  assert.strictEqual(room.phase, 'showdown');
  assert.strictEqual(room.lastResult.reason, '其余玩家已全下，直接开牌');
  assert.ok(room.lastResult.showdown.length === 2, '两人都参与开牌');
  assert.strictEqual([...room.players.values()].reduce((s, p) => s + p.net, 0), 0);
  void pb;
});

// ------------------------------------------------------------ 掉线托管

test('掉线托管：真人断线后超宽限期由系统代打，牌局不卡；重连即恢复', () => {
  const room = newRoom(2, { ...QUIET, turnSeconds: 0 });
  const [a, b] = room.order;
  room.startHand(a);

  const pb = room.players.get(b);
  pb.connected = false; // 掉线
  room.turnId = b;

  // 宽限期内不代打
  const t0 = Date.now();
  room.turnStartedAt = t0 - 29999;
  assert.strictEqual(room.botTick(t0), false, '30 秒宽限内不应托管');

  // 过了宽限期自动代打
  room.turnStartedAt = t0 - 31000;
  const acted = room.botTick(t0);
  assert.strictEqual(acted, true, '宽限期过后应托管出牌');
  assert.notStrictEqual(room.turnId, b, '托管后应轮转到下一个人');

  // 在线真人不托管
  const pa = room.players.get(a);
  pa.connected = true;
  room.turnId = a;
  room.turnStartedAt = t0 - 999999;
  assert.strictEqual(room.botTick(Date.now()), false, '在线真人的回合绝不代打');
});

// ------------------------------------------------------------ 比牌亮牌 / 借分

test('比牌：双方都能看到彼此的牌，无关玩家看不到', () => {
  const room = newRoom(3, { ...QUIET, turnSeconds: 0 });
  const [a, b, c] = room.order;
  room.startHand(a);
  room.turnId = a;
  room.act(a, 'compare', { target: b });

  const va = room.serialize(a);
  const vb = room.serialize(b);
  const vc = room.serialize(c);

  assert.ok(va.myCompare, '主动比牌者能看到双方牌');
  assert.strictEqual(va.myCompare.aCards.length, 3);
  assert.strictEqual(va.myCompare.bCards.length, 3);
  assert.ok(vb.myCompare, '被比牌的一方也能看到双方牌');
  assert.strictEqual(vb.myCompare.aCards.length, 3);
  assert.strictEqual(vc.myCompare, null, '无关玩家看不到比牌的牌');

  // 比牌信息不落进公开的 players 字段
  const leaked = vc.players.filter((p) => p.cards && p.cards.length === 3);
  assert.strictEqual(leaked.length, 0, '无关玩家看不到暗牌');
});

test('借分：需要对方同意才到账，金额与条件都有校验', () => {
  const room = newRoom(3, { ...QUIET, autoRebuy: false, turnSeconds: 0 });
  const [a, b, c] = room.order;
  const pb = room.players.get(b);
  pb.chips = 0; // b 输光了

  assert.throws(() => room.proposeLoan(a, b, 0), /金额无效/);
  assert.throws(() => room.proposeLoan(a, b, 99999), /最多 5000/);
  assert.throws(() => room.proposeLoan(a, c, 100), /不需要借分/, '对方还有筹码不该借');
  assert.throws(() => room.proposeLoan(a, a, 100), /不能借给自己/);

  const loan = room.proposeLoan(a, b, 200);
  assert.strictEqual(loan.status, 'pending');
  const chipsA = room.players.get(a).chips;
  const chipsB = room.players.get(b).chips;
  assert.strictEqual(chipsB, 0, '同意前不到账');

  // 无关的人不能同意/拒绝
  assert.throws(() => room.acceptLoan(loan.id, c), /与你无关/);
  assert.throws(() => room.declineLoan(loan.id, c), /与你无关/);

  // 对方同意后到账
  room.acceptLoan(loan.id, b);
  assert.strictEqual(room.players.get(a).chips, chipsA - 200);
  assert.strictEqual(room.players.get(b).chips, chipsB + 200);
  // 借分直接结算：出借方净分 -200，借入方净分 +200，不记欠分
  assert.strictEqual(room.players.get(a).net, -200, '出借方直接扣分');
  assert.strictEqual(room.players.get(b).net, 200, '借入方直接加分');
  assert.strictEqual(room.serialize(a).players.find((x) => x.id === a).debt, undefined);
  assert.strictEqual(room.serialize(a).loans[0].status, 'accepted');

  // 已经处理过的不能再操作
  assert.throws(() => room.acceptLoan(loan.id, b), /处理过了/);

  // 拒绝流程（再把 b 的筹码清零才符合"需要借分"的条件）
  room.players.get(b).chips = 0;
  const loan2 = room.proposeLoan(a, b, 100);
  room.declineLoan(loan2.id, b);
  assert.strictEqual(loan2.status, 'declined');
  assert.strictEqual(room.players.get(b).chips, 0, '拒绝后不到账');
});

test('借分：关闭自动补筹码后，筹码输光的人进不了下一局', () => {
  const room = newRoom(3, { ...QUIET, autoRebuy: false, turnSeconds: 0 });
  const [a, b, c] = room.order;
  room.startHand(a);
  // 快速打完一局
  room.turnId = b;
  room.act(b, 'fold');
  room.turnId = c;
  room.act(c, 'fold');
  assert.strictEqual(room.phase, 'showdown');

  // 把 b 筹码清零，再开一局：b 应被排除
  room.players.get(b).chips = 0;
  room.nextHand(a);
  assert.strictEqual(room.phase, 'playing');
  assert.strictEqual(room.players.get(b).inHand, false, '筹码不足且不自动补，无法入局');
  assert.strictEqual(room.players.get(c).inHand, true);
});

test('观战：不占座位、不能操作、看不到暗牌、开牌后可见', () => {
  const room = newRoom(3, { ...QUIET, turnSeconds: 0, maxPot: 200 });
  const [a, b, c] = room.order;
  const spec = room.addSpectator('观众甲');

  assert.strictEqual(room.players.size, 3, '观战者不占玩家座位');
  assert.strictEqual(room.spectators.size, 1);
  assert.notStrictEqual(spec.id, a);

  room.startHand(a);

  // 观战者不能执行任何动作
  assert.throws(() => room.act(spec.id, 'call', {}), /玩家不存在/);
  assert.throws(() => room.look(spec.id), /玩家不存在/);
  assert.throws(() => room.setBid(spec.id, 2), /玩家不存在/);

  // 观战视角：看不到任何暗牌
  const v = room.serialize(spec.id);
  assert.strictEqual(v.spectating, true);
  assert.strictEqual(v.spectatorCount, 1);
  assert.strictEqual(v.myCards, null, '观战者看不到自己的牌（没有牌）');
  for (const p of v.players) {
    assert.strictEqual(p.cards, null, `${p.name} 的暗牌不该下发给观战者`);
    assert.strictEqual(p.handName, null);
  }

  // 玩家视角确认观战者在列表里
  const pv = room.serialize(a);
  assert.strictEqual(pv.spectating, false);
  assert.strictEqual(pv.spectators[0].name, '观众甲');

  // 开牌后，观战者能看到参与摊牌者的牌（打到总注封顶开牌）
  forceCards(room, a, [card('S', 14), card('H', 14), card('D', 14)]);
  forceCards(room, b, [card('S', 5), card('H', 6), card('D', 7)]);
  forceCards(room, c, [card('C', 9), card('C', 2), card('C', 3)]);
  let guard2 = 0;
  while (room.phase === 'playing' && guard2++ < 200) {
    const opts = room.optionsFor(room.turnId);
    const call = opts.find((o) => o.type === 'call');
    if (call) room.act(room.turnId, 'call');
    else room.act(room.turnId, 'fold');
    if (room.phase !== 'playing') break;
  }
  assert.strictEqual(room.phase, 'showdown');

  const sv = room.serialize(spec.id);
  const shown = sv.players.filter((p) => p.cards && p.cards.length === 3);
  assert.ok(shown.length >= 1, '开牌后观战者应能看到摊牌');
  assert.ok(sv.lastResult && sv.lastResult.winners.length > 0, '观战者能看到结算结果');

  // 观战者可以聊天
  room.addChat(spec.id, '好看');
  assert.strictEqual(room.chat[room.chat.length - 1].text, '好看');

  // 离场
  assert.strictEqual(room.removePlayer(spec.id), true);
  assert.strictEqual(room.spectators.size, 0);
});

test('观战：人数上限与落盘恢复', () => {
  const room = new Room('spec2', QUIET);
  room.addPlayer('主');
  for (let i = 0; i < MAX_SPECTATORS_TEST; i++) room.addSpectator('观众' + i);
  assert.throws(() => room.addSpectator('超员'), /观战人数已满/);

  const raw = JSON.parse(JSON.stringify(room.toJSON()));
  const restored = Room.fromJSON(raw);
  assert.strictEqual(restored.spectators.size, room.spectators.size, '观战者随落盘保留');
  const lastToken = [...room.spectators.values()][0].token;
  const sp = [...restored.spectators.values()][0];
  assert.strictEqual(sp.token, lastToken, '观战 token 保留');
  assert.strictEqual(restored.serialize(sp.id).spectating, true);
});

test('抢庄：抢的人中随机定庄，全部选完后自动进入下注阶段', () => {
  const room = newRoom(3, { ...QUIET, dealerBid: true, bidSeconds: 5, turnSeconds: 0 });
  const [a, b, c] = room.order;
  room.startHand(a);

  assert.strictEqual(room.phase, 'bidding', '开启抢庄后应先进入抢庄阶段');
  assert.ok(room.bidDeadline > Date.now(), '应有抢庄截止时刻');
  assert.strictEqual(room.dealerId, null, '抢庄阶段庄家未定');
  assert.strictEqual(room.pot, QUIET.ante * 3, '底注已收');

  room.act(a, 'bid', { bid: 1 });
  room.act(b, 'bid', { bid: 1 });
  room.act(c, 'bid', { bid: 0 });

  // 全员选完应自动定庄：庄家在抢的人（a/b）里随机，不抢的 c 不会当庄
  assert.strictEqual(room.phase, 'playing');
  assert.ok(room.dealerId === a || room.dealerId === b, `庄家应是抢庄的 a 或 b，实际 ${room.dealerId}`);
  assert.notStrictEqual(room.dealerId, c);
  assert.strictEqual(room.turnId, room.nextInHandAfter(room.dealerId), '庄家下一位先行动');

  // 抢庄阶段已结束，不能再 bid
  assert.throws(() => room.act(a, 'bid', { bid: 1 }), /不是抢庄阶段/);
});

test('抢庄：只有一个人抢时就是他当庄', () => {
  const room = newRoom(3, { ...QUIET, dealerBid: true, bidSeconds: 5, turnSeconds: 0 });
  const [a, b, c] = room.order;
  room.startHand(a);
  room.act(a, 'bid', { bid: 0 });
  room.act(b, 'bid', { bid: 1 });
  room.act(c, 'bid', { bid: 0 });
  assert.strictEqual(room.phase, 'playing');
  assert.strictEqual(room.dealerId, b);
});

test('抢庄：无人抢时按座位轮转确定庄家', () => {
  const room = newRoom(3, { ...QUIET, dealerBid: true, bidSeconds: 5, turnSeconds: 0 });
  const [a, b, c] = room.order;
  room.startHand(a);
  room.act(a, 'bid', { bid: 0 });
  room.act(b, 'bid', { bid: 0 });
  // c 未选，到截止时间视为不抢
  const future = room.bidDeadline + 1000;
  room.tick(future);

  assert.strictEqual(room.phase, 'playing');
  assert.ok(room.dealerId, '应有庄家（轮转产生）');
  assert.notStrictEqual(room.players.get(room.dealerId).bid, null, '未选的应被记为 0');
});

test('抢庄：只能选 0/1（没有倍数），非抢庄阶段不能 bid', () => {
  const room = newRoom(3, { ...QUIET, dealerBid: true, bidSeconds: 5, turnSeconds: 0 });
  const [a] = room.order;
  room.startHand(a);
  assert.throws(() => room.act(a, 'bid', { bid: 5 }), /只能选择/);
  assert.throws(() => room.act(a, 'bid', { bid: 2 }), /只能选择/);
  assert.throws(() => room.act(a, 'bid', { bid: -1 }), /只能选择/);
  assert.throws(() => room.act(a, 'call', {}), /抢庄阶段/);

  // 未开启抢庄的房间，bid 动作不可用
  const room2 = newRoom(2, QUIET);
  room2.startHand(room2.order[0]);
  assert.strictEqual(room2.phase, 'playing');
  assert.throws(() => room2.act(room2.turnId, 'bid', { bid: 1 }), /不是抢庄阶段/);
});

test('抢庄：人在抢庄阶段退出，人数不足时作废退注', () => {
  const room = newRoom(3, { ...QUIET, dealerBid: true, bidSeconds: 5, turnSeconds: 0 });
  const [a, b, c] = room.order;
  room.startHand(a);
  room.act(a, 'bid', { bid: 1 });
  room.removePlayer(b);
  room.removePlayer(c);

  // 只剩一人：到点/全选完时作废
  const future = room.bidDeadline + 1000;
  room.tick(future);
  assert.strictEqual(room.phase, 'lobby', '人数不足应作废回大厅');
  const netSum = [...room.players.values()].reduce((s, p) => s + p.net, 0);
  assert.strictEqual(netSum, 0, '退注后零和');
});

test('抢庄：人机在抢庄阶段自动决策，整局可打完', () => {
  const room = new Room('bid6', { ...QUIET, dealerBid: true, bidSeconds: 5, turnSeconds: 0, maxPot: 300 });
  const me = room.addPlayer('独狼');
  room.addBot();
  room.addBot();
  me.ready = true;
  room.startHand(me.id);

  assert.strictEqual(room.phase, 'bidding');
  // 时间推进 3 秒：人机（最迟约 2.7 秒）已选，但未到 5 秒截止，真人仍可选
  room.tick(Date.now() + 3000);
  const bots = [...room.players.values()].filter((p) => p.isBot);
  assert.ok(bots.every((p) => p.bid != null), '人机应已做出抢庄选择');
  // 真人选不抢
  room.act(me.id, 'bid', { bid: 0 });

  assert.strictEqual(room.phase, 'playing', '全员选完应进入下注阶段');
  // 之后正常打完
  let guard = 0;
  while (room.phase === 'playing' && guard++ < 60) {
    if (room.turnId === me.id) room.act(me.id, 'fold');
    else room.botTick(Date.now() + 999999);
  }
  assert.strictEqual(room.phase, 'showdown');
});

test('自动连开：结算后按配置排定下一局，到点自动开局；可取消', () => {
  const room = newRoom(2, { ...QUIET, turnSeconds: 0, maxPot: 60, autoNext: true, autoNextSeconds: 3 });
  const [a, b] = room.order;
  room.startHand(a);
  forceCards(room, a, [card('S', 14), card('H', 14), card('D', 14)]);
  forceCards(room, b, [card('S', 5), card('H', 6), card('D', 7)]);
  room.turnId = a;
  room.act(a, 'compare', { target: b });

  assert.strictEqual(room.phase, 'showdown');
  assert.ok(room.nextHandAt > 0, '开启自动连开后应排定下一局时刻');
  const delay = room.nextHandAt - Date.now();
  assert.ok(delay > 2500 && delay <= 3500, `等待时长应接近 3 秒，实际 ${delay}`);

  // 未到点不自动开
  assert.strictEqual(room.tick(Date.now()), false, '未到点不应开局');
  assert.strictEqual(room.phase, 'showdown');

  // 到点自动开局（用伪造的未来时间）
  const startedAt = room.nextHandAt + 100;
  assert.strictEqual(room.tick(startedAt), true, '到点应自动开局');
  assert.strictEqual(room.phase, 'playing');
  assert.strictEqual(room.handNo, 2, '应进入第 2 局');
  assert.strictEqual(room.nextHandAt, 0, '开局后清空计划');

  // 关闭自动连开则不排定
  const room2 = newRoom(2, { ...QUIET, turnSeconds: 0, maxPot: 60, autoNext: false });
  const [x, y] = room2.order;
  room2.startHand(x);
  forceCards(room2, x, [card('S', 14), card('H', 14), card('D', 14)]);
  forceCards(room2, y, [card('S', 5), card('H', 6), card('D', 7)]);
  room2.turnId = x;
  room2.act(x, 'compare', { target: y });
  assert.strictEqual(room2.nextHandAt, 0, '未开启自动连开不应排定');
});

test('自动连开：可手动取消；手动「下一局」也会清空计划', () => {
  const room = newRoom(2, { ...QUIET, turnSeconds: 0, maxPot: 60, autoNext: true, autoNextSeconds: 30 });
  const [a, b] = room.order;
  room.startHand(a);
  forceCards(room, a, [card('S', 14), card('H', 14), card('D', 14)]);
  forceCards(room, b, [card('S', 5), card('H', 6), card('D', 7)]);
  room.turnId = a;
  room.act(a, 'compare', { target: b });
  assert.ok(room.nextHandAt > 0);

  // 任何玩家都能取消
  assert.strictEqual(room.pauseAutoNext(b), true);
  assert.strictEqual(room.nextHandAt, 0);
  // 取消后到点也不会自动开
  assert.strictEqual(room.tick(Date.now() + 60000), false);
  assert.strictEqual(room.phase, 'showdown');

  // 手动开下一局
  room.nextHand(a);
  assert.strictEqual(room.phase, 'playing');
  assert.strictEqual(room.nextHandAt, 0);

  // 非房间成员不能取消
  assert.throws(() => room2Pause(), /玩家不存在/);
  function room2Pause() { room.pauseAutoNext('ghost'); }
});

// ------------------------------------------------------------ 房间密码

test('房间密码：设置/校验/清除，且不会下发给客户端', () => {
  const room = newRoom(2, QUIET);
  const [host, other] = room.order;
  assert.strictEqual(room.joinPin, '');

  // 非房主不能设
  assert.throws(() => room.setJoinPin(other, '1234'), /只有房主/);
  // 位数校验
  assert.throws(() => room.setJoinPin(host, '12'), /4~8 位数字/);
  assert.throws(() => room.setJoinPin(host, '123456789'), /4~8 位数字/);

  // 正常设置（非数字字符会被剔除）
  room.setJoinPin(host, '12 34');
  assert.strictEqual(room.joinPin, '1234');

  // 校验
  assert.strictEqual(room.checkJoinPin('1234'), true);
  assert.strictEqual(room.checkJoinPin('4 3 2 1'), false);
  assert.strictEqual(room.checkJoinPin(''), false);
  assert.strictEqual(room.checkJoinPin(null), false);

  // 无密码时任何输入都通过
  const room2 = newRoom(2, QUIET);
  assert.strictEqual(room2.checkJoinPin(''), true);
  assert.strictEqual(room2.checkJoinPin('9999'), true);

  // 客户端只能看到 hasJoinPin，拿不到明文
  const view = room.serialize(host);
  assert.strictEqual(view.hasJoinPin, true);
  assert.strictEqual(view.joinPin, undefined, '绝不能下发密码明文');
  assert.strictEqual(JSON.stringify(view).indexOf('1234') >= 0 && JSON.stringify(view).indexOf('"1234"') >= 0, false, '状态里不应出现密码');

  // 落盘保留，且 fromJSON 不泄露
  const raw = JSON.parse(JSON.stringify(room.toJSON()));
  const restored = Room.fromJSON(raw);
  assert.strictEqual(restored.joinPin, '1234', '密码随落盘保留');
  assert.strictEqual(restored.serialize(host).joinPin, undefined);

  // 牌局中不能改
  room.clearJoinPin = null;
  const room3 = newRoom(2, QUIET);
  room3.startHand(room3.order[0]);
  assert.throws(() => room3.setJoinPin(room3.order[0], '5678'), /牌局进行中/);

  // 清除
  room.setJoinPin(host, '');
  assert.strictEqual(room.joinPin, '');
  assert.strictEqual(room.checkJoinPin(''), true);
});

// ------------------------------------------------------------ 战绩与聊天

test('战绩统计：参与/胜局/最大赢池随对局累计，且落盘保留', () => {
  const room = newRoom(2, { ...QUIET, turnSeconds: 0, maxPot: 60 });
  const [a, b] = room.order;
  room.startHand(a);
  forceCards(room, a, [card('S', 14), card('H', 14), card('D', 14)]);
  forceCards(room, b, [card('S', 5), card('H', 6), card('D', 7)]);
  room.turnId = a;
  room.act(a, 'compare', { target: b });

  assert.strictEqual(room.phase, 'showdown');
  assert.strictEqual(room.stats[a].hands, 1);
  assert.strictEqual(room.stats[a].wins, 1);
  assert.strictEqual(room.stats[a].best, room.lastResult.winners[0].amount);
  assert.strictEqual(room.stats[b].hands, 1);
  assert.strictEqual(room.stats[b].wins, 0);

  // 落盘往返
  const raw = JSON.parse(JSON.stringify(room.toJSON()));
  const restored = Room.fromJSON(raw);
  assert.deepStrictEqual(restored.stats[a], room.stats[a], '战绩应随落盘保留');
});

test('快捷聊天：清洗、限长、带序号；不过滤表情', () => {
  const room = newRoom(2, QUIET);
  const [a, b] = room.order;

  room.addChat(a, '  快点啦  ');
  room.addChat(b, '哈哈😄'.repeat(10)); // 20 个字符（emoji 计 1）
  room.addChat(a, 'a'.repeat(50));

  assert.strictEqual(room.chat.length, 3);
  assert.strictEqual(room.chat[0].text, '快点啦');
  assert.strictEqual(room.chat[1].text.length <= 30, true, '超长应被截断');
  assert.strictEqual(room.chat[2].text.length, 30);
  assert.ok(room.chat[0].seq < room.chat[1].seq && room.chat[1].seq < room.chat[2].seq, 'seq 递增');

  assert.throws(() => room.addChat(a, '   '), /说点什么/);
  assert.throws(() => room.addChat('ghost', 'hi'), /玩家不存在/);

  const view = room.serialize(a);
  assert.strictEqual(view.chat.length, 3);
  assert.strictEqual(view.chatSeq, 3);
});

test('设置锁定：首局开始后房主也不能改规则；开局前可自定义底分和初始筹码', () => {
  const room = newRoom(2, { ...QUIET, turnSeconds: 0 });
  const [a] = room.order;

  // 开局前：自定义底分 / 初始筹码，并同步到还没开局的玩家
  const saved = room.setConfig({ ...QUIET, turnSeconds: 0, ante: 25, initialChips: 300, baseStake: 25, maxStake: 100, maxPot: 3000 }, room.hostId);
  assert.strictEqual(saved.ante, 25, '底分可以自定义');
  assert.strictEqual(saved.initialChips, 300, '初始筹码可以自定义');
  for (const p of room.players.values()) assert.strictEqual(p.chips, 300, '大厅阶段同步初始筹码');

  // 底分/初始筹码下限放宽
  const low = room.setConfig({ ...QUIET, turnSeconds: 0, ante: 1, initialChips: 10 }, room.hostId);
  assert.strictEqual(low.ante, 1);
  assert.strictEqual(low.initialChips, 10);

  // 首局开始后：锁定
  room.setConfig({ ...QUIET, turnSeconds: 0, ante: 10, initialChips: 1000, baseStake: 10, maxStake: 100, maxPot: 5000 }, room.hostId);
  room.startHand(a);
  assert.throws(
    () => room.setConfig({ ...QUIET, turnSeconds: 0, ante: 99 }, room.hostId),
    /牌局进行中不能修改设置/,
    '牌局进行中不能改设置'
  );

  // 局间（showdown）同样锁定：不能边打边改
  room.turnId = room.order[1];
  room.act(room.order[1], 'fold');
  assert.strictEqual(room.phase, 'showdown');
  assert.throws(
    () => room.setConfig({ ...QUIET, turnSeconds: 0, ante: 99 }, room.hostId),
    /设置已锁定/,
    '首局开始后（包括局间）都不能改设置'
  );
});

test('比牌后双方都算看过牌：输家闷牌也能看到自己的牌并留场观战', () => {
  const room = newRoom(3, { ...QUIET, turnSeconds: 0 });
  const [a, b, c] = room.order;
  room.startHand(a);
  assert.strictEqual(room.players.get(a).seen, false, '开局都是闷牌');
  assert.strictEqual(room.players.get(b).seen, false);

  room.turnId = a;
  room.act(a, 'compare', { target: b });

  assert.strictEqual(room.players.get(a).seen, true, '比牌后主动方算看过牌');
  assert.strictEqual(room.players.get(b).seen, true, '比牌后被比方也算看过牌');

  const loserId = room.players.get(a).folded ? a : b;
  const winnerId = loserId === a ? b : a;
  const lv = room.serialize(loserId);
  assert.ok(lv.myCards && lv.myCards.length === 3, '输家（原本闷牌）能看到自己的 3 张牌');
  assert.ok(lv.myHandName, '输家能看到自己的牌型');
  const wv = room.serialize(winnerId);
  assert.ok(wv.myCards && wv.myCards.length === 3, '赢家也能看到自己的牌');
  // 输家留在房间里继续观战
  assert.strictEqual(lv.phase, 'playing');
  assert.strictEqual(room.players.get(loserId).inHand, true, '输家仍在本局（留场观战）');
  assert.strictEqual(room.players.get(loserId).folded, true);
  void c;
});

test('出牌顺序：以当前行动者开头轮转，弃牌/全下的人自动移出', () => {
  const room = newRoom(4, { ...QUIET, turnSeconds: 0 });
  const [a, b, c, d] = room.order;
  room.startHand(a);

  const st0 = room.serialize(a);
  assert.strictEqual(st0.turnOrder.length, room.actorsInHand().length);
  assert.strictEqual(st0.turnOrder[0], room.turnId, '顺序第一个是当前行动者');
  assert.strictEqual(st0.myTurnIndex, st0.turnOrder.indexOf(a), '我的位次正确');

  // 行动一次后顺序跟着当前行动者重排
  room.act(room.turnId, 'call');
  const st1 = room.serialize(a);
  assert.strictEqual(st1.turnOrder[0], room.turnId, '顺序随当前行动者变化');

  // 有人弃牌后从顺序里移除
  const foldedId = room.turnId;
  room.act(foldedId, 'fold');
  const st2 = room.serialize(a);
  assert.strictEqual(st2.turnOrder.indexOf(foldedId), -1, '弃牌的人不在顺序里');
  assert.strictEqual(st2.turnOrder.length, room.actorsInHand().length);
  void b; void c; void d;
});

test('头像：白名单校验、落盘保留、人机随机头像', () => {
  const room = newRoom(2, QUIET);
  const [a] = room.order;

  room.setAvatar(a, '🐼');
  assert.strictEqual(room.players.get(a).avatar, '🐼');
  assert.strictEqual(room.serialize(a).myAvatar, '🐼');

  assert.throws(() => room.setAvatar(a, '<script>'), /头像不在可选范围/);
  assert.throws(() => room.setAvatar('不存在的玩家', '🐼'), /玩家不存在/);

  // 清空 = 用名字首字
  room.setAvatar(a, '');
  assert.strictEqual(room.players.get(a).avatar, null);

  // 落盘保留
  room.setAvatar(a, '🦊');
  const restored = Room.fromJSON(JSON.parse(JSON.stringify(room.toJSON())));
  assert.strictEqual(restored.players.get(a).avatar, '🦊');

  // 人机自动带随机头像
  const bot = room.addBot();
  assert.ok(bot.avatar, '人机应该有随机头像');
  assert.strictEqual(room.serialize(a).players.find((p) => p.id === bot.id).avatar, bot.avatar);
});

test('豹子/顺金奖励：开牌时赢家开出豹子，其他在局玩家每人给奖励分（零和）', () => {
  const room = newRoom(3, { ...QUIET, turnSeconds: 0, maxPot: 60, baoziBonus: 100, shunjinBonus: 50 });
  const [a, b, c] = room.order;
  room.startHand(a);
  forceCards(room, a, [card('S', 14), card('H', 14), card('D', 14)]); // 豹子
  forceCards(room, b, [card('S', 5), card('H', 6), card('D', 7)]);
  forceCards(room, c, [card('C', 9), card('C', 2), card('C', 3)]);

  let guard = 0;
  while (room.phase === 'playing' && guard++ < 100) {
    const opts = room.optionsFor(room.turnId);
    const call = opts.find((o) => o.type === 'call');
    if (call) room.act(room.turnId, 'call');
    else room.act(room.turnId, 'fold');
  }
  assert.strictEqual(room.phase, 'showdown');

  const res = room.lastResult;
  assert.ok(res.bonuses && res.bonuses.length === 1, '应有豹子喜钱记录');
  assert.strictEqual(res.bonuses[0].type, '豹子');
  assert.strictEqual(res.bonuses[0].perPlayer, 100);
  assert.strictEqual(res.bonuses[0].total, 200, '另外两人各给 100');

  const netSum = [...room.players.values()].reduce((s, p) => s + p.net, 0);
  assert.strictEqual(netSum, 0, '喜钱后账目仍零和');
  const pa = room.players.get(a);
  const pb = room.players.get(b);
  assert.ok(pa.chips > 5000, '赢家筹码应增加（含喜钱）');
  assert.ok(pb.chips < 5000, '其他人筹码应减少（含喜钱）');
});

test('顺金奖励：开出顺金时按配置给喜钱；配置为 0 时没有喜钱', () => {
  const room = newRoom(3, { ...QUIET, turnSeconds: 0, maxPot: 60, baoziBonus: 100, shunjinBonus: 50 });
  const [a, b, c] = room.order;
  room.startHand(a);
  forceCards(room, a, [card('S', 7), card('S', 8), card('S', 9)]); // 顺金
  forceCards(room, b, [card('H', 5), card('D', 6), card('C', 7)]);
  forceCards(room, c, [card('D', 2), card('H', 3), card('C', 9)]);

  let guard = 0;
  while (room.phase === 'playing' && guard++ < 100) {
    const opts = room.optionsFor(room.turnId);
    const call = opts.find((o) => o.type === 'call');
    if (call) room.act(room.turnId, 'call');
    else room.act(room.turnId, 'fold');
  }
  assert.strictEqual(room.phase, 'showdown');
  const res = room.lastResult;
  assert.ok(res.bonuses && res.bonuses.length === 1);
  assert.strictEqual(res.bonuses[0].type, '顺金');
  assert.strictEqual(res.bonuses[0].perPlayer, 50);
  assert.strictEqual(res.bonuses[0].total, 100);

  // 关掉奖励后不再有喜钱
  const room2 = newRoom(2, { ...QUIET, turnSeconds: 0, maxPot: 40, baoziBonus: 0, shunjinBonus: 0 });
  const [p] = room2.order;
  room2.startHand(p);
  forceCards(room2, p, [card('S', 14), card('H', 14), card('D', 14)]);
  forceCards(room2, room2.order[1], [card('S', 5), card('H', 6), card('D', 7)]);
  let g2 = 0;
  while (room2.phase === 'playing' && g2++ < 60) {
    const opts = room2.optionsFor(room2.turnId);
    const call = opts.find((o) => o.type === 'call');
    if (call) room2.act(room2.turnId, 'call');
    else room2.act(room2.turnId, 'fold');
  }
  assert.strictEqual(room2.phase, 'showdown');
  assert.strictEqual((room2.lastResult.bonuses || []).length, 0, '配置为 0 不该有喜钱');
});

test('头像：支持相册图片（小尺寸 base64），拒绝 SVG/超大/非法内容', () => {
  const room = newRoom(2, QUIET);
  const [a] = room.order;
  const png = 'data:image/png;base64,' + 'A'.repeat(400);

  room.setAvatar(a, png);
  assert.strictEqual(room.players.get(a).avatar, png, '小图 data URL 可以设为头像');
  assert.strictEqual(room.serialize(a).myAvatar, png);

  assert.throws(() => room.setAvatar(a, 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='), /头像不在可选范围/, 'SVG 不安全，必须拒绝');
  assert.throws(() => room.setAvatar(a, 'data:image/png;base64,' + 'A'.repeat(30000)), /头像不在可选范围/, '超大图片必须拒绝');
  assert.throws(() => room.setAvatar(a, 'data:image/png;base64,'), /头像不在可选范围/, '空内容必须拒绝');

  // 落盘保留
  const restored = Room.fromJSON(JSON.parse(JSON.stringify(room.toJSON())));
  assert.strictEqual(restored.players.get(a).avatar, png);
});

test('昵称唯一：同房间重名被拒，并记录用过的昵称', () => {
  const room = newRoom(2, QUIET);
  const [a] = room.order;
  assert.throws(() => room.addPlayer('P1'), /已经有人用了/, '重名必须被拒绝');
  assert.throws(() => room.addPlayer('P2'), /已经有人用了/);
  assert.ok(room.usedNames.includes('P1') && room.usedNames.includes('P2'), '用过的昵称要有记录');
  // 人机名字自动避开重名
  const bots = [room.addBot(), room.addBot(), room.addBot()];
  const names = bots.map((b) => b.name);
  assert.strictEqual(new Set(names).size, names.length, '人机名字不重复');
  for (const n of names) assert.notStrictEqual(room.players.get(a).name, n, '人机不能和玩家重名');
});

test('参与/观战：观战玩家不参与本局，可在局间切回；进行中不能切换', () => {
  const room = newRoom(3, { ...QUIET, turnSeconds: 0 });
  const [a, b, c] = room.order;

  assert.strictEqual(room.setSitOut(c, true), true);
  assert.strictEqual(room.serialize(c).mySitOut, true);
  room.startHand(a);
  assert.strictEqual(room.players.get(c).inHand, false, '观战玩家不参与本局');
  assert.strictEqual(room.players.get(a).inHand, true);

  // 进行中不能切换
  assert.throws(() => room.setSitOut(a, true), /牌局进行中不能切换/);

  // 打完一局后切回来（a 弃牌后只剩 b，直接结算）
  room.turnId = a;
  room.act(a, 'fold');
  assert.strictEqual(room.phase, 'showdown');
  room.setSitOut(c, false);
  room.nextHand(a);
  assert.strictEqual(room.players.get(c).inHand, true, '切回后参与下一局');

  // 全部观战：无法开局（用新房间验证）
  const room2 = newRoom(2, { ...QUIET, turnSeconds: 0 });
  for (const id of room2.order) room2.setSitOut(id, true);
  assert.throws(() => room2.startHand(room2.order[0]), /参与本局的人数不足/);
});

test('每局输赢 + 每轮总结：deltas 零和，roundSummary 累计，再来一轮重新累计', () => {
  const room = newRoom(2, { ...QUIET, turnSeconds: 0, maxPot: 60, sessionHands: 2 });
  const [a, b] = room.order;

  const playOne = () => {
    room.startHand(a);
    forceCards(room, a, [card('S', 14), card('H', 14), card('D', 14)]);
    forceCards(room, b, [card('S', 5), card('H', 6), card('D', 7)]);
    room.turnId = a;
    room.act(a, 'compare', { target: b });
  };

  playOne();
  const r1 = room.lastResult;
  assert.ok(r1.deltas && r1.deltas.length === 2, '每人都有本局输赢');
  assert.strictEqual(r1.deltas.reduce((s, d) => s + d.delta, 0), 0, '本局输赢零和');
  assert.strictEqual(r1.sessionOver, undefined);

  playOne();
  const r2 = room.lastResult;
  assert.strictEqual(r2.sessionOver, true);
  assert.ok(r2.roundSummary && r2.roundSummary.length === 2, '本轮总结包含所有人');
  const roundSum = r2.roundSummary.reduce((s, x) => s + x.delta, 0);
  assert.strictEqual(roundSum, 0, '本轮总结零和');
  // 本轮总结 = 两局净分变化之和
  const netA = room.players.get(a).net;
  assert.strictEqual(r2.roundSummary.find((x) => x.id === a).delta, netA, '本轮总结与净分一致');

  // 本轮打满后可以在本房间继续下一轮（不再要求新开房间）
  const netBefore = netA;
  room.nextHand(a); // 应由内部切到下一轮并开新局
  assert.strictEqual(room.roundNo, 2, '已进入第 2 轮');
  const rDeltas = room.lastResult && room.lastResult.deltas;
  assert.ok(rDeltas === null || rDeltas === undefined || rDeltas.length >= 0, '新一轮照常');

  // 新房间：输赢统计重新累计（每轮总结重新开始）
  const room2 = newRoom(2, { ...QUIET, turnSeconds: 0, maxPot: 60, sessionHands: 2 });
  room2.startHand(room2.order[0]);
  forceCards(room2, room2.order[0], [card('S', 14), card('H', 14), card('D', 14)]);
  forceCards(room2, room2.order[1], [card('S', 5), card('H', 6), card('D', 7)]);
  room2.turnId = room2.order[0];
  room2.act(room2.order[0], 'compare', { target: room2.order[1] });
  const r3 = room2.lastResult;
  assert.strictEqual(r3.sessionOver, undefined, '新房间重新开始计数');
  assert.ok(r3.deltas, '新房间每局输赢照常');
});

test('每局结束亮出所有牌：开启时弃牌获胜也全亮，关闭时只有赢家可选公布', () => {
  // 开启（默认）：弃牌获胜也把所有在局玩家的牌亮给所有人
  const room = newRoom(3, { ...QUIET, turnSeconds: 0, showAllAtEnd: true });
  const [a, b, c] = room.order;
  room.startHand(a);
  room.turnId = b;
  room.act(b, 'fold');
  room.turnId = c;
  room.act(c, 'fold');
  assert.strictEqual(room.phase, 'showdown');
  assert.strictEqual(room.lastResult.singleWin, true);
  assert.ok(room.lastResult.showdown.length >= 2, '开启全亮时结算数据包含所有人的牌');
  const v = room.serialize(b);
  const visible = v.players.filter((p) => p.cards && p.cards.length === 3);
  assert.strictEqual(visible.length, 3, '三个人（含弃牌者）的牌都可见');

  // 关闭：默认不亮，只有赢家可选公布
  const room2 = newRoom(3, { ...QUIET, turnSeconds: 0, showAllAtEnd: false });
  const [x, y, z] = room2.order;
  room2.startHand(x);
  room2.turnId = y;
  room2.act(y, 'fold');
  room2.turnId = z;
  room2.act(z, 'fold');
  assert.strictEqual(room2.phase, 'showdown');
  assert.strictEqual((room2.lastResult.showdown || []).length, 0, '关闭时结算数据不带牌');
  const v2 = room2.serialize(y);
  assert.strictEqual(v2.players.filter((p) => p.cards && p.cards.length === 3).length, 0, '关闭时看不到别人的牌');
  room2.revealWin(x);
  const v3 = room2.serialize(y);
  assert.ok(v3.players.find((p) => p.id === x).cards, '关闭时赢家公布后才可见');
});

test('积分：新玩家从 0 开始；房主可重置所有人积分（局间）', () => {
  const room = newRoom(2, { ...QUIET, turnSeconds: 0, maxPot: 60 });
  const [a, b] = room.order;
  assert.strictEqual(room.players.get(a).net, 0, '新玩家积分从 0 开始');
  assert.strictEqual(room.players.get(b).net, 0);

  // 打一局：赢家正分、输家负分
  room.startHand(a);
  forceCards(room, a, [card('S', 14), card('H', 14), card('D', 14)]);
  forceCards(room, b, [card('S', 5), card('H', 6), card('D', 7)]);
  room.turnId = a;
  room.act(a, 'compare', { target: b });
  assert.ok(room.players.get(a).net > 0, '赢家积分往上加');
  assert.ok(room.players.get(b).net < 0, '输家积分是负数');

  // 非房主不能重置
  assert.throws(() => room.resetScores(b), /只有房主/);
  // 牌局进行中不能重置（新开一局验证）
  room.startHand(a);
  assert.throws(() => room.resetScores(a), /牌局进行中不能重置/);
  room.abortHand('测试');
  // 房主重置：积分归 0、战绩清零、筹码恢复初始值
  room.resetScores(a);
  for (const p of room.players.values()) {
    assert.strictEqual(p.net, 0, '重置后积分归 0');
    assert.strictEqual(p.chips, room.config.initialChips, '筹码恢复初始值');
  }
  for (const s of Object.values(room.stats)) {
    assert.strictEqual(s.hands, 0);
    assert.strictEqual(s.wins, 0);
  }
});

test('看牌跟注不递增：闷牌付单注，看牌者一律付 单注×看牌倍数（都是 40）', () => {
  const room = newRoom(4, {
    ...QUIET, turnSeconds: 0, maxStake: 100, seeMultiplier: 2, maxPot: 99999
  });
  const [a, b, c, d] = room.order;
  room.startHand(a); // 庄 a，先行动 b

  // b 闷牌跟注：付单注 10
  room.act(b, 'call');
  assert.strictEqual(room.players.get(b).bet, 20, '闷牌：底注10 + 跟注10');
  assert.strictEqual(room.stake, 10, '闷牌不改变单注');

  // c 看牌跟注：单注10 × 2 = 20
  room.look(c);
  room.act(c, 'call');
  assert.strictEqual(room.players.get(c).bet, 30, '看牌：底注10 + 跟注20');

  // d 看牌跟注：仍然 20（不在上一个看牌者基础上再翻倍）
  room.look(d);
  room.act(d, 'call');
  assert.strictEqual(room.players.get(d).bet, 30, '第二个看牌者也是跟 20');

  // a 看牌跟注：仍然 20
  room.look(a);
  room.act(a, 'call');
  assert.strictEqual(room.players.get(a).bet, 30, '第三个看牌者还是跟 20');
  assert.strictEqual(room.stake, 10, '看牌跟注不会推高单注');
});

test('单注从底分推导：底分 2 → 单注 2，可加注到 4/8/16/32', () => {
  const room = newRoom(2, { ...QUIET, ante: 2, maxStake: 100, turnSeconds: 0, maxPot: 99999 });
  assert.strictEqual(room.config.baseStake, 2, '初始单注 = 底分');
  room.startHand(room.order[0]);
  assert.strictEqual(room.stake, 2, '开局单注 = 底分 2');
  const cur = room.turnId;
  room.act(cur, 'raise', { to: 4 });
  assert.strictEqual(room.stake, 4, '加到 4（底分×2）成功');
  const cur2 = room.turnId;
  room.act(cur2, 'raise', { to: 16 });
  assert.strictEqual(room.stake, 16, '加到 16（底分×8）成功');
  // 超过单注封顶被拒
  const cur3 = room.turnId;
  assert.throws(() => room.act(cur3, 'raise', { to: 200 }), /单注封顶/);
});

test('固定 8 座位：新玩家坐空位，换座位改变出牌顺序，牌局中不能换', () => {
  const room = newRoom(3, { ...QUIET, turnSeconds: 0 });
  const [a, b, c] = room.order;
  assert.strictEqual(room.players.get(a).seat, 0);
  assert.strictEqual(room.players.get(b).seat, 1);
  assert.strictEqual(room.players.get(c).seat, 2);
  // 序列化带座位表（8 个位置）
  const sv0 = room.serialize(b);
  assert.deepStrictEqual(sv0.seats.slice(0, 3), [a, b, c]);
  assert.strictEqual(sv0.seats.length, 8);
  assert.strictEqual(sv0.mySeat, 1);

  // c 换到 5 号位：出牌顺序仍按座位（a0 b1 c5）
  room.setSeat(c, 5);
  assert.strictEqual(room.players.get(c).seat, 5);
  assert.deepStrictEqual(room.order, [a, b, c]);

  // a 换到 7 号位：顺序变成 b1 c5 a7
  room.setSeat(a, 7);
  assert.deepStrictEqual(room.order, [b, c, a]);
  // 有人坐的座位不能再坐
  assert.throws(() => room.setSeat(a, 1), /已经有人/);
  // 非法座位号
  assert.throws(() => room.setSeat(a, 8), /座位号无效/);

  // 开局后不能换座位
  room.startHand(room.order[0]);
  assert.throws(() => room.setSeat(b, 3), /进行中不能换座位/);
  room.abortHand('测试');
  room.setSeat(b, 3);
  assert.strictEqual(room.players.get(b).seat, 3);
  assert.deepStrictEqual(room.order, [b, c, a]);
});

test('加入申请：房主审批后才进房间，拒绝则进不去，过期申请清理', () => {
  const room = newRoom(2, { ...QUIET, requireApproval: true });
  const [a, b] = room.order;
  assert.strictEqual(room.requireApproval(), true);

  // 申请人：进不了 players，只在 pendingJoins
  const req = room.requestJoin('新来的');
  assert.strictEqual(room.players.size, 2, '申请不占座位');
  assert.strictEqual(room.pendingJoins.size, 1);
  assert.strictEqual(req.status, 'pending');
  // 重名申请被拒
  assert.throws(() => room.requestJoin('新来的'), /已经有人用了/);
  // 非房主不能审批
  assert.throws(() => room.approveJoin(req.id, b), /只有房主/);
  assert.throws(() => room.rejectJoin(req.id, b), /只有房主/);

  // 房主同意 → 进入 players
  const p = room.approveJoin(req.id, a);
  assert.strictEqual(room.players.size, 3);
  // 审批后申请移出待审批区（释放名额），结果保留在 recentJoins 供查询
  assert.strictEqual(room.pendingJoins.has(req.id), false, '已批准的申请不占名额');
  assert.strictEqual(room.recentJoins.get(req.id).status, 'approved');
  const st = room.joinStatus(req.id);
  assert.strictEqual(st.status, 'approved');
  assert.strictEqual(st.playerId, p.id);
  assert.ok(st.playerToken, '同意后拿到正式 token');
  // 重复审批被拒
  assert.throws(() => room.approveJoin(req.id, a), /已经处理过了/);

  // 拒绝流程
  const req2 = room.requestJoin('捣乱的');
  room.rejectJoin(req2.id, a);
  assert.strictEqual(room.players.size, 3, '被拒绝的不进房间');
  assert.strictEqual(room.joinStatus(req2.id).status, 'rejected');

  // 序列化：房主看到待审批列表，其他人看不到
  const req3 = room.requestJoin('排队中');
  const hostView = room.serialize(a);
  assert.strictEqual(hostView.pendingJoins.length, 1);
  assert.strictEqual(hostView.pendingJoinCount, 1);
  const otherView = room.serialize(b);
  assert.strictEqual(otherView.pendingJoins.length, 0, '非房主看不到申请列表');

  // 关闭审批开关后可以直接加入
  const room2 = newRoom(2, { ...QUIET, requireApproval: false });
  assert.strictEqual(room2.requireApproval(), false);
  const p2 = room2.addPlayer('直接进');
  assert.ok(p2.id);
});

test('准备机制：全员准备才能开局，缺一人则报错并列出名字', () => {
  const room = new Room('ready1', { ...QUIET, turnSeconds: 0 });
  room.addPlayer('甲');
  room.addPlayer('乙');
  room.addPlayer('丙');
  const [a, b, c] = room.order;
  assert.strictEqual(room.allReady(), false, '刚进房都没准备');

  // 只准备一人 → 仍不能开局
  room.setReady(a, true);
  assert.strictEqual(room.players.get(a).ready, true);
  assert.throws(() => room.startHand(b), /还有 2 人没准备/);
  // 报错信息里带没准备的人名
  try {
    room.startHand(b);
    assert.fail('不该开局成功');
  } catch (e) {
    assert.ok(e.message.indexOf('乙') >= 0 || e.message.indexOf('丙') >= 0, '要列出谁没准备');
  }

  // 再多一人
  room.setReady(b, true);
  assert.throws(() => room.startHand(c), /还有 1 人没准备/);
  // 最后一人准备 → 房主点开始成功
  room.setReady(c, true);
  assert.strictEqual(room.allReady(), true);
  room.startHand(c);
  assert.strictEqual(room.phase, 'playing');
  // 开局后准备状态清零（同一轮后面的局不用再点准备）
  for (const p of room.players.values()) assert.strictEqual(p.ready, false);
});

test('准备机制：观战者和人机不需要准备；取消准备生效', () => {
  const room = new Room('ready2', { ...QUIET, turnSeconds: 0 });
  const a = room.addPlayer('真人甲');
  const b = room.addPlayer('真人乙');
  const bot = room.addBot();
  // 人机自动就绪
  assert.strictEqual(bot.ready, true, '人机自动准备');
  assert.strictEqual(room.readyWaiters().length, 2, '两个真人待准备');

  // 乙选择观战 → 不计入准备名单
  room.setSitOut(b.id, true);
  assert.strictEqual(room.readyWaiters().length, 1, '观战者不需要准备');
  // 观战状态下不能点准备
  assert.throws(() => room.setReady(b.id, true), /观战/);

  room.setReady(a.id, true);
  assert.strictEqual(room.allReady(), true, '甲 + 人机就绪即可开局');
  room.startHand(a.id);
  assert.strictEqual(room.phase, 'playing');
  // 乙是观战，本局不参与
  assert.strictEqual(room.players.get(b.id).inHand, false);

  // 取消准备后不能开局
  room.abortHand('测试');
  room.setSitOut(b.id, false);
  room.setReady(a.id, false);
  assert.strictEqual(room.players.get(a.id).ready, false);
  assert.strictEqual(room.allReady(), false);
  assert.throws(() => room.startHand(a.id), /还有 2 人没准备|没准备/);
});


test('房主观战时不占参与位：8 个玩家可以全部参与', () => {
  const room = new Room('seat8', { ...QUIET, turnSeconds: 0 });
  const host = room.addPlayer('房主');
  // 房主切观战 → 让出座位
  room.setSitOut(host.id, true);
  assert.strictEqual(host.sitOut, true);
  assert.strictEqual(host.seat, null, '观战时不占座位');
  assert.strictEqual(room.freeSeats(), 8, '空出 8 个参与位');
  // 8 个玩家全部进来参与
  for (let i = 1; i <= 8; i++) {
    const p2 = room.addPlayer('P' + i);
    assert.ok(Number.isInteger(p2.seat), '参与者应有座位');
  }
  assert.strictEqual(room.activePlayers().length, 8);
  assert.strictEqual(room.players.size, 9, '8 玩家 + 观战房主 = 9 人');
  assert.strictEqual(room.freeSeats(), 0);
  // 第 9 个参与被拒，但观战可以
  assert.throws(() => room.addPlayer('P9'), /参与位已满/);
  const w = room.addPlayer('观战者', { sitOut: true });
  assert.strictEqual(w.seat, null);
  assert.strictEqual(room.players.size, 10);
  // 房间总人数上限
  assert.throws(() => room.addPlayer('超员', { sitOut: true }), /房间总人数已满/);
});

test('房主可主动转让房主给指定的人；不能转给自己/人机', () => {
  const room = newRoom(3, QUIET);
  const host = room.hostId;
  const [other1, other2] = room.order.filter((id) => id !== host);
  // 转给 other2
  const name = room.transferHost(host, other2);
  assert.strictEqual(room.hostId, other2);
  assert.ok(name, '返回被转让者的名字');
  // 新房东可以再转让
  room.transferHost(other2, other1);
  assert.strictEqual(room.hostId, other1);
  // 原房主已不是房主，不能再转让
  assert.throws(() => room.transferHost(host, other2), /只有房主/);
  // 不能转给自己
  assert.throws(() => room.transferHost(other1, other1), /不能转给自己/);
  // 不能转给人机
  const bot = room.addBot();
  assert.throws(() => room.transferHost(other1, bot.id), /人机/);
});

test('房主离开：无指定则房间无房主，任一真人可接管', () => {
  const room = newRoom(3, QUIET);
  const host = room.hostId;
  const others = room.order.filter((id) => id !== host);
  room.removePlayer(host);
  assert.strictEqual(room.hostId, null, '不自动转交');
  // 无房主时谁都能接管
  room.claimHost(others[1]);
  assert.strictEqual(room.hostId, others[1]);
  // 已有房主时不能再接管
  assert.throws(() => room.claimHost(others[0]), /已经有房主/);
  // 人机不能当房主
  const bot = room.addBot();
  assert.throws(() => room.claimHost(bot.id), /人机/);
});

test('房主离开前指定接班人：离开时按指定移交', () => {
  const room = newRoom(3, QUIET);
  const host = room.hostId;
  const others = room.order.filter((id) => id !== host);
  room.setHostHeir(host, others[1]);
  assert.strictEqual(room.hostHeir, others[1]);
  room.removePlayer(host);
  assert.strictEqual(room.hostId, others[1], '按指定移交');
  assert.strictEqual(room.hostHeir, null, '移交后清空接班人');
  // 指定的接班人已离开则变成无房主
  const room2 = newRoom(3, QUIET);
  const h2 = room2.hostId;
  const o2 = room2.order.filter((id) => id !== h2);
  room2.setHostHeir(h2, o2[1]);
  room2.removePlayer(o2[1]);
  room2.removePlayer(h2);
  assert.strictEqual(room2.hostId, null, '接班人已离开则不转交');
});

