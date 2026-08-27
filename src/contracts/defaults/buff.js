/**
 * buff.apply 契约实现（裁决 1：存绝对到期时间戳）。
 *
 * 叠层规则：同 buffId 累加层数并刷新到期时间。刷新而非延长，符合常规 Buff 语义
 * 且避免无限累积。
 */

import { ContractViolationError, assertNonNegativeInteger } from '../../utils/invariant.js';
import { STEP_MS } from '../../core/constants.js';

export function createBuffApply({ store, findEntity, pushLog, getBuffTable }) {
  return function buffApply({ targetId, buffId, stacks = 1, durationMs, maxStacks = 99 }) {
    if (typeof buffId !== 'string' || buffId === '') {
      throw new ContractViolationError('buff.apply 需要非空 buffId', { targetId, buffId });
    }
    assertNonNegativeInteger(durationMs, 'buff.apply 的 durationMs');
    if (durationMs % STEP_MS !== 0) {
      throw new ContractViolationError(
        `buff.apply 的 durationMs 必须是 ${STEP_MS} 的整数倍，实际为 ${durationMs}`,
        { buffId, durationMs },
      );
    }

    const state = store.unsafeGetState();
    const target = findEntity(state, targetId);
    if (target === null) {
      throw new ContractViolationError(`buff.apply 找不到目标实体 ${targetId}`, { targetId });
    }

    const existing = target.buffs.get(buffId);
    const isActive = existing !== undefined && state.virtualTime < existing.expiresAtMs;
    const nextStacks = Math.min(maxStacks, (isActive ? existing.stacks : 0) + stacks);

    target.buffs.set(buffId, {
      stacks: nextStacks,
      expiresAtMs: state.virtualTime + durationMs,
    });

    // 日志面向玩家，必须用模组声明的显示名，不能括出 buffId 这种内部键。
    // 取不到定义时法定回退到 buffId，但加载期的引用校验已经堆死了这条路径。
    const definition = getBuffTable?.()?.get(buffId);
    const label = definition?.name ?? buffId;
    const verb = definition?.isDebuff === true ? '受到' : '获得';
    const suffix = nextStacks > 1 ? `（${nextStacks} 层）` : '';
    pushLog(state, `${target.name} ${verb} ${label}${suffix}`);
  };
}
