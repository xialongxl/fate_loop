/**
 * Buff 效果解析（规格 5.2 的补全）。
 *
 * 设计取舍：Buff 只做「乘数修正」，不做持续伤害（DOT）。
 * DOT 需要每逻辑步 tick，会引入"tick 时机依赖步长"的确定性风险，
 * 而乘数修正是纯查表 —— 任何步长下读到的结果都一样。
 * 想要 DOT 效果的模组可以用高层数的易伤 debuff 近似表达。
 *
 * Buff 定义本身属于模组内容（pool.buffs），核心只提供解析逻辑。
 */

/** 无任何修正时的中性结果。复用同一冻结对象避免重复分配。 */
export const NEUTRAL_MODIFIERS = Object.freeze({
  attackMul: 1,
  defenseMul: 1,
  damageTakenMul: 1,
  damageDealtMul: 1,
  healMul: 1,
});

/**
 * 解析实体当前所有在场 Buff 的合并修正。
 *
 * 多个 Buff 的同类修正取乘积；层数以线性方式叠加进单个 Buff 的修正
 * （`1 + (mul - 1) * stacks`），这样 2 层 1.1 倍 = 1.2 倍而非 1.21 倍，
 * 对玩家更直观也更好配平。
 *
 * @param {object} entity
 * @param {Map<string, object>} buffTable 模组注册的 Buff 定义表
 * @param {number} virtualTime
 */
export function resolveModifiers(entity, buffTable, virtualTime) {
  if (entity.buffs.size === 0 || buffTable === undefined) return NEUTRAL_MODIFIERS;

  let attackMul = 1;
  let defenseMul = 1;
  let damageTakenMul = 1;
  let damageDealtMul = 1;
  let healMul = 1;
  let touched = false;

  // 按 buffId 排序遍历：浮点乘法不满足交换律，顺序必须确定
  const ids = [...entity.buffs.keys()].sort();
  for (const buffId of ids) {
    const buff = entity.buffs.get(buffId);
    if (virtualTime >= buff.expiresAtMs) continue;

    const definition = buffTable.get(buffId);
    if (definition === undefined) continue;

    touched = true;
    const n = buff.stacks;
    if (definition.attackMul !== undefined) {
      attackMul *= 1 + (definition.attackMul - 1) * n;
    }
    if (definition.defenseMul !== undefined) {
      defenseMul *= 1 + (definition.defenseMul - 1) * n;
    }
    if (definition.damageTakenMul !== undefined) {
      damageTakenMul *= 1 + (definition.damageTakenMul - 1) * n;
    }
    if (definition.damageDealtMul !== undefined) {
      damageDealtMul *= 1 + (definition.damageDealtMul - 1) * n;
    }
    if (definition.healMul !== undefined) {
      healMul *= 1 + (definition.healMul - 1) * n;
    }
  }

  if (!touched) return NEUTRAL_MODIFIERS;

  // 下限保护：修正后不得出现负数或零倍率（会让伤害公式失去意义）
  return {
    attackMul: Math.max(0.05, attackMul),
    defenseMul: Math.max(0.05, defenseMul),
    damageTakenMul: Math.max(0.05, damageTakenMul),
    damageDealtMul: Math.max(0.05, damageDealtMul),
    healMul: Math.max(0, healMul),
  };
}

/** 实体的有效攻击力（含 Buff 修正，取整）。 */
export function effectiveAttack(entity, buffTable, virtualTime) {
  const mods = resolveModifiers(entity, buffTable, virtualTime);
  return Math.max(0, Math.round(entity.attack * mods.attackMul));
}

/** 实体的有效防御力（含 Buff 修正，取整）。 */
export function effectiveDefense(entity, buffTable, virtualTime) {
  const mods = resolveModifiers(entity, buffTable, virtualTime);
  return Math.max(0, Math.round(entity.defense * mods.defenseMul));
}
