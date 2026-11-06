'use strict';

/**
 * 炸金花房间引擎（纯状态机，不涉及网络）
 *
 * 关键设计：
 * 1. 所有状态在服务端，客户端只拿到"自己看过的牌"和公共信息 —— 防 F12 偷看。
 * 2. 回合推进用 playerId 而不是数组下标 —— 玩家中途退出不会串位。
 * 3. net（累计净胜负分）与 chips（筹码）分离：筹码可补，net 不会被补筹码污染，
 *    用于最后按分算惩罚。
 * 4. 所有外部输入都做校验并 clamp，异常一律抛出可读中文错误，由服务端兜底。
 */

const crypto = require('crypto');
const { makeDeck, shuffle, handInfo, compareHands, cardId, cardLabel } = require('./cards');
const { BOT_NAMES, decideBotAction } = require('./bot');

const MAX_PLAYERS = 6;
const LOG_LIMIT = 60;
const MAX_TURNS_PER_HAND = 500;

const DEFAULT_CONFIG = {
  ante: 10,            // 底注
  initialChips: 1000,  // 初始筹码
  baseStake: 10,       // 初始单注（闷牌跟注额）
  maxStake: 100,       // 单注封顶
  maxPot: 3000,        // 总注封顶，达到即开牌
  seeMultiplier: 2,    // 看牌后下注倍数
  special235: false,   // 235 不同花通杀豹子
  turnSeconds: 45,     // 每步思考时间，0 = 不限时
  autoRebuy: true      // 筹码不足时自动补到初始筹码（不影响 net）
};

const PHASES = ['lobby', 'playing', 'showdown'];

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function sanitizeName(name, fallback = '玩家') {
  const s = String(name == null ? '' : name)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 12);
  return s || fallback;
}

function sanitizeConfig(raw) {
  const c = { ...DEFAULT_CONFIG };
  if (!raw || typeof raw !== 'object') return c;

  c.ante = clampNumber(raw.ante, 1, 10000, c.ante);
  c.initialChips = clampNumber(raw.initialChips, 100, 1000000, c.initialChips);
  c.baseStake = clampNumber(raw.baseStake, 1, 10000, c.baseStake);
  c.maxStake = clampNumber(raw.maxStake, c.baseStake, 100000, c.maxStake);
  c.maxPot = clampNumber(raw.maxPot, c.ante * 2, 10000000, c.maxPot);
  c.seeMultiplier = clampNumber(raw.seeMultiplier, 1, 4, c.seeMultiplier);
  c.turnSeconds = clampNumber(raw.turnSeconds, 0, 600, c.turnSeconds);

  if (typeof raw.special235 === 'boolean') c.special235 = raw.special235;
  if (typeof raw.autoRebuy === 'boolean') c.autoRebuy = raw.autoRebuy;

  // 让步数自洽：封顶必须 >= 初注
  if (c.maxStake < c.baseStake) c.maxStake = c.baseStake;
  if (c.maxPot < c.maxStake * 2) c.maxPot = c.maxStake * 2;

  return c;
}

class GameError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GameError';
    this.isGameError = true;
  }
}

class Room {
  constructor(id, config) {
    this.id = String(id);
    this.config = sanitizeConfig(config);
    this.players = new Map(); // pid -> player
    this.order = [];          // 座位顺序（pid 数组）
    this.hostId = null;

    this.phase = 'lobby';     // lobby | playing | showdown
    this.handNo = 0;

    this.dealerId = null;
    this.turnId = null;
    this.turnDeadline = 0;

    this.pot = 0;
    this.stake = this.config.baseStake;
    this.turnCount = 0;

    this.logs = [];
    this.lastResult = null;

    this.createdAt = Date.now();
    this.updatedAt = Date.now();
    this.seq = 0;
  }

  touch() {
    this.updatedAt = Date.now();
  }

  log(text) {
    this.logs.push({ t: Date.now(), text: String(text).slice(0, 200) });
    if (this.logs.length > LOG_LIMIT) this.logs.splice(0, this.logs.length - LOG_LIMIT);
    this.touch();
  }

  // ---------------------------------------------------------------- 玩家管理

  addPlayer(name, opts) {
    if (this.players.size >= MAX_PLAYERS) {
      throw new GameError(`房间已满（最多 ${MAX_PLAYERS} 人）`);
    }
    const isBot = !!(opts && opts.isBot);
    const cleanName = sanitizeName(name);
    const dup = [...this.players.values()].some((p) => p.name === cleanName);
    const finalName = dup ? `${cleanName}${this.players.size + 1}` : cleanName;

    const pid = `p${++this.seq}`;
    const player = {
      id: pid,
      name: finalName,
      token: crypto.randomBytes(16).toString('hex'),
      chips: this.config.initialChips,
      net: 0,
      connected: isBot, // 人机永远在场
      lastSeen: 0,
      inHand: false,
      folded: false,
      seen: false,
      bet: 0,
      cards: null,
      joinedAt: Date.now(),
      isBot,
      botDelay: isBot ? 900 + crypto.randomInt(1800) : null // 思考延迟（毫秒）
    };

    this.players.set(pid, player);
    this.order.push(pid);
    if (!this.hostId && !isBot) this.hostId = pid;
    this.log(`${player.name} 加入了房间${isBot ? '（人机）' : ''}`);
    return player;
  }

  /** 添加一个人机玩家（名字可省略，自动从名单里挑） */
  addBot(customName) {
    if (this.players.size >= MAX_PLAYERS) {
      throw new GameError(`房间已满（最多 ${MAX_PLAYERS} 人）`);
    }
    const used = new Set([...this.players.values()].map((p) => p.name));
    let name = '';
    if (customName != null && String(customName).trim()) {
      name = sanitizeName(customName);
    }
    if (!name) {
      for (const n of BOT_NAMES) {
        if (!used.has(n)) {
          name = n;
          break;
        }
      }
      if (!name) name = `人机${this.players.size + 1}`;
    } else if (used.has(name)) {
      name = `${name}${this.players.size + 1}`;
    }
    return this.addPlayer(name, { isBot: true });
  }

  getPlayer(pid) {
    return this.players.get(pid) || null;
  }

  auth(pid, token) {
    const p = this.players.get(pid);
    if (!p) return null;
    if (p.token !== token) return null;
    return p;
  }

  removePlayer(pid) {
    const p = this.players.get(pid);
    if (!p) return false;

    const wasInHand = p.inHand && !p.folded && this.phase === 'playing';
    const wasTurn = this.turnId === pid;

    this.players.delete(pid);
    this.order = this.order.filter((x) => x !== pid);
    if (this.dealerId === pid) this.dealerId = null;

    if (this.phase === 'playing') {
      if (wasInHand) {
        this.log(`${p.name} 离开了房间（本局视为弃牌）`);
        // 已下注不退，继续牌局
        if (this.activeInHand().length === 0) {
          this.abortHand('玩家全部离开');
          return true;
        }
        if (this.checkEnd()) return true;
      }
      if (wasTurn) this.advanceTurn();
    }

    if (p.inHand) p.folded = true;
    p.inHand = false;

    if (this.hostId === pid) {
      // 房主只移交给真人，人机不能当房主
      const next = this.order.find((id) => {
        const q = this.players.get(id);
        return q && !q.isBot;
      });
      this.hostId = next || null;
      if (next) this.log(`房主已转交给 ${this.players.get(next).name}`);
    }

    if (this.players.size === 0) {
      this.phase = 'lobby';
      this.pot = 0;
      this.turnId = null;
      return true;
    }

    if (this.phase === 'playing' && this.activeInHand().length <= 1) {
      this.checkEnd();
    }

    this.touch();
    return true;
  }

  connectedCount() {
    let n = 0;
    for (const p of this.players.values()) if (p.connected) n++;
    return n;
  }

  // ---------------------------------------------------------------- 牌局流程

  activeInHand() {
    const out = [];
    for (const pid of this.order) {
      const p = this.players.get(pid);
      if (p && p.inHand && !p.folded) out.push(p);
    }
    return out;
  }

  nextInHandAfter(playerId) {
    const n = this.order.length;
    if (n === 0) return null;
    let idx = this.order.indexOf(playerId);
    for (let i = 1; i <= n; i++) {
      const pid = this.order[(idx + i) % n];
      const p = this.players.get(pid);
      if (p && p.inHand && !p.folded) return p.id;
    }
    return null;
  }

  setConfig(raw, pid) {
    if (this.hostId !== pid) throw new GameError('只有房主可以修改设置');
    if (this.phase === 'playing') throw new GameError('牌局进行中不能修改设置');
    this.config = sanitizeConfig(raw);
    this.stake = this.config.baseStake;
    // 大厅阶段调整初始筹码时，同步还没开局的玩家
    if (this.phase === 'lobby') {
      for (const p of this.players.values()) {
        if (p.net === 0) p.chips = this.config.initialChips;
      }
    }
    this.log('房主更新了房间设置');
    return this.config;
  }

  /** 开始新的一局 */
  startHand(pid) {
    if (this.phase === 'playing') throw new GameError('本局还没结束');
    if (this.players.size < 2) throw new GameError('至少需要 2 名玩家才能开局');

    // 补筹码 / 判定谁能入局
    const eligible = [];
    for (const id of this.order) {
      const p = this.players.get(id);
      if (!p) continue;
      p.folded = false;
      p.seen = false;
      p.bet = 0;
      p.cards = null;
      p.inHand = false;

      if (p.chips < this.config.ante) {
        if (this.config.autoRebuy) {
          p.chips = this.config.initialChips;
          this.log(`${p.name} 筹码不足，补到 ${p.chips}`);
        } else {
          continue;
        }
      }
      eligible.push(p);
    }

    if (eligible.length < 2) throw new GameError('筹码不足的玩家太多，无法开局');

    this.handNo += 1;
    this.phase = 'playing';
    this.lastResult = null;
    this.pot = 0;
    this.stake = this.config.baseStake;
    this.turnCount = 0;

    // 庄家轮转：从上一局庄家的下一位开始（此处 inHand 还没置位，不能用 nextInHandAfter）
    const eligibleSet = new Set(eligible.map((p) => p.id));
    let dealer = eligible[0];
    if (this.dealerId && this.order.includes(this.dealerId)) {
      const base = this.order.indexOf(this.dealerId);
      for (let i = 1; i <= this.order.length; i++) {
        const cand = this.players.get(this.order[(base + i) % this.order.length]);
        if (cand && eligibleSet.has(cand.id)) {
          dealer = cand;
          break;
        }
      }
    }
    this.dealerId = dealer.id;

    // 底注
    for (const p of eligible) {
      p.inHand = true;
      this.takeChips(p, this.config.ante);
      p.bet = this.config.ante;
      this.pot += this.config.ante;
    }

    // 洗牌发牌
    const deck = shuffle(makeDeck());
    let k = 0;
    for (const p of eligible) {
      p.cards = [deck[k++], deck[k++], deck[k++]];
    }

    this.turnId = this.nextInHandAfter(this.dealerId);
    this.armTimer();
    this.log(
      `第 ${this.handNo} 局开始 · 底注 ${this.config.ante} · 庄家 ${dealer.name} · 底池 ${this.pot}`
    );
    this.touch();
    return true;
  }

  armTimer() {
    this.turnStartedAt = Date.now();
    this.turnDeadline =
      this.config.turnSeconds > 0 ? Date.now() + this.config.turnSeconds * 1000 : 0;
  }

  takeChips(p, amount) {
    p.chips -= amount;
    p.net -= amount;
  }

  giveChips(p, amount) {
    p.chips += amount;
    p.net += amount;
  }

  callCost(p) {
    return p.seen ? this.stake * this.config.seeMultiplier : this.stake;
  }

  /** 看牌（不消耗回合，任何时候轮到自己前后都行） */
  look(pid) {
    const p = this.players.get(pid);
    if (!p) throw new GameError('玩家不存在');
    if (this.phase !== 'playing') throw new GameError('当前不在牌局中');
    if (!p.inHand || p.folded) throw new GameError('你已不在本局中');
    if (p.seen) throw new GameError('你已经看过牌了');
    p.seen = true;
    this.log(`${p.name} 看牌了`);
    this.touch();
    return true;
  }

  /** 执行一个回合动作 */
  act(pid, action, payload) {
    const p = this.players.get(pid);
    if (!p) throw new GameError('玩家不存在');
    if (this.phase !== 'playing') throw new GameError('当前不在牌局中');
    if (!p.inHand) throw new GameError('你不在本局中，等待下一局');
    if (p.folded) throw new GameError('你已经弃牌了');

    const act = String(action || '');

    // 看牌不是回合动作，任何时候都能看（放在回合校验之前）
    if (act === 'look') return this.look(pid);

    if (this.turnId !== pid) throw new GameError('还没轮到你');

    const data = payload && typeof payload === 'object' ? payload : {};

    switch (act) {
      case 'call': {
        const cost = this.callCost(p);
        if (p.chips < cost) {
          throw new GameError(`筹码不足，跟注需要 ${cost}，你只有 ${p.chips}`);
        }
        this.takeChips(p, cost);
        p.bet += cost;
        this.pot += cost;
        this.log(`${p.name} 跟注 ${cost}`);
        break;
      }
      case 'raise': {
        const to = Math.round(Number(data.to));
        if (!Number.isFinite(to)) throw new GameError('加注金额无效');
        if (to <= this.stake) throw new GameError(`加注必须大于当前注额 ${this.stake}`);
        if (to > this.config.maxStake) throw new GameError(`单注封顶 ${this.config.maxStake}`);
        const cost = p.seen ? to * this.config.seeMultiplier : to;
        if (p.chips < cost) {
          throw new GameError(`筹码不足，加注需要 ${cost}，你只有 ${p.chips}`);
        }
        this.takeChips(p, cost);
        p.bet += cost;
        this.pot += cost;
        this.stake = to;
        this.log(`${p.name} 加注到 ${to}（下注 ${cost}）`);
        break;
      }
      case 'fold': {
        p.folded = true;
        this.log(`${p.name} 弃牌`);
        break;
      }
      case 'compare': {
        const targetId = String(data.target || '');
        const target = this.players.get(targetId);
        if (!target) throw new GameError('比牌对象不存在');
        if (target.id === p.id) throw new GameError('不能和自己比牌');
        if (!target.inHand || target.folded) throw new GameError('该玩家已不在本局中');
        if (this.activeInHand().length < 2) throw new GameError('人数不足，无法比牌');

        const cost = this.callCost(p);
        if (p.chips < cost) {
          throw new GameError(`筹码不足，比牌需要 ${cost}，你只有 ${p.chips}`);
        }
        this.takeChips(p, cost);
        p.bet += cost;
        this.pot += cost;

        const a = handInfo(p.cards);
        const b = handInfo(target.cards);
        // 平局时主动比牌者输（常见规则）
        const cmp = compareHands(a, b, { special235: this.config.special235 });
        const loser = cmp > 0 ? target : p;
        loser.folded = true;
        this.log(`${p.name} 约 ${target.name} 比牌，${loser.name} 出局`);
        break;
      }
      case 'look': {
        return this.look(pid);
      }
      default:
        throw new GameError('未知操作');
    }

    this.turnCount += 1;

    if (this.checkEnd()) {
      this.touch();
      return true;
    }

    this.advanceTurn();
    this.touch();
    return true;
  }

  advanceTurn() {
    if (this.phase !== 'playing') return;
    const next = this.nextInHandAfter(this.turnId);
    this.turnId = next;
    this.armTimer();
  }

  /** 判定牌局是否结束；返回 true 表示已结算 */
  checkEnd() {
    if (this.phase !== 'playing') return false;
    const active = this.activeInHand();

    if (active.length === 0) {
      this.abortHand('无人继续游戏');
      return true;
    }
    if (active.length === 1) {
      this.settleSingle(active[0], '其余玩家均已弃牌');
      return true;
    }
    if (this.pot >= this.config.maxPot) {
      this.settleShowdown('达到总注封顶');
      return true;
    }
    if (this.turnCount >= MAX_TURNS_PER_HAND) {
      this.settleShowdown('回合数达到上限');
      return true;
    }
    return false;
  }

  /** 超时自动弃牌，返回是否发生了状态变化（人机豁免：由 botTick 驱动） */
  tick(now) {
    if (this.phase !== 'playing') return false;
    if (!this.config.turnSeconds) return false;
    if (!this.turnDeadline || now < this.turnDeadline) return false;

    const p = this.players.get(this.turnId);
    if (!p || !p.inHand || p.folded) {
      this.advanceTurn();
      this.touch();
      return true;
    }
    if (p.isBot) return false; // 人机由 botTick 负责，不会卡场

    p.folded = true;
    this.log(`${p.name} 超时未操作，自动弃牌`);
    if (this.checkEnd()) {
      this.touch();
      return true;
    }
    this.advanceTurn();
    this.touch();
    return true;
  }

  /**
   * 人机回合驱动：轮到人机且延迟到了就决策执行。
   * 决策走 this.act 的完整校验路径，与真人操作同一条代码。
   * @returns {boolean} 是否执行了动作（true 时服务端应 broadcast）
   */
  botTick(now) {
    if (this.phase !== 'playing') return false;
    if (!this.turnId) return false;
    const p = this.players.get(this.turnId);
    if (!p || !p.isBot || !p.inHand || p.folded) return false;
    if (this.turnStartedAt == null) return false;
    const delay = p.botDelay == null ? 1200 : p.botDelay;
    if (now - this.turnStartedAt < delay) return false;

    let acted = false;

    // 先看牌（不消耗回合，85% 概率早点看）
    if (!p.seen && crypto.randomInt(100) < 85) {
      try {
        this.look(p.id);
      } catch (e) {
        /* 已看过等异常忽略 */
      }
    }

    const decision = decideBotAction(this, p, () => crypto.randomInt(1000) / 1000);
    try {
      this.act(p.id, decision.action, decision.payload || {});
      acted = true;
    } catch (e) {
      // 兜底链：跟注 → 弃牌，保证人机永远不会卡住牌局
      try {
        this.act(p.id, 'call', {});
        acted = true;
      } catch (e2) {
        try {
          this.act(p.id, 'fold', {});
          acted = true;
        } catch (e3) {
          /* 理论上到不了这里 */
        }
      }
    }

    if (acted) {
      // 下一次思考时长随机化，避免节奏机械
      p.botDelay = 900 + crypto.randomInt(1800);
    }
    return acted;
  }

  settleSingle(winner, reason) {
    this.pot += 0;
    this.giveChips(winner, this.pot);
    const amount = this.pot;
    this.finishHand({
      reason,
      winners: [{ id: winner.id, name: winner.name, amount }],
      pot: amount
    });
  }

  settleShowdown(reason) {
    const active = this.activeInHand();
    if (active.length === 0) {
      this.abortHand('无人可开牌');
      return;
    }
    const entries = active.map((p) => ({ p, info: handInfo(p.cards) }));
    let best = entries[0];
    for (let i = 1; i < entries.length; i++) {
      const cmp = compareHands(entries[i].info, best.info, {
        special235: this.config.special235
      });
      if (cmp > 0) best = entries[i];
    }
    const winners = entries.filter(
      (e) =>
        compareHands(e.info, best.info, { special235: this.config.special235 }) === 0
    );

    const pot = this.pot;
    const share = Math.floor(pot / winners.length);
    let remainder = pot - share * winners.length;
    const winnerList = winners.map((w) => {
      let amount = share;
      if (remainder > 0) {
        amount += 1;
        remainder -= 1;
      }
      this.giveChips(w.p, amount);
      return { id: w.p.id, name: w.p.name, amount };
    });

    this.finishHand({
      reason,
      winners: winnerList,
      pot,
      showdown: entries
        .slice()
        .sort(
          (a, b) =>
            -compareHands(a.info, b.info, { special235: this.config.special235 })
        )
        .map((e) => ({
          id: e.p.id,
          name: e.p.name,
          hand: e.info.name,
          cards: e.p.cards.map((c) => ({ s: c.s, r: c.r, id: cardId(c), label: cardLabel(c) }))
        }))
    });
  }

  finishHand(result) {
    this.lastResult = { ...result, handNo: this.handNo, at: Date.now() };
    this.pot = 0;
    this.phase = 'showdown';
    this.turnId = null;
    this.turnDeadline = 0;
    const names = result.winners.map((w) => `${w.name} +${w.amount}`).join('、');
    this.log(`本局结束（${result.reason}）：${names}`);
    this.touch();
  }

  /** 中途作废：按本局各自下注原额退还，保证账目零和 */
  abortHand(reason) {
    for (const p of this.players.values()) {
      if (p.bet > 0) {
        this.giveChips(p, p.bet);
        p.bet = 0;
      }
      p.inHand = false;
      p.folded = false;
      p.seen = false;
      p.cards = null;
    }
    this.pot = 0;
    this.stake = this.config.baseStake;
    this.turnId = null;
    this.turnDeadline = 0;
    this.turnCount = 0;
    this.phase = 'lobby';
    this.log(`本局作废（${reason}），所有下注已退还`);
  }

  /** 结算后可开下一局；任何人可点，防止房主掉线卡住 */
  nextHand(pid) {
    if (this.phase === 'playing') throw new GameError('本局还没结束');
    const p = this.players.get(pid);
    if (!p) throw new GameError('玩家不存在');
    return this.startHand(pid);
  }

  /** 当前玩家可选动作（给前端渲染按钮） */
  optionsFor(pid) {
    const p = this.players.get(pid);
    if (!p) return [];
    if (this.phase !== 'playing') return [];
    if (!p.inHand || p.folded) return [];
    if (this.turnId !== pid) return [];

    const list = [];
    const cost = this.callCost(p);

    if (!p.seen) list.push({ type: 'look', label: '看牌', cost: 0 });
    if (p.chips >= cost) {
      list.push({ type: 'call', label: '跟注', cost });
    }
    if (this.stake < this.config.maxStake) {
      const candidates = new Set([
        this.stake + this.config.baseStake,
        this.stake * 2,
        this.config.maxStake
      ]);
      const raises = [...candidates]
        .filter((to) => to > this.stake && to <= this.config.maxStake)
        .sort((a, b) => a - b)
        .slice(0, 4)
        .map((to) => ({
          to,
          cost: p.seen ? to * this.config.seeMultiplier : to
        }))
        .filter((r) => p.chips >= r.cost);
      if (raises.length) list.push({ type: 'raise', label: '加注', raises });
    }

    const targets = this.activeInHand()
      .filter((x) => x.id !== pid)
      .map((x) => ({ id: x.id, name: x.name }));
    if (targets.length > 0 && p.chips >= cost) {
      list.push({ type: 'compare', label: '比牌', cost, targets });
    }

    list.push({ type: 'fold', label: '弃牌' });
    return list;
  }

  // ---------------------------------------------------------------- 快照

  /** 生成发给某个玩家的个性化状态（别人的牌看不到） */
  serialize(viewerId) {
    const revealAll = this.phase === 'showdown';

    const players = [];
    for (const id of this.order) {
      const p = this.players.get(id);
      if (!p) continue;
      const isMe = id === viewerId;
      // 弃牌的人不亮牌（真实牌局里弃牌就收牌了，亮出来等于泄露信息）
      const showCards = (isMe && p.seen) || (revealAll && p.inHand && !p.folded);
      let info = null;
      if (showCards && p.cards) {
        try {
          info = handInfo(p.cards);
        } catch (e) {
          info = null;
        }
      }
      players.push({
        id: p.id,
        name: p.name,
        chips: p.chips,
        net: p.net,
        bet: p.bet,
        inHand: p.inHand,
        folded: p.folded,
        seen: p.seen,
        connected: p.connected,
        isBot: !!p.isBot,
        isHost: id === this.hostId,
        isDealer: id === this.dealerId,
        isTurn: id === this.turnId,
        cards: showCards && p.cards
          ? p.cards.map((c) => ({ s: c.s, r: c.r, id: cardId(c), label: cardLabel(c) }))
          : null,
        handName: info ? info.name : null
      });
    }

    const me = this.players.get(viewerId) || null;
    const myEntry = players.find((x) => x.id === viewerId) || null;

    return {
      roomId: this.id,
      phase: this.phase,
      handNo: this.handNo,
      config: { ...this.config },
      pot: this.pot,
      stake: this.stake,
      dealerId: this.dealerId,
      turnId: this.turnId,
      turnDeadline: this.turnDeadline,
      serverNow: Date.now(),
      hostId: this.hostId,
      maxPlayers: MAX_PLAYERS,
      players,
      me: viewerId,
      mySeen: me ? me.seen : false,
      myCards: myEntry ? myEntry.cards : null,
      myHandName: myEntry ? myEntry.handName : null,
      inHand: me ? me.inHand : false,
      myOptions: this.optionsFor(viewerId),
      canLook: !!(me && this.phase === 'playing' && me.inHand && !me.folded && !me.seen),
      lastResult: this.lastResult,
      logs: this.logs.slice(-30),
      updatedAt: this.updatedAt
    };
  }

  /** 用于落盘的快照：必须带上本局下注额和底池，否则重启后无法退注 */
  toJSON() {
    return {
      id: this.id,
      config: this.config,
      hostId: this.hostId,
      order: this.order,
      seq: this.seq,
      createdAt: this.createdAt,
      phase: this.phase,
      pot: this.pot,
      stake: this.stake,
      handNo: this.handNo,
      players: [...this.players.values()].map((p) => ({
        id: p.id,
        name: p.name,
        token: p.token,
        chips: p.chips,
        net: p.net,
        bet: p.bet,
        isBot: !!p.isBot,
        botDelay: p.botDelay,
        joinedAt: p.joinedAt
      }))
    };
  }

  static fromJSON(raw) {
    const room = new Room(raw.id, raw.config);
    room.hostId = raw.hostId || null;
    room.seq = raw.seq || 0;
    room.createdAt = raw.createdAt || Date.now();
    room.order = Array.isArray(raw.order) ? raw.order.slice() : [];
    room.handNo = Number.isFinite(raw.handNo) ? raw.handNo : 0;

    for (const sp of raw.players || []) {
      const isBot = !!sp.isBot;
      room.players.set(sp.id, {
        id: sp.id,
        name: sanitizeName(sp.name),
        token: sp.token,
        chips: Number.isFinite(sp.chips) ? sp.chips : room.config.initialChips,
        net: Number.isFinite(sp.net) ? sp.net : 0,
        connected: isBot, // 人机永远在场
        lastSeen: 0,
        inHand: false,
        folded: false,
        seen: false,
        bet: Number.isFinite(sp.bet) ? sp.bet : 0,
        cards: null,
        joinedAt: sp.joinedAt || Date.now(),
        isBot,
        botDelay: isBot ? 900 + crypto.randomInt(1800) : null
      });
    }

    room.order = room.order.filter((id) => room.players.has(id));
    if (!room.hostId || !room.players.has(room.hostId)) {
      room.hostId = room.order[0] || null;
    }

    // 重启后不恢复进行中的牌局：按各自本局下注原额退还，保证账目零和
    room.pot = Number.isFinite(raw.pot) ? raw.pot : 0;
    const hasUnsettled =
      raw.phase === 'playing' ||
      room.pot > 0 ||
      [...room.players.values()].some((p) => p.bet > 0);

    if (hasUnsettled) {
      room.abortHand('服务重启');
    } else {
      room.phase = 'lobby';
      room.pot = 0;
      room.stake = room.config.baseStake;
      room.turnId = null;
      room.turnDeadline = 0;
      room.turnCount = 0;
    }

    return room;
  }
}

module.exports = {
  Room,
  GameError,
  MAX_PLAYERS,
  DEFAULT_CONFIG,
  sanitizeConfig,
  sanitizeName,
  PHASES
};
