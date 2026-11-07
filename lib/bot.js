'use strict';

/**
 * 人机玩家决策（纯函数，无状态）
 * 由 engine.botTick 驱动：轮到人机、延迟到了就调这里拿决策，
 * 然后走 engine.act 的正常校验路径执行（跟真人完全同一条代码路径）。
 */

const { handInfo, TYPE } = require('./cards');

const BOT_NAMES = [
  '人机·阿福',
  '人机·小六',
  '人机·老K',
  '人机·阿花',
  '人机·大猫',
  '人机·阿宝',
  '人机·铁蛋',
  '人机·翠花',
  '人机·二狗',
  '人机·七喜',
  '人机·八戒',
  '人机·九爷',
  '人机·十全',
  '人机·百顺'
];

/** 牌力评分 0..1（只服务端自己用，不会发给客户端） */
function handScore(cards, special235Rule) {
  const info = handInfo(cards);
  if (special235Rule && info.special235) return 1.0;
  switch (info.type) {
    case TYPE.TRIPS:
      return 0.95;
    case TYPE.STRAIGHT_FLUSH:
      return 0.90;
    case TYPE.FLUSH:
      return 0.68 + ((info.tiebreak[0] - 2) / 12) * 0.10;
    case TYPE.STRAIGHT:
      return 0.62;
    case TYPE.PAIR:
      return 0.45 + ((info.tiebreak[0] - 2) / 12) * 0.18;
    default:
      return 0.12 + ((info.tiebreak[0] - 2) / 12) * 0.22;
  }
}

/**
 * 决策
 * @param {import('./engine').Room} room 房间（读 stake/pot/config/activeInHand）
 * @param {object} p 人机玩家（cards/seen/chips）
 * @param {function} rand 随机源 () => [0,1)
 * @returns {{action:string, payload?:object}}
 */
function decideBotAction(room, p, rand) {
  const cfg = room.config;
  const cost = room.callCost(p);
  const others = room.activeInHand().filter((x) => x.id !== p.id);
  if (others.length === 0) return { action: 'fold' };

  // 闷牌时当中等牌打；看过牌按真实牌力
  const s = p.seen ? handScore(p.cards, cfg.special235) : 0.38;
  const r = rand();

  // 只剩两家且牌很强：一定概率直接比牌收局
  if (others.length === 1 && s >= 0.8 && r < 0.25 && p.chips >= cost) {
    return { action: 'compare', payload: { target: others[0].id } };
  }

  // 强牌：加注施压，否则稳跟
  if (s >= 0.82) {
    if (room.stake < cfg.maxStake && r < 0.55) {
      const to = Math.min(cfg.maxStake, room.stake + cfg.baseStake);
      const raiseCost = p.seen ? to * cfg.seeMultiplier : to;
      if (p.chips >= raiseCost) return { action: 'raise', payload: { to } };
    }
    return { action: 'call' };
  }

  // 中等牌：偶尔加注，多数跟注
  if (s >= 0.5) {
    if (room.stake < cfg.maxStake && p.chips >= cost * 3 && r < 0.18) {
      const to = Math.min(cfg.maxStake, room.stake * 2);
      return { action: 'raise', payload: { to } };
    }
    if (p.chips >= cost) return { action: 'call' };
    return { action: 'fold' };
  }

  // 弱牌：跟不跟看成本脸色
  if (cost > p.chips) return { action: 'fold' };
  const stakePressure = Math.min(0.4, (room.stake / cfg.maxStake) * 0.4);
  const potPressure = room.pot > p.chips * 2 ? 0.15 : 0;
  if (r < 0.35 + stakePressure + potPressure) return { action: 'fold' };
  return { action: 'call' };
}

module.exports = { BOT_NAMES, handScore, decideBotAction };
