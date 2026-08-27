/**
 * 模组加载六步法（规格 9.2）。
 *
 * 1. 发现     import.meta.glob 扫描 manifest
 * 2. 依赖提取  加载 manifest，构建 requires → provides 图
 * 3. 循环检测  有环则详细报错并终止
 * 4. 拓扑排序  Kahn，依赖先行
 * 5. 实例化    按序执行 setup，注册产物
 * 6. 覆盖裁决  后加载覆盖先加载，mods/dev 排最后
 *
 * 任一模组抛错则整体加载失败（不做部分加载）—— 部分加载会产生悬空 ID 引用，
 * 比直接失败更难排查。
 */

import { ModLoadError } from '../../utils/invariant.js';
import { CONTRACT_MAP } from '../../contracts/symbols.js';
import { validateManifest } from './manifest.js';
import { applyPriority, topoSort } from './graph.js';
import {
  normalizeBuff,
  normalizeEncounter,
  normalizeEvent,
  normalizeMonster,
  normalizeShopItem,
  normalizeSkill,
} from './normalize.js';

/** 全局内容池。加载完成后冻结。 */
export function createContentPool() {
  return {
    skills: new Map(),
    buffs: new Map(),
    monsters: new Map(),
    encounters: new Map(),
    shopItems: new Map(),
    events: new Map(),
    mapGenerators: new Map(),
  };
}

/**
 * 步骤 1：发现模组。
 * 浏览器环境用 import.meta.glob；测试环境由调用方直接注入 modules。
 */
async function discoverModules(injected) {
  if (injected !== undefined) return injected;

  // eager: false → 返回 () => Promise<Module>，按拓扑序惰性加载
  const manifestGlob = import.meta.glob('/src/mods/**/manifest.js');
  const setupGlob = import.meta.glob('/src/mods/**/{setup,index}.js');

  const entries = [];
  for (const [path, loadManifest] of Object.entries(manifestGlob)) {
    const dir = path.slice(0, path.lastIndexOf('/'));
    const setupPath =
      Object.keys(setupGlob).find((p) => p === `${dir}/setup.js`) ??
      Object.keys(setupGlob).find((p) => p === `${dir}/index.js`);
    if (setupPath === undefined) {
      throw new ModLoadError(`模组目录 ${dir} 缺少 setup.js 或 index.js`, { dir });
    }
    entries.push({ path, dir, loadManifest, loadSetup: setupGlob[setupPath] });
  }
  return entries;
}

/**
 * @param {object} deps
 * @param {import('../../contracts/registry.js').Registry} deps.registry
 * @param {Array} [deps.modules] 测试注入的模组条目
 * @returns {Promise<{pool:object, loaded:Array}>}
 */
export async function loadMods({ registry, modules } = {}) {
  const entries = await discoverModules(modules);

  // 步骤 2：加载全部 manifest
  const manifests = [];
  const setupByModId = new Map();
  for (const entry of entries) {
    let manifestModule;
    try {
      manifestModule = await entry.loadManifest();
    } catch (cause) {
      throw new ModLoadError(`无法加载 manifest：${entry.path}`, { path: entry.path, cause: String(cause) });
    }
    const manifest = validateManifest(manifestModule.default ?? manifestModule, entry.path);
    if (setupByModId.has(manifest.id)) {
      throw new ModLoadError(`模组 id 重复：${manifest.id}`, { id: manifest.id });
    }
    manifests.push(manifest);
    setupByModId.set(manifest.id, entry.loadSetup);
  }

  // 步骤 3 + 4：循环检测与拓扑排序（在 topoSort 内完成）
  const sorted = applyPriority(topoSort(manifests));

  // 步骤 5 + 6：按序实例化，后加载覆盖先加载
  const pool = createContentPool();
  const loaded = [];

  for (const manifest of sorted) {
    const loadSetup = setupByModId.get(manifest.id);
    let setupModule;
    try {
      setupModule = await loadSetup();
    } catch (cause) {
      throw new ModLoadError(`无法加载 setup：${manifest.path}`, { id: manifest.id, cause: String(cause) });
    }

    const setup = setupModule.setup ?? setupModule.default;
    if (typeof setup !== 'function') {
      throw new ModLoadError(`模组 ${manifest.id} 必须导出 setup 函数`, { id: manifest.id });
    }

    let result;
    try {
      result = setup({
        registry,
        contracts: CONTRACT_MAP,
        modId: manifest.id,
        log: (msg) => console.info(`[mod:${manifest.id}] ${msg}`),
      });
    } catch (cause) {
      throw new ModLoadError(`模组 ${manifest.id} 的 setup 执行失败：${String(cause)}`, {
        id: manifest.id,
        cause: String(cause),
      });
    }

    mergeIntoPool(pool, result ?? {}, manifest.id);
    loaded.push({ id: manifest.id, version: manifest.version, path: manifest.path });
  }

  validatePoolReferences(pool);
  return { pool, loaded };
}

/** 步骤 6：合并产物，后者覆盖前者。 */
function mergeIntoPool(pool, result, modId) {
  for (const skill of result.skills ?? []) {
    pool.skills.set(skill.id, normalizeSkill(skill, modId));
  }
  for (const buff of result.buffs ?? []) {
    pool.buffs.set(buff.id, normalizeBuff(buff, modId));
  }
  for (const monster of result.monsters ?? []) {
    pool.monsters.set(monster.id, normalizeMonster(monster, modId));
  }
  for (const encounter of result.encounters ?? []) {
    pool.encounters.set(encounter.id, normalizeEncounter(encounter, modId));
  }
  for (const item of result.shopItems ?? []) {
    pool.shopItems.set(item.id, normalizeShopItem(item, modId));
  }
  for (const event of result.events ?? []) {
    pool.events.set(event.id, normalizeEvent(event, modId));
  }
  for (const generator of result.mapGenerators ?? []) {
    pool.mapGenerators.set(generator.id, generator);
  }
}

/**
 * 跨引用校验：怪物的技能、遭遇的怪物都必须存在。
 * 这是阶段 7d 的验收项之一（无悬空 ID）。
 */
export function validatePoolReferences(pool) {
  const problems = [];

  for (const monster of pool.monsters.values()) {
    for (const skillId of monster.gcdSequence) {
      if (!pool.skills.has(skillId)) {
        problems.push(`怪物 ${monster.id} 引用了不存在的技能 ${skillId}`);
      }
    }
    for (const slot of monster.ogcdSlots) {
      if (!pool.skills.has(slot.skillId)) {
        problems.push(`怪物 ${monster.id} 的 oGCD 槽引用了不存在的技能 ${slot.skillId}`);
      }
    }
  }

  // 技能引用的 Buff 必须已注册 —— 否则 resolveModifiers 会静默忽略，
  // 技能看上去生效但实际零效果，这种 bug 极难发现。
  for (const skill of pool.skills.values()) {
    if (skill.buffId !== null && !pool.buffs.has(skill.buffId)) {
      problems.push(`技能 ${skill.id} 引用了未注册的 Buff ${skill.buffId}`);
    }
  }

  for (const encounter of pool.encounters.values()) {
    for (const monsterId of encounter.monsterIds) {
      if (!pool.monsters.has(monsterId)) {
        problems.push(`遭遇 ${encounter.id} 引用了不存在的怪物 ${monsterId}`);
      }
    }
  }

  if (problems.length > 0) {
    throw new ModLoadError(`内容池存在 ${problems.length} 处悬空引用`, { problems: problems.slice(0, 20) });
  }
  return true;
}
