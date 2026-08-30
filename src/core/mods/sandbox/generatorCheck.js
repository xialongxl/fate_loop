/**
 * 沙箱地图生成器的**准入校验**。
 *
 * 为什么必须有：地图是这局游戏能不能玩下去的地基 —— 起点到不了出口、或者留个
 * 孤岛节点，玩家会卡在地图上，而这局已经写进存档了。官方生成器有
 * `map.test.js` / `cross-speed.test.js` 守着；**包代码不过 lint、不过测试**，
 * 所以必须在装包这一刻把它跑一遍。
 *
 * 两件分别检查的事：
 *  1. **结构不变量**：节点唯一、邻接对称且不含未知 id、起点可达出口、无孤岛
 *  2. **确定性**：同一组 (seed, floorNumber) 跑两遍必须逐字节相同
 *     —— 这是抓包里 Math.random / Date.now 的**唯一**手段（沙箱不禁这两个，
 *     禁了官方内容也没法写；而非确定性生成器会直接毁掉"同种子必得同结果"）
 */

import { NODE_TYPE } from '../../constants.js';
import { assertConnected } from '../../map/connectivity.js';

const VALID_TYPES = new Set(Object.values(NODE_TYPE));

/** 采样点：跨层数与种子各来几发，覆盖"第 1 层能跑第 30 层崩"这类情况。 */
export const DEFAULT_SAMPLES = Object.freeze([
  { seed: 1, floorNumber: 1 },
  { seed: 7, floorNumber: 1 },
  { seed: 12345, floorNumber: 2 },
  { seed: 999983, floorNumber: 5 },
  { seed: 424242, floorNumber: 12 },
]);

const stableJson = (value) => JSON.stringify(value);

/**
 * @param {{id:string, generate:Function}} generator
 * @param {{samples?:Array, source:string}} [options]
 * @throws {Error} 带可读 reason 的错误（调用方据此拒绝该包）
 */
export function validateMapGenerator(generator, { samples = DEFAULT_SAMPLES, source = 'unknown' } = {}) {
  if (typeof generator?.generate !== 'function') {
    throw new Error(`mapGenerator ${generator?.id ?? '?'} 没有 generate 函数`);
  }
  const label = `${source}:${generator.id}`;

  for (const sample of samples) {
    let first;
    let second;
    try {
      first = generator.generate({ seed: sample.seed, floorNumber: sample.floorNumber });
      second = generator.generate({ seed: sample.seed, floorNumber: sample.floorNumber });
    } catch (error) {
      throw new Error(`${label} 在 seed=${sample.seed} 第 ${sample.floorNumber} 层抛错：${error?.message ?? String(error)}`);
    }

    // 确定性：跑两遍不一样就是带了随机源或时钟 —— 同种子复现直接失效
    if (stableJson(first) !== stableJson(second)) {
      throw new Error(
        `${label} 不是确定性的：同一组 (seed=${sample.seed}, floor=${sample.floorNumber}) 两次生成结果不同` +
          '（地图生成里不能用 Math.random / Date.now，请用传入的 seed 自己派生）',
      );
    }

    checkShape(first, label, sample);
    checkConnectivity(first, label, sample);
  }
  return true;
}

function checkShape(map, label, sample) {
  const where = `${label} @ seed=${sample.seed} 第 ${sample.floorNumber} 层`;
  if (map === null || typeof map !== 'object') throw new Error(`${where} 没有返回对象`);
  const { nodes, adjacency, startNodeId, exitNodeId } = map;
  if (!Array.isArray(nodes) || nodes.length === 0) throw new Error(`${where} nodes 必须是非空数组`);
  if (adjacency === null || typeof adjacency !== 'object') throw new Error(`${where} adjacency 必须是对象`);
  if (typeof startNodeId !== 'string' || typeof exitNodeId !== 'string') {
    throw new Error(`${where} 必须给出 startNodeId 与 exitNodeId`);
  }

  const ids = new Set();
  for (const node of nodes) {
    if (typeof node?.id !== 'string' || node.id === '') throw new Error(`${where} 有节点缺非空 id`);
    if (ids.has(node.id)) throw new Error(`${where} 节点 id 重复：${node.id}`);
    ids.add(node.id);
    if (!VALID_TYPES.has(node.type)) throw new Error(`${where} 节点 ${node.id} 的 type 非法：${String(node.type)}`);
  }
  if (!ids.has(startNodeId)) throw new Error(`${where} startNodeId 不在节点里：${startNodeId}`);
  if (!ids.has(exitNodeId)) throw new Error(`${where} exitNodeId 不在节点里：${exitNodeId}`);
  if (startNodeId === exitNodeId) throw new Error(`${where} 起点与出口是同一个节点`);

  for (const [nodeId, neighbors] of Object.entries(adjacency)) {
    if (!ids.has(nodeId)) throw new Error(`${where} 邻接表里有未知节点 ${nodeId}`);
    if (!Array.isArray(neighbors)) throw new Error(`${where} ${nodeId} 的邻接不是数组`);
    for (const neighbor of neighbors) {
      if (!ids.has(neighbor)) throw new Error(`${where} ${nodeId} 邻接到未知节点 ${neighbor}`);
    }
  }
  // ⚠️ **不检查对称性**。第一版加了"每条边都要有反向边"，结果官方生成器
  // 当场没过 —— 单向边是本作的设计：死路节点列出邻居（为了把连线画出来），
  // 但邻居不列出死路，于是 areAdjacent 天然拒绝往死路里走（见 generator.js
  // 第 154 行附近的注释）。写校验器之前得先读被校验对象的真实契约，
  // 否则就会发明一套连官方内容都不满足的"不变量"。
}

function checkConnectivity(map, label, sample) {
  const where = `${label} @ seed=${sample.seed} 第 ${sample.floorNumber} 层`;
  // 只要求**可通行节点**全连通：死路按设计就不在可达集里（邻居不列它），
  // 拿全部节点去要求会把正常地图判成孤岛图。
  const passableIds = map.nodes.filter((n) => n.type !== NODE_TYPE.DEAD_END).map((n) => n.id);
  try {
    assertConnected(map.startNodeId, map.exitNodeId, map.adjacency, { source: where }, passableIds);
  } catch (error) {
    throw new Error(`${where} 地图结构不合法：${error?.message ?? String(error)}`);
  }
}
