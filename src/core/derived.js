/**
 * 派生属性（阶段 8）。
 *
 * 单一数据源原则：玩家的 maxHp / attack / defense / critChance 从不手写，
 * 一律由 (等级, 装备, 种子浮动, 永久加成) 重算。存档只存 exp、装备、当前 hp
 * 与 permanentBonus 四样，属性不入存档 ——
 * 这样调整成长曲线时，老存档会自动按新曲线重算，不会留下不一致的旧数值。
 *
 * 推论（阶段 6 遗留缺陷的根因）：任何「永久提升」都必须写进 permanentBonus，
 * 直接给 player.maxHp / attack / defense 加数值只是幻觉，下一次重算就蒸发。
 * 用 addPermanentBonus() 而不是手改字段。
 *
 * 调用时机：升级、穿脱装备、强化、商店消费、事件结算、读档、进入战斗前。统一走 recalcPlayer。
 */

import { baseStatsAtLevel, levelFromTotalExp } from './progression.js';
import { totalEquipmentStats } from './equipment.js';

/** permanentBonus 的字段清单。新增可永久成长的属性时只改这里。 */
export const PERMANENT_BONUS_FIELDS = Object.freeze(['maxHp', 'attack', 'defense', 'crit']);

/** 空的永久加成。读旧存档缺字段时的兜底值。 */
export function emptyPermanentBonus() {
  return { maxHp: 0, attack: 0, defense: 0, crit: 0 };
}

/** 读出一名玩家的永久加成（缺字段按 0 补齐，不返回 undefined）。 */
export function permanentBonusOf(player) {
  const source = player?.permanentBonus ?? emptyPermanentBonus();
  const out = emptyPermanentBonus();
  for (const field of PERMANENT_BONUS_FIELDS) {
    const value = source[field];
    out[field] = Number.isFinite(value) ? Math.trunc(value) : 0;
  }
  return out;
}

/**
 * 施加一项永久加成（就地修改），返回规范化后的对象。
 *
 * 允许负值（「狂徒之刃」用生命上限换攻击）。crit 与装备词缀同量纲：
 * 以 0.1 个百分点为单位存整数，避免浮点累积破坏跨速度对拍。
 *
 * @param {object} player 状态中的玩家实体
 * @param {object} bonus 要累加的量，如 { maxHp: 60 }
 */
export function addPermanentBonus(player, bonus) {
  const current = permanentBonusOf(player);
  for (const field of PERMANENT_BONUS_FIELDS) {
    const value = bonus?.[field];
    if (Number.isFinite(value)) current[field] += Math.trunc(value);
  }
  player.permanentBonus = current;
  return current;
}

/**
 * 计算玩家的最终面板。
 * @param {object} params
 * @param {number} params.exp 累计经验
 * @param {object} params.equipment 装备栏
 * @param {object} [params.seedBonus] 种子派生的开局小幅浮动（固定值，不随等级变化）
 * @param {object} [params.permanentBonus] 商店/事件给的永久加成（可与 seedBonus 同为负）
 */
export function derivePlayerStats({ exp, equipment, seedBonus = null, permanentBonus = null }) {
  const level = levelFromTotalExp(exp);
  const base = baseStatsAtLevel(level);
  const gear = totalEquipmentStats(equipment);
  const bonus = { ...emptyPermanentBonus(), ...(permanentBonus ?? null) };

  const maxHp = base.maxHp + gear.maxHp + (seedBonus?.maxHp ?? 0) + bonus.maxHp;
  const attack = base.attack + gear.attack + (seedBonus?.attack ?? 0) + bonus.attack;
  const defense = base.defense + gear.defense + (seedBonus?.defense ?? 0) + bonus.defense;
  // 装备暴击以 0.1 百分点为单位存整数，此处换算为小数概率并封顶 75%
  const critChance = Math.min(0.75, base.critChance + (gear.crit + bonus.crit) / 1000);

  return {
    level,
    maxHp: Math.max(1, Math.floor(maxHp)),
    attack: Math.max(0, Math.floor(attack)),
    defense: Math.max(0, Math.floor(defense)),
    critChance,
    breakdown: {
      base,
      gear,
      seedBonus: seedBonus ?? { maxHp: 0, attack: 0, defense: 0 },
      permanentBonus: bonus,
    },
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
    permanentBonus: player.permanentBonus ?? null,
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
