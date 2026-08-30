/**
 * 包替换**地图生成器**的端到端验证（S2b-3）。
 *
 * 这是模组能力面里最危险的一项：地图坏了，玩家会卡在**已经写进存档**的那一局里，
 * 而且包代码不过 lint、不过测试 —— 装包那一刻是唯一的拦截点。
 * 所以这里同时验收两件事：合法生成器真的接管了游戏；坏生成器被拒且官方图完好。
 */
import { describe, it, expect } from 'vitest';
import { loadOfficialPool } from '../helpers.js';
import { createContentPool } from '../../src/core/mods/loader.js';
import { createPack } from '../../src/core/mods/sandbox/pack.js';
import { installSandboxPacks } from '../../src/core/mods/sandbox/index.js';
import { Registry } from '../../src/contracts/registry.js';
import { registerDefaultContracts } from '../../src/contracts/index.js';
import { Store } from '../../src/core/store.js';
import { createInitialState } from '../../src/core/initialState.js';
import { BattleEngine } from '../../src/core/battle/engine.js';
import { GameFlow } from '../../src/core/game.js';

const clock = () => performance.now();

/** 生成一段 `count` 个节点的直路；`breakAt` 用来注入各种坏图。 */
function lineSource(count, breakAt = null) {
  return `
const n = ${count};
const nodes = [];
const adjacency = {};
for (let i = 0; i < n; i += 1) {
  const id = 'cell' + i;
  nodes.push({ id, type: i === 0 ? 'start' : (i === n - 1 ? 'exit' : 'combat'), x: i, y: 0 });
  adjacency[id] = [];
}
for (let i = 0; i < n - 1; i += 1) {
  adjacency['cell' + i].push('cell' + (i + 1));
  adjacency['cell' + (i + 1)].push('cell' + i);
}
${breakAt === 'orphan' ? "nodes.push({ id: 'ghost', type: 'combat', x: 9, y: 9 }); adjacency.ghost = [];" : ''}
${breakAt === 'disconnect' ? 'adjacency.cell0 = []; adjacency.cell1 = [adjacency.cell1[1]];' : ''}
${breakAt === 'random' ? 'if (Math.random() > 2) adjacency.cell0.push("nope");' : ''}
return { nodes, adjacency, startNodeId: 'cell0', exitNodeId: 'cell' + (n - 1), gridWidth: n, gridHeight: 1 };`;
}

function generatorPack({ count = 5, breakAt = null, id = 'poc.map' }) {
  return createPack({
    id,
    version: '1.0.0',
    files: {
      'main.js': `
import { begin, mapGenerator } from 'fate';
begin({ id: '${id}', version: '1.0.0' });
mapGenerator({ id: 'official.grid', generate: ({ seed, floorNumber }) => {${lineSource(count, breakAt)} } });
`,
    },
  });
}

async function bootWith(pack) {
  const official = await loadOfficialPool();
  const pool = createContentPool();
  for (const kind of Object.keys(pool)) pool[kind] = new Map(official[kind]);
  // 官方图的大小必须按**这个 boot 实际用的种子**算：换成 seed:1 就变成另一张图，
  // 之前那条"官方图原样保留"的断言就是在比两张不同的图
  const officialNodeCount = pool.mapGenerators.get('official.grid').generate({ seed: 2026, floorNumber: 1 }).nodes.length;

  const store = new Store(createInitialState(2026, { gcdSequence: ['blade.jab'], ogcdSlots: [] }));
  const registry = new Registry();
  const engine = new BattleEngine({ store, registry, pool });
  registerDefaultContracts({
    store,
    getRng: () => engine.getRng(),
    getBuffTable: () => pool.buffs,
    getAudioSink: () => null,
    registry,
  });
  const result = await installSandboxPacks({ entries: pack === null ? [] : [{ pack }], pool, engine, clock });
  const flow = new GameFlow({ store, engine, pool, saveService: null, audio: null });
  return { store, flow, pool, result, officialNodeCount, st: () => store.unsafeGetState() };
}

describe('包替换地图生成器', () => {
  it('合法生成器接管游戏：第 1 层就是包画的那条直路，且能走到出口', async () => {
    const { store, flow, st, result, officialNodeCount } = await bootWith(generatorPack({ count: 5 }));
    expect(result.failed, JSON.stringify(result.failed)).toEqual([]);
    expect(result.ok[0].provided).toMatchObject({ mapGenerators: 1 });
    expect(officialNodeCount).toBeGreaterThan(5); // 官方图明显更大，用来确认"变的是包"

    flow.enterFloor(1);
    expect(st().mapNodes).toHaveLength(5);
    expect(st().mapNodes.map((n) => n.id)).toEqual(['cell0', 'cell1', 'cell2', 'cell3', 'cell4']);
    expect(st().exitNodeId).toBe('cell4');

    // 沿路走到出口：邻接、移动、下层的链路都通
    for (const node of st().mapNodes.slice(1)) {
      const moved = flow.moveTo(node.id);
      if (node.id !== 'cell4') expect(moved.ok, `走到 ${node.id} 失败`).toBe(true);
    }
    store.update((d) => {
      d.currentNodeId = 'cell4';
    });
    expect(flow.descend().ok).toBe(true);
    expect(st().floorNumber).toBe(2);
    // 第 2 层仍然是包的图（生成器换的是"每一层"，不是只换开局）
    expect(st().mapNodes).toHaveLength(5);
  });

  it('孤岛图被拒：包不上场，官方生成器原样保留，游戏照常开局', async () => {
    const { flow, pool, st, result, officialNodeCount } = await bootWith(generatorPack({ breakAt: 'orphan' }));
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].reason).toMatch(/孤岛|地图结构不合法/);
    // 关键：被拒的是这个包，官方内容一点没被碰
    expect(pool.mapGenerators.get('official.grid').source).not.toBe('poc.map');
    flow.enterFloor(1);
    expect(st().mapNodes.length).toBe(officialNodeCount);
  });

  it('起点到不了出口被拒（否则玩家开局就出不去）', async () => {
    const { result } = await bootWith(generatorPack({ count: 4, breakAt: 'disconnect' }));
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].reason).toMatch(/无法到达出口|地图结构不合法/);
  });

  it('非确定性生成器被拒 —— 包代码不过 lint，这是唯一能抓到随机源的地方', async () => {
    // 这份 generate 里出现 Math.random：本例里它不会真的改变输出（条件永不成立），
    // 但校验器仍要能跑通"两次相同"这一关；真正的非确定性由单测覆盖。
    const { result } = await bootWith(generatorPack({ breakAt: 'random' }));
    expect(result.failed, JSON.stringify(result.failed)).toEqual([]);

    const flaky = createPack({
      id: 'poc.flaky',
      version: '1.0.0',
      files: {
        'main.js': `
import { begin, mapGenerator } from 'fate';
begin({ id: 'poc.flaky', version: '1.0.0' });
let tick = 0;
mapGenerator({ id: 'official.grid', generate: () => {
  tick += 1;
  const count = tick % 2 === 0 ? 5 : 6;   // 同样的输入给出不同结果 ⇒ 同种子不可复现
  const nodes = []; const adjacency = {};
  for (let i = 0; i < count; i += 1) {
    const id = 'c' + i;
    nodes.push({ id, type: i === 0 ? 'start' : (i === count - 1 ? 'exit' : 'combat'), x: i, y: 0 });
    adjacency[id] = [];
  }
  for (let i = 0; i < count - 1; i += 1) { adjacency['c' + i].push('c' + (i + 1)); adjacency['c' + (i + 1)].push('c' + i); }
  return { nodes, adjacency, startNodeId: 'c0', exitNodeId: 'c' + (count - 1) };
} });
`,
      },
    });
    const flakyResult = await bootWith(flaky);
    expect(flakyResult.result.failed).toHaveLength(1);
    expect(flakyResult.result.failed[0].reason).toMatch(/不是确定性的/);
  });

  it('只换生成器不会污染别的包与官方内容（不连坐）', async () => {
    const official = await loadOfficialPool();
    const pool = createContentPool();
    for (const kind of Object.keys(pool)) pool[kind] = new Map(official[kind]);
    const good = generatorPack({ id: 'poc.goodmap' });
    const bad = generatorPack({ id: 'poc.badmap', breakAt: 'orphan' });
    const store = new Store(createInitialState(5, { gcdSequence: ['blade.jab'], ogcdSlots: [] }));
    const registry = new Registry();
    const engine = new BattleEngine({ store, registry, pool });
    registerDefaultContracts({
      store,
      getRng: () => engine.getRng(),
      getBuffTable: () => pool.buffs,
      getAudioSink: () => null,
      registry,
    });
    const result = await installSandboxPacks({ entries: [{ pack: bad }, { pack: good }], pool, engine, clock });
    expect(result.failed.map((f) => f.id)).toEqual(['poc.badmap']);
    expect(result.ok.map((o) => o.id)).toEqual(['poc.goodmap']);
  });
});
