/**
 * 内容指纹（S1）。
 *
 * 为什么必须有：本作的一切结果都是 `f(种子, 序列, 内容池)`。今天内容池等于"这个
 * 构建"，所以种子就够了；一旦允许装 mod（或有人 fork 改了官方数值），两个人种子相同
 * 也可能打出完全不同的局 —— "抄种子复现"这个立项卖点会静默失效。
 *
 * 指纹 = 内容池形状 + 模组清单 + 构建标识 的哈希，8 位十六进制。
 * 它要出现在：头部、存档记录、历史战绩、结算面板。
 *
 * ⚠️ 一个必须说清的局限：**函数体不参与哈希**。
 *   - 生产构建会 minify，函数文本每次都变，哈希会假报警
 *   - 因此行为改动的捕获靠两件事：模组自己 bump version，以及运行时包的 sha256
 *     （S2 提供 —— 那是对整个包字节的哈希，连代码一起算）
 *   - 换句话说：构建期模组"改了逻辑没改 version"是**骗得过指纹**的，这是已知代价，
 *     不是遗漏。第三方包不受此影响，因为它的 sha256 覆盖一切。
 */

import { BUILD_TAG, SCHEMA_VERSION } from '../core/constants.js';
import { fnv1a } from '../core/prng.js';
import { mapToEntries } from '../utils/serialize.js';

/** 参与哈希的池成员种类。新增一种产物就加一行，否则它改了也不会反映到指纹上。 */
const SHAPE_KINDS = Object.freeze([
  'skills',
  'buffs',
  'monsters',
  'encounters',
  'shopItems',
  'events',
  'families',
  'mapGenerators',
]);

function shapeOfMap(map) {
  return mapToEntries(map).map(([id, item]) => {
    const out = { id, source: item?.source ?? null };
    for (const [key, value] of Object.entries(item ?? {})) {
      if (key === 'id' || key === 'source') continue;
      if (typeof value === 'function') continue; // 见文件头的局限说明
      if (typeof value === 'number' && !Number.isFinite(value)) {
        out[key] = value === Number.POSITIVE_INFINITY ? '∞' : 'x';
        continue;
      }
      if (Array.isArray(value)) out[key] = value.map((v) => (typeof v === 'function' ? 'fn' : v));
      else out[key] = value;
    }
    return out;
  });
}

/**
 * 内容池的规范化形状。顺序稳定：Map 按 key 排序，tags 之类数组也排序。
 * @param {object} pool createContentPool + loadMods 的结果
 */
export function contentShape(pool) {
  const shape = {};
  for (const kind of SHAPE_KINDS) {
    shape[kind] = pool?.[kind] instanceof Map ? shapeOfMap(pool[kind]) : [];
  }
  return shape;
}

/**
 * 算内容指纹。
 * @param {object} pool 内容池
 * @param {object} [options]
 * @param {Array<{id:string, version:string}>} [options.mods] 已加载模组清单
 * @param {Array<{id:string, version:string, sha256?:string}>} [options.packs] 已启用的运行时包（S2）
 * @returns {{hash:string, mods:Array, packs:Array, counts:Record<string,number>}}
 */
export function computeContentFingerprint(pool, { mods = [], packs = [] } = {}) {
  const sortedMods = [...mods]
    .map((m) => ({ id: String(m.id), version: String(m.version ?? '0') }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const sortedPacks = [...packs]
    .map((p) => ({ id: String(p.id), version: String(p.version ?? '0'), sha256: p.sha256 ?? null }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const shape = contentShape(pool);
  const counts = Object.fromEntries(Object.entries(shape).map(([kind, list]) => [kind, list.length]));

  const payload = JSON.stringify({
    schema: SCHEMA_VERSION,
    build: BUILD_TAG,
    mods: sortedMods,
    packs: sortedPacks,
    shape,
  });

  return {
    hash: fnv1a(payload).toString(16).padStart(8, '0'),
    mods: sortedMods,
    packs: sortedPacks,
    counts,
  };
}

/** 给 UI 用的一行摘要，例如 `a1b2c3d4 · 5 模组 · 技能 95`。 */
export function formatFingerprint(fingerprint) {
  const skillCount = fingerprint.counts.skills ?? 0;
  return `${fingerprint.hash} · ${fingerprint.mods.length} 模组 · ${skillCount} 技能`;
}

/**
 * 存档指纹与当前指纹是否一致。
 * 老存档没有这个字段（S1 之前写的）—— 按"未知"处理并提示一次，而不是当成不匹配。
 */
export function fingerprintMatches(record, currentHash) {
  const saved = record?.contentHash;
  if (saved === undefined || saved === null) return { status: 'unknown', saved: null, current: currentHash };
  if (saved === currentHash) return { status: 'match', saved, current: currentHash };
  return { status: 'mismatch', saved, current: currentHash };
}
