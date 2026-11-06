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
const { Room } = require('../lib/engine');
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

test('房间人数上限 6 人，第 7 人被拒绝', () => {
  const room = newRoom(6, QUIET);
  assert.strictEqual(room.players.size, 6);
  assert.throws(() => room.addPlayer('P7'), /房间已满/);
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

test('房主退出后自动移交房主', () => {
  const room = newRoom(3, QUIET);
  const host = room.hostId;
  room.removePlayer(host);
  assert.notStrictEqual(room.hostId, host);
  assert.ok(room.players.has(room.hostId));
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

test('结算时弃牌玩家的牌不会被公开（防开控制台偷看）', () => {
  const room = newRoom(3, { ...QUIET, maxPot: 200 });
  room.startHand(room.order[0]);
  const [a, b, c] = room.order;

  // 让 a 弃牌，然后 b、c 一路打到封顶开牌
  room.turnId = a;
  room.act(a, 'fold');

  let guard = 0;
  while (room.phase === 'playing' && guard++ < 100) {
    const opts = room.optionsFor(room.turnId);
    const by = {};
    for (const o of opts) by[o.type] = o;
    if (by.call) room.act(room.turnId, 'call');
    else room.act(room.turnId, 'fold');
  }
  assert.strictEqual(room.phase, 'showdown');

  const viewer = room.players.get(b);
  const view = room.serialize(b.id);
  const foldedView = view.players.find((p) => p.id === a);
  assert.strictEqual(foldedView.folded, true);
  assert.strictEqual(foldedView.cards, null, '弃牌玩家的牌不应被公开');
  assert.strictEqual(foldedView.handName, null);

  // 而参与摊牌的人应该亮牌
  const others = view.players.filter((p) => !p.folded && p.inHand);
  assert.ok(others.length >= 1);
  assert.ok(others.some((p) => p.cards && p.cards.length === 3));
  void c;
  void viewer;
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

  // 恢复后还能正常开新的一局
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
