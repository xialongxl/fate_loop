/**
 * 阶段 3 验收：地图生成。
 *
 * 核心不变量（任一条被破坏都会让游戏卡死或不可复现）：
 *   1. 同种子同层 → 完全相同的地图
 *   2. 起点必达出口
 *   3. 可通行节点集无孤岛
 *   4. 死路不阻断主路径
 */

import { describe, expect, it } from 'vitest';
import { generateFloor, shortestPath } from '../../src/core/map/generator.js';
import { areAdjacent, buildAdjacency } from '../../src/core/map/adjacency.js';
import {
  distancesFrom,
  farthestNodeFrom,
  reachableFrom,
  staysConnectedWithout,
} from '../../src/core/map/connectivity.js';
import { revealAround, revealInitial } from '../../src/core/map/reveal.js';
import { DEAD_END_RATIO, GRID_MAX, GRID_MIN, NODE_TYPE } from '../../src/core/constants.js';

/** 抽样种子组：固定列表而非随机，保证测试自身可复现。 */
const SEEDS = [1, 42, 1337, 20240101, 0x7fffffff, 999999, 31337, 8888];

function passableOf(floor) {
  return floor.nodes.filter((n) => n.type !== NODE_TYPE.DEAD_END).map((n) => n.id);
}

describe('地图生成确定性', () => {
  it('同种子同层生成完全相同的地图', () => {
    for (const seed of SEEDS) {
      const a = generateFloor({ seed, floorNumber: 3 });
      const b = generateFloor({ seed, floorNumber: 3 });
      expect(b).toEqual(a);
    }
  });

  it('同种子不同层生成不同地图（层号参与派生）', () => {
    const f1 = generateFloor({ seed: 42, floorNumber: 1 });
    const f2 = generateFloor({ seed: 42, floorNumber: 2 });
    expect(JSON.stringify(f2.nodes)).not.toBe(JSON.stringify(f1.nodes));
  });

  it('不同种子同层生成不同地图', () => {
    const a = generateFloor({ seed: 1, floorNumber: 1 });
    const b = generateFloor({ seed: 2, floorNumber: 1 });
    expect(JSON.stringify(b.nodes)).not.toBe(JSON.stringify(a.nodes));
  });

  it('节点数组按 ID 排序，邻接表键序稳定', () => {
    const floor = generateFloor({ seed: 777, floorNumber: 1 });
    const ids = floor.nodes.map((n) => n.id);
    expect(ids).toEqual([...ids].sort());
    for (const neighbors of Object.values(floor.adjacency)) {
      expect(neighbors).toEqual([...neighbors].sort());
    }
  });
});

describe('地图结构不变量（多种子批量）', () => {
  it('网格尺寸落在 8~14 区间', () => {
    for (const seed of SEEDS) {
      const floor = generateFloor({ seed, floorNumber: 1 });
      expect(floor.gridWidth).toBeGreaterThanOrEqual(GRID_MIN);
      expect(floor.gridWidth).toBeLessThanOrEqual(GRID_MAX);
      expect(floor.gridHeight).toBeGreaterThanOrEqual(GRID_MIN);
      expect(floor.gridHeight).toBeLessThanOrEqual(GRID_MAX);
    }
  });

  it('起点必达出口，且出口不等于起点', () => {
    for (const seed of SEEDS) {
      for (let f = 1; f <= 5; f += 1) {
        const floor = generateFloor({ seed, floorNumber: f });
        expect(floor.exitNodeId).not.toBe(floor.startNodeId);
        const path = shortestPath(floor.startNodeId, floor.exitNodeId, floor.adjacency);
        expect(path.length, `种子 ${seed} 层 ${f}`).toBeGreaterThan(1);
        expect(path[0]).toBe(floor.startNodeId);
        expect(path.at(-1)).toBe(floor.exitNodeId);
      }
    }
  });

  it('可通行节点集无孤岛', () => {
    for (const seed of SEEDS) {
      for (let f = 1; f <= 5; f += 1) {
        const floor = generateFloor({ seed, floorNumber: f });
        const passable = passableOf(floor);
        const reachable = reachableFrom(floor.startNodeId, floor.adjacency);
        const orphans = passable.filter((id) => !reachable.has(id));
        expect(orphans, `种子 ${seed} 层 ${f} 的孤岛`).toEqual([]);
      }
    }
  });

  it('300 组种子 × 3 层全部生成成功（回归：死路曾导致必然孤岛）', () => {
    let count = 0;
    for (let s = 1; s <= 300; s += 1) {
      for (let f = 1; f <= 3; f += 1) {
        expect(() => generateFloor({ seed: s * 7919, floorNumber: f })).not.toThrow();
        count += 1;
      }
    }
    expect(count).toBe(900);
  });

  it('起点与出口永不是死路，主路径上也没有死路', () => {
    for (const seed of SEEDS) {
      const floor = generateFloor({ seed, floorNumber: 2 });
      const byId = new Map(floor.nodes.map((n) => [n.id, n]));

      expect(byId.get(floor.startNodeId).type).toBe(NODE_TYPE.START);
      expect(byId.get(floor.exitNodeId).type).toBe(NODE_TYPE.EXIT);

      for (const id of shortestPath(floor.startNodeId, floor.exitNodeId, floor.adjacency)) {
        expect(byId.get(id).type, `${id} 在主路径上却是死路`).not.toBe(NODE_TYPE.DEAD_END);
      }
    }
  });

  it('死路占比不超过目标值（贪心回退只会少给，不会多给）', () => {
    for (const seed of SEEDS) {
      const floor = generateFloor({ seed, floorNumber: 1 });
      const deadEnds = floor.nodes.filter((n) => n.type === NODE_TYPE.DEAD_END).length;
      expect(deadEnds).toBeLessThanOrEqual(Math.floor(floor.nodes.length * DEAD_END_RATIO));
    }
  });

  it('每层恰好一个起点与一个出口', () => {
    for (const seed of SEEDS) {
      const floor = generateFloor({ seed, floorNumber: 4 });
      expect(floor.nodes.filter((n) => n.type === NODE_TYPE.START)).toHaveLength(1);
      expect(floor.nodes.filter((n) => n.type === NODE_TYPE.EXIT)).toHaveLength(1);
    }
  });

  it('节点坐标落在网格内且无重复', () => {
    for (const seed of SEEDS) {
      const floor = generateFloor({ seed, floorNumber: 1 });
      const seen = new Set();
      for (const node of floor.nodes) {
        expect(node.gridX).toBeGreaterThanOrEqual(0);
        expect(node.gridX).toBeLessThan(floor.gridWidth);
        expect(node.gridY).toBeGreaterThanOrEqual(0);
        expect(node.gridY).toBeLessThan(floor.gridHeight);
        expect(node.id).toBe(`node_${node.gridX}_${node.gridY}`);
        expect(seen.has(node.id)).toBe(false);
        seen.add(node.id);
      }
    }
  });

  it('节点初始均未揭示未清除，且类型合法', () => {
    const validTypes = new Set(Object.values(NODE_TYPE));
    const floor = generateFloor({ seed: 12345, floorNumber: 1 });
    for (const node of floor.nodes) {
      expect(node.isRevealed).toBe(false);
      expect(node.isCleared).toBe(false);
      expect(validTypes.has(node.type)).toBe(true);
      expect(node.displayName).toBeTypeOf('string');
      expect(node.displayName.length).toBeGreaterThan(0);
    }
  });

  it('地图规模足够玩（至少 18 个节点）', () => {
    for (const seed of SEEDS) {
      const floor = generateFloor({ seed, floorNumber: 1 });
      expect(floor.nodes.length).toBeGreaterThanOrEqual(18);
    }
  });
});

describe('死路的单向可见性', () => {
  it('死路列出邻居（供渲染连线），但邻居不列出死路（阻止移动）', () => {
    for (const seed of SEEDS) {
      const floor = generateFloor({ seed, floorNumber: 1 });
      const deadEnds = floor.nodes.filter((n) => n.type === NODE_TYPE.DEAD_END);

      for (const dead of deadEnds) {
        const neighbors = floor.adjacency[dead.id] ?? [];
        for (const neighbor of neighbors) {
          // 单向：从死路能"看到"邻居，但 areAdjacent(邻居 → 死路) 必须为假
          expect(areAdjacent(floor.adjacency, neighbor, dead.id), `${neighbor} 不该能走向死路 ${dead.id}`).toBe(
            false,
          );
        }
      }
    }
  });

  it('玩家从任何可达节点都无法移动到死路', () => {
    const floor = generateFloor({ seed: 42, floorNumber: 1 });
    const deadEndIds = new Set(
      floor.nodes.filter((n) => n.type === NODE_TYPE.DEAD_END).map((n) => n.id),
    );
    const reachable = reachableFrom(floor.startNodeId, floor.adjacency);

    for (const from of reachable) {
      for (const to of floor.adjacency[from] ?? []) {
        if (deadEndIds.has(from)) continue; // 玩家不可能站在死路上
        expect(deadEndIds.has(to)).toBe(false);
      }
    }
  });
});

describe('邻接表与连通性工具', () => {
  const cells = new Map([
    ['node_0_0', { gridX: 0, gridY: 0 }],
    ['node_1_0', { gridX: 1, gridY: 0 }],
    ['node_2_0', { gridX: 2, gridY: 0 }],
    ['node_0_1', { gridX: 0, gridY: 1 }],
    ['node_5_5', { gridX: 5, gridY: 5 }], // 孤立格
  ]);

  it('buildAdjacency 只连接四方向相邻且都在集合内的节点', () => {
    const adj = buildAdjacency([...cells.keys()], cells, 8, 8);
    expect(adj.node_0_0).toEqual(['node_0_1', 'node_1_0']);
    expect(adj.node_1_0).toEqual(['node_0_0', 'node_2_0']);
    expect(adj.node_5_5).toEqual([]); // 孤立
  });

  it('不在集合内的节点不被连接（子集邻接）', () => {
    const adj = buildAdjacency(['node_0_0', 'node_2_0'], cells, 8, 8);
    expect(adj.node_0_0).toEqual([]); // node_1_0 被排除，链断开
  });

  it('对角线不算相邻', () => {
    const diag = new Map([
      ['node_0_0', { gridX: 0, gridY: 0 }],
      ['node_1_1', { gridX: 1, gridY: 1 }],
    ]);
    const adj = buildAdjacency([...diag.keys()], diag, 8, 8);
    expect(adj.node_0_0).toEqual([]);
  });

  it('areAdjacent 对不存在的节点返回 false 而不抛错', () => {
    const adj = buildAdjacency([...cells.keys()], cells, 8, 8);
    expect(areAdjacent(adj, 'node_不存在', 'node_0_0')).toBe(false);
  });

  it('reachableFrom 与 distancesFrom 一致', () => {
    const adj = buildAdjacency([...cells.keys()], cells, 8, 8);
    const reachable = reachableFrom('node_0_0', adj);
    const dist = distancesFrom('node_0_0', adj);

    expect(reachable).toEqual(new Set([...dist.keys()]));
    expect(reachable.has('node_5_5')).toBe(false);
    expect(dist.get('node_2_0')).toBe(2);
  });

  it('farthestNodeFrom 距离相同时取字典序最小者（确定性）', () => {
    // node_1_0 与 node_0_1 距 node_0_0 均为 1
    const small = new Map([
      ['node_0_0', { gridX: 0, gridY: 0 }],
      ['node_1_0', { gridX: 1, gridY: 0 }],
      ['node_0_1', { gridX: 0, gridY: 1 }],
    ]);
    const adj = buildAdjacency([...small.keys()], small, 8, 8);
    expect(farthestNodeFrom('node_0_0', adj)).toBe('node_0_1');
  });

  it('staysConnectedWithout 能识别切断图的关键节点', () => {
    const line = new Map([
      ['node_0_0', { gridX: 0, gridY: 0 }],
      ['node_1_0', { gridX: 1, gridY: 0 }],
      ['node_2_0', { gridX: 2, gridY: 0 }],
    ]);
    const neighborsOf = (id) => {
      const c = line.get(id);
      return [`node_${c.gridX - 1}_0`, `node_${c.gridX + 1}_0`].filter((k) => line.has(k));
    };

    // 去掉末端 node_2_0：剩 {0_0, 1_0} 仍连通
    expect(staysConnectedWithout('node_0_0', new Set(['node_0_0', 'node_1_0']), neighborsOf)).toBe(true);
    // 去掉中间 node_1_0：剩 {0_0, 2_0} 断裂
    expect(staysConnectedWithout('node_0_0', new Set(['node_0_0', 'node_2_0']), neighborsOf)).toBe(false);
  });
});

describe('节点揭示', () => {
  it('初始只揭示起点及其相邻节点', () => {
    const floor = generateFloor({ seed: 42, floorNumber: 1 });
    revealInitial(floor.nodes, floor.adjacency, floor.startNodeId);

    const expected = new Set([floor.startNodeId, ...floor.adjacency[floor.startNodeId]]);
    for (const node of floor.nodes) {
      expect(node.isRevealed, node.id).toBe(expected.has(node.id));
    }
  });

  it('揭示是单调的：已揭示的不会被复原', () => {
    const floor = generateFloor({ seed: 42, floorNumber: 1 });
    revealInitial(floor.nodes, floor.adjacency, floor.startNodeId);
    const firstBatch = floor.nodes.filter((n) => n.isRevealed).map((n) => n.id);

    const next = floor.adjacency[floor.startNodeId][0];
    revealAround(floor.nodes, floor.adjacency, next);

    const nowRevealed = new Set(floor.nodes.filter((n) => n.isRevealed).map((n) => n.id));
    for (const id of firstBatch) {
      expect(nowRevealed.has(id)).toBe(true);
    }
    expect(nowRevealed.size).toBeGreaterThanOrEqual(firstBatch.length);
  });

  it('揭示不存在的节点是安全的空操作', () => {
    const floor = generateFloor({ seed: 42, floorNumber: 1 });
    expect(() => revealAround(floor.nodes, floor.adjacency, 'node_999_999')).not.toThrow();
    expect(floor.nodes.every((n) => !n.isRevealed)).toBe(true);
  });

  it('沿主路径逐步揭示后，出口最终可见', () => {
    const floor = generateFloor({ seed: 20240101, floorNumber: 1 });
    revealInitial(floor.nodes, floor.adjacency, floor.startNodeId);
    for (const id of shortestPath(floor.startNodeId, floor.exitNodeId, floor.adjacency)) {
      revealAround(floor.nodes, floor.adjacency, id);
    }
    expect(floor.nodes.find((n) => n.id === floor.exitNodeId).isRevealed).toBe(true);
  });
});
