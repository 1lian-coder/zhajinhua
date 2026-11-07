# table-verify —— 牌桌 UI 自动化验收工具

面向「椭圆牌桌 / 15 座位 / 抢庄 UI」前端重构的验收脚本。
一个文件（`tools/table-verify.js`），零 npm 依赖（Node 24 自带 fetch / WebSocket），
驱动 Edge 无头浏览器（CDP）在真实手机视口下走完整局并断言。

## 用法

```bash
node tools/table-verify.js [baseUrl] [模式]
```

| 参数 | 说明 |
|---|---|
| `baseUrl` | 缺省 `http://127.0.0.1:18081`。**不带 baseUrl 且该端口没有服务时**，脚本自动 `PORT=18081 node server.js` 起服，结束时杀掉并删除 `data/rooms.json`。带 baseUrl 则视为外部服务：不停服、不动 `data/rooms.json`（只打印提醒）。 |
| `模式` | `smoke`（默认）或 `layout` |

- **smoke**：起服 → 2 / 6 / 15 人局（14 人机）各走一遍完整流程（布局 + 抢庄 + 打完整局）。
- **layout**：只做布局检查。同样建房→加人机→开局进 playing，但不打完整下注局（几分钟出结果，适合重构时快速自检）。

退出码：全部断言通过 `0`，任何断言失败 `1`；参数错误 `2`。

## 断言内容（每组人数 × 320 / 375 / 480 三档视口）

| # | 断言 | 判定 |
|---|---|---|
| a | 无横向滚动 | `documentElement.scrollWidth - clientWidth <= 0` |
| b | 座位无重叠 | 所有 `.seat` 的 `getBoundingClientRect` 两两比较；**两轴穿透深度都 > 4px** 才算真重叠（<4px 视为边框/阴影误差，允许，但会在详情里以「浅重叠」列出供人工核对） |
| c | 座位数量正确 | `.seat` 数 + 我的座位（`#my-seat`/`.my-seat`）=== 玩家数（当前前端把「我」单独渲染在下方，`.seat` 只有对手，故按两者之和判定） |
| d | 抢庄流程 | `/api/start` 后 phase=`bidding`：① `#bid-bar` 里存在「不抢」+「抢庄」按钮（`#act-look` 之外，按 id/文本识别）② 抢庄倒计时文案（`#bid-strip`/`#bid-count` 数字）存在，并**打印抢庄区实际 DOM 供人工核对** ③ 真人用 CDP 点「不抢」（fallback：文本匹配 → 抢庄弹窗）后服务端 `myBid` 更新 ④ phase=`playing` 且庄家徽标/庄家信息出现（中央庄家名 + 头像/座位徽标任一） |
| e | 完整一局（仅 smoke） | 真人轮到即 CDP 点「弃牌」（含二次确认，UI 失败有 HTTP 兜底），人机服务端自驱动；phase=`showdown` 后断言 `lastResult.winners` 非空、所有玩家 `net` 合计 === 0（零和） |

### 房间流程（脚本怎么搭局）

1. `POST /api/create`（`pin` 自动读 `data/settings.json` 的 `createPin`，缺省 `7749`；`dealerBid=true` + 快节奏配置：`maxStake=30`、`maxPot=300`、`turnSeconds=0`、`autoNext=false`、`bidSeconds=10`）
2. 浏览器走真实 UI 加入：`/?r=<房号>` 预填 → 填昵称「验收员」→ 点「加入」
3. 临时房主（HTTP 建的「开房助手」）`POST /api/leave` 退出，房主转给浏览器玩家
4. `POST /api/addBot` × (n-1) 加人机 → `POST /api/start` → 抢庄 → …

## 产物

- 每组 × 每档视口截图：`%TEMP%\table-verify\<人数>p-<宽度>.png`（如 `15p-320.png`）
- 终端逐项 ✓/✗；结尾汇总断言数/失败数、浏览器控制台错误（**不计入断言**）、截图目录

## 已知行为 / 注意事项

- **不碰** `public/`、`lib/`、`server.js`、`test/`、`docs/`；除结束时 mandated 的 `data/rooms.json` 删除外不写仓库文件；截图 / Edge profile 全在 `%TEMP%`。
- 结束清理：杀自己起的 node + Edge（`taskkill /T /F`）、删 `data/rooms.json`（防残留测试玩家占满全局 150 人上限毒害下次重启）。外部服务模式下不停服、不删文件，只提醒。
- layout 模式下人机会把牌打完（它们自驱动），视口切换期间 phase 可能已到 `showdown`，日志会提示；这不影响布局断言。
- 同机**并行跑多个服务**（如另一套工具用别的端口）会争写同一个 `data/rooms.json`（后者覆盖前者）；本工具只保证自己退出前删干净。
- 对「我」的座位判定的兼容：若重构后 `.seat` 包含全部玩家（含我），c 项同样通过（和 === 玩家数即可）。
- 抢庄按钮 / 倒计时的识别按「id 或文本」双通道（`btn-bid-pass`/「不抢」、`btn-bid-grab`/「抢庄」、`bid-strip`/`bid-count` 数字）。重构若改 id，文本通道仍能兜底；d1/d2 失败时会把抢庄区实际 DOM 打进日志供人工核对。
