/**
 * 全局常量与枚举。
 * 所有时间量纲统一为整数毫秒（规格 4.2），且必须是 STEP_MS 的整数倍（裁决 4）。
 */

/** 单个逻辑步的时间粒度。所有冷却/GCD/Buff 时长必须是它的整数倍。 */
export const STEP_MS = 16;

/** 速度模式 → 每帧推进的毫秒数。MAX 为 null，表示同步跑到结束。 */
export const SPEED_MODES = Object.freeze({
  PAUSED: 'paused',
  X1: '1x',
  X4: '4x',
  MAX: 'MAX',
});

export const SPEED_STEP_MS = Object.freeze({
  [SPEED_MODES.X1]: 16,
  [SPEED_MODES.X4]: 64,
});

/** 战斗超时保护（规格 13）：虚拟时间超过 5 分钟仍未结束，判负。 */
export const BATTLE_TIMEOUT_MS = 300_000;

/** MAX 模式的步数上限，双重保护，防止契约实现异常导致死循环。 */
export const MAX_MODE_STEP_LIMIT = Math.ceil(BATTLE_TIMEOUT_MS / STEP_MS) + 16;

/** 地图生成步数上限（规格 13）。 */
export const MAP_GENERATION_STEP_LIMIT = 10_000;

/** 战斗日志环形缓冲容量（规格 8.2）。 */
export const LOG_CAPACITY = 100;

/** 运行状态机（规格 5.1）。 */
export const GAME_STATUS = Object.freeze({
  IDLE: 'idle',
  EXPLORING: 'exploring',
  BATTLING: 'battling',
  PAUSED: 'paused',
  FINISHED: 'finished',
  ERROR: 'error',
});

export const WINNER = Object.freeze({
  PLAYER: 'player',
  MONSTERS: 'monsters',
});

/** 节点类型（规格 5.4 + 裁决 B 补齐 empty）。 */
export const NODE_TYPE = Object.freeze({
  START: 'start',
  COMBAT: 'combat',
  ELITE: 'elite',
  REST: 'rest',
  SHOP: 'shop',
  EVENT: 'event',
  EMPTY: 'empty',
  EXIT: 'exit',
  DEAD_END: 'deadEnd',
});

/**
 * 节点类型分配权重（决定 B，合计 100%）。
 * 起点、死路、出口不参与此分配。
 */
export const NODE_TYPE_WEIGHTS = Object.freeze([
  { type: NODE_TYPE.COMBAT, weight: 45 },
  { type: NODE_TYPE.ELITE, weight: 12 },
  { type: NODE_TYPE.REST, weight: 12 },
  { type: NODE_TYPE.SHOP, weight: 8 },
  { type: NODE_TYPE.EVENT, weight: 8 },
  { type: NODE_TYPE.EMPTY, weight: 15 },
]);

/** 技能类型（规格 5.3）。 */
export const SKILL_TYPE = Object.freeze({
  GCD: 'GCD',
  OGCD: 'oGCD',
});

/** 技能作用范围（规格 5.3）。 */
export const SKILL_RANGE = Object.freeze({
  SELF: 'self',
  SINGLE: 'single',
  ALL_ENEMIES: 'allEnemies',
  ALL_ALLIES: 'allAllies',
  RANDOM_ENEMY: 'randomEnemy',
});

/** 实体阵营。 */
export const FACTION = Object.freeze({
  PLAYER: 'player',
  MONSTER: 'monster',
});

/** oGCD 槽位上限（规格 5.2）。 */
export const OGCD_SLOT_LIMIT = 3;

/** 地图网格尺寸范围（规格 6.2）。 */
export const GRID_MIN = 8;
export const GRID_MAX = 14;

/** 死路节点目标占比（规格 6.2 第三步）。 */
export const DEAD_END_RATIO = 0.3;

/** 休息节点恢复比例（决定 A）。 */
export const REST_HEAL_RATIO = 0.3;

/** 命运碎片掉落（决定 A）：普通战斗基础量，精英双倍。 */
export const SHARD_REWARD_COMBAT = 10;
export const SHARD_REWARD_ELITE_MULTIPLIER = 2;

/** 商店待售项数量（决定 A）。 */
export const SHOP_OFFER_COUNT = 3;

/** 商店同时上架的装备件数（阶段 8）。 */
export const SHOP_GEAR_COUNT = 2;

/**
 * 终点层（P1-6 的产品决策）：在第 VICTORY_FLOOR 层使用出口即通关，
 * 结算 outcome:'victory' 并写入历史；玩家可选择「继续挑战无尽」，
 * 之后没有第二次结算（见 state.victoryAchieved）。
 *
 * 为什么是 50：按现有经验曲线实测，50 层大约 48 级，是"一局能走完、
 * 又足够长"的位置。经验曲线与 SKILL_UNLOCK_MAX_LEVEL=120 的错配本轮不动，
 * 数据记在交接文档附录。
 */
export const VICTORY_FLOOR = 50;

/** 地图视口缩放范围（规格 6.5）。 */
export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 2.0;

/**
 * 自动对准（fitToRevealed）允许的缩放上限。
 *
 * 为什么不直接用 ZOOM_MAX：开局只揭示三五个节点时，fit 会一路顶到 2.0，
 * 于是玩家**往上滚滚轮完全没反应**（已经在上限）—— 实测探针里连续三下
 * 放大全是空操作。自动对准要留出向上缩放的头等。
 */
export const MAP_FIT_ZOOM_MAX = 1.5;

/**
 * 存档 schema 版本（裁决 7）。
 * v2：新增等级/经验/装备/背包/解锁技能（阶段 8），与 v1 不兼容。
 */
export const SCHEMA_VERSION = 2;

/** 存档槽位：3 个手动槽 + 1 个自动槽。 */
export const MANUAL_SAVE_SLOTS = 3;
export const AUTO_SAVE_SLOT = 'auto';

/** 暴击基础倍率。 */
export const CRIT_MULTIPLIER = 1.5;

export const BUILD_TAG = 'FATE LOOP // deterministic core online';

// ============================================================
// 成长系统（阶段 8）
// ============================================================

/** 满级。长局游戏：单局目标是数十层，120 级对应深层推图。 */
export const MAX_LEVEL = 120;

/**
 * 经验曲线分段（参考 Fate_echo 三段式，按本作 120 级上限重调）。
 * 低段升级快（开局 3~4 场战斗一级），高段指数拉升但不致停滞。
 */
export const EXP_CURVE = Object.freeze({
  BASE: 60,
  /** 1~39 级：BASE * 1.14^(lv-1) */
  EARLY_MAX: 40,
  EARLY_RATE: 1.14,
  /** 40~79 级：接续 40 级值后改用 1.11 */
  MID_MAX: 80,
  MID_RATE: 1.11,
  /** 80~120 级：接续 80 级值后改用 1.08 */
  LATE_RATE: 1.08,
});

/** 玩家 1 级基线（种子浮动在 initialState 中叠加）。 */
export const PLAYER_BASE = Object.freeze({
  maxHp: 320,
  attack: 34,
  defense: 8,
  critChance: 0.05,
});

/**
 * 成长预算总账（P3）。曲线上所有旋钮收在这一个地方，读表只走 `core/growth.js`。
 *
 * 为什么要有这个对象：数字本来散在五处（`GROWTH_PER_LEVEL`、`encounter.js` 里
 * 硬编码的 0.12/0.08、`equipment.js` 的掉落权重、`RARITIES.mult`、`EXP_CURVE`），
 * 合起来到底是什么形状没人能回答 —— 「数值不膨胀」不是谁调过的结果，
 * 是因为没人总账。P0 那个 bug（高档权重是常数）能活这么久的原因也是这个。
 *
 * 默认值**逐项等于现状**（+28/+6/+4/+0.25 每级、1+0.12(f-1)、1+0.08(f-1)）：
 * 本轮只把旋钮收口，不顺手改曲线 —— 改曲线等于重跑平衡，那得单独一轮拍板。
 * 守卫在 `tests/unit/growth.test.js`：逐层逐项复算必须与旧闭式相等。
 *
 * 表的语义（三张都是「分段」，段只管到下一段起点之前）：
 *  - `player.perLevel`：自 `fromLevel` 起每升一级的增量（改的是「玩家应多强」）
 *  - `monster.*`：自 `fromFloor` 起的楼层缩放。`linear` = `base + rate×步数`，
 *    `compound` = `base × (1+rate)^步数`。**段界连续**：新段以旧段外推到本段起点的
 *    值为起点，所以 50→51 不会出现跳变（这是无尽段能接上的前提）
 *  - `loot`：掉落品质权重曲线（P0 那张，见下方 LOOT_RARITY_CURVE 的注释）
 *
 * `targets` **不进任何运行时路径**，它是设计判据与报告脚本的对照组：
 * 判据是「安全边际 = 玩家扛得住的秒数 ÷ 打完全部怪要的秒数」，不是各自 TTK 区间
 * （两条独立区间会放过「要 26 刀才打死一个怪 vs 只能抗 8 刀」这种必输组合）。
 * 跑 `npm run growth:report` 全程扇描，不要只看控制点 —— 实测三点全命中时
 * 第 11 层能掉到 ×1.11、第 40 层能鼓到 ×2.92。
 */
export const GROWTH_BUDGET = Object.freeze({
  player: Object.freeze({
    base: PLAYER_BASE,
    perLevel: Object.freeze([
      Object.freeze({ fromLevel: 1, maxHp: 28, attack: 6, defense: 4, crit: 0.25 }),
    ]),
  }),
  monster: Object.freeze({
    hp: Object.freeze([Object.freeze({ fromFloor: 1, mode: 'linear', rate: 0.12 })]),
    attack: Object.freeze([Object.freeze({ fromFloor: 1, mode: 'linear', rate: 0.08 })]),
    // 防御不随层缩放（模板值直接入战）：rate 0 的占位段，不是漏写 ——
    // 防御进的是 100/(100+def) 递减项，拿楼层去乘它会跟 K=100 这个常数打架。
    defense: Object.freeze([Object.freeze({ fromFloor: 1, mode: 'linear', rate: 0 })]),
  }),
  loot: Object.freeze({
    lowSuppressFloors: 4,
    lowSuppressStep: 0.08,
    lowSuppressCap: 0.9,
    /** P1 从 45 改 60、0.8 改 0.5：与九档的 weight 梯子联合解，理由见 LOOT_RARITY_CURVE 注释 */
    rampFloor: 60,
    tierLift: 0.5,
    progressCap: 2,
  }),
  targets: Object.freeze({
    /** 安全边际控制点（floor → 目标倍率），由 demo/scale-curve.html 反解得到 */
    margin: Object.freeze([
      Object.freeze({ floor: 1, value: 2.7 }),
      Object.freeze({ floor: 50, value: 2.0 }),
      Object.freeze({ floor: 300, value: 2.5 }),
    ]),
    band: Object.freeze({ min: 1.4, max: 4.0, fatalBelow: 1.0 }),
    /** 单场战斗时长上限（秒）：超过它玩家会直接跳结果，日志也刷不完 */
    fightSecondsMax: 90,
  }),
});

/**
 * 首段每级成长的快照（crit 单位为百分点）。
 * 表分段之后「每级成长」不再是常数，真正取值走 `growth.js#playerGrowthAtLevel`；
 * 这个名字留着给展示与旧断言用，值必须与 `GROWTH_BUDGET.player.perLevel[0]` 一致
 * （`tests/unit/growth.test.js` 守这条）。
 */
export const GROWTH_PER_LEVEL = Object.freeze({
  maxHp: GROWTH_BUDGET.player.perLevel[0].maxHp,
  attack: GROWTH_BUDGET.player.perLevel[0].attack,
  defense: GROWTH_BUDGET.player.perLevel[0].defense,
  crit: GROWTH_BUDGET.player.perLevel[0].crit,
});

/** 战斗胜利经验：每只怪物基础值 × 层数缩放，精英双倍。 */
export const EXP_REWARD = Object.freeze({
  PER_MONSTER: 18,
  FLOOR_SCALE: 0.35,
  ELITE_MULTIPLIER: 2,
});

/**
 * 技能流派。唯一来源：解锁表的轮转、序列屏与图鉴的筛选按钮都读这里。
 * （此前这两份中文名在 sequenceScreen.js 与 codex.js 里各拄了一遍，改一处漏一处。）
 * 顺序即解锁轮转的次序，也是筛选按钮的展示顺序 —— 不要随意调整。
 */
export const SKILL_FAMILIES = Object.freeze(['physical', 'fire', 'frost', 'shadow', 'thunder', 'order']);

/** 流派 id → 中文名。 */
export const SKILL_FAMILY_LABELS = Object.freeze({
  physical: '斩击',
  fire: '烈焰',
  frost: '霜寒',
  shadow: '幽影',
  thunder: '雷霆',
  order: '秩序',
});

/** 没有任一流派标签的技能归到这里，轮转时排最后。 */
export const UNGROUPED_FAMILY = 'untagged';

/** 技能解锁：等级门槛的上限（最后一个技能在此级解锁）。 */
export const SKILL_UNLOCK_MAX_LEVEL = 120;

/**
 * 开局（1 级）就解锁的技能数，按类型分名额。
 *
 * 为什么分开算：旧版只给「全局前 N 个」，而排序里 GCD 永远排在 oGCD 前，
 * 于是 30 个 oGCD 全部落在 79~120 级（含唯一自保技）——实测导致 1 级
 * 合法序列胜率从 90% 砸到 38%，而 oGCD 这套「插入技」作为本作卖点从头到尾
 * 不存在于玩家视野里。分名额保证 1 级既能打输出也有插入手段。
 */
export const STARTER_GCD_COUNT = 6;
export const STARTER_OGCD_COUNT = 4;

/** 开局解锁的技能总数（两类名额之和，供旧调用方与断言使用）。 */
export const STARTER_SKILL_COUNT = STARTER_GCD_COUNT + STARTER_OGCD_COUNT;

// ============================================================
// 装备系统（阶段 8，参考 Fate_echo 的槽位/品质/词缀结构）
// ============================================================

/** 8 个装备槽位。数组顺序即 UI 展示顺序，也是序列化顺序。 */
export const EQUIP_SLOTS = Object.freeze([
  'weapon',
  'head',
  'chest',
  'legs',
  'feet',
  'pendant',
  'ring',
  'trinket',
]);

export const EQUIP_SLOT_NAMES = Object.freeze({
  weapon: '武器',
  head: '头冠',
  chest: '胸甲',
  legs: '腿甲',
  feet: '靴子',
  pendant: '项链',
  ring: '戒指',
  trinket: '遗物',
});

/**
 * 品质九档（P1：6 → 9）。
 *
 * **只有 `{ id, name, mult, weight }` 是手写的**（那是设计意图本身，推导出来
 * 只是把常数换个地方藏），`index` / `cls` / `affixMax` 一律由下标推导 ——
 * 原来六档每档手抄 `cls` 与 `affixMax`，扩到九档就会「三处互相漏」（方案文档 待决 B）。
 *
 * 数字的两条约束：
 *  - `mult` 从 1.5 档起大致等比 ≈1.55 拉到 22（破损 0.6 是拖底、不是梯子一部分）
 *  - `weight` 在峰值「普通」之后按 **1/2.4 等比**衰减 —— 重排前是
 *    220/400/240/100/33/7，比例 0.42/0.33/0.21 一路变陡（中段鼓包）；
 *    现在只保留一个形状参数，调曲线 = 调公比
 *
 * ⚠️ `weight` 与 `GROWTH_BUDGET.loot` 是**绑在一起的**（层数抬升会乘在这条梯子上），
 * 改任何一边都要重跑 `npm run growth:report`。
 */
const RARITY_SPEC = Object.freeze([
  { id: 'worn', name: '破损', mult: 0.6, weight: 220, orbSlots: 0 },
  { id: 'common', name: '普通', mult: 1.0, weight: 400, orbSlots: 0 },
  { id: 'fine', name: '精良', mult: 1.5, weight: 167, orbSlots: 1 },
  { id: 'superb', name: '卓越', mult: 2.3, weight: 69, orbSlots: 1 },
  { id: 'epic', name: '史诗', mult: 3.6, weight: 29, orbSlots: 2 },
  { id: 'legend', name: '传说', mult: 6.0, weight: 12, orbSlots: 3 },
  { id: 'mythic', name: '神话', mult: 9.5, weight: 5, orbSlots: 4 },
  { id: 'relic', name: '不朽', mult: 14.5, weight: 2.1, orbSlots: 5 },
  { id: 'finale', name: '终焉', mult: 22.0, weight: 0.9, orbSlots: 6 },
]);

/**
 * `orbSlots` 暂时留着：**当前无消费者**（宝珠系统不存在），
 * 图鉴屏会如实标注「系统未实装」。实装或删除是单独一个决定，
 * 见交接文档 §七「P1 档 —— 只剩一条清理项」。
 */
export const RARITIES = Object.freeze(
  RARITY_SPEC.map((spec, index) =>
    Object.freeze({
      ...spec,
      /** 数组下标本身就是品质序号：存档里存的就是它 */
      index,
      /** CSS 品质色类名，与 styles.css 里的 .q0..q8 一一对应 */
      cls: `q${index}`,
      /** 词缀条数 = 下标 ⇒ 九档是 0..8 条（同一条词缀可重复中签后累加） */
      affixMax: index,
    }),
  ),
);

/**
 * 掉落品质曲线（P0，P1 重新调过一档）。它现在是 `GROWTH_BUDGET.loot` 的别名 ——
 * 同一个对象，不是第二份定义（两个名字各自演化过一次，那正是本包要避免的事）。
 *
 * 语义：低两档按 `lowSuppressStep` 逐段压制；高档（下标 ≥2）按
 * `(1 + tierLift) ** (progress * (index - 1))` 抬升，第 `rampFloor` 层吃满 progress=1，
 * 之后按同一速率涨到 `progressCap`。
 *
 * 修的是一个真 bug：旧实现只压制低档、高档权重是常数 ⇒「层数只让你更少捡到
 * 破烂，并不会让你更容易捡到传说」，40 层以后装备成长停住。
 *
 * ⚠️ **这组数与 `RARITIES[].weight` 是联合解出来的，不是各自调好的两件事。**
 * 九档把尾巴重排平滑后，沿用旧的 `tierLift 0.8 / rampFloor 45` 会把顶三档
 * 抬到「90 层占 66%、终焉占 29%」—— P4 的精炼当场变白给。
 * 所以下面每个数都与那张 weight 梯子绑在一起，改一处要重跑
 * `npm run growth:report` 与 `tests/unit/equipment.test.js` 里的曲线守卫。
 */
export const LOOT_RARITY_CURVE = GROWTH_BUDGET.loot;

/** 装备词缀。注意：只有这四项，与伤害公式直接挂钩。 */
export const AFFIXES = Object.freeze([
  { id: 'maxHp', name: '生命', suffix: '' },
  { id: 'attack', name: '攻击', suffix: '' },
  { id: 'defense', name: '防御', suffix: '' },
  { id: 'crit', name: '暴击', suffix: '%' },
]);

/** 强化上限与费用曲线（货币为命运碎片）。 */
export const ENHANCE_MAX = 10;
export const ENHANCE_BASE_COST = 12;
export const ENHANCE_COST_RATE = 1.45;
/** 每级强化的主属性增幅（乘法）。固定值而非概率：确定性区不玩失败率。 */
export const ENHANCE_STEP_MUL = 0.08;

/** 分解回收：碎片 = 基础 × 品质下标 × (1 + 强化等级 × 0.2)。 */
export const SALVAGE_BASE = 4;

/** 背包容量。溢出时 UI 强制要求先分解。 */
export const INVENTORY_CAPACITY = 60;

/** 战斗胜利掉装备的概率（精英必掉）。 */
export const LOOT_DROP_CHANCE = 0.45;

// ============================================================
// 界面路由（阶段 9）
// ============================================================

/** 屏幕标识。路由器以此为唯一真相。 */
export const SCREEN = Object.freeze({
  MAIN_MENU: 'mainMenu',
  SAVES: 'saves',
  SETTINGS: 'settings',
  MAP: 'map',
  BATTLE: 'battle',
  SEQUENCE: 'sequence',
  EQUIPMENT: 'equipment',
  CHARACTER: 'character',
  CODEX: 'codex',
  HISTORY: 'history',
  MODS: 'mods',
});
