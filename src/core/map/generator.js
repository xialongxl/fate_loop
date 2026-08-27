/**
 * 网格化地图生成（规格 6.2，黑流树海风格）。
 *
 * 确定性来源：mapStream(seed, floorNumber)，与遭遇流/战斗流完全隔离（裁决 2），
 * 因此玩家的探索顺序不会影响任何一层的布局。
 *
 * 五步法：
 *   1. 网格尺寸 8×8 ~ 14×14
 *   2. 起点置于中央偏下（60%~70% 高度）
 *   3. 从起点 BFS 式随机延伸，延伸概率随距离递减（近密远疏）
 *   4. 节点类型按权重分配（决定 B 补齐至 100%）
 *   5. 连通性校验 + 出口选取（最远点）
 */

import {
  DEAD_END_RATIO,
  GRID_MAX,
  GRID_MIN,
  MAP_GENERATION_STEP_LIMIT,
  NODE_TYPE,
  NODE_TYPE_WEIGHTS,
} from '../constants.js';
import { mapStream } from '../prng.js';
import { MapGenerationError } from '../../utils/invariant.js';
import { buildAdjacency } from './adjacency.js';
import {
  assertConnected,
  farthestNodeFrom,
  reachableFrom,
  staysConnectedWithout,
} from './connectivity.js';

const DIRECTIONS = Object.freeze([
  { dx: 0, dy: -1 },
  { dx: 1, dy: 0 },
  { dx: 0, dy: 1 },
  { dx: -1, dy: 0 },
]);

function nodeId(x, y) {
  return `node_${x}_${y}`;
}

/** 节点显示名池，按类型取用。纯风味，不影响逻辑。 */
const DISPLAY_NAMES = Object.freeze({
  [NODE_TYPE.START]: ['轮回起点'],
  [NODE_TYPE.COMBAT]: ['荒径', '碎石道', '低语回廊', '苔痕小径', '残垣', '灰雾隘口'],
  [NODE_TYPE.ELITE]: ['幽邃祭坛', '锈钉刑场', '哀鸣王座', '断罪之门'],
  [NODE_TYPE.REST]: ['静水泉', '余烬营地', '苔石憩所'],
  [NODE_TYPE.SHOP]: ['流浪货摊', '碎片交易所', '拾荒者棚屋'],
  [NODE_TYPE.EVENT]: ['歧路石碑', '无主行囊', '低吟古井', '褪色壁画'],
  [NODE_TYPE.EMPTY]: ['空地', '岔路', '枯枝林', '风蚀凹地'],
  [NODE_TYPE.EXIT]: ['向下阶梯'],
  [NODE_TYPE.DEAD_END]: ['此路不通', '塌方处', '死巷'],
});

function pickDisplayName(rng, type) {
  const pool = DISPLAY_NAMES[type] ?? ['未知'];
  return pool.length === 1 ? pool[0] : rng.pick(pool);
}

/**
 * @param {object} params
 * @param {number} params.seed
 * @param {number} params.floorNumber
 * @returns {{nodes:Array, adjacency:object, startNodeId:string, exitNodeId:string,
 *            gridWidth:number, gridHeight:number}}
 */
export function generateFloor({ seed, floorNumber }) {
  const rng = mapStream(seed, floorNumber);

  // 步骤 1：网格尺寸
  const gridWidth = rng.nextRange(GRID_MIN, GRID_MAX);
  const gridHeight = rng.nextRange(GRID_MIN, GRID_MAX);

  // 步骤 2：起点在中央偏下（60%~70% 高度）
  const startX = Math.floor(gridWidth / 2);
  const startY = Math.min(gridHeight - 1, Math.floor(gridHeight * (0.6 + rng.next() * 0.1)));
  const startKey = nodeId(startX, startY);

  // 步骤 3：随机延伸
  const cells = new Map();
  cells.set(startKey, { gridX: startX, gridY: startY, distance: 0 });

  const frontier = [{ x: startX, y: startY, distance: 0 }];
  let steps = 0;
  // 目标节点数：随网格面积缩放，保证地图有足够内容但不铺满
  const targetCount = Math.max(18, Math.floor(gridWidth * gridHeight * 0.45));

  while (frontier.length > 0 && cells.size < targetCount) {
    steps += 1;
    if (steps > MAP_GENERATION_STEP_LIMIT) {
      throw new MapGenerationError('地图生成超过步数上限', { seed, floorNumber, steps });
    }

    const current = frontier.shift();
    // 起点的分支数由种子决定（1~4 条，不固定四方通）
    const dirs = rng.shuffle(DIRECTIONS);
    const branchLimit = current.distance === 0 ? rng.nextRange(1, 4) : 4;
    let branched = 0;

    for (const dir of dirs) {
      if (branched >= branchLimit) break;

      const nx = current.x + dir.dx;
      const ny = current.y + dir.dy;
      if (nx < 0 || ny < 0 || nx >= gridWidth || ny >= gridHeight) continue;

      const key = nodeId(nx, ny);
      if (cells.has(key)) continue;

      // 延伸概率随距起点越远而递减 —— 形成"近密远疏"的自然分布
      const extendChance = current.distance === 0 ? 1 : Math.max(0.18, 0.9 - current.distance * 0.07);
      if (!rng.chance(extendChance)) continue;

      const distance = current.distance + 1;
      cells.set(key, { gridX: nx, gridY: ny, distance });
      frontier.push({ x: nx, y: ny, distance });
      branched += 1;
    }
  }

  const adjacency = buildAdjacency([...cells.keys()], cells, gridWidth, gridHeight);

  // 步骤 5（前置）：确认全部生成节点都从起点可达，剔除孤岛
  const reachable = reachableFrom(startKey, adjacency);
  for (const key of [...cells.keys()]) {
    if (!reachable.has(key)) cells.delete(key);
  }
  const prunedAdjacency = buildAdjacency([...cells.keys()], cells, gridWidth, gridHeight);

  // 出口 = 距起点最远的节点，保证需要实际探索
  const exitKey = farthestNodeFrom(startKey, prunedAdjacency);
  if (exitKey === null || exitKey === startKey) {
    throw new MapGenerationError('地图生成失败：无法确定出口节点', { seed, floorNumber, size: cells.size });
  }

  // 步骤 4：类型分配
  const nodes = assignTypes({
    rng,
    cells,
    adjacency: prunedAdjacency,
    startKey,
    exitKey,
    gridWidth,
    gridHeight,
  });

  // 类型分配可能把节点标成死路，需据此重建可通行邻接表
  const passableIds = nodes.filter((n) => n.type !== NODE_TYPE.DEAD_END).map((n) => n.id);
  const passableSet = new Set(passableIds);
  const finalAdjacency = buildAdjacency(passableIds, cells, gridWidth, gridHeight);

  // 死路节点仍需在图上可见（玩家要看到“此路不通”），单向接回其邻居。
  // 单向是有意的：死路列出邻居以便渲染连线，但邻居不列出死路，因此
  // areAdjacent 天然拒绝向死路移动，无需额外判定。
  for (const node of nodes) {
    if (node.type !== NODE_TYPE.DEAD_END) continue;
    // 与 buildAdjacency 一致地排序：邻接表遵循字典序，否则死路的邻居会按
    // DIRECTIONS 的方位序输出，让快照比对与渲染顺序依赖实现细节
    finalAdjacency[node.id] = neighborsOf(node.id, cells, gridWidth, gridHeight)
      .filter((id) => passableSet.has(id))
      .sort();
  }

  // 只要求可通行节点全连通；死路不在可达集内是设计使然
  assertConnected(startKey, exitKey, finalAdjacency, { seed, floorNumber }, passableSet);

  return {
    nodes,
    adjacency: finalAdjacency,
    startNodeId: startKey,
    exitNodeId: exitKey,
    gridWidth,
    gridHeight,
  };
}

function neighborsOf(key, cells, gridWidth, gridHeight) {
  const cell = cells.get(key);
  if (cell === undefined) return [];
  const out = [];
  for (const dir of DIRECTIONS) {
    const nx = cell.gridX + dir.dx;
    const ny = cell.gridY + dir.dy;
    if (nx < 0 || ny < 0 || nx >= gridWidth || ny >= gridHeight) continue;
    const nk = nodeId(nx, ny);
    if (cells.has(nk)) out.push(nk);
  }
  return out;
}

/**
 * 步骤 4：节点类型分配。
 *
 * 死路选取是此处的难点：不能单纯“抽 30% 的节点标成死路”，因为把一个
 * 度大于 1 的节点变成死路可能切断地图，产生孤岛。做法是逐个贪心选取：
 * 每选一个就验证剩余可通行集仍全连通，不过关则回退。
 *
 * 优先从叶子节点（度为 1）取：它们删除后不可能切断图，命中率高。
 * 起点、出口以及主路径上的节点受保护，绝不变死路。
 */
function assignTypes({ rng, cells, adjacency, startKey, exitKey, gridWidth, gridHeight }) {
  const allKeys = [...cells.keys()].sort();
  const protectedKeys = new Set([startKey, exitKey]);

  // 出口主路径上的节点受保护，不可变死路
  for (const key of shortestPath(startKey, exitKey, adjacency)) {
    protectedKeys.add(key);
  }

  const candidates = allKeys.filter((k) => !protectedKeys.has(k));

  // 死路：目标约 30%（规格 6.2），优先取叶子节点
  const deadEndTarget = Math.floor(allKeys.length * DEAD_END_RATIO);
  const leaves = candidates.filter((k) => (adjacency[k] ?? []).length <= 1);
  const nonLeaves = candidates.filter((k) => (adjacency[k] ?? []).length > 1);
  const deadEndPool = [...rng.shuffle(leaves), ...rng.shuffle(nonLeaves)];

  const neighbors = (key) => neighborsOf(key, cells, gridWidth, gridHeight);
  const passable = new Set(allKeys);
  const deadEnds = new Set();

  for (const key of deadEndPool) {
    if (deadEnds.size >= deadEndTarget) break;
    passable.delete(key);
    if (staysConnectedWithout(startKey, passable, neighbors)) {
      deadEnds.add(key);
    } else {
      passable.add(key); // 回退：此节点是关锤，不能堵
    }
  }

  const nodes = [];
  for (const key of allKeys) {
    const cell = cells.get(key);
    let type;

    if (key === startKey) type = NODE_TYPE.START;
    else if (key === exitKey) type = NODE_TYPE.EXIT;
    else if (deadEnds.has(key)) type = NODE_TYPE.DEAD_END;
    else type = rng.pickWeighted(NODE_TYPE_WEIGHTS).type;

    nodes.push({
      id: key,
      gridX: cell.gridX,
      gridY: cell.gridY,
      type,
      displayName: pickDisplayName(rng, type),
      isRevealed: false,
      isCleared: false,
      combatEncounter: null,
      eventId: null,
    });
  }

  return nodes;
}

/** BFS 最短路径。返回含端点的节点 ID 数组，不可达返回空数组。 */
function shortestPath(fromKey, toKey, adjacency) {
  const prev = new Map([[fromKey, null]]);
  const queue = [fromKey];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === toKey) break;
    for (const next of adjacency[current] ?? []) {
      if (prev.has(next)) continue;
      prev.set(next, current);
      queue.push(next);
    }
  }
  if (!prev.has(toKey)) return [];
  const path = [];
  let cursor = toKey;
  while (cursor !== null && cursor !== undefined) {
    path.push(cursor);
    cursor = prev.get(cursor);
  }
  return path.reverse();
}

export { nodeId, DIRECTIONS, shortestPath };
