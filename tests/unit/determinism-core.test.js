/**
 * 阶段 1 验收：确定性内核。
 */

import { describe, expect, it } from 'vitest';
import { createInitialState, createPlayer } from '../../src/core/initialState.js';
import { deriveSeed, mulberry32, normalizeSeed, mapStream, encounterStream, battleStream } from '../../src/core/prng.js';
import { Store } from '../../src/core/store.js';
import { stableStringify } from '../../src/utils/serialize.js';

describe('Mulberry32', () => {
  it('同种子产生完全相同的序列', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const seqA = Array.from({ length: 200 }, () => a.next());
    const seqB = Array.from({ length: 200 }, () => b.next());
    expect(seqA).toEqual(seqB);
  });

  it('输出落在 [0, 1) 区间', () => {
    const rng = mulberry32(7);
    for (let i = 0; i < 5000; i += 1) {
      const v = rng.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('不同种子产生不同序列', () => {
    const a = Array.from({ length: 50 }, ((r) => () => r.next())(mulberry32(1)));
    const b = Array.from({ length: 50 }, ((r) => () => r.next())(mulberry32(2)));
    expect(a).not.toEqual(b);
  });

  it('状态可保存与恢复', () => {
    const rng = mulberry32(999);
    for (let i = 0; i < 10; i += 1) rng.next();
    const saved = rng.getState();
    const expected = Array.from({ length: 20 }, () => rng.next());

    rng.setState(saved);
    const actual = Array.from({ length: 20 }, () => rng.next());
    expect(actual).toEqual(expected);
  });

  it('nextRange 落在闭区间内且可复现', () => {
    const rng = mulberry32(555);
    for (let i = 0; i < 2000; i += 1) {
      const v = rng.nextRange(8, 14);
      expect(v).toBeGreaterThanOrEqual(8);
      expect(v).toBeLessThanOrEqual(14);
      expect(Number.isInteger(v)).toBe(true);
    }
  });

  it('shuffle 不修改入参且同种子结果一致', () => {
    const input = [1, 2, 3, 4, 5, 6, 7, 8];
    const a = mulberry32(31).shuffle(input);
    const b = mulberry32(31).shuffle(input);
    expect(a).toEqual(b);
    expect(input).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(a.slice().sort()).toEqual(input);
  });

  it('pickWeighted 权重和为 0 时返回首项而不抛错', () => {
    const items = [{ weight: 0, id: 'a' }, { weight: 0, id: 'b' }];
    expect(mulberry32(1).pickWeighted(items).id).toBe('a');
  });
});

describe('deriveSeed 子种子派生（裁决 2）', () => {
  it('是纯函数：同输入必得同输出', () => {
    expect(deriveSeed(100, 'map', 3)).toBe(deriveSeed(100, 'map', 3));
    expect(deriveSeed(100, 'battle', 3, 'node_1_2', 0)).toBe(deriveSeed(100, 'battle', 3, 'node_1_2', 0));
  });

  it('不同维度组合产生不同子种子', () => {
    const seeds = new Set([
      deriveSeed(1, 'map', 1),
      deriveSeed(1, 'map', 2),
      deriveSeed(1, 'encounter', 1),
      deriveSeed(1, 'battle', 1, 'node_0_0', 0),
      deriveSeed(2, 'map', 1),
    ]);
    expect(seeds.size).toBe(5);
  });

  it('输出恒为 32 位无符号整数', () => {
    for (let i = 0; i < 500; i += 1) {
      const s = deriveSeed(i, 'x', i * 7);
      expect(Number.isInteger(s)).toBe(true);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(0xffffffff);
    }
  });

  it('三条流互不干扰：任一流的消费不影响其他流', () => {
    const seed = 777;
    // 地图流消费 1000 次
    const map = mapStream(seed, 1);
    for (let i = 0; i < 1000; i += 1) map.next();

    // 遭遇流与战斗流的首个输出不受影响
    expect(encounterStream(seed, 1, 'node_3_3').next()).toBe(
      encounterStream(seed, 1, 'node_3_3').next(),
    );
    expect(battleStream(seed, 1, 'node_3_3', 0).next()).toBe(
      battleStream(seed, 1, 'node_3_3', 0).next(),
    );
  });

  it('遭遇流按节点隔离：不同节点得到不同序列', () => {
    const a = encounterStream(5, 1, 'node_1_1').next();
    const b = encounterStream(5, 1, 'node_2_2').next();
    expect(a).not.toBe(b);
  });
});

describe('normalizeSeed', () => {
  it('数字字符串按数值解析', () => {
    expect(normalizeSeed('12345')).toBe(12345);
  });

  it('空输入返回 null', () => {
    expect(normalizeSeed('')).toBeNull();
    expect(normalizeSeed('   ')).toBeNull();
    expect(normalizeSeed(null)).toBeNull();
  });

  it('非数字字符串走哈希，且可复现', () => {
    const a = normalizeSeed('命运');
    const b = normalizeSeed('命运');
    expect(a).toBe(b);
    expect(Number.isInteger(a)).toBe(true);
  });

  it('负数被规范化为 32 位无符号', () => {
    const v = normalizeSeed('-1');
    expect(v).toBe(0xffffffff);
  });
});

describe('玩家初始属性', () => {
  it('同种子产生完全相同的属性', () => {
    const a = createPlayer(2024);
    const b = createPlayer(2024);
    expect(a.maxHp).toBe(b.maxHp);
    expect(a.attack).toBe(b.attack);
    expect(a.defense).toBe(b.defense);
  });

  it('1 级属性落在设计范围内（基线 + 种子浮动）', () => {
    for (const seed of [1, 99, 12345, 0xffffffff]) {
      const p = createPlayer(seed);
      expect(p.level).toBe(1);
      // PLAYER_BASE 320 + seedBonus 0~40
      expect(p.maxHp).toBeGreaterThanOrEqual(320);
      expect(p.maxHp).toBeLessThanOrEqual(360);
      // 34 + 0~4
      expect(p.attack).toBeGreaterThanOrEqual(34);
      expect(p.attack).toBeLessThanOrEqual(38);
      // 8 + 0~2
      expect(p.defense).toBeGreaterThanOrEqual(8);
      expect(p.defense).toBeLessThanOrEqual(10);
      expect(p.critChance).toBeCloseTo(0.05, 10);
    }
  });

  it('初始 hp 等于 maxHp', () => {
    const p = createPlayer(4242);
    expect(p.hp).toBe(p.maxHp);
  });

  it('时间字段使用到期时间戳而非倒计时（裁决 1）', () => {
    const p = createPlayer(1);
    expect(p.gcdReadyAtMs).toBe(0);
    expect(p.ogcdReadyAtMs).toBeInstanceOf(Map);
    expect(p).not.toHaveProperty('gcdCounter');
    expect(p).not.toHaveProperty('ogcdCooldowns');
  });
});

describe('初始状态与 Store', () => {
  it('同种子的初始状态逐字段相等（阶段 1 验收门）', () => {
    const a = createInitialState(31337);
    const b = createInitialState(31337);
    expect(stableStringify(a)).toBe(stableStringify(b));
  });

  it('不含视图状态字段（裁决 5）', () => {
    const state = createInitialState(1);
    expect(state).not.toHaveProperty('mapZoom');
    expect(state).not.toHaveProperty('mapOffsetX');
    expect(state).not.toHaveProperty('mapOffsetY');
  });

  it('getSnapshot 返回深冻结对象', () => {
    const store = new Store(createInitialState(1));
    const snap = store.getSnapshot();
    expect(Object.isFrozen(snap)).toBe(true);
    expect(Object.isFrozen(snap.player)).toBe(true);
    expect(() => {
      'use strict';
      snap.player.hp = 0;
    }).toThrow();
  });

  it('快照与内部状态隔离：修改内部不影响已取快照', () => {
    const store = new Store(createInitialState(1));
    const before = store.getSnapshot();
    store.update((draft) => {
      draft.player.hp = 1;
    });
    expect(before.player.hp).not.toBe(1);
    expect(store.getSnapshot().player.hp).toBe(1);
  });

  it('subscribe 收到通知，unsubscribe 后停止', () => {
    const store = new Store(createInitialState(1));
    let count = 0;
    const off = store.subscribe(() => {
      count += 1;
    });
    store.update((d) => {
      d.floorNumber = 2;
    });
    expect(count).toBe(1);
    off();
    store.update((d) => {
      d.floorNumber = 3;
    });
    expect(count).toBe(1);
  });

  it('update 禁止嵌套调用', () => {
    const store = new Store(createInitialState(1));
    expect(() =>
      store.update(() => {
        store.update(() => {});
      }),
    ).toThrow(/不可嵌套/);
  });

  it('updateSilent 不触发订阅者', () => {
    const store = new Store(createInitialState(1));
    let count = 0;
    store.subscribe(() => {
      count += 1;
    });
    store.updateSilent((d) => {
      d.floorNumber = 5;
    });
    expect(count).toBe(0);
    expect(store.unsafeGetState().floorNumber).toBe(5);
  });
});
