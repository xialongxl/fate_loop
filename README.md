# 命运轮回：FATE LOOP

纯文字、纯单机、**模组驱动**、**确定性**的 Roguelike 自动战斗工具。

你不操作战斗。你做的事是**编排技能序列**（GCD 循环队列 + oGCD 优先级槽），让角色自己打，
观察结果，回去改序列。战斗过程是纯函数：

```
(种子, 序列配置, 内容模组)  →  逐帧结果必然一致
```

1x / 4x / MAX 三种倍速下的终态**逐字节相同**，种子是复现整局的完整凭据 ——
抄下种子就能在别的机器上重放出同一局。这是本项目的立项卖点，也是全部工程约束的来源。

---

## 快速开始

```bash
npm install
npm run dev        # 本地开发（默认 http://localhost:5173）
npm test           # vitest run
npm run lint       # eslint
npm run build      # vite build
npm run verify     # lint + test + build 串联（提交前的门）
```

没有后端、没有构建产物依赖、没有账号：`npm run build` 出来的 `dist/` 是纯静态站，
丢到任意静态托管即可玩。

## 30 秒上手

1. 主菜单点 **新的轮回**，输入任意种子（数字或一串词语都行，留空则随机）
2. 在**地图**屏点相邻节点移动；踩到战斗节点自动开战
3. **战斗**屏只能看 —— 用 1x / 4x / MAX 控制观察速度，MAX 直接同步跑到结束
4. 打输了？回去在**技能轴**屏换序列。**装备**屏换装、强化、分解
5. 走到出口**下一层**，休息回血、商店买永久加成、事件做取舍
6. 死了就清零（局内 run）。**战绩**屏能看到历次轮回的种子与到达层数

## 代码结构

```
src/
  boot.js           浏览器入口：装配 + 失败兜底错误屏
  main.js           应用装配工厂 createApp()：内核 → 屏幕 → 意图翻译
  core/             纯逻辑，禁止碰 DOM（eslint 硬禁 async / Math.random / Date.now）
    constants.js    枚举与调参常量的单一来源
    prng.js         Mulberry32 + 三流分派（map / battle / player）
    store.js        不可变状态容器（update(draft) + 订阅 + getSnapshot 深冻结）
    derived.js      属性单一数据源：recalcPlayer / addPermanentBonus
    game.js         GameFlow：探索流程编排（移动 / 下层 / 休息 / 商店 / 事件 / 装备）
    battle/         engine（主循环+倍速）/ scheduler（oGCD 抢占）/ resolution（伤害）
    contracts/      契约注册表 —— 模组只能通过契约影响世界
    mods/           模组加载六步法（发现 → 依赖 → 检环 → 拓扑 → 实例化 → 覆盖裁决）
  mods/official/    官方内容模组：90 技能 · 14 Buff · 300 怪物 · 100 遭遇 · 商品 · 事件 · 地图
  persistence/      SaveService（同步入队 + 宏任务串行 flush）+ schema + 三适配器降级
  ui/               shell 外壳 / router 屏幕路由 / dialog 模态 / screens/ 10 屏 / map SVG
```

依赖方向是单向的：`ui → core`、`ui → persistence`，**core 永不 import ui**，
`core/**` 也永不直接调存储（存储异步，而战斗必须同步）。

## 六条不可违反的内核不变量

1. **三流随机分派** —— 地图 / 战斗 / 玩家开局各自的流互不干扰；战斗流的调用次数必须
   与倍速无关；UI 要随机数请用 `Math.random()`，别碰 PRNG
2. **绝对到期时间戳** —— 冷却与 Buff 存 `readyAt` / `expiresAt`，只比较大小，绝不每帧递减
3. **时间量必须是 `STEP_MS`(16ms) 整数倍** —— 模组加载时 `normalize` 会强制拒绝
4. **属性单一数据源** —— `maxHp/attack/defense/critChance` 一律由
   `(exp, equipment, seedBonus, permanentBonus)` 重算；「永久提升」必须走
   `addPermanentBonus`，直接写派生值等于写空气（有守卫测试拦）
5. **音频永不影响逻辑** —— 契约返回 `undefined`、不消费随机数、sink 抛错不外传
6. **UI 不得触碰活状态** —— 屏幕只吃 `getSnapshot()`，要改状态就调 `GameFlow` 方法

细节与反例见 [`docs/交接文档.md`](docs/交接文档.md)。

## 测试

| 文件 | 守什么 |
|---|---|
| `integration/cross-speed.test.js` | 1x / 4x / MAX 终态逐项相等（**改引擎必看它绿**） |
| `integration/app-wiring.test.js` | 阶段 9 接线的 jsdom 冒烟：十屏、节点操作、结算、存档、路由、**渲染再多也不消费随机流** |
| `integration/screens.test.js` | 屏幕级细测：序列编辑、装备操作、排序筛选、无障碍与焦点陷阱 |
| `integration/balance.test.js` | 开局可用性：1 级两类手段都有、默认序列能打下 1~3 层（胜率固化成确定性断言） |
| `unit/gameflow.test.js` | 探索流程编排：移动 / 战斗结算 / 商店 / 事件 / 下层 / 装备 / 读档 |
| `unit/scheduler.test.js` | oGCD 抢占与平局打破（裁决 3）、目标解析、GCD 循环队列 |
| `unit/determinism-core.test.js`、`unit/progression.test.js` | PRNG 分派、经验曲线、解锁表 |
| `unit/equipment.test.js` | 装备生成纯函数、派生属性、强化/分解、永久加成 |
| `unit/map-generation.test.js` | 网格地图生成不变量：连通、起点出口、死路、300 组种子 |
| `unit/persistence.test.js` | 三适配器同形、序列化纯函数、版本拒读、成长字段往返 |
| `unit/mod-loading.test.js` | 六步法与 normalize、内容守卫（禁止手写派生值） |
| `unit/audio.test.js`、`unit/contracts.test.js` | 节流器、清单、契约注册与音频无关性 |

## UI 布局体检（CSS 不是闭眼写的）

jsdom 没有布局引擎，CSS 写歪了测试照样全绿。所以仓库里带了一个真浏览器体检：

```bash
npm run ui:audit                                      # 13 个界面 × 1440x900
npm run ui:audit -- --views=1440x900,900x900,420x900  # 多档视口矩阵
npm run ui:audit -- --only=map,battle --shots=.ui-audit
UI_AUDIT_BROWSER=/路径/msedge.exe npm run ui:audit    # 指定浏览器
```

它起一个 dev server，用无头 Edge/Chrome 把应用驱动到每个界面（打过仗、有装备、
开着商店/事件/通关面板），然后量：**横向溢出、零高度可见元素、元素跑出视口、
文本被裁且没写 ellipsis、面板被遮挡、对比度 < 4.5:1、当前屏几乎是空的**，
外加屏高占比 / 节点数 / 雾点数 / 可达节点 / 实体卡数等指标。有问题就非零退出。

两条设计约束值得记：
- **每个用例都有前置断言**（"通关面板确实打开了"）。没有它，"其实阵亡在地图上"
  这种状态会安静地报成 ✓ —— 比没有体检更坏
- 结果写进 `<script type="application/json">` 由 Node 侧解析，不引入
  puppeteer/playwright（本项目运行时依赖只有 howler）

## 加内容（模组）

内容就是放在 `src/mods/<作者>/<模组名>/` 下的 ES 模块：一个 `manifest.js` 声明
`id / version / provides / requires`，一个 `setup.js` 往内容池里注册技能、怪物、
遭遇、商品、事件或地图生成器。加载器按依赖拓扑排序实例化，**任一模组出错则整体
加载失败**（部分加载会留下悬空 ID 引用，比直接失败难查得多）。

想写模组：看 **[`docs/模组开发指南.md`](docs/模组开发指南.md)** —— 契约签名、八种产物的
字段速查、六条硬约束、覆盖规则、常见报错对照表。

直接抄最省事的起点是仓库里那个**会被真正加载**的示例模组：
[`src/mods/dev/example-pack/`](src/mods/dev/example-pack/) —— 它注册了一个新流派
（虚空）、5 个技能、1 个 Buff、2 种怪物、3 个遭遇、2 件商品、1 个事件，
并且由 `tests/integration/mod-example.test.js` 端到端验证，所以它不会悄悄过期。

## 当前状态

阶段 0~9 已完成并接线（多屏 UI 可用），**一局可以打通**：

- **终点是第 50 层** —— 使用第 50 层的出口即通关，弹结算面板并写入历史战绩
  （`outcome: 'victory'`）。之后可以选「继续挑战无尽」，那之后没有第二次结算，
  死在无尽里的记录会带「通关后 · 无尽」标记
- 50 这个数字来自实测：按现有经验曲线，50 层大约 48 级，是"一局走得完又足够长"
  的位置。经验曲线与 `SKILL_UNLOCK_MAX_LEVEL = 120` 仍不匹配（详见
  `docs/交接文档.md` 附录），那是下一轮要谈的平衡问题

已知限制：
- **仓库不含音频资源** —— `AUDIO_ASSETS` 为空，音频层整体静默降级，不发请求
- **宝珠系统未实装** —— `RARITIES[].orbSlots` 只是数据，图鉴会如实标注
- 官方遭遇模板最深到第 999 层；再深的无尽段会回退到最深一档模板（不会崩，但
  数值不再增长，等于难度天花板）

## 文档

- [`docs/《命运轮回：FATE LOOP》完整设计计划书.md`](docs/《命运轮回：FATE%20LOOP》完整设计计划书.md) —— 主设计（玩法、状态模型、规格）
- [`docs/技术实施细化方案.md`](docs/技术实施细化方案.md) —— 分层、契约、裁决与验收门
- [`docs/交接文档.md`](docs/交接文档.md) —— **接手必读**：现状、不变量、未完成工作、推进路线、实测数据
- `docs/archive/` —— 两份属于旧项目（Boss Rush 弹幕）的文档，仅作历史参考
