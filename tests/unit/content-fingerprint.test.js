/**
 * 内容指纹（S1）单测。
 *
 * 指纹的意义：结果 = f(种子, 序列, 内容池)。装 mod 或改数值后光有种子不够，
 * 所以指纹必须稳定（同内容必同哈希）、灵敏（改内容必变哈希）、
 * 且不受 Map 插入顺序影响（本项目一贯的确定性纪律）。
 */

import { describe, expect, it } from 'vitest';
import {
  computeContentFingerprint,
  contentShape,
  fingerprintMatches,
  formatFingerprint,
} from '../../src/persistence/contentFingerprint.js';
import { createContentPool, loadMods } from '../../src/core/mods/loader.js';
import { Registry } from '../../src/contracts/registry.js';
import { Store } from '../../src/core/store.js';
import { createInitialState } from '../../src/core/initialState.js';
import { registerDefaultContracts } from '../../src/contracts/index.js';
import { officialModuleEntries } from '../helpers.js';

async function officialPool() {
  const registry = new Registry();
  const store = new Store(createInitialState(1, { gcdSequence: [], ogcdSlots: [] }));
  registerDefaultContracts({
    store,
    getRng: () => null,
    getBuffTable: () => null,
    getAudioSink: () => null,
    registry,
  });
  return (await loadMods({ registry, modules: officialModuleEntries() })).pool;
}

describe('稳定性与灵敏度', () => {
  it('同一内容池两次计算得到同一指纹', async () => {
    const pool = await officialPool();
    const a = computeContentFingerprint(pool, { mods: [{ id: 'official.core-skills', version: '1.0.0' }] });
    const b = computeContentFingerprint(pool, { mods: [{ id: 'official.core-skills', version: '1.0.0' }] });
    expect(a.hash).toBe(b.hash);
    expect(a.hash).toMatch(/^[0-9a-f]{8}$/);
  });

  it('模组 version 变了 ⇒ 指纹变（行为改动的唯一捕获手段，函数体不参与哈希）', async () => {
    const pool = await officialPool();
    const before = computeContentFingerprint(pool, { mods: [{ id: 'm', version: '1.0.0' }] });
    const after = computeContentFingerprint(pool, { mods: [{ id: 'm', version: '1.0.1' }] });
    expect(after.hash).not.toBe(before.hash);
  });

  it('改一个数值字段 ⇒ 指纹变', async () => {
    const pool = await officialPool();
    const base = computeContentFingerprint(pool);
    expect(pool.skills.get('blade.jab').gcdCostMs).toBe(1600); // 断言前提，别改这个数
    const tampered = { ...pool, skills: new Map(pool.skills) };
    const skill = { ...tampered.skills.get('blade.jab'), gcdCostMs: 1616 };
    tampered.skills.set('blade.jab', skill);
    expect(computeContentFingerprint(tampered).hash).not.toBe(base.hash);
  });

  it('新增一个技能 ⇒ 指纹变', async () => {
    const pool = await officialPool();
    const base = computeContentFingerprint(pool);
    const tampered = { ...pool, skills: new Map(pool.skills) };
    tampered.skills.set('mod.new', {
      id: 'mod.new',
      type: 'GCD',
      source: 'mod',
      gcdCostMs: 1600,
      cooldownMs: 0,
      range: 'single',
      power: 1,
      tags: [],
      condition: null,
      buffId: null,
      execute: () => {},
    });
    expect(computeContentFingerprint(tampered).hash).not.toBe(base.hash);
  });

  it('Map 插入顺序不影响指纹', async () => {
    const pool = await officialPool();
    const forward = computeContentFingerprint(pool);
    const reversed = {
      ...pool,
      skills: new Map([...pool.skills.entries()].reverse()),
      monsters: new Map([...pool.monsters.entries()].reverse()),
    };
    expect(computeContentFingerprint(reversed).hash).toBe(forward.hash);
  });

  it('Infinity（遭遇 maxFloor）不会把 JSON 变成 null 而静默丢字段', async () => {
    const pool = createContentPool();
    pool.encounters.set('e1', {
      id: 'e1',
      tier: 'normal',
      monsterIds: ['m1'],
      minFloor: 1,
      maxFloor: Number.POSITIVE_INFINITY,
      weight: 10,
      source: 'x',
    });
    const shape = contentShape(pool);
    expect(JSON.stringify(shape)).toContain('∞');
    expect(computeContentFingerprint(pool).hash).toMatch(/^[0-9a-f]{8}$/);
  });

  it('空池与官方池指纹不同，且 counts 报得出条目数', async () => {
    const empty = computeContentFingerprint(createContentPool());
    const official = computeContentFingerprint(await officialPool());
    expect(empty.hash).not.toBe(official.hash);
    expect(official.counts.skills).toBe(90);
    expect(official.counts.monsters).toBe(300);
    expect(formatFingerprint(official)).toContain('90 技能');
  });

  it('未登记的产物种类改了也不会静默 —— 通过 SHAPE_KINDS 覆盖检查', async () => {
    const pool = await officialPool();
    const shape = contentShape(pool);
    // 内容池里每个 Map 都必须被指纹覆盖，否则改它不会反映到哈希上
    for (const [key, value] of Object.entries(pool)) {
      if (value instanceof Map) expect(shape, `产物种类 ${key} 未纳入指纹`).toHaveProperty(key);
    }
  });
});

describe('fingerprintMatches 三态', () => {
  it('一致 / 不一致 / 老存档没有字段', () => {
    expect(fingerprintMatches({ contentHash: 'aaaa1111' }, 'aaaa1111').status).toBe('match');
    expect(fingerprintMatches({ contentHash: 'bbbb2222' }, 'aaaa1111')).toMatchObject({
      status: 'mismatch',
      saved: 'bbbb2222',
      current: 'aaaa1111',
    });
    expect(fingerprintMatches({}, 'aaaa1111').status).toBe('unknown');
    expect(fingerprintMatches(null, 'aaaa1111').status).toBe('unknown');
  });
});
