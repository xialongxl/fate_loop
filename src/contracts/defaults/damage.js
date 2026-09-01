/**
 * damage.apply 契约实现。
 *
 * 伤害公式（纯整数输出，确定性）：
 *   attack    = amount * 攻击方 damageDealtMul
 *   mitigated = attack * 100 / (100 + effectiveDefense)   // 防御按递减收益减伤
 *   taken     = mitigated * 受击方 damageTakenMul
 *   final     = round(taken * (暴击 ? CRIT_MULTIPLIER : 1))
 *   final     = max(1, final)                              // 至少造成 1 点
 *
 * Buff 修正在伤害结算时惰性查表，而不是写回实体属性 —— 写回会让
 * Buff 到期时需要反向撤销，而反向撤销在浮点下不可逆（a*1.1/1.1 !== a）。
 *
 * 暴击判定消费一次战斗流随机数。只有 canCrit 为真时才消费 —— 这条很重要：
 * 是否消费随机数必须完全由输入决定，否则相同输入会产生不同的后续随机序列。
 */

import { CRIT_MULTIPLIER } from '../../core/constants.js';
import { resolveModifiers } from '../../core/buffs.js';
import { ContractViolationError } from '../../utils/invariant.js';

const DEFAULT_CRIT_CHANCE = 0.15;

export function createDamageApply({ store, getRng, findEntity, pushLog, getBuffTable }) {
  return function damageApply({ sourceId, targetId, amount, canCrit = true, critChance }) {
    if (!Number.isFinite(amount)) {
      throw new ContractViolationError('damage.apply 的 amount 必须是有限数', { sourceId, targetId, amount });
    }

    const state = store.unsafeGetState();
    const target = findEntity(state, targetId);
    if (target === null) {
      throw new ContractViolationError(`damage.apply 找不到目标实体 ${targetId}`, { targetId });
    }

    // 已死亡目标不再受击，且不消费随机数
    if (target.hp <= 0) {
      return { dealt: 0, isCrit: false, targetHp: 0, lethal: false };
    }

    // findEntity 不消费随机数，因此提到暴击判定之前不改变随机序列。
    // 暴击率优先级：显式入参 > 源实体的 critChance（等级 + 装备派生）> 默认 15%。
    const source = findEntity(state, sourceId);

    let isCrit = false;
    if (canCrit) {
      const chance = Number.isFinite(critChance)
        ? critChance
        : (source?.critChance ?? DEFAULT_CRIT_CHANCE);
      isCrit = getRng().next() < chance;
    }

    const buffTable = getBuffTable?.() ?? undefined;
    const now = state.virtualTime;

    const sourceMods = source === null ? null : resolveModifiers(source, buffTable, now);
    const targetMods = resolveModifiers(target, buffTable, now);

    const boosted = amount * (sourceMods?.damageDealtMul ?? 1);
    const defense = Math.max(0, Math.round(target.defense * targetMods.defenseMul));
    const mitigated = (boosted * 100) / (100 + defense);
    const taken = mitigated * targetMods.damageTakenMul;
    const scaled = isCrit ? taken * CRIT_MULTIPLIER : taken;
    const dealt = Math.max(1, Math.round(scaled));

    const before = target.hp;
    target.hp = Math.max(0, before - dealt);
    const actual = before - target.hp;

    target.stats.damageTaken += actual;
    state.metadata.totalDamage += actual;

    if (source !== null) source.stats.damageDealt += actual;

    const lethal = target.hp === 0;
    pushLog(
      state,
      `${source?.name ?? sourceId} 对 ${target.name} 造成 ${actual} 点伤害${isCrit ? '（暴击）' : ''}${
        lethal ? ' — 击杀' : ''
      }`,
    );

    return { dealt: actual, isCrit, targetHp: target.hp, lethal };
  };
}
