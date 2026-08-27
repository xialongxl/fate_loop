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

    fateShards: state.fateShards,
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
    seed: save.seed,
    floorNumber: save.floorNumber,
    exp: save.exp ?? 0,
    fateShards: save.fateShards ?? 0,
    nodesCleared: (save.clearedNodeIds ?? []).length,
    battlesWon: save.metadata?.battlesWon ?? 0,
    equippedCount: Object.values(save.equipment ?? {}).filter((g) => g !== null).length,
  };
}

/** 历史记录条目（规格 11.1）。 */
export function createHistoryEntry(state, { outcome }) {
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
    gcdSequence: [...state.player.gcdSequence],
    ogcdSlots: state.player.ogcdSlots.map((s) => s.skillId),
    outcome,
  };
}

/** 默认设置。设置界面的字段清单以此为准。 */
export function defaultSettings() {
  return {
    schemaVersion: SCHEMA_VERSION,
    muted: false,
    volume: 0.6,
    defaultSpeed: '1x',
    autoStartBattle: true,
    showDamageNumbers: true,
    logLimit: 100,
  };
}
