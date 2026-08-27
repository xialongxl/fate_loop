/**
 * 战利品生成（阶段 8）。
 *
 * 随机流选择：用遭遇流的 `${nodeId}:loot` 派生，而不是战斗流。
 *
 * 理由：战斗流的消费量取决于战斗过程（暴击次数、randomEnemy 次数），
 * 若掉落也从战斗流取数，掉落结果就会与「战斗打了多少步」耦合。用遭遇流
 * 按 nodeId 独立派生后，同一节点的掉落在任何情况下恒定 —— 与裁决 2 对
 * 商店/遭遇的处理一致。
 */

import { LOOT_DROP_CHANCE, RARITIES } from './constants.js';
import { encounterStream } from './prng.js';
import { rollEquipment } from './equipment.js';

/**
 * 为一场胜利的战斗生成掉落。
 *
 * @param {object} params
 * @param {number} params.seed
 * @param {number} params.floorNumber
 * @param {string} params.nodeId
 * @param {boolean} params.isElite 精英必掉且品质有下限
 * @returns {Array<object>} 装备数组，可能为空
 */
export function rollBattleLoot({ seed, floorNumber, nodeId, isElite }) {
  const rng = encounterStream(seed, floorNumber, `${nodeId}:loot`);

  if (!isElite && !rng.chance(LOOT_DROP_CHANCE)) return [];

  // 精英掉 2 件且品质不低于「精良」（下标 2）；普通掉 1 件无下限
  const count = isElite ? 2 : 1;
  const minRarity = isElite ? 2 : 0;
  const drops = [];

  for (let i = 0; i < count; i += 1) {
    drops.push(
      rollEquipment({
        rng,
        floorNumber,
        idSuffix: `${floorNumber}.${nodeId}.${i}`,
        minRarity,
      }),
    );
  }

  return drops;
}

/**
 * 商店售卖的装备。
 * 与商店商品共用 `${nodeId}:shop` 之外的独立派生键，避免两者互相影响消费序列。
 */
export function rollShopGear({ seed, floorNumber, nodeId, index }) {
  const rng = encounterStream(seed, floorNumber, `${nodeId}:shopgear:${index}`);
  // 商店货至少「精良」，否则花碎片买破损装备毫无意义
  return rollEquipment({
    rng,
    floorNumber,
    idSuffix: `shop.${floorNumber}.${nodeId}.${index}`,
    minRarity: 2,
  });
}

/** 装备的建议售价（碎片）。品质越高越贵，随层数缓涨。 */
export function gearPrice(gear) {
  const rarity = RARITIES[gear.rarityIndex] ?? RARITIES[0];
  return Math.max(8, Math.floor(rarity.mult * 18 + Math.sqrt(gear.floorNumber) * 6));
}
