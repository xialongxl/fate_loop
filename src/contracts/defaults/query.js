/**
 * state.query 契约实现。
 * 返回深冻结只读视图：模组可以读任意状态，但写入会被冻结阻断（严格模式下抛错）。
 */

import { deepClone, deepFreeze } from '../../utils/deepFreeze.js';
import { ContractViolationError } from '../../utils/invariant.js';

export function createStateQuery({ store }) {
  return function stateQuery(selector) {
    const state = store.unsafeGetState();

    if (selector === undefined || selector === null) {
      return deepFreeze(deepClone(state));
    }

    if (typeof selector === 'function') {
      return deepFreeze(deepClone(selector(state)));
    }

    if (typeof selector === 'string') {
      let cursor = state;
      for (const key of selector.split('.')) {
        if (cursor === null || cursor === undefined) return undefined;
        cursor = cursor instanceof Map ? cursor.get(key) : cursor[key];
      }
      return deepFreeze(deepClone(cursor));
    }

    throw new ContractViolationError('state.query 的选择器必须是字符串路径或函数', { selector });
  };
}
