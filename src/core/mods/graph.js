/**
 * 模组依赖图：循环检测 + Kahn 拓扑排序（规格 9.2 步骤 2~4）。
 *
 * 依赖以 Symbol 表达：模组 A 的 requires 必须由某个模组的 provides 满足。
 */

import { ModLoadError } from '../../utils/invariant.js';

/**
 * @param {Array<{id:string, provides:symbol[], requires:symbol[], path:string}>} manifests
 * @returns {Array<{id:string, path:string}>} 拓扑排序后的模组
 */
export function topoSort(manifests) {
  // provides → 模组 id
  const providerOf = new Map();
  for (const manifest of manifests) {
    for (const symbol of manifest.provides) {
      if (providerOf.has(symbol)) {
        throw new ModLoadError(
          `契约 ${String(symbol.description ?? symbol)} 被多个模组 provide：${providerOf.get(symbol)} 与 ${manifest.id}`,
          { symbol: String(symbol.description ?? symbol) },
        );
      }
      providerOf.set(symbol, manifest.id);
    }
  }

  const byId = new Map(manifests.map((m) => [m.id, m]));
  const edges = new Map(manifests.map((m) => [m.id, new Set()]));
  const inDegree = new Map(manifests.map((m) => [m.id, 0]));

  for (const manifest of manifests) {
    for (const symbol of manifest.requires) {
      const provider = providerOf.get(symbol);
      if (provider === undefined) {
        throw new ModLoadError(
          `模组 ${manifest.id} 依赖的契约 ${String(symbol.description ?? symbol)} 无人提供`,
          { modId: manifest.id, missing: String(symbol.description ?? symbol) },
        );
      }
      if (provider === manifest.id) continue;
      if (edges.get(provider).has(manifest.id)) continue;
      edges.get(provider).add(manifest.id);
      inDegree.set(manifest.id, inDegree.get(manifest.id) + 1);
    }
  }

  // Kahn：入度为 0 的按 id 字典序入队，保证同层顺序确定
  const queue = [...inDegree.entries()]
    .filter(([, degree]) => degree === 0)
    .map(([id]) => id)
    .sort();

  const sorted = [];
  while (queue.length > 0) {
    const id = queue.shift();
    sorted.push(byId.get(id));
    const nextIds = [...edges.get(id)].sort();
    for (const next of nextIds) {
      const degree = inDegree.get(next) - 1;
      inDegree.set(next, degree);
      if (degree === 0) {
        queue.push(next);
        queue.sort();
      }
    }
  }

  if (sorted.length !== manifests.length) {
    const cyclic = manifests.filter((m) => !sorted.includes(m)).map((m) => m.id);
    throw new ModLoadError(`模组依赖存在循环：${cyclic.join(' → ')}`, { cyclic });
  }

  return sorted;
}

/**
 * 按加载优先级重排：mods/dev 始终排到最后（规格 9.2 步骤 6）。
 * 在拓扑序内做稳定分区，不破坏依赖顺序。
 */
export function applyPriority(sorted) {
  const isDev = (m) => m.path.includes('/mods/dev/');
  return [...sorted.filter((m) => !isDev(m)), ...sorted.filter(isDev)];
}
