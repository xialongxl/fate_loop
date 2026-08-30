/**
 * 沙箱地图生成器的准入校验。
 *
 * 这里测的是"什么样的生成器不许装进游戏"。地图坏了玩家会卡在**已存档**的
 * 那一局里，而包代码不过 lint 也不过测试 —— 装包这一刻是唯一的拦截点。
 */
import { describe, it, expect } from 'vitest';
import { validateMapGenerator, DEFAULT_SAMPLES } from '../../src/core/mods/sandbox/generatorCheck.js';
import { loadOfficialPool } from '../helpers.js';

/** 一条 a-b-c 直路。`extra` 用来注入各种坏形状。 */
function lineMap({ startNodeId = 'a', exitNodeId = 'c', extra = null, type = null } = {}) {
  const nodes = [
    { id: 'a', type: type ?? 'start', x: 0, y: 0 },
    { id: 'b', type: 'combat', x: 1, y: 0 },
    { id: 'c', type: 'exit', x: 2, y: 0 },
  ];
  const adjacency = { a: ['b'], b: ['a', 'c'], c: ['b'] };
  if (extra !== null) Object.assign(adjacency, extra);
  return { nodes, adjacency, startNodeId, exitNodeId, gridWidth: 3, gridHeight: 1 };
}

const gen = (impl) => ({ id: 'test.gen', generate: impl });

describe('validateMapGenerator', () => {
  it('合法生成器通过，且默认采样覆盖多层', () => {
    expect(validateMapGenerator(gen(() => lineMap()))).toBe(true);
    expect(DEFAULT_SAMPLES.length).toBeGreaterThanOrEqual(4);
  });

  it('官方生成器必须能过这道校验 —— 否则校验器本身写错了', async () => {
    const pool = await loadOfficialPool();
    const official = pool.mapGenerators.get('official.grid');
    expect(official, '官方地图生成器应在池里').toBeDefined();
    expect(validateMapGenerator(official, { source: 'official' })).toBe(true);
  });

  it('非确定性被拒：同一组参数两次结果不同 ⇒ 报错并说明该怎么做（抓包内随机源的唯一手段，包代码不过 lint）', () => {
    let n = 0;
    expect(() =>
      validateMapGenerator(
        gen(() => {
          n += 1;
          return lineMap({ extra: n % 2 === 0 ? { c: ['b', 'a'] } : {} });
        }),
        { source: 'bad' },
      ),
    ).toThrow(/不是确定性的/);
  });

  it('起点到不了出口被拒', () => {
    expect(() =>
      validateMapGenerator(
        gen(() => ({
          nodes: [
            { id: 'a', type: 'start', x: 0, y: 0 },
            { id: 'b', type: 'combat', x: 1, y: 0 },
            { id: 'c', type: 'exit', x: 2, y: 0 },
          ],
          adjacency: { a: ['b'], b: ['a'], c: [] },
          startNodeId: 'a',
          exitNodeId: 'c',
        })),
        { source: 'bad' },
      ),
    ).toThrow(/地图结构不合法/);
  });

  it('孤岛节点被拒（起点能到出口但有个节点谁也到不了）', () => {
    expect(() =>
      validateMapGenerator(
        gen(() => ({
          nodes: [
            { id: 'a', type: 'start', x: 0, y: 0 },
            { id: 'c', type: 'exit', x: 1, y: 0 },
            { id: 'ghost', type: 'shop', x: 5, y: 5 },
          ],
          adjacency: { a: ['c'], c: ['a'], ghost: [] },
          startNodeId: 'a',
          exitNodeId: 'c',
        })),
        { source: 'bad' },
      ),
    ).toThrow(/孤岛/);
  });

  it('单向邻接必须被接受 —— 死路就是靠它表达的（官方生成器也依赖这条）', () => {
    // 死路节点列出邻居（为了画连线），邻居不列它 ⇒ areAdjacent 天然拒绝走进去。
    // 曾经这里加了"每条边必须对称"的检查，官方地图当场没过 —— 别把它改回去。
    const oneWay = () => ({
      nodes: [
        { id: 'a', type: 'start', x: 0, y: 0 },
        { id: 'b', type: 'combat', x: 1, y: 0 },
        { id: 'dead', type: 'deadEnd', x: 1, y: 1 },
      ],
      adjacency: { a: ['b'], b: ['a'], dead: ['b'] },
      startNodeId: 'a',
      exitNodeId: 'b',
    });
    expect(validateMapGenerator(gen(oneWay), { source: 'ok' })).toBe(true);
  });

  it('邻接指向不存在的节点仍然被拒（单向可以，悬空不行）', () => {
    expect(() =>
      validateMapGenerator(gen(() => lineMap({ extra: { a: ['b', 'ghost'] } })), { source: 'bad' }),
    ).toThrow(/未知节点/);
  });

  it('未知节点 id、重复 id、非法 type、缺 start/exit 都被拒', () => {
    const cases = [
      [() => lineMap({ extra: { ghost: ['a'] } }), /未知节点/],
      [() => ({ ...lineMap(), nodes: [...lineMap().nodes, { id: 'a', type: 'combat', x: 9, y: 9 }] }), /id 重复/],
      [() => lineMap({ type: 'treasure-chest' }), /type 非法/],
      [() => ({ ...lineMap(), startNodeId: 'nope' }), /startNodeId 不在节点里/],
      [() => ({ ...lineMap(), exitNodeId: 'a' }), /起点与出口是同一个/],
    ];
    for (const [make, pattern] of cases) {
      expect(() => validateMapGenerator(gen(make), { source: 'bad' })).toThrow(pattern);
    }
  });

  it('generate 抛错被包装成可读原因（而不是把装包流程炸穿）', () => {
    expect(() =>
      validateMapGenerator(
        gen(() => {
          throw new Error('算不动');
        }),
        { source: 'poc.x' },
      ),
    ).toThrow(/poc.x.*抛错.*算不动/s);
  });

  it('没有 generate 函数直接拒', () => {
    expect(() => validateMapGenerator({ id: 'test.none' }, { source: 'bad' })).toThrow(/没有 generate 函数/);
  });
});
