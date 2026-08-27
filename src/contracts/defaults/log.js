/**
 * combat.log 契约实现。
 * 定长裁剪至 LOG_CAPACITY（规格 8.2 环形缓冲的等价语义）。
 * 每条日志附 virtualTime，便于 UI 展示时间轴。
 */

import { LOG_CAPACITY } from '../../core/constants.js';

/** 引擎内部也用这个函数写日志，保证格式统一。 */
export function pushLog(state, message) {
  state.log.push({ t: state.virtualTime, message });
  if (state.log.length > LOG_CAPACITY) {
    state.log.splice(0, state.log.length - LOG_CAPACITY);
  }
}

export function createCombatLog({ store }) {
  return function combatLog(message) {
    pushLog(store.unsafeGetState(), String(message));
  };
}
