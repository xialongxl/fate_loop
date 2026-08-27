/** 深冻结工具。用于 getSnapshot 与 state.query 契约返回只读视图。 */

/**
 * 递归冻结对象。Map/Set 无法真正冻结内部条目，故转为冻结后的副本语义：
 * 本函数只冻结容器引用本身，Map/Set 的可变方法在快照场景由调用方约定不使用。
 * 对确定性断言而言，冻结的目的是防止 UI/模组误写，而非实现完整不可变结构。
 */
export function deepFreeze(value, seen = new WeakSet()) {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return value;
  seen.add(value);

  if (value instanceof Map) {
    for (const entry of value.values()) deepFreeze(entry, seen);
    return Object.freeze(value);
  }
  if (value instanceof Set) {
    for (const entry of value.values()) deepFreeze(entry, seen);
    return Object.freeze(value);
  }
  if (Array.isArray(value)) {
    for (const entry of value) deepFreeze(entry, seen);
    return Object.freeze(value);
  }

  for (const key of Object.keys(value)) {
    deepFreeze(value[key], seen);
  }
  return Object.freeze(value);
}

/** 深克隆，支持 Map / Set / Array / 普通对象。用于快照隔离。 */
export function deepClone(value, seen = new Map()) {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return seen.get(value);

  if (value instanceof Map) {
    const out = new Map();
    seen.set(value, out);
    for (const [k, v] of value) out.set(k, deepClone(v, seen));
    return out;
  }
  if (value instanceof Set) {
    const out = new Set();
    seen.set(value, out);
    for (const v of value) out.add(deepClone(v, seen));
    return out;
  }
  if (Array.isArray(value)) {
    const out = [];
    seen.set(value, out);
    for (const v of value) out.push(deepClone(v, seen));
    return out;
  }
  // 函数保持引用（技能的 execute/condition 需要跨快照保持同一实现）
  if (typeof value === 'function') return value;

  const out = {};
  seen.set(value, out);
  for (const key of Object.keys(value)) out[key] = deepClone(value[key], seen);
  return out;
}
