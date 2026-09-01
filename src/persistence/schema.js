/**
 * 存档 schema 与序列化（裁决 6、7，阶段 8/9 扩展）。
 *
 * v2 相对 v1 的变化：
 *   - 新增 exp（等级由 exp 重算，不入存档 —— 见 derived.js 的单一数据源原则）
 *   - 新增 equipment / inventory
 *   - 新增槽位概念：3 个手动槽 + 1 个自动槽，key 为 `run:<slotId>`
 *   - 玩家属性（maxHp/attack/defense）不再入存档，读档时由 recalcPlayer 重算
 *
 * v2 内部追加的可选字段 permanentBonus（永久加成）：旧 v2 存档没有它时按全零补齐，
 * 语义恰好正确 —— 那时还没有任何能穿过重算的永久加成，因此不升 schema 版本。
 *
 * 只存探索层信息，不存战斗中间态（规格 11.2）—— 战斗输即死，中间态无保存价值。
 * Set 转已排序数组，保证同一逻辑状态序列化出的字节完全一致。
 */

import { AUTO_SAVE_SLOT, MANUAL_SAVE_SLOTS, SCHEMA_VERSION } from '../core/constants.js';
import { permanentBonusOf } from '../core/derived.js';
import { filterHashOf, filterSummary, normalizeLootFilter } from '../core/lootFilter.js';
import { setToArray } from '../utils/serialize.js';
import { FateError } from '../utils/invariant.js';

/** v1 的单存档键，仅用于启动时清理遗留数据。 */
export const LEGACY_SAVE_KEY = 'active-run';
export const HISTORY_KEY = 'history';
export const SETTINGS_KEY = 'settings';

/** 全部槽位 id，顺序即 UI 展示顺序。 */
export const SAVE_SLOT_IDS = Object.freeze([
  ...Array.from({ length: MANUAL_SAVE_SLOTS }, (_, i) => `slot${i + 1}`),
  AUTO_SAVE_SLOT,
]);

/** 槽位 id → 存储键。 */
export function slotKey(slotId) {
  return `run:${slotId}`;
}

/** 槽位是否为自动槽（自动槽不允许手动写入，只由游戏流程写）。 */
export function isAutoSlot(slotId) {
  return slotId === AUTO_SAVE_SLOT;
}

export function slotLabel(slotId) {
  return isAutoSlot(slotId) ? '自动存档' : `存档位 ${slotId.replace('slot', '')}`;
}

/** 单件装备 → 纯 JSON。stats 显式列字段，避免未来加字段时静默漏存。 */
function serializeGear(gear) {
  if (gear === null || gear === undefined) return null;
  return {
    id: gear.id,
    name: gear.name,
    slot: gear.slot,
    rarityIndex: gear.rarityIndex,
    floorNumber: gear.floorNumber,
    enhanceLevel: gear.enhanceLevel,
    stats: {
      maxHp: gear.stats.maxHp,
      attack: gear.stats.attack,
      defense: gear.stats.defense,
      crit: gear.stats.crit,
    },
    score: gear.score,
  };
}

/** 状态 → 存档（纯 JSON 可序列化）。纯函数：不含时间戳，便于对拍测试。 */
export function serializeRun(state) {
  const equipment = {};
  for (const [slot, gear] of Object.entries(state.player.equipment)) {
    equipment[slot] = serializeGear(gear);
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    seed: state.seed,
    floorNumber: state.floorNumber,
    currentNodeId: state.currentNodeId,
    startNodeId: state.startNodeId,
    exitNodeId: state.exitNodeId,
    visitedNodeIds: setToArray(state.visitedNodeIds),
    clearedNodeIds: setToArray(state.clearedNodeIds),

    // 成长：exp 是等级的唯一真相源，level 不入存档
    exp: state.player.exp,
    playerHp: state.player.hp,
    seedBonus: { ...state.player.seedBonus },
    // 永久加成（商店/事件）：不存就会被 recalcPlayer 抹掉，见 derived.js
    permanentBonus: permanentBonusOf(state.player),

    gcdSequence: [...state.player.gcdSequence],
    ogcdSlots: state.player.ogcdSlots.map((s) => ({ skillId: s.skillId, priority: s.priority })),

    equipment,
    inventory: state.player.inventory.map(serializeGear),

    /**
     * 熔炼规则（P2）。存规则本体而不是只存哈希：读档要能**恢复当时的行为**。
     * 哈希另记一份是为了在列表里一眼看出“这两份档用的不是同一套规则”。
     * 旧 v2 档缺这个字段 → normalize 兼平为「不自动熔炼」，所以不升 schema 版本。
     */
    lootFilter: normalizeLootFilter(state.lootFilter),
    lootFilterHash: filterHashOf(state.lootFilter),

    fateShards: state.fateShards,
    // 通关标记（P1-6）。老存档缺它按 false 处理：那时还没有终点层这回事
    victoryAchieved: state.victoryAchieved === true,
    /** 熔炼规则（P2）：规则会变背包→变属性→变后续战斗，所以它属于这一局的凭据 */
    lootFilter: normalizeLootFilter(state.lootFilter),
    lootFilterHash: filterHashOf(state.lootFilter),
    shopPurchases: [...state.shopStates.entries()]
      .map(([nodeId, shop]) => [nodeId, setToArray(shop.purchasedIds)])
      .sort((a, b) => (a[0] < b[0] ? -1 : 1)),
    metadata: { ...state.metadata },
  };
}

/** 存档 → 恢复参数。版本不匹配时拒读并抛错，不静默丢弃。 */
export function deserializeRun(save) {
  if (save === null || save === undefined) return null;
  if (save.schemaVersion !== SCHEMA_VERSION) {
    throw new FateError(
      `存档版本不兼容：存档为 v${String(save.schemaVersion)}，当前引擎为 v${SCHEMA_VERSION}`,
      { code: 'SAVE_VERSION_MISMATCH', details: { found: save.schemaVersion, expected: SCHEMA_VERSION } },
    );
  }
  return save;
}

/**
 * 存档摘要，供存档界面列表展示而无需完整反序列化。
 * 不抛错：版本不匹配时返回 incompatible 标记，让 UI 显示「不兼容」而非崩溃。
 */
export function summarizeSave(record) {
  if (record === null || record === undefined) return null;
  const save = record.data ?? record;
  if (save.schemaVersion !== SCHEMA_VERSION) {
    return { incompatible: true, schemaVersion: save.schemaVersion ?? null, savedAt: record.savedAt ?? null };
  }
  return {
    incompatible: false,
    savedAt: record.savedAt ?? null,
    // 存档时那一局的内容指纹（记录级字段，不在 run data 里）
    contentHash: record.contentHash ?? null,
    contentMods: record.contentMods ?? [],
    /** 熔炼规则（P2）：存档列表上能看出“这份档是开着自动熔炼打的” */
    lootFilterHash: save.lootFilterHash ?? null,
    lootFilterSummary: save.lootFilter ? filterSummary(save.lootFilter) : null,
    seed: save.seed,
    floorNumber: save.floorNumber,
    exp: save.exp ?? 0,
    fateShards: save.fateShards ?? 0,
    nodesCleared: (save.clearedNodeIds ?? []).length,
    battlesWon: save.metadata?.battlesWon ?? 0,
    victoryAchieved: save.victoryAchieved === true,
    equippedCount: Object.values(save.equipment ?? {}).filter((g) => g !== null).length,
  };
}

/** 历史记录条目（规格 11.1）。 */
export function createHistoryEntry(state, { outcome, atm = null }) {
  return {
    schemaVersion: SCHEMA_VERSION,
    seed: state.seed,
    floorReached: state.floorNumber,
    level: state.player.level,
    exp: state.player.exp,
    virtualTimeMs: state.virtualTime,
    totalDamage: state.metadata.totalDamage,
    totalHeal: state.metadata.totalHeal,
    nodesVisited: state.metadata.nodesVisited,
    nodesCleared: state.clearedNodeIds.size,
    battlesWon: state.metadata.battlesWon,
    shardsEarned: state.metadata.shardsEarned,
    expEarned: state.metadata.expEarned ?? 0,
    gearFound: state.metadata.gearFound ?? 0,
    /** 自动熔炼的账（P2）：一局熔了几件、换了多少碎片 */
    gearMelted: state.metadata.gearMelted ?? 0,
    shardsFromMelt: state.metadata.shardsFromMelt ?? 0,
    lootFilterHash: filterHashOf(state.lootFilter),
    lootFilterSummary: filterSummary(state.lootFilter),
    /**
     * ATM 当时的跳局账。记的是**结算那一刻**的余额与累计：本作第一个跳局的
     * 数值输入进来了，“同一种子”就得多一句“同一台 ATM”。不是防作弊（纯单机），
     * 而是两人对不上账、或自己换个浏览器重跑时对不上时，得有地方查。
     */
    atmBalance: atm === null || atm === undefined ? null : atm.balance,
    atmTotal: atm === null || atm === undefined ? null : atm.total,
    /** 本局是否先通关过再死在无尽里。历史界面据此标「通关后 · 无尽」。 */
    victoryAchieved: state.victoryAchieved === true,
    gcdSequence: [...state.player.gcdSequence],
    ogcdSlots: state.player.ogcdSlots.map((s) => s.skillId),
    outcome,
  };
}

/**
 * 默认设置。设置界面的字段清单以此为准。
 *
 * 每个字段都必须有消费方 —— 上一版留着 `showDamageNumbers` 但根本没画过伤害数字，
 * 那种"看着有其实没有"的选项比没有更糟，已删。
 * logLimit 只裁剪**展示**数组：state.log 的容量仍固定为 LOG_CAPACITY，
 * 否则改一个偏好就会改快照，跨速度对拍与存档比对全部失真。
 */
export function defaultSettings() {
  return {
    schemaVersion: SCHEMA_VERSION,
    muted: false,
    volume: 0.6,
    defaultSpeed: '1x',
    autoStartBattle: true,
    logLimit: 100,
  };
}
