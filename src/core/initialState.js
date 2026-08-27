/**
 * 初始状态构造（规格 5.1，阶段 8 扩展成长与装备）。
 *
 * 玩家属性的单一数据源是 (exp, equipment, seedBonus, permanentBonus)：createPlayer 只负责
 * 定义 seedBonus 与初始装备，最终面板由 derived.js#recalcPlayer 算出。
 * 这样调整成长曲线时不需要迁移存档，重算即可。
 *
 * 注意：日志用普通数组 + 定长裁剪，而非 RingBuffer 类（utils/ringBuffer.js 曾存在，
 * 因下述原因已删）。原因是状态要被 deepClone 做快照，
 * 带私有字段的类实例无法被通用克隆正确复制。
 */

import { FACTION, GAME_STATUS } from './constants.js';
import { playerStream } from './prng.js';
import { createEntity } from './entity.js';
import { createEmptyEquipment } from './equipment.js';
import { emptyPermanentBonus, recalcPlayer } from './derived.js';

/**
 * 玩家初始构造。
 *
 * seedBonus 是种子驱动的开局小幅浮动，一经生成就固定不变（不随等级缩放）——
 * 让不同种子的开局手感略有差异，但不至于形成强弱鸿沟。
 */
export function createPlayer(seed, { gcdSequence = [], ogcdSlots = [], exp = 0, equipment = null } = {}) {
  const rng = playerStream(seed);
  const seedBonus = {
    maxHp: rng.nextRange(0, 8) * 5, // 0 ~ 40
    attack: rng.nextRange(0, 4), // 0 ~ 4
    defense: rng.nextRange(0, 2), // 0 ~ 2
  };

  const player = createEntity({
    id: 'player',
    name: '序列编织者',
    faction: FACTION.PLAYER,
    // 占位值，立刻被 recalcPlayer 覆盖。createEntity 要求正整数，故不能给 0
    maxHp: 1,
    attack: 0,
    defense: 0,
    gcdSequence,
    ogcdSlots,
  });

  player.exp = exp;
  player.level = 1;
  player.seedBonus = seedBonus;
  /** 永久加成（商店/事件给予）。与 seedBonus 同级参与派生，否则会被 recalc 抹掉。 */
  player.permanentBonus = emptyPermanentBonus();
  player.equipment = equipment ?? createEmptyEquipment();
  /** 背包：未穿戴的装备。 */
  player.inventory = [];

  recalcPlayer(player, { fullHeal: true });
  return player;
}

/**
 * @param {number} seed 32 位主种子
 * @param {object} [options]
 * @param {string[]} [options.gcdSequence] 初始 GCD 序列
 * @param {Array} [options.ogcdSlots] 初始 oGCD 槽位
 */
export function createInitialState(seed, options = {}) {
  return {
    seed,
    virtualTime: 0,
    status: GAME_STATUS.IDLE,
    winner: null,

    player: createPlayer(seed, options),
    monsters: [],

    // 探索
    floorNumber: 1,
    mapNodes: [],
    mapAdjacency: {},
    currentNodeId: null,
    exitNodeId: null,
    startNodeId: null,
    gridWidth: 0,
    gridHeight: 0,
    visitedNodeIds: new Set(),
    clearedNodeIds: new Set(),

    // 经济（决定 A）
    fateShards: 0,
    /** Map<nodeId, { offers:Array, purchasedIds:Set }> 商店状态按节点持久 */
    shopStates: new Map(),

    // 当前战斗上下文：{ nodeId, attemptIndex, isElite }
    activeBattle: null,
    /** 上一场战斗的结算摘要（经验、碎片、掉落），供战斗界面展示 */
    lastBattleReward: null,

    // 统计
    metadata: {
      totalDamage: 0,
      totalHeal: 0,
      emptyLoops: 0,
      floorsCleared: 0,
      nodesVisited: 0,
      battlesWon: 0,
      shardsEarned: 0,
      expEarned: 0,
      gearFound: 0,
    },

    /** 战斗日志，定长裁剪至 LOG_CAPACITY。 */
    log: [],
    error: null,
  };
}
