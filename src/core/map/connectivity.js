/** 连通性校验与最远点查找（规格 6.2 第五步）。 */

import { MapGenerationError } from '../../utils/invariant.js';

/** BFS 可达集合。 */
export function reachableFrom(startId, adjacency) {
  const seen = new Set([startId]);
  const queue = [startId];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const next of adjacency[current] ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return seen;
}

/** BFS 距离表。 */
export function distancesFrom(startId, adjacency) {
  const dist = new Map([[startId, 0]]);
  const queue = [startId];
  while (queue.length > 0) {
    const current = queue.shift();
    const d = dist.get(current);
    for (const next of adjacency[current] ?? []) {
      if (dist.has(next)) continue;
      dist.set(next, d + 1);
      queue.push(next);
    }
  }
  return dist;
}

/**
 * 距起点最远的节点。距离相同时取 ID 字典序最小者，保证确定性。
 */
export function farthestNodeFrom(startId, adjacency) {
  const dist = distancesFrom(startId, adjacency);
  let best = null;
  let bestDistance = -1;
  for (const [id, d] of [...dist.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (d > bestDistance) {
      best = id;
      bestDistance = d;
    }
  }
  return best;
}

/**
 * 起点到出口必须连通，且可通行集内不得存在孤岛（规格 6.2 第五步）。
 *
 * requiredIds 必须显式传入：默认取 adjacency 的全部键会误判。
 * 死路节点是有意设计的单向可见节点（玩家能看到它但进不去），
 * 它们列出邻居但不被邻居列出，因此天然不在 BFS 可达集内。
 *
 * @param {Set<string>|string[]} [requiredIds] 必须可达的节点集（可通行节点）
 */
export function assertConnected(startId, exitId, adjacency, context = {}, requiredIds = null) {
  const reachable = reachableFrom(startId, adjacency);
  if (!reachable.has(exitId)) {
    throw new MapGenerationError('起点无法到达出口', { ...context, startId, exitId });
  }
  const required = requiredIds === null ? Object.keys(adjacency) : [...requiredIds];
  const orphans = required.filter((id) => !reachable.has(id));
  if (orphans.length > 0) {
    throw new MapGenerationError(`存在 ${orphans.length} 个孤岛节点`, { ...context, orphans: orphans.slice(0, 8) });
  }
  return true;
}

/**
 * 删除 candidate 后，剩余集合是否仍从 startId 全连通。
 * 用于死路选取的贪心校验 —— 把一个度大于 1 的节点变成死路可能切断地图。
 *
 * @param {Set<string>} passable 当前可通行集（不包含 candidate）
 * @param {(id:string)=>string[]} neighborsOf 网格四方向邻居（含不可通行者）
 */
export function staysConnectedWithout(startId, passable, neighborsOf) {
  if (!passable.has(startId)) return false;
  const seen = new Set([startId]);
  const queue = [startId];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const next of neighborsOf(current)) {
      if (!passable.has(next) || seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return seen.size === passable.size;
}
