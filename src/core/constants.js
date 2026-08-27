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

/** 地图视口缩放范围（规格 6.5）。 */
export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 2.0;

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

/** 每级成长。crit 单位为百分点。 */
export const GROWTH_PER_LEVEL = Object.freeze({
  maxHp: 28,
  attack: 6,
  defense: 4,
  crit: 0.25,
});

/** 玩家 1 级基线（种子浮动在 initialState 中叠加）。 */
export const PLAYER_BASE = Object.freeze({
  maxHp: 320,
  attack: 34,
  defense: 8,
  critChance: 0.05,
});

/** 战斗胜利经验：每只怪物基础值 × 层数缩放，精英双倍。 */
export const EXP_REWARD = Object.freeze({
  PER_MONSTER: 18,
  FLOOR_SCALE: 0.35,
  ELITE_MULTIPLIER: 2,
});

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
 * 品质六档。mult 为主属性倍率，cls 是 CSS 品质色类名。
 * 比 Fate_echo 的九档收束：本作无抽卡，掉落源少，六档已够拉开差异。
 */
export const RARITIES = Object.freeze([
  { id: 'worn', name: '破损', mult: 0.6, cls: 'q0', weight: 220, affixMax: 0, orbSlots: 0 },
  { id: 'common', name: '普通', mult: 1.0, cls: 'q1', weight: 400, affixMax: 1, orbSlots: 0 },
  { id: 'fine', name: '精良', mult: 1.5, cls: 'q2', weight: 240, affixMax: 2, orbSlots: 1 },
  { id: 'superb', name: '卓越', mult: 2.3, cls: 'q3', weight: 100, affixMax: 3, orbSlots: 1 },
  { id: 'epic', name: '史诗', mult: 3.6, cls: 'q4', weight: 33, affixMax: 4, orbSlots: 2 },
  { id: 'legend', name: '传说', mult: 6.0, cls: 'q5', weight: 7, affixMax: 5, orbSlots: 3 },
]);

/** 装备词缀。注意：只有这四项，与伤害公式直接挂钩。 */
export const AFFIXES = Object.freeze([
  { id: 'maxHp', name: '生命', suffix: '' },
  { id: 'attack', name: '攻击', suffix: '' },
  { id: 'defense', name: '防御', suffix: '' },
  { id: 'crit', name: '暂击', suffix: '%' },
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
});
