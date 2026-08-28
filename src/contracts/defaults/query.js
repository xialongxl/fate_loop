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
        if (cursor instanceof Map) {
          cursor = cursor.get(key);
        } else if (Array.isArray(cursor)) {
          // 数组只支持数字下标。**不要试图按 id 走路径**：实体 id 含点
          // （'mon.thunder.herald.t1#0'），会被 split('.') 切碎，永远取不到。
          // 按 id 取实体请用 ctx.entity(id)。
          const byIndex = Number(key);
          cursor = Number.isInteger(byIndex) ? cursor[byIndex] : undefined;
        } else {
          cursor = cursor[key];
        }
      }
      return deepFreeze(deepClone(cursor));
    }

    throw new ContractViolationError('state.query 的选择器必须是字符串路径或函数', { selector });
  };
}
