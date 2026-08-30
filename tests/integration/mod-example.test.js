// @vitest-environment jsdom
/**
 * 模组管线的端到端验证：把 `src/mods/dev/example-pack/` 与官方内容一起加载。
 *
 * 为什么值得单独立一个文件：示例模组是"模组作者的文档"，文档烂掉没人会发现，
 * 除非有人真的把它加载一遍。这里同时验证三件事：
 *   1. 官方 + dev 一起进池，dev 排最后（覆盖优先级）
 *   2. 模组注册的新流派真的参与解锁轮转（否则 modder 加的技能全挤在最后）
 *   3. 加载期护栏会拦住坏模组（悬空引用、async execute、非 16ms 对齐时长）
 */

import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/main.js';
import { addPermanentBonus } from '../../src/core/derived.js';
import { Registry } from '../../src/contracts/registry.js';
import { registerDefaultContracts } from '../../src/contracts/index.js';
import { loadMods, createContentPool } from '../../src/core/mods/loader.js';
import { buildUnlockTable, familyOf } from '../../src/core/progression.js';
import { Store } from '../../src/core/store.js';
import { createInitialState } from '../../src/core/initialState.js';
import { BattleEngine } from '../../src/core/battle/engine.js';
import { nullAudio } from '../../src/ui/audio/nullAudio.js';
import { resetAdapterCache } from '../../src/persistence/storageAdapter.js';
import { SaveService } from '../../src/persistence/saveService.js';
import { SCREEN } from '../../src/core/constants.js';
import { officialModuleEntries } from '../helpers.js';

/** dev 示例模组的条目（形状与 import.meta.glob 一致）。 */
function devModuleEntries() {
  const dir = '/src/mods/dev/example-pack';
  return [
    {
      path: `${dir}/manifest.js`,
      dir,
      loadManifest: () => import('../../src/mods/dev/example-pack/manifest.js'),
      loadSetup: () => import('../../src/mods/dev/example-pack/setup.js'),
    },
  ];
}

/** 复刻 GameFlow#stateOps 的最小实现，用来直接调包里的 apply。 */
function makeOps(player) {
  return {
    permanentBonus: (bonus) => addPermanentBonus(player, bonus),
    shards: 0,
    gainShards: () => {},
    spendShards: () => false,
    setShards: () => {},
    healRatio: (r) => {
      player.hp = Math.min(player.maxHp, player.hp + Math.floor(player.maxHp * r));
    },
    hpCostRatio: () => {},
    fullHeal: () => {},
    addMetadata: () => {},
  };
}

/** 造一套「官方 + dev」的内容池（不启动引擎）。 */
async function loadWithDev() {
  const registry = new Registry();
  const store = new Store(createInitialState(1, { gcdSequence: [], ogcdSlots: [] }));
  registerDefaultContracts({
    store,
    getRng: () => null,
    getBuffTable: () => null,
    getAudioSink: () => null,
    registry,
  });
  return loadMods({ registry, modules: [...officialModuleEntries(), ...devModuleEntries()] });
}

/** 造一个坏模组条目，用于验证加载期护栏。 */
function badMod(id, setupFn) {
  return [
    {
      path: `/src/mods/dev/${id}/manifest.js`,
      dir: `/src/mods/dev/${id}`,
      loadManifest: async () => ({ default: { id, version: '1.0.0', provides: [], requires: [] } }),
      loadSetup: async () => ({ setup: setupFn }),
    },
  ];
}

describe('官方 + 示例模组一起加载', () => {
  it('dev 模组被加载且排在最后（覆盖优先级最低 ⇒ 它最后写）', async () => {
    const { loaded } = await loadWithDev();
    expect(loaded.map((m) => m.id)).toContain('dev.example-pack');
    expect(loaded.at(-1).id).toBe('dev.example-pack');
    expect(loaded).toHaveLength(5);
  });

  it('模组注册的新流派进池，并带上来源', async () => {
    const { pool } = await loadWithDev();
    expect(pool.families.get('void')).toEqual({ id: 'void', label: '虚空', source: 'dev.example-pack' });
    // 官方六个 + 模组一个
    expect(pool.families.size).toBe(7);
  });

  it('技能/Buff/怪物/遭遇/商品/事件全部注册，且 normalize 生效', async () => {
    const { pool } = await loadWithDev();

    const rift = pool.skills.get('void.rift');
    expect(rift).toBeDefined();
    expect(rift.gcdCostMs).toBe(2400); // 秒 → 毫秒
    expect(rift.source).toBe('dev.example-pack');

    const eclipse = pool.skills.get('void.eclipse');
    expect(eclipse.type).toBe('oGCD');
    expect(eclipse.cooldownMs).toBe(12000);
    expect(eclipse.gcdCostMs).toBe(0);

    expect(pool.skills.get('void.collapse').buffDurationMs).toBe(8000);
    expect(pool.buffs.get('void.mark').damageTakenMul).toBe(1.12);
    expect(pool.monsters.get('mon.void.riftling').gcdSequence).toContain('void.rift');
    expect(pool.encounters.get('enc.void.lone').maxFloor).toBe(999);
    expect(pool.shopItems.get('shop.void.core').kind).toBe('upgrade');
    expect(pool.events.get('event.void.altar').choices).toHaveLength(3);

    // ── S2b 新增能力：带记忆的机制 + onBattleStart + 地图生成器 ─────────────
    const debt = pool.skills.get('void.debt');
    expect(debt, '示例包应演示一个带记忆的技能').toBeDefined();
    expect(pool.mapGenerators.get('dev.example.grid'), '示例包应演示一个地图生成器').toBeDefined();
    // 刻意不叫 official.grid：示例包不该把开发时的地图换成小路
    expect(pool.mapGenerators.has('official.grid')).toBe(true);
    expect(pool.mapGenerators.get('official.grid').source).not.toBe('dev.example-pack');
  });

  it('模组技能引用的官方 ID 通过跨引用校验（怪物混编官方 + 自有技能）', async () => {
    // loadMods 内部会 validatePoolReferences，写错 ID 会直接抛
    await expect(loadWithDev()).resolves.toBeTruthy();
  });

  it('模组流派参与解锁轮转：1 级就能见到虚空系，且同族空档 ≤15 级', async () => {
    const { pool } = await loadWithDev();
    const table = buildUnlockTable(pool.skills, { families: [...pool.families.keys()] });
    const voidLevels = [...pool.skills.values()]
      .filter((s) => s.type === 'GCD' && familyOf(s, [...pool.families.keys()]) === 'void')
      .map((s) => table.get(s.id))
      .sort((a, b) => a - b);

    expect(voidLevels.length).toBeGreaterThanOrEqual(4);
    expect(voidLevels[0]).toBe(1); // 新流派第一个技能 1 级可得
    for (let i = 1; i < voidLevels.length; i += 1) {
      expect(voidLevels[i] - voidLevels[i - 1]).toBeLessThanOrEqual(15);
    }
    // 说明：不传 families 时，本例恰好也给出同样的等级 —— 因为 void 是唯一
    // 的 untagged 组，且 starter 名额会自动扩到流派数。所以这条不写成反例断言，
    // 真正的风险是"两个包都 untagged 时混成一桶"，那要等 S2 的多包场景再验。
  });

  it('示例怪物能真的打一场：契约伤害生效、日志有输出', async () => {
    const { pool } = await loadWithDev();
    const store = new Store(
      createInitialState(4242, { gcdSequence: ['void.rift', 'void.collapse', 'void.execute'], ogcdSlots: [] }),
    );
    const registry = new Registry();
    let engine = null;
    registerDefaultContracts({
      store,
      getRng: () => engine.getRng(),
      getBuffTable: () => pool.buffs,
      getAudioSink: () => nullAudio,
      registry,
    });
    engine = new BattleEngine({ store, registry, pool });
    engine.setAudioSinks({ live: nullAudio, silent: nullAudio });

    const monster = pool.monsters.get('mon.void.herald');
    expect(monster).toBeDefined();
    engine.begin({ nodeId: 'node_test', tier: 'elite' });
    store.update((d) => {
      d.monsters = [
        {
          id: 'm0',
          name: monster.name,
          faction: 'monster',
          maxHp: monster.maxHp,
          hp: monster.maxHp,
          attack: monster.attack,
          defense: monster.defense,
          critChance: 0.05,
          gcdSequence: [...monster.gcdSequence],
          gcdIndex: 0,
          gcdReadyAtMs: 0,
          ogcdSlots: monster.ogcdSlots.map((s, i) => ({ ...s, slotIndex: i })),
          ogcdReadyAtMs: new Map(),
          buffs: new Map(),
          stats: { damageDealt: 0, damageTaken: 0, healDone: 0, skillsCast: 0 },
        },
      ];
    });
    engine.runToEnd();

    const state = store.getSnapshot();
    expect(state.metadata.totalDamage).toBeGreaterThan(0);
    expect(['player', 'monsters']).toContain(state.winner);
  });

  it('模组商品的永久加成撑得过重算（与官方同一条铁律）', async () => {
    const { pool } = await loadWithDev();
    const { recalcPlayer } = await import('../../src/core/derived.js');
    const player = createInitialState(7).player;
    const before = { maxHp: player.maxHp, attack: player.attack };

    const ops = makeOps(player);
    pool.shopItems.get('shop.void.core').apply({ player, fateShards: 100, metadata: {} }, ops);
    recalcPlayer(player);

    expect(player.maxHp).toBe(before.maxHp + 25);
    expect(player.attack).toBe(before.attack + 5);
    expect(player.permanentBonus).toMatchObject({ maxHp: 25, attack: 5 });
  });
});

describe('加载期护栏（坏模组必须当场失败）', () => {
  it('悬空引用：怪物引用不存在的技能', async () => {
    const registry = new Registry();
    const store = new Store(createInitialState(1, { gcdSequence: [], ogcdSlots: [] }));
    registerDefaultContracts({ store, getRng: () => null, getBuffTable: () => null, getAudioSink: () => null, registry });

    await expect(
      loadMods({
        registry,
        modules: [
          ...officialModuleEntries(),
          ...badMod('broken-ref', () => ({
            monsters: [
              {
                id: 'mon.broken',
                name: '坏',
                maxHp: 10,
                attack: 1,
                defense: 0,
                gcdSequence: ['skill.that.does.not.exist'],
              },
            ],
          })),
        ],
      }),
    ).rejects.toThrow(/悬空引用/);
  });

  it('async execute 被拒绝（战斗逻辑必须同步）', async () => {
    const registry = new Registry();
    const store = new Store(createInitialState(1, { gcdSequence: [], ogcdSlots: [] }));
    registerDefaultContracts({ store, getRng: () => null, getBuffTable: () => null, getAudioSink: () => null, registry });

    await expect(
      loadMods({
        registry,
        modules: [
          ...officialModuleEntries(),
          ...badMod('broken-async', () => ({
            skills: [
              {
                id: 'bad.async',
                name: '异步',
                type: 'GCD',
                gcdCost: 2.4,
                range: 'single',
                async execute() {},
              },
            ],
          })),
        ],
      }),
    ).rejects.toThrow(/不能是 async/);
  });

  it('非 16ms 对齐的时长被拒绝（裁决 4）', async () => {
    const registry = new Registry();
    const store = new Store(createInitialState(1, { gcdSequence: [], ogcdSlots: [] }));
    registerDefaultContracts({ store, getRng: () => null, getBuffTable: () => null, getAudioSink: () => null, registry });

    await expect(
      loadMods({
        registry,
        modules: [
          ...officialModuleEntries(),
          ...badMod('broken-ms', () => ({
            skills: [
              {
                id: 'bad.ms',
                name: '不对齐',
                type: 'GCD',
                gcdCost: 2.501, // 2501 % 16 !== 0
                range: 'single',
                execute() {},
              },
            ],
          })),
        ],
      }),
    ).rejects.toThrow(/16|对齐|STEP/);
  });

  it('零效果的 Buff 被拒绝', async () => {
    const registry = new Registry();
    const store = new Store(createInitialState(1, { gcdSequence: [], ogcdSlots: [] }));
    registerDefaultContracts({ store, getRng: () => null, getBuffTable: () => null, getAudioSink: () => null, registry });

    await expect(
      loadMods({
        registry,
        modules: [...officialModuleEntries(), ...badMod('broken-buff', () => ({ buffs: [{ id: 'buff.noop', name: '空' }] }))],
      }),
    ).rejects.toThrow(/未声明任何修正/);
  });

  it('模组 id 重复被拒绝', async () => {
    const registry = new Registry();
    const store = new Store(createInitialState(1, { gcdSequence: [], ogcdSlots: [] }));
    registerDefaultContracts({ store, getRng: () => null, getBuffTable: () => null, getAudioSink: () => null, registry });

    await expect(
      loadMods({ registry, modules: [...devModuleEntries(), ...devModuleEntries()] }),
    ).rejects.toThrow(/模组 id 重复/);
  });
});

describe('应用能带着示例模组跑起来', () => {
  it('图鉴的流派筛选里出现「虚空」', async () => {
    resetAdapterCache();
    document.body.innerHTML = '<div id="app"></div>';
    const cleaner = new SaveService();
    await cleaner.init();
    await cleaner.clearAll();

    const app = await createApp({
      root: document.querySelector('#app'),
      seed: 20240101,
      modules: [...officialModuleEntries(), ...devModuleEntries()],
      audio: nullAudio,
    });
    app.startNewRun(20240101);
    app.router.go(SCREEN.CODEX);

    const families = [...app.screens[SCREEN.CODEX].element.querySelectorAll('[data-family]')].map((b) =>
      b.getAttribute('data-family'),
    );
    expect(families).toContain('void');

    // 选中新流派后只剩它的技能（筛选按钮会被重绘，所以点完要重新取元素）
    const before = app.screens[SCREEN.CODEX].element.querySelectorAll('.codex-item').length;
    app.screens[SCREEN.CODEX].element
      .querySelector('[data-family="void"]')
      .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    const rows = app.screens[SCREEN.CODEX].element.querySelectorAll('.codex-item');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(before);
    expect(
      app.screens[SCREEN.CODEX].element.querySelector('[data-family="void"]').className,
    ).toContain('is-active');
    app.destroy();
  });

  it('内容池为空时 createContentPool 仍是合法形状（给测试与工具用）', () => {
    const pool = createContentPool();
    expect(pool.families.size).toBe(0);
    expect(pool.skills.size).toBe(0);
  });
});
