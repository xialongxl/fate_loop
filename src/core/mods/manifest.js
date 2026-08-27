/** manifest 结构校验（规格 9.1）。 */

import { ModLoadError } from '../../utils/invariant.js';

const VALID_TYPES = new Set(['content', 'system']);

/**
 * @param {object} raw manifest 默认导出
 * @param {string} path 模组文件路径，用于错误定位与优先级判定
 */
export function validateManifest(raw, path) {
  if (raw === null || typeof raw !== 'object') {
    throw new ModLoadError(`模组 manifest 必须默认导出对象：${path}`, { path });
  }
  if (typeof raw.id !== 'string' || raw.id === '') {
    throw new ModLoadError(`模组 manifest 缺少非空 id：${path}`, { path });
  }
  if (typeof raw.version !== 'string' || raw.version === '') {
    throw new ModLoadError(`模组 ${raw.id} 缺少 version`, { path, id: raw.id });
  }
  const type = raw.type ?? 'content';
  if (!VALID_TYPES.has(type)) {
    throw new ModLoadError(`模组 ${raw.id} 的 type 非法：${String(type)}`, { path, id: raw.id });
  }

  const provides = raw.provides ?? [];
  const requires = raw.requires ?? [];
  for (const [label, list] of [
    ['provides', provides],
    ['requires', requires],
  ]) {
    if (!Array.isArray(list)) {
      throw new ModLoadError(`模组 ${raw.id} 的 ${label} 必须是数组`, { path, id: raw.id });
    }
    for (const item of list) {
      if (typeof item !== 'symbol') {
        throw new ModLoadError(`模组 ${raw.id} 的 ${label} 只能包含 Symbol`, { path, id: raw.id });
      }
    }
  }

  return { id: raw.id, version: raw.version, type, provides, requires, path };
}
