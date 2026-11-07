# 前后端协议（v1）—— 炸金花网页版

服务端：`server.js`（零依赖，Node >= 18），静态页托管在 `public/`。
实时通道：**SSE**（Server-Sent Events）。客户端用 `EventSource` 订阅，用 `fetch()` POST 发动作。

- 所有请求 `Content-Type: application/json`，响应均为 JSON：成功 `{ok:true, ...}`，失败 `{ok:false, error:"中文错误"}`。
- 身份 = `roomId + playerId + token`，客户端把三者存 `localStorage`，刷新/断网后自动 rejoin。
- **服务端只把"你自己看过的牌"发给你**，别人的牌在开牌前一律为 `null`。

---

## 1. HTTP 接口

### POST /api/create
创建房间并成为房主。
```json
{ "name": "阿强", "pin": "1234", "config": { "ante":10, "initialChips":1000, "baseStake":10,
  "maxStake":100, "maxPot":3000, "seeMultiplier":2, "special235":false,
  "turnSeconds":45, "autoRebuy":true } }
```
`config` 可省略（用默认值）。
`pin` 可选：当服务端配置了创建口令（`data/settings.json` 的 `createPin`）时**必填**，
错误/缺失返回 `{ok:false, error:"...", code:"PIN_REQUIRED"}`。
返回：
```json
{ "ok":true, "roomId":"837261", "playerId":"p1", "token":"a1b2..." }
```

### POST /api/join
```json
{ "roomId":"837261", "name":"小李", "password":"1234" }
```
`password` 仅在房间设了房间密码时必填。返回同上。房间不存在/已满/密码错误返回 `{ok:false,error,code?}`。

### POST /api/rejoin
断线重连，恢复身份。
```json
{ "roomId":"837261", "playerId":"p1", "token":"a1b2..." }
```
返回 `{ok:true, roomId, playerId, token}`。

### GET /api/events?roomId=837261&playerId=p1&token=a1b2...
SSE 长连接。事件类型：
- `event: state` ＋ `data: <State JSON>` —— 首次连接立刻推一次，之后每次状态变化推一次。
- `event: ping` ＋ `data: 1` —— 每 20 秒一次心跳（保活，防代理断连）。

断线时浏览器 `EventSource` 会自动重连；重连后需带同样的 query 参数。

### POST /api/action
```json
{ "roomId":"837261", "playerId":"p1", "token":"a1b2...", "action":"call", "payload":{} }
```
`action` 取值与 `payload`：

| action | payload | 说明 |
|---|---|---|
| `look` | `{}` | 看自己的牌（不结束回合，看牌后下注额 ×seeMultiplier）。**不是回合动作**，任何时候都能看 |
| `call` | `{}` | 跟注，扣 `cost` |
| `raise` | `{ "to": 40 }` | 加注到单注 `to`（必须 > 当前 stake 且 ≤ maxStake） |
| `fold` | `{}` | 弃牌 |
| `allin` | `{}` | 孤注一掷：筹码不够跟注时押上全部，留在牌局直到开牌（`myOptions` 会给出 `cost`=剩余筹码） |
| `bid` | `{ "bid": 2 }` | **仅抢庄阶段**：0=不抢，1~4=抢庄倍数。全员选完或到 `bidDeadline` 自动定庄（倍数最高者当庄，并列随机；无人抢按座位轮转）。下注阶段发 bid 返回「现在不是抢庄阶段」 |
| `compare` | `{ "target": "p2" }` | 约比牌，付 `cost`，输的人出局 |

### POST /api/chat
快捷聊天（大厅/牌局中都可发）。
```json
{ "roomId":"837261", "playerId":"p1", "token":"a1b2...", "text":"快点啦" }
```
`text` 服务端清洗（去控制字符、trim、截 30 字）；每玩家 3 秒内最多 2 条。
响应 `{ok:true}`，内容通过 state 的 `chat` 数组下发（最近 12 条，每条带递增 `seq`，前端靠 seq 判断新消息）。

### POST /api/setRoomPin
房主设置/清除**房间加入密码**（仅 lobby / showdown 阶段）。与创建口令无关：这个限制的是**谁能进这个房间**。
```json
{ "roomId":"837261", "playerId":"p1", "token":"a1b2...", "password":"1234" }
```
`password` 为 4~8 位数字；传空字符串表示清除密码。返回 `{ok:true, hasJoinPin:true|false}`。

`POST /api/join` 需带上 `password`；缺失或错误返回 `{ok:false, code:"ROOM_PASSWORD_REQUIRED", error:"..."}`。
连续输错 20 次锁定 10 分钟。密码明文**永不下发**，state 里只有 `hasJoinPin`。

### POST /api/pauseAuto
取消本局的自动连开（任何人可调用）。`{ roomId, playerId, token }`

### POST /api/watch
加入房间**观战**（不占玩家座位、不能出牌、看不到任何暗牌，开牌后才可见）。
```json
{ "roomId":"837261", "name":"观众甲", "password":"1234" }
```
房间有密码时需带 `password`（错误返回 `code:"ROOM_PASSWORD_REQUIRED"`）。
返回 `{ ok:true, roomId, playerId:"s5", token, spectating:true }`。
观战者上限 20 人，可正常连 SSE、聊天、看结算。

### GET /api/rooms?pin=1234
观战大厅：列出当前所有房间。
```json
{ "ok":true, "rooms":[
  { "roomId":"837261", "players":4, "maxPlayers":15, "spectators":1,
    "phase":"playing", "handNo":3, "pot":120, "stake":20, "hasJoinPin":false }
]}
```
若服务器设置了创建口令（`CREATE_PIN`），需带 `pin`，否则返回 `{ok:false, code:"PIN_REQUIRED"}`。

### POST /api/addBot
房主添加人机玩家（仅 lobby / showdown 阶段）。人机由服务端 `botTick` 驱动自动出牌。
```json
{ "roomId":"837261", "playerId":"p1", "token":"a1b2...", "name":"人机·阿福" }
```
`name` 可省略（自动从名单挑）。返回 `{ok:true, playerId:"p3", name:"人机·阿福", isBot:true}`。

### POST /api/removeBot
房主移除人机（仅 lobby / showdown 阶段）。
```json
{ "roomId":"837261", "playerId":"p1", "token":"a1b2...", "target":"p3" }
```

### POST /api/look
专门用于看牌，**不校验是否轮到你**（看牌不消耗回合）。`{ roomId, playerId, token }`
等价于 `POST /api/action` 且 `action="look"`；两者行为一致。

### POST /api/config
房主在大厅修改设置。`{ roomId, playerId, token, config }`

### POST /api/start
开始本局 / 下一局。`{ roomId, playerId, token }`（大厅或结算阶段都可用，任何人可点）

### POST /api/leave
`{ roomId, playerId, token }`

### GET /api/health
`{ ok:true, rooms: 3, players: 5, uptime: 1234, createPinRequired: false }`
`createPinRequired` 为 true 时，首页应显示「创建口令」输入框。

---

## 2. State（服务端推给客户端的完整状态）

```json
{
  "roomId": "837261",
  "phase": "playing",                  // lobby | bidding | playing | showdown
                                       // bidding = 抢庄阶段（房间配置 dealerBid=true 时，开局先抢庄再下注）
  "handNo": 3,
  "config": { "ante":10, "initialChips":1000, "baseStake":10, "maxStake":100,
              "maxPot":3000, "seeMultiplier":2, "special235":false,
              "turnSeconds":45, "autoRebuy":true },
  "pot": 120,
  "stake": 20,                         // 当前单注（闷牌跟注额）
  "hasJoinPin": true,                  // 房间是否设了加入密码（明文永不下发）
  "nextHandAt": 0,                     // 自动连开：下一局的计划时刻（0=不自动）
  "nextHandSeconds": 8,                // 自动连开的等待秒数（配置值）
  "dealerId": "p2",
  "turnId": "p3",                      // 轮到谁，null = 无人
  "turnDeadline": 1699999999999,       // 毫秒时间戳，0 = 不限时
  "bidDeadline": 1699999500000,        // 抢庄阶段截止时刻（phase=bidding 时有效，否则 0）
  "bidStartedAt": 1699999400000,       // 抢庄阶段开始时刻
  "myBid": 2,                          // 我自己的抢庄选择（null=未选）
  "spectating": false,                 // 我是否是观战者
  "spectatorCount": 1,                 // 当前观战人数
  "spectators": [ { "id":"s1", "name":"观众甲", "connected":true } ],
  "serverNow": 1699999950000,          // 用于校准倒计时（别用本机时间）
  "hostId": "p1",
  "maxPlayers": 6,
  "players": [
    {
      "id": "p1", "name": "阿强",
      "chips": 880,                    // 剩余筹码
      "net": -120,                     // 累计净胜负分（惩罚依据，可为负）
      "bet": 40,                       // 本局已下注
      "inHand": true,                  // 是否在本局中
      "folded": false,                 // 是否已弃牌
      "seen": true,                    // 是否已看牌（公开信息）
      "connected": true,               // 是否在线（人机恒为 true）
      "isBot": false,                 // 是否人机玩家
      "allIn": false,                 // 本局是否孤注一掷（全下留场，不再参与轮转）
      "bid": 2,                       // 抢庄选择：null=未选，0=不抢，1~4=倍数（仅 bidding/playing 早期有意义）
      "stats": { "hands": 5, "wins": 2, "best": 360 },  // 本房间累计战绩（落盘保留）
      "isHost": true,
      "isDealer": false,
      "isTurn": false,
      "cards": [                       // 只有"自己的且看过"或"结算时"才有值，否则 null
        { "s":"S", "r":14, "id":"S14", "label":"♠A" }
      ],
      "handName": "金花"                // 同上，否则 null
    }
  ],
  "me": "p1",
  "mySeen": true,
  "myCards": [ { "s":"S","r":14,"id":"S14","label":"♠A" }, ... ],
  "myHandName": "金花",
  "inHand": true,
  "myOptions": [                       // 轮到自己时的可选动作，否则空数组
    { "type":"call", "label":"跟注", "cost":20 },
    { "type":"raise", "label":"加注", "raises":[ { "to":40, "cost":80 }, { "to":100, "cost":200 } ] },
    { "type":"compare", "label":"比牌", "cost":20, "targets":[ {"id":"p2","name":"小李"} ] },
    { "type":"look", "label":"看牌", "cost":0 },
    { "type":"fold", "label":"弃牌" }
  ],
  "canLook": false,
  "lastResult": {
    "reason": "达到总注封顶",
    "handNo": 3,
    "pot": 320,
    "winners": [ { "id":"p1", "name":"阿强", "amount":320 } ],
    "showdown": [ { "id":"p1","name":"阿强","hand":"金花",
                    "cards":[{"s":"S","r":14,"id":"S14","label":"♠A"}] } ]
  },
  "logs": [ { "t": 1699999999000, "text": "阿强 跟注 20" } ],
  "updatedAt": 1699999999000
}
```

> 注意：`myCards` 在你点"看牌"之前是 `null`（闷牌就是真闷，前端别自己藏）。
> `players[].cards` 对其他玩家在 `phase !== "showdown"` 时永远是 `null`；
> 到了 `showdown` 也只公开**参与摊牌（未弃牌）**的牌，**已弃牌的人不亮牌**。

---

## 3. 前端需要实现的界面

### 页面结构（单页，路由用 hash 或状态切换）
1. **首页**
   - 昵称输入（存 localStorage）
   - 「创建房间」（可选：展开设置项）
   - 「加入房间」（6 位数字房间号输入）
   - 支持 URL `?r=837261` 自动跳到加入页并预填房号
2. **房间 / 牌桌**（核心）
   - 顶部：房间号（大号、可复制）、在线人数、分享按钮（复制邀请链接）、退出
   - 中央：底池 `pot`、当前单注 `stake`、第几局
   - 座位区：最多 6 个座位环形/网格排列，每人显示 昵称 / 筹码 / 本局下注 / 净分 / 状态徽标（庄家·闷·看牌·弃牌·离线·等待）
   - 我的三张牌：未看牌时显示牌背，点「看牌」翻转；看牌后显示牌面 + 牌型名
   - 操作栏（仅轮到自己时可用）：跟注(显示金额) / 加注(弹出可选金额) / 比牌(选目标) / 看牌 / 弃牌
   - 倒计时：用 `turnDeadline - serverNow` 校准本地时钟，进度条或秒数
   - 日志流：`logs` 最新在下
   - 大厅阶段：显示房主设置面板（底注/初始筹码/单注封顶/总注封顶/看牌倍数/235通杀/思考时间），房主可改，其他人只读；「开始游戏」按钮（≥2 人）
3. **结算**（`phase === "showdown"`）
   - 赢家、底池、所有人牌面与牌型（`lastResult.showdown`）
   - 累计积分榜（按 `players[].net` 排序，显示 +/−）
   - **惩罚换算**：输入「1 分 = 几个惩罚」，实时算出每人该做多少个（如 1 分 = 1 个俯卧撑）
   - 「下一局」按钮

### 视觉要求
- 移动端优先，竖屏 375×667 起，桌面居中卡片式布局
- 深绿/墨绿牌桌质感，牌面白底，红黑花色
- 大按钮、拇指热区，禁止误触（弃牌/比牌做二次确认）
- 纯 CSS 画牌（不依赖外部图片/CDN，离线可用）
- **不引入任何第三方库/CDN**（纯原生 JS + CSS），保证内网/弱网可用
- 断线时顶部显示「连接中…」条，重连成功自动消失
- 所有金额、房间号用等宽字体或 tabular-nums，避免跳动

### 前端约束
- 只写 `public/` 下的文件：`index.html`、`app.js`、`style.css`（可加 `cards.css`）
- 不修改 `server.js` / `lib/`（那边由 Lead 负责）
- 通过 `fetch('/api/...')` 调用；SSE 用 `new EventSource('/api/events?...')`
- 需兼容微信内置浏览器（iOS Safari / Android WebView）：避免过新语法（可选链 `?.` 和 `??` 可以，`Array.prototype.at` 少用）
### POST /api/loan
借分（双方同意才生效）。
```json
{ "roomId":"837261", "playerId":"p1", "token":"…", "op":"propose", "to":"p2", "amount":200 }
{ "roomId":"837261", "playerId":"p1", "token":"…", "op":"propose", "from":"p2", "amount":200 }
{ "roomId":"837261", "playerId":"p1", "token":"…", "op":"accept",  "loanId":"L3" }
{ "roomId":"837261", "playerId":"p1", "token":"…", "op":"decline", "loanId":"L3" }
```
`propose` 支持两个方向：`to`（我借给对方）/ `from`（我向对方借）。对方筹码低于底注时才需要借分。
同意后筹码与净分立即结算：出借方 chips/net 各 -amount，借入方 chips/net 各 +amount（不记欠分）。

### state 里与借分/比牌相关字段
- `loans`：最近借分记录 `{ id, from, fromName, to, toName, amount, status(pending/accepted/declined), at }`
- `myCompare`：**仅比牌双方可见**，最近一次比牌 `{ a,aName,aCards, b,bName,bCards, winner, at }`

### POST /api/config 的锁定规则
- 只有房主能改；非房主返回「只有房主可以修改设置」
- `phase = playing / bidding` 时返回「牌局进行中不能修改设置」
- `handNo > 0`（已开过局）返回「牌局已开始，设置已锁定」，想改规则请重新建房
- `ante`（底分）范围 1~10000；`initialChips`（初始筹码）范围 10~1000000
