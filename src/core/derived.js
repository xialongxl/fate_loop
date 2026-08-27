/**
 * 派生属性（阶段 8）。
 *
 * 单一数据源原则：玩家的 maxHp / attack / defense / critChance 从不手写，
 * 一律由 (等级, 装备) 重算。存档只存 exp、装备、当前 hp 三样，属性不入存档 ——
 * 这样调整成长曲线时，老存档会自动按新曲线重算，不会留下不一致的旧数值。
 *
 * 调用时机：升级、穿脱装备、强化、读档、进入战斗前。统一走 recalcPlayer。
 */

import { baseStatsAtLevel, levelFromTotalExp } from './progression.js';
import { totalEquipmentStats } from './equipment.js';

/**
 * 计算玩家的最终面板。
 * @param {object} params
 * @param {number} params.exp 累计经验
 * @param {object} params.equipment 装备栏
 * @param {object} [params.seedBonus] 种子派生的开局小幅浮动（固定值，不随等级变化）
 */
export function derivePlayerStats({ exp, equipment, seedBonus = null }) {
  const level = levelFromTotalExp(exp);
  const base = baseStatsAtLevel(level);
  const gear = totalEquipmentStats(equipment);

  const maxHp = base.maxHp + gear.maxHp + (seedBonus?.maxHp ?? 0);
  const attack = base.attack + gear.attack + (seedBonus?.attack ?? 0);
  const defense = base.defense + gear.defense + (seedBonus?.defense ?? 0);
  // 装备暴击以 0.1 百分点为单位存整数，此处换算为小数概率并封顶 75%
  const critChance = Math.min(0.75, base.critChance + gear.crit / 1000);

  return {
    level,
    maxHp: Math.max(1, Math.floor(maxHp)),
    attack: Math.max(0, Math.floor(attack)),
    defense: Math.max(0, Math.floor(defense)),
    critChance,
    breakdown: { base, gear, seedBonus: seedBonus ?? { maxHp: 0, attack: 0, defense: 0 } },
  };
}

/**
 * 把派生属性写回玩家实体（就地修改）。
 *
 * HP 处理：maxHp 上升时按「保持缺失量」而非「保持比例」补齐 —— 升级不应该
 * 因为百分比换算而凭空回血或掉血。maxHp 下降时（卸装备）夹到新上限。
 *
 * @param {object} player 状态中的玩家实体
 * @param {object} [options]
 * @param {boolean} [options.fullHeal] 是否补满（读档新局时用）
 */
export function recalcPlayer(player, { fullHeal = false } = {}) {
  const missing = Math.max(0, player.maxHp - player.hp);
  const derived = derivePlayerStats({
    exp: player.exp ?? 0,
    equipment: player.equipment,
    seedBonus: player.seedBonus ?? null,
  });

  player.level = derived.level;
  player.maxHp = derived.maxHp;
  player.attack = derived.attack;
  player.defense = derived.defense;
  player.critChance = derived.critChance;

  if (fullHeal) {
    player.hp = derived.maxHp;
  } else {
    player.hp = Math.max(1, Math.min(derived.maxHp, derived.maxHp - missing));
  }

  return derived;
}
