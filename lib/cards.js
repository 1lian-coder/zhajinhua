'use strict';

/**
 * 扑克牌与牌型判定（炸金花 / 三张牌）
 * 牌值：2..10, 11=J, 12=Q, 13=K, 14=A
 * 花色：S 黑桃 H 红桃 D 方块 C 梅花
 */

const crypto = require('crypto');

const SUITS = ['S', 'H', 'D', 'C'];
const SUIT_SYMBOL = { S: '♠', H: '♥', D: '♦', C: '♣' };
const SUIT_COLOR = { S: 'black', H: 'red', D: 'red', C: 'black' };
const SUIT_NAME = { S: '黑桃', H: '红桃', D: '方块', C: '梅花' };
const RANK_LABEL = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };

// 牌型从小到大
const TYPE = {
  HIGH: 1,
  PAIR: 2,
  STRAIGHT: 3,
  FLUSH: 4,
  STRAIGHT_FLUSH: 5,
  TRIPS: 6
};

const TYPE_NAME = {
  1: '单张',
  2: '对子',
  3: '顺子',
  4: '金花',
  5: '顺金',
  6: '豹子'
};

function rankLabel(r) {
  return RANK_LABEL[r] || String(r);
}

function cardId(c) {
  return c.s + c.r;
}

function cardLabel(c) {
  return SUIT_SYMBOL[c.s] + rankLabel(c.r);
}

function makeDeck() {
  const deck = [];
  for (const s of SUITS) {
    for (let r = 2; r <= 14; r++) deck.push({ s, r });
  }
  return deck;
}

function randInt(n) {
  return crypto.randomInt(n);
}

/** Fisher-Yates 洗牌；可注入确定性随机源用于测试 */
function shuffle(deck, rng) {
  const rnd = typeof rng === 'function' ? rng : randInt;
  const arr = deck.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = rnd(i + 1);
    const t = arr[i];
    arr[i] = arr[j];
    arr[j] = t;
  }
  return arr;
}

/**
 * 计算牌型
 * @returns {{type:number,name:string,tiebreak:number[],special235:boolean,flush:boolean,straightHigh:number,ranks:number[]}}
 */
function handInfo(cards) {
  if (!Array.isArray(cards) || cards.length !== 3) {
    throw new Error('手牌必须正好 3 张');
  }
  const ranks = cards.map((c) => c.r).sort((a, b) => b - a);
  const flush = cards[0].s === cards[1].s && cards[1].s === cards[2].s;
  const r0 = ranks[0];
  const r1 = ranks[1];
  const r2 = ranks[2];

  // 顺子：连续三张；A23 视为最小的顺子
  let straightHigh = 0;
  if (r0 - r1 === 1 && r1 - r2 === 1) straightHigh = r0;
  else if (r0 === 14 && r1 === 3 && r2 === 2) straightHigh = 3;

  // 235 不同花（某些地区规则：专门通杀豹子）
  const special235 = !flush && r0 === 5 && r1 === 3 && r2 === 2;

  let type;
  let tiebreak;

  if (r0 === r1 && r1 === r2) {
    type = TYPE.TRIPS;
    tiebreak = [r0];
  } else if (flush && straightHigh) {
    type = TYPE.STRAIGHT_FLUSH;
    tiebreak = [straightHigh];
  } else if (flush) {
    type = TYPE.FLUSH;
    tiebreak = [r0, r1, r2];
  } else if (straightHigh) {
    type = TYPE.STRAIGHT;
    tiebreak = [straightHigh];
  } else if (r0 === r1 || r1 === r2) {
    const pairRank = r0 === r1 ? r0 : r1;
    const kicker = r0 === r1 ? r2 : r0;
    type = TYPE.PAIR;
    tiebreak = [pairRank, kicker];
  } else {
    type = TYPE.HIGH;
    tiebreak = [r0, r1, r2];
  }

  return {
    type,
    name: TYPE_NAME[type],
    tiebreak,
    special235,
    flush,
    straightHigh,
    ranks
  };
}

function compareTiebreak(a, b) {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

/**
 * 比较两手牌
 * @returns {number} 1 = a 大，-1 = b 大，0 = 平
 */
function compareHands(a, b, opts = {}) {
  const use235 = !!opts.special235;
  if (use235) {
    if (a.special235 && b.special235) return 0;
    if (a.special235) return 1;
    if (b.special235) return -1;
  }
  if (a.type !== b.type) return a.type > b.type ? 1 : -1;
  return compareTiebreak(a.tiebreak, b.tiebreak);
}

/** 牌型英文描述，用于日志，如 "金花 K" */
function describeHand(info) {
  if (!info) return '';
  switch (info.type) {
    case TYPE.TRIPS:
      return `豹子 ${rankLabel(info.tiebreak[0])}`;
    case TYPE.STRAIGHT_FLUSH:
      return `顺金 ${rankLabel(info.tiebreak[0])} 高`;
    case TYPE.FLUSH:
      return `金花 ${rankLabel(info.tiebreak[0])} 高`;
    case TYPE.STRAIGHT:
      return `顺子 ${rankLabel(info.tiebreak[0])} 高`;
    case TYPE.PAIR:
      return `对子 ${rankLabel(info.tiebreak[0])}`;
    default:
      return `单张 ${rankLabel(info.tiebreak[0])} 高`;
  }
}

module.exports = {
  SUITS,
  SUIT_SYMBOL,
  SUIT_COLOR,
  SUIT_NAME,
  RANK_LABEL,
  TYPE,
  TYPE_NAME,
  rankLabel,
  cardId,
  cardLabel,
  makeDeck,
  shuffle,
  handInfo,
  compareHands,
  describeHand
};
