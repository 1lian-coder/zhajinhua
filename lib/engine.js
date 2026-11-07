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

const MAX_PLAYERS = 15;
const MAX_SPECTATORS = 20;
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
  autoRebuy: false,    // 筹码不足时自动补到初始筹码（默认关闭：改为向朋友借分，双方同意才生效）
  autoNext: false,     // 一局结束后自动开下一局
  autoNextSeconds: 8,  // 自动开下一局的等待秒数
  dealerBid: false,    // 抢庄模式：每局开始先抢庄，倍数最高者当庄
  bidSeconds: 10,      // 抢庄阶段时长（秒）
  sessionHands: 0      // 每轮打几局（0=不限），打满后由玩家决定是否继续
};

const PHASES = ['lobby', 'bidding', 'playing', 'showdown'];

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
  c.autoNextSeconds = clampNumber(raw.autoNextSeconds, 3, 120, c.autoNextSeconds);
  c.bidSeconds = clampNumber(raw.bidSeconds, 3, 60, c.bidSeconds);
  c.sessionHands = clampNumber(raw.sessionHands, 0, 200, c.sessionHands);

  if (typeof raw.special235 === 'boolean') c.special235 = raw.special235;
  if (typeof raw.autoRebuy === 'boolean') c.autoRebuy = raw.autoRebuy;
  if (typeof raw.autoNext === 'boolean') c.autoNext = raw.autoNext;
  if (typeof raw.dealerBid === 'boolean') c.dealerBid = raw.dealerBid;

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

    /** 房间加入密码（4~8 位数字，空字符串=无密码）。永不发给客户端，只下发 hasJoinPin */
    this.joinPin = '';

    /** 自动连开：本局结算后计划开下一局的时刻（0=不自动） */
    this.nextHandAt = 0;

    /** 抢庄阶段：截止时刻与开始时刻（0=不在抢庄） */
    this.bidDeadline = 0;
    this.bidStartedAt = 0;

    /** 观战者：能看到公共信息，不占玩家座位，不参与任何操作 */
    this.spectators = new Map();

    /** 弃牌获胜时，赢家是否公布了牌（null=未公布） */
    this.revealWinner = null;
    /** 最近一次比牌的双方牌面（仅比牌双方可见） */
    this.lastCompare = null;
    /** 借分记录：{id, from, to, amount, status, at} */
    this.loans = [];
    this.loanSeq = 0;
    /** 每轮局数的配置基数（用于「再来一轮」时恢复相同局数） */
    this.sessionBase = this.config.sessionHands || 0;

    this.logs = [];
    this.lastResult = null;

    /** 快捷聊天（保留最近 20 条，不落盘） */
    this.chat = [];
    this.chatSeq = 0;

    /** 战绩统计 pid -> {hands, wins, best}（落盘保留） */
    this.stats = {};

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
      allIn: false,
      bid: null, // 抢庄：null=未选，0=不抢，1~4=抢庄倍数
      debt: 0,   // 借分累计（输了分找朋友借的，用于展示）
      botDelay: isBot ? 900 + crypto.randomInt(1800) : null // 思考延迟（毫秒）
    };

    this.players.set(pid, player);
    this.order.push(pid);
    if (!this.hostId && !isBot) this.hostId = pid;
    if (!this.stats[pid]) this.stats[pid] = { hands: 0, wins: 0, best: 0 };
    this.log(`${player.name} 加入了房间${isBot ? '（人机）' : ''}`);
    return player;
  }

  /** 设置/清除房间加入密码（房主，仅大厅/结算阶段） */
  setJoinPin(pid, rawPin) {
    if (this.hostId !== pid) throw new GameError('只有房主可以设置房间密码');
    if (this.phase === 'playing') throw new GameError('牌局进行中不能改密码');
    const digits = String(rawPin == null ? '' : rawPin).replace(/\D/g, '');
    if (digits && (digits.length < 4 || digits.length > 8)) {
      throw new GameError('房间密码需为 4~8 位数字');
    }
    this.joinPin = digits;
    this.log(digits ? '房主设置了房间密码' : '房主取消了房间密码');
    return digits;
  }

  /** 校验加入密码（返回 true/false），不泄露真实密码 */
  checkJoinPin(rawPin) {
    if (!this.joinPin) return true;
    const digits = String(rawPin == null ? '' : rawPin).replace(/\D/g, '');
    return digits === this.joinPin;
  }

  /** 取消本局的自动连开（任何人可点，防止人不在时干等） */
  pauseAutoNext(pid) {
    if (!this.players.has(pid)) throw new GameError('玩家不存在');
    if (!this.nextHandAt) return false;
    this.nextHandAt = 0;
    this.log('已取消自动开下一局');
    this.touch();
    return true;
  }

  /** 抢庄：bid=0 不抢，1~4 抢庄倍数 */
  setBid(pid, rawBid) {
    const p = this.players.get(pid);
    if (!p) throw new GameError('玩家不存在');
    if (this.phase !== 'bidding') throw new GameError('现在不是抢庄阶段');
    if (!p.inHand || p.folded) throw new GameError('你不在本局中');
    const bid = Math.round(Number(rawBid));
    if (!Number.isFinite(bid) || bid < 0 || bid > 4) {
      throw new GameError('抢庄倍数无效（0=不抢，1~4=倍数）');
    }
    p.bid = bid;
    this.touch();
    const pending = this.activeInHand().filter((x) => x.bid == null).length;
    if (pending === 0) this.resolveBid();
    return true;
  }

  /** 抢庄竞标结束：倍数最高者当庄（并列随机），无人抢则按座位轮转 */
  resolveBid() {
    if (this.phase !== 'bidding') return false;
    this.bidDeadline = 0;
    const inHand = this.activeInHand();
    // 有人中途退出导致人不满：作废本局退注
    if (inHand.length < 2) {
      this.abortHand('抢庄阶段人数不足');
      return true;
    }
    for (const p of inHand) if (p.bid == null) p.bid = 0; // 没选的视为不抢

    const grabbers = inHand.filter((p) => p.bid > 0);
    if (grabbers.length > 0) {
      const top = Math.max(...grabbers.map((p) => p.bid));
      const tied = grabbers.filter((p) => p.bid === top);
      const pick = tied[crypto.randomInt(tied.length)];
      this.dealerId = pick.id;
      this.log(`抢庄结束：${pick.name} 以 ${top} 倍抢庄成功，成为庄家`);
    } else {
      // 无人抢庄：从上局庄家的下一位顺时针
      const seatSet = new Set(inHand.map((p) => p.id));
      let dealer = inHand[0];
      if (this.dealerId && this.order.includes(this.dealerId)) {
        const base = this.order.indexOf(this.dealerId);
        for (let i = 1; i <= this.order.length; i++) {
          const cand = this.players.get(this.order[(base + i) % this.order.length]);
          if (cand && seatSet.has(cand.id)) {
            dealer = cand;
            break;
          }
        }
      }
      this.dealerId = dealer ? dealer.id : null;
      this.log(`无人抢庄，庄家为 ${dealer ? dealer.name : '无'}`);
    }

    this.phase = 'playing';
    this.turnId = this.dealerId
      ? this.nextInHandAfter(this.dealerId)
      : (inHand[0] ? inHand[0].id : null);
    this.armTimer();
    const dName = this.dealerId && this.players.get(this.dealerId)
      ? this.players.get(this.dealerId).name : '—';
    this.log(`庄家确定：${dName} · 底池 ${this.pot} · 开始下注`);
    this.touch();
    return true;
  }

  /**
   * 借分：A 借给 B（或 B 向 A 借），双方任意一方发起，另一方同意后才到账。
   * 只有筹码输光（低于底注）的人需要借分；借到的分记在债务里仅供展示。
   */
  proposeLoan(fromId, toId, amountRaw) {
    const from = this.players.get(fromId);
    const to = this.players.get(toId);
    if (!from || !to) throw new GameError('玩家不存在');
    if (from.id === to.id) throw new GameError('不能借给自己');
    const amount = Math.round(Number(amountRaw));
    if (!Number.isFinite(amount) || amount < 1) throw new GameError('借分金额无效');
    if (amount > 5000) throw new GameError('单次借分最多 5000');
    if (from.chips < amount) throw new GameError('你的筹码不够借出这么多');
    if (to.chips >= this.config.ante) throw new GameError('对方筹码还够，不需要借分');
    const pending = this.loans.find(
      (l) => l.status === 'pending' && l.from === from.id && l.to === to.id
    );
    if (pending) throw new GameError('已经有一笔待确认的借分，等对方先回应');
    const loan = {
      id: 'L' + ++this.loanSeq,
      from: from.id,
      to: to.id,
      amount,
      status: 'pending',
      by: null,
      at: Date.now()
    };
    this.loans.push(loan);
    if (this.loans.length > 100) this.loans.shift();
    this.log(`${from.name} 想借 ${amount} 分给 ${to.name}，等对方同意`);
    this.touch();
    return loan;
  }

  /** 同意借分：只能由发起方的对手方（收款方或出借方）同意 */
  acceptLoan(loanId, pid) {
    const loan = this.loans.find((l) => l.id === loanId);
    if (!loan) throw new GameError('借分记录不存在');
    if (loan.status !== 'pending') throw new GameError('这笔借分已经处理过了');
    if (pid !== loan.from && pid !== loan.to) throw new GameError('这笔借分与你无关');
    const from = this.players.get(loan.from);
    const to = this.players.get(loan.to);
    if (!from || !to) throw new GameError('玩家已离开房间');
    if (from.chips < loan.amount) throw new GameError('对方筹码已不够借出');
    from.chips -= loan.amount;
    to.chips += loan.amount;
    to.debt = (to.debt || 0) + loan.amount;
    loan.status = 'accepted';
    loan.at = Date.now();
    this.log(`${from.name} 借给 ${to.name} ${loan.amount} 分`);
    this.touch();
    return loan;
  }

  declineLoan(loanId, pid) {
    const loan = this.loans.find((l) => l.id === loanId);
    if (!loan) throw new GameError('借分记录不存在');
    if (loan.status !== 'pending') throw new GameError('这笔借分已经处理过了');
    if (pid !== loan.from && pid !== loan.to) throw new GameError('这笔借分与你无关');
    loan.status = 'declined';
    loan.at = Date.now();
    const from = this.players.get(loan.from);
    const to = this.players.get(loan.to);
    this.log(`${to ? to.name : '玩家'} 拒绝了借分请求`);
    this.touch();
    return loan;
  }

  /** 快捷聊天（服务端只做清洗和限长，不落盘）。观战者也可以发言 */
  addChat(pid, rawText) {
    const p = this.players.get(pid) || this.spectators.get(pid);
    if (!p) throw new GameError('玩家不存在');
    const text = String(rawText == null ? '' : rawText)
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .trim()
      .slice(0, 30);
    if (!text) throw new GameError('说点什么吧');
    this.chat.push({ seq: ++this.chatSeq, id: p.id, name: p.name, text, t: Date.now() });
    if (this.chat.length > 20) this.chat.splice(0, this.chat.length - 20);
    this.touch();
    return true;
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

  /** 观战者：能看到公共信息（下注/弃牌/聊天/开牌），看不到任何暗牌，不能操作 */
  addSpectator(name) {
    if (this.spectators.size >= MAX_SPECTATORS) {
      throw new GameError(`观战人数已满（最多 ${MAX_SPECTATORS} 人）`);
    }
    const cleanName = sanitizeName(name, '观众');
    const pid = `s${++this.seq}`;
    this.spectators.set(pid, {
      id: pid,
      name: cleanName,
      token: crypto.randomBytes(16).toString('hex'),
      connected: false,
      joinedAt: Date.now()
    });
    this.log(`${cleanName} 进入观战`);
    return this.spectators.get(pid);
  }

  auth(pid, token) {
    const p = this.players.get(pid);
    if (p) return p.token === token ? p : null;
    const s = this.spectators.get(pid);
    if (s) return s.token === token ? s : null;
    return null;
  }

  removePlayer(pid) {
    // 观战者离场
    if (this.spectators.has(pid)) {
      const s = this.spectators.get(pid);
      this.spectators.delete(pid);
      this.log(`${s.name} 离开了观战`);
      this.touch();
      return true;
    }
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
      // 全下的玩家留在牌局里（开牌时参与分池），但不再参与轮转下注
      if (p && p.inHand && !p.folded && !p.allIn) return p.id;
    }
    return null;
  }

  /** 还能行动的玩家（未弃牌、未全下） */
  actorsInHand() {
    return this.activeInHand().filter((p) => !p.allIn);
  }

  setConfig(raw, pid) {
    if (this.hostId !== pid) throw new GameError('只有房主可以修改设置');
    if (this.phase === 'playing') throw new GameError('牌局进行中不能修改设置');
    this.config = sanitizeConfig(raw);
    this.stake = this.config.baseStake;
    this.sessionBase = this.config.sessionHands || 0;
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
      p.allIn = false;
      p.bid = null;

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
    // 52 张牌最多容纳 15 人 × 3 张
    if (eligible.length * 3 > 52) throw new GameError('人数超出牌堆容量');

    // 战绩：参与局数
    for (const p of eligible) {
      if (!this.stats[p.id]) this.stats[p.id] = { hands: 0, wins: 0, best: 0 };
      this.stats[p.id].hands += 1;
    }

    this.handNo += 1;
    this.lastResult = null;
    this.nextHandAt = 0;
    this.pot = 0;
    this.stake = this.config.baseStake;
    this.turnCount = 0;
    this.bidDeadline = 0;
    this.bidStartedAt = 0;
    this.revealWinner = null;
    this.lastCompare = null;

    // 庄家轮转（非抢庄模式时在此确定；抢庄模式等竞标结束后再定）
    const prevDealerId = this.dealerId;
    let dealer = null;
    if (!this.config.dealerBid) {
      const eligibleSet = new Set(eligible.map((p) => p.id));
      dealer = eligible[0];
      if (prevDealerId && this.order.includes(prevDealerId)) {
        const base = this.order.indexOf(prevDealerId);
        for (let i = 1; i <= this.order.length; i++) {
          const cand = this.players.get(this.order[(base + i) % this.order.length]);
          if (cand && eligibleSet.has(cand.id)) {
            dealer = cand;
            break;
          }
        }
      }
      this.dealerId = dealer.id;
    } else {
      this.dealerId = null; // 抢庄模式：竞标后确定
    }

    // 底注
    for (const p of eligible) {
      p.inHand = true;
      this.takeChips(p, this.config.ante);
      p.bet = this.config.ante;
      this.pot += this.config.ante;
    }

    // 洗牌发牌（52 张牌，15 人也只发 45 张）
    const deck = shuffle(makeDeck());
    let k = 0;
    for (const p of eligible) {
      p.cards = [deck[k++], deck[k++], deck[k++]];
    }

    if (this.config.dealerBid) {
      // 抢庄阶段：大家先看牌，再决定抢不抢庄
      this.phase = 'bidding';
      this.bidStartedAt = Date.now();
      this.bidDeadline = this.bidStartedAt + this.config.bidSeconds * 1000;
      this.turnId = null;
      this.turnDeadline = 0;
      this.log(
        `第 ${this.handNo} 局开始 · 底注 ${this.config.ante} · 底池 ${this.pot} · 抢庄阶段 ${this.config.bidSeconds} 秒`
      );
    } else {
      this.phase = 'playing';
      this.turnId = this.nextInHandAfter(this.dealerId);
      this.armTimer();
      this.log(
        `第 ${this.handNo} 局开始 · 底注 ${this.config.ante} · 庄家 ${dealer.name} · 底池 ${this.pot}`
      );
    }
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

  /** 看牌（不消耗回合，抢庄阶段和下注阶段都可以看） */
  look(pid) {
    const p = this.players.get(pid);
    if (!p) throw new GameError('玩家不存在');
    if (this.phase !== 'playing' && this.phase !== 'bidding') {
      throw new GameError('当前不在牌局中');
    }
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
    if (this.phase !== 'playing' && this.phase !== 'bidding') {
      throw new GameError('当前不在牌局中');
    }
    if (!p.inHand) throw new GameError('你不在本局中，等待下一局');
    if (p.folded) throw new GameError('你已经弃牌了');

    const act = String(action || '');

    // 看牌不是回合动作，任何时候都能看（放在回合校验之前）
    if (act === 'look') return this.look(pid);

    // 抢庄阶段只接受 bid 动作
    if (this.phase === 'bidding') {
      if (act !== 'bid') throw new GameError('抢庄阶段，请先选择是否抢庄');
      return this.setBid(pid, payload && typeof payload === 'object' ? payload.bid : 0);
    }

    if (act === 'bid') throw new GameError('现在不是抢庄阶段');

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
      case 'allin': {
        // 孤注一掷：筹码不够正常跟注时，把剩下的全部押上，留在牌局里直到开牌
        if (p.chips <= 0) throw new GameError('没有筹码可以全下');
        const full = this.callCost(p);
        if (p.chips >= full) throw new GameError(`筹码足够跟注（${full}），直接跟注即可`);
        const amount = p.chips;
        this.takeChips(p, amount);
        p.bet += amount;
        this.pot += amount;
        p.allIn = true;
        this.log(`${p.name} 孤注一掷，全下 ${amount}`);
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
        // 比牌双方都可以看到彼此的牌
        this.lastCompare = {
          a: p.id,
          aName: p.name,
          aCards: p.cards.map((c) => ({ s: c.s, r: c.r, id: cardId(c), label: cardLabel(c) })),
          b: target.id,
          bName: target.name,
          bCards: target.cards.map((c) => ({ s: c.s, r: c.r, id: cardId(c), label: cardLabel(c) })),
          winner: loser.id === p.id ? target.id : p.id,
          at: Date.now()
        };
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
    // 其他人都弃牌/全下，只剩一人能行动：没人可跟，直接开牌
    if (this.actorsInHand().length <= 1) {
      this.settleShowdown('其余玩家已全下，直接开牌');
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
    // 抢庄阶段：人机到点决策，全员选完或到截止时间就定庄
    if (this.phase === 'bidding') {
      let changed = false;
      const elapsed = now - (this.bidStartedAt || now);
      for (const p of this.players.values()) {
        if (p.inHand && !p.folded && p.isBot && p.bid == null) {
          const decideAt = Math.min(p.botDelay == null ? 1200 : p.botDelay,
            Math.max(500, this.config.bidSeconds * 1000 - 800));
          if (elapsed >= decideAt) {
            // 45% 概率抢庄，倍数随机
            p.bid = crypto.randomInt(100) < 45 ? 1 + crypto.randomInt(4) : 0;
            changed = true;
          }
        }
      }
      const pending = this.activeInHand().filter((x) => x.bid == null).length;
      if (pending === 0 || now >= this.bidDeadline) {
        this.resolveBid();
        changed = true;
      }
      if (changed) this.touch();
      return changed;
    }

    // 自动连开：结算阶段到点就开下一局
    if (this.phase === 'showdown' && this.nextHandAt && now >= this.nextHandAt) {
      const starter = [...this.players.values()].find((p) => !p.isBot) || [...this.players.values()][0];
      this.nextHandAt = 0;
      if (starter) {
        try {
          this.startHand(starter.id);
          this.touch();
          return true;
        } catch (e) {
          this.log(`自动开局失败：${e.message}，已暂停自动连开`);
          this.touch();
          return true;
        }
      }
      return false;
    }

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
   * 自动出牌驱动：
   *   · 人机：思考延迟到了就决策
   *   · 真人掉线（SSE 断开）：过一段宽限仍没回来，系统托管出牌，
   *     避免手机切后台回来发现被超时弃牌/牌局卡死
   * 决策走 this.act 的完整校验路径，与真人操作同一条代码。
   * @returns {boolean} 是否执行了动作（true 时服务端应 broadcast）
   */
  botTick(now) {
    if (this.phase !== 'playing') return false;
    if (!this.turnId) return false;
    const p = this.players.get(this.turnId);
    if (!p || !p.inHand || p.folded || p.allIn) return false;
    if (this.turnStartedAt == null) return false;

    const autopilot = !p.isBot && p.connected === false;
    if (!p.isBot && !autopilot) return false;

    // 宽限：人机 1~3 秒；掉线真人给 reconnect 的机会（限时局取一半，不限时局 30 秒兜底）
    const grace = p.isBot
      ? (p.botDelay == null ? 1200 : p.botDelay)
      : this.config.turnSeconds > 0
        ? Math.max(2000, Math.min(15000, (this.config.turnSeconds * 1000) / 2))
        : 30000;
    if (now - this.turnStartedAt < grace) return false;

    let acted = false;

    if (p.isBot && !p.seen && crypto.randomInt(100) < 85) {
      // 人机会自己看牌；托管的真人**不代看**，保持他的闷/看状态
      try {
        this.look(p.id);
      } catch (e) {
        /* ignore */
      }
    }
    if (autopilot) {
      this.log(`${p.name} 掉线，系统托管`);
    }

    const decision = decideBotAction(this, p, () => crypto.randomInt(1000) / 1000);
    const tryAct = (action, payload) => {
      try {
        this.act(p.id, action, payload || {});
        return true;
      } catch (e) {
        return false;
      }
    };

    acted = tryAct(decision.action, decision.payload);
    if (!acted) acted = tryAct('call', {});
    if (!acted) acted = tryAct('allin', {});
    if (!acted) acted = tryAct('fold', {});

    if (acted && p.isBot) {
      // 下一次思考时长随机化，避免节奏机械
      p.botDelay = 900 + crypto.randomInt(1800);
    }
    return acted;
  }

  settleSingle(winner, reason) {
    const amount = this.pot;
    this.giveChips(winner, amount);
    // 弃牌获胜：赢家可选择是否公布自己的牌
    this.revealWinner = null;
    this.finishHand({
      reason,
      winners: [{ id: winner.id, name: winner.name, amount }],
      pot: amount,
      singleWin: true
    });
  }

  /** 弃牌获胜后，赢家选择公开自己的牌 */
  revealWin(pid) {
    if (this.phase !== 'showdown') throw new GameError('现在不是结算阶段');
    const r = this.lastResult;
    if (!r || !r.singleWin) throw new GameError('本局不是弃牌获胜，牌已公开');
    const w = r.winners && r.winners[0];
    if (!w || w.id !== pid) throw new GameError('只有本局赢家可以决定是否公布');
    this.revealWinner = true;
    this.log(`${w.name} 公布了自己的牌`);
    this.touch();
    return true;
  }

  /**
   * 开牌结算（含侧池）：
   * 按每个人本局总投入分层，每一层由"投入达到该层且仍在牌局里"的人比牌分钱。
   * 全下的人只能赢到自己投入被对手匹配到的部分；弃牌者的投入按层归入池中。
   */
  settleShowdown(reason) {
    const active = this.activeInHand();
    if (active.length === 0) {
      this.abortHand('无人可开牌');
      return;
    }
    const cmp235 = { special235: this.config.special235 };
    const infos = new Map();
    for (const p of active) infos.set(p.id, handInfo(p.cards));
    const bestOf = (list) => {
      let best = list[0];
      for (let i = 1; i < list.length; i++) {
        if (compareHands(infos.get(list[i].id), infos.get(best.id), cmp235) > 0) best = list[i];
      }
      return list.filter(
        (x) => compareHands(infos.get(x.id), infos.get(best.id), cmp235) === 0
      );
    };

    // 所有出过钱的人（含弃牌者）按总投入分层
    const contributors = [...this.players.values()].filter((p) => p.bet > 0);
    const levels = [...new Set(contributors.map((p) => p.bet))].sort((a, b) => a - b);

    const totalByPid = new Map();
    let prev = 0;
    for (const L of levels) {
      const atLeast = contributors.filter((p) => p.bet >= L);
      const layerAmount = (L - prev) * atLeast.length;
      if (layerAmount > 0) {
        let contenders = active.filter((p) => p.bet >= L);
        if (contenders.length === 0) contenders = active; // 极端：该层没人有资格，整体开牌者分
        const winners = bestOf(contenders);
        const share = Math.floor(layerAmount / winners.length);
        let remainder = layerAmount - share * winners.length;
        for (const w of winners) {
          let amount = share;
          if (remainder > 0) {
            amount += 1;
            remainder -= 1;
          }
          totalByPid.set(w.id, (totalByPid.get(w.id) || 0) + amount);
        }
      }
      prev = L;
    }

    // 发钱
    const winnerList = [...totalByPid.entries()]
      .map(([pid, amount]) => {
        const p = this.players.get(pid);
        this.giveChips(p, amount);
        return { id: pid, name: p.name, amount };
      })
      .sort((a, b) => b.amount - a.amount);

    this.finishHand({
      reason,
      winners: winnerList,
      pot: this.pot,
      // 开牌时公开所有人（含已弃牌者）的牌
      showdown: [...this.players.values()]
        .filter((p) => p.inHand && p.cards)
        .sort((a, b) => {
          const ia = handInfo(a.cards);
          const ib = handInfo(b.cards);
          return -compareHands(ia, ib, cmp235);
        })
        .map((p) => ({
          id: p.id,
          name: p.name,
          hand: handInfo(p.cards).name,
          allIn: !!p.allIn,
          folded: !!p.folded,
          cards: p.cards.map((c) => ({ s: c.s, r: c.r, id: cardId(c), label: cardLabel(c) }))
        }))
    });
  }

  finishHand(result) {
    this.lastResult = { ...result, handNo: this.handNo, at: Date.now() };
    this.pot = 0;
    this.phase = 'showdown';
    this.turnId = null;
    this.turnDeadline = 0;
    // 每轮局数限制：打满后不再自动连开，由玩家决定是否继续
    const target = this.config.sessionHands || 0;
    const sessionOver = target > 0 && this.handNo >= target;
    if (sessionOver) this.lastResult.sessionOver = true;
    // 自动连开：按配置排定下一局时刻（打满一轮时不排）
    this.nextHandAt =
      this.config.autoNext && !sessionOver
        ? Date.now() + this.config.autoNextSeconds * 1000
        : 0;
    // 战绩：胜局数 / 最大单局赢池
    for (const w of result.winners || []) {
      if (!this.stats[w.id]) this.stats[w.id] = { hands: 0, wins: 0, best: 0 };
      this.stats[w.id].wins += 1;
      if (w.amount > this.stats[w.id].best) this.stats[w.id].best = w.amount;
    }
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
      p.allIn = false;
      p.bid = null;
      p.cards = null;
    }
    this.pot = 0;
    this.stake = this.config.baseStake;
    this.turnId = null;
    this.turnDeadline = 0;
    this.turnCount = 0;
    this.bidDeadline = 0;
    this.bidStartedAt = 0;
    this.phase = 'lobby';
    this.log(`本局作废（${reason}），所有下注已退还`);
  }

  /** 结算后可开下一局；任何人可点，防止房主掉线卡住 */
  nextHand(pid) {
    if (this.phase === 'playing') throw new GameError('本局还没结束');
    const p = this.players.get(pid);
    if (!p) throw new GameError('玩家不存在');
    this.nextHandAt = 0;
    // 上一轮已打满：继续玩则再开同样局数的一轮
    const target = this.config.sessionHands || 0;
    if (target > 0 && this.handNo >= target) {
      const perRound = this.sessionBase > 0 ? this.sessionBase : target;
      this.config.sessionHands = this.handNo + perRound;
      this.log(`继续下一轮：再打 ${perRound} 局`);
    }
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
    } else if (p.chips > 0) {
      // 跟不起但还有筹码：孤注一掷，押上全部留在牌局里
      list.push({ type: 'allin', label: '孤注一掷', cost: p.chips });
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
    const viewerIsSpectator = this.spectators.has(viewerId);

    const players = [];
    for (const id of this.order) {
      const p = this.players.get(id);
      if (!p) continue;
      const isMe = id === viewerId;
      // 普通开牌：公开所有人（含弃牌者）的牌。
      // 弃牌获胜（singleWin）：默认不公布，只有赢家主动公布后大家才看得到。
      const singleWinCase = !!(this.lastResult && this.lastResult.singleWin);
      const singleWinReveal =
        !!this.revealWinner &&
        singleWinCase &&
        !!(this.lastResult.winners && this.lastResult.winners[0]) &&
        this.lastResult.winners[0].id === id;
      const showCards =
        (isMe && p.seen) ||
        (revealAll && p.inHand && !singleWinCase) ||
        singleWinReveal;
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
        allIn: !!p.allIn,
        bid: p.bid == null ? null : p.bid,
        debt: p.debt || 0,
        stats: this.stats[p.id] || { hands: 0, wins: 0, best: 0 },
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
      hasJoinPin: !!this.joinPin,
      nextHandAt: this.nextHandAt,
      nextHandSeconds: this.config.autoNextSeconds,
      bidDeadline: this.bidDeadline || 0,
      bidStartedAt: this.bidStartedAt || 0,
      myBid: me ? (me.bid == null ? null : me.bid) : null,
      spectating: viewerIsSpectator,
      spectatorCount: this.spectators.size,
      revealWinner: !!this.revealWinner,
      myDebt: me ? (me.debt || 0) : 0,
      loans: this.loans.slice(-20).map((l) => ({
        id: l.id,
        from: l.from,
        fromName: this.players.get(l.from) ? this.players.get(l.from).name : '?',
        to: l.to,
        toName: this.players.get(l.to) ? this.players.get(l.to).name : '?',
        amount: l.amount,
        status: l.status,
        at: l.at
      })),
      // 只有比牌双方能看到彼此的牌
      myCompare: (() => {
        const lc = this.lastCompare;
        if (!lc || !me) return null;
        if (lc.a !== me.id && lc.b !== me.id) return null;
        return lc;
      })(),
      spectators: [...this.spectators.values()].map((s) => ({
        id: s.id,
        name: s.name,
        connected: s.connected
      })),
      players,
      me: viewerId,
      mySeen: me ? me.seen : false,
      myCards: myEntry ? myEntry.cards : null,
      myHandName: myEntry ? myEntry.handName : null,
      inHand: me ? me.inHand : false,
      myOptions: this.optionsFor(viewerId),
      canLook: !!(me && (this.phase === 'playing' || this.phase === 'bidding') && me.inHand && !me.folded && !me.seen),
      chat: this.chat.slice(-12),
      chatSeq: this.chatSeq,
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
      stats: this.stats,
      joinPin: this.joinPin,
      loans: this.loans.slice(-100).map((l) => ({ ...l })),
      loanSeq: this.loanSeq,
      spectators: [...this.spectators.values()].map((s) => ({
        id: s.id,
        name: s.name,
        token: s.token,
        joinedAt: s.joinedAt
      })),
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
    room.joinPin = typeof raw.joinPin === 'string' ? raw.joinPin.replace(/\D/g, '') : '';
    room.loans = Array.isArray(raw.loans)
      ? raw.loans.filter((l) => l && typeof l.id === 'string').map((l) => ({
          id: l.id,
          from: String(l.from || ''),
          to: String(l.to || ''),
          amount: Number(l.amount) || 0,
          status: l.status === 'accepted' || l.status === 'declined' ? l.status : 'pending',
          at: Number(l.at) || 0
        }))
      : [];
    room.loanSeq = Number.isFinite(raw.loanSeq) ? raw.loanSeq : room.loans.length;
    for (const sp of raw.spectators || []) {
      room.spectators.set(sp.id, {
        id: sp.id,
        name: sanitizeName(sp.name, '观众'),
        token: sp.token,
        connected: false,
        joinedAt: sp.joinedAt || Date.now()
      });
    }
    room.stats =
      raw.stats && typeof raw.stats === 'object' && !Array.isArray(raw.stats)
        ? raw.stats
        : {};

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
        debt: Number.isFinite(sp.debt) ? sp.debt : 0,
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
  MAX_SPECTATORS,
  DEFAULT_CONFIG,
  sanitizeConfig,
  sanitizeName,
  PHASES
};
