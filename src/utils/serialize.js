/**
 * Set/Map ↔ 存档形态互转（裁决 6）。
 * 排序是硬要求：保证同一逻辑状态序列化出的字节完全一致，存档可做哈希比对。
 */

export function setToArray(set) {
  return [...set].sort();
}

export function arrayToSet(array) {
  return new Set(array ?? []);
}

/** Map → 按键排序的二元组数组。 */
export function mapToEntries(map) {
  return [...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

export function entriesToMap(entries) {
  return new Map(entries ?? []);
}

/** 深度规范化：对象键排序，用于生成稳定的 JSON。 */
export function stableStringify(value) {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value instanceof Map) return mapToEntries(value).map(([k, v]) => [k, sortKeys(v)]);
  if (value instanceof Set) return setToArray(value);
  const out = {};
  for (const key of Object.keys(value).sort()) {
    out[key] = sortKeys(value[key]);
  }
  return out;
}
