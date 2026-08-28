/**
 * 测试用装配助手。
 * 用注入模组的方式绕过 import.meta.glob（Vitest 环境无 Vite 的 glob 转换）。
 */

import { Store } from '../src/core/store.js';
import { createInitialState } from '../src/core/initialState.js';
import { Registry } from '../src/contracts/registry.js';
import { registerDefaultContracts } from '../src/contracts/index.js';
import { BattleEngine } from '../src/core/battle/engine.js';
import { GameFlow } from '../src/core/game.js';
import { loadMods } from '../src/core/mods/loader.js';

import skillsManifest from '../src/mods/official/core-skills/manifest.js';
import * as skillsSetup from '../src/mods/official/core-skills/setup.js';
import monstersManifest from '../src/mods/official/core-monsters/manifest.js';
import * as monstersSetup from '../src/mods/official/core-monsters/setup.js';
import encountersManifest from '../src/mods/official/core-encounters/manifest.js';
import * as encountersSetup from '../src/mods/official/core-encounters/setup.js';
import mapManifest from '../src/mods/official/core-map/manifest.js';
import * as mapSetup from '../src/mods/official/core-map/setup.js';

/** 官方模组条目，模拟 import.meta.glob 的返回形状。 */
export function officialModuleEntries() {
  return [
    {
      path: '/src/mods/official/core-skills/manifest.js',
      loadManifest: async () => ({ default: skillsManifest }),
      loadSetup: async () => skillsSetup,
    },
    {
      path: '/src/mods/official/core-monsters/manifest.js',
      loadManifest: async () => ({ default: monstersManifest }),
      loadSetup: async () => monstersSetup,
    },
    {
      path: '/src/mods/official/core-encounters/manifest.js',
      loadManifest: async () => ({ default: encountersManifest }),
      loadSetup: async () => encountersSetup,
    },
    {
      path: '/src/mods/official/core-map/manifest.js',
      loadManifest: async () => ({ default: mapManifest }),
      loadSetup: async () => mapSetup,
    },
  ];
}

let cachedPool = null;

/** 加载官方内容池（跨测试缓存，加载是纯函数所以安全）。 */
export async function loadOfficialPool() {
  if (cachedPool !== null) return cachedPool;
  const registry = new Registry();
  const { pool } = await loadMods({ registry, modules: officialModuleEntries() });
  cachedPool = pool;
  return pool;
}

/**
 * 测试用开局序列。**必须全部是 1 级解锁的技能**：GameFlow.startBattle 会调
 * sanitizeSequence 把未解锁项踢出去，用高级技能当测试默认值会让"测的行为"
 * 悄悄变成"被清洗后剩下的那一两个技能"，白测。
 */
export const TEST_GCD_SEQUENCE = [
  'blade.jab',
  'fire.spark',
  'frost.shard',
  'shadow.touch',
  'thunder.spark',
  'order.emergencyCare',
];

export const TEST_OGCD_SLOTS = [
  { skillId: 'ogcd.secondWind', priority: 95 },
  { skillId: 'ogcd.suddenStrike', priority: 30 },
];

/**
 * 构造完整可用的引擎装配。
 * @param {object} [options]
 * @param {number} [options.seed]
 */
export async function createHarness({ seed = 123456789, gcdSequence, ogcdSlots, saveService = null } = {}) {
  const pool = await loadOfficialPool();
  const store = new Store(
    createInitialState(seed, {
      gcdSequence: gcdSequence ?? TEST_GCD_SEQUENCE,
      ogcdSlots: ogcdSlots ?? TEST_OGCD_SLOTS,
    }),
  );

  const registry = new Registry();
  let engine = null;
  registerDefaultContracts({
    store,
    getRng: () => engine.getRng(),
    getBuffTable: () => pool.buffs,
    getAudioSink: () => engine?.getAudioSink() ?? null,
    registry,
  });

  engine = new BattleEngine({ store, registry, pool });
  const flow = new GameFlow({ store, engine, pool, saveService, audio: null });

  return { store, registry, engine, flow, pool };
}

/** 提取用于确定性对比的终态摘要（剔除函数引用等不可比字段）。 */
export function battleFingerprint(snapshot) {
  return {
    virtualTime: snapshot.virtualTime,
    winner: snapshot.winner,
    reason: snapshot.battleEndReason,
    playerHp: snapshot.player.hp,
    playerStats: { ...snapshot.player.stats },
    monsterHps: snapshot.monsters.map((m) => m.hp),
    monsterStats: snapshot.monsters.map((m) => ({ ...m.stats })),
    totalDamage: snapshot.metadata.totalDamage,
    totalHeal: snapshot.metadata.totalHeal,
    emptyLoops: snapshot.metadata.emptyLoops,
    logMessages: snapshot.log.map((l) => `${l.t}|${l.message}`),
  };
}
