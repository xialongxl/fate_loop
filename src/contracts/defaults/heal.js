/**
 * heal.apply 契约实现。
 * 溢出治疗不计入统计（healed 为实际生效量），死亡目标不可被治疗。
 * 治疗量受受治方 healMul 修正（例如重伤类 debuff 可以减治）。
 */

import { resolveModifiers } from '../../core/buffs.js';
import { ContractViolationError } from '../../utils/invariant.js';

export function createHealApply({ store, findEntity, pushLog, getBuffTable }) {
  return function healApply({ sourceId, targetId, amount }) {
    if (!Number.isFinite(amount) || amount < 0) {
      throw new ContractViolationError('heal.apply 的 amount 必须是非负有限数', { sourceId, targetId, amount });
    }

    const state = store.unsafeGetState();
    const target = findEntity(state, targetId);
    if (target === null) {
      throw new ContractViolationError(`heal.apply 找不到目标实体 ${targetId}`, { targetId });
    }
    if (target.hp <= 0) {
      return { healed: 0, targetHp: 0 };
    }

    const mods = resolveModifiers(target, getBuffTable?.() ?? undefined, state.virtualTime);
    const before = target.hp;
    target.hp = Math.min(target.maxHp, before + Math.round(amount * mods.healMul));
    const healed = target.hp - before;

    state.metadata.totalHeal += healed;
    const source = findEntity(state, sourceId);
    if (source !== null) source.stats.healDone += healed;

    if (healed > 0) {
      // 自疗时不重复报名，否则日志是“X 为 X 恢复”
      const sourceName = source?.name ?? sourceId;
      pushLog(
        state,
        source === target
          ? `${target.name} 恢复了 ${healed} 点生命`
          : `${sourceName} 为 ${target.name} 恢复 ${healed} 点生命`,
      );
    }

    return { healed, targetHp: target.hp };
  };
}
