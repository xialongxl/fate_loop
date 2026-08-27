/**
 * Mulberry32 PRNG + 子种子派生（裁决 2）。
 *
 * 铁律：这是整个项目唯一的随机性来源。除 randomSeed() 外，本文件不接触任何
 * 物理时钟。randomSeed() 只在"玩家未输入种子"时调用一次，产出后立即丢弃时钟依赖。
 */

import { assertNonNegativeInteger } from '../utils/invariant.js';

/** 32 位无符号规范化。 */
function toUint32(n) {
  return n >>> 0;
}

/**
 * Mulberry32：32 位整数状态，纯整数运算，跨平台逐位一致。
 * @param {number} seed 32 位整数种子
 */
export function mulberry32(seed) {
  let state = toUint32(seed);

  function next() {
    state = toUint32(state + 0x6d2b79f5);
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  return {
    next,
    /** 返回 [0, max) 的整数。 */
    nextInt(max) {
      if (!Number.isInteger(max) || max <= 0) {
        throw new TypeError(`nextInt 的 max 必须是正整数，实际为 ${String(max)}`);
      }
      return Math.floor(next() * max);
    },
    /** 返回 [min, max] 闭区间整数。 */
    nextRange(min, max) {
      if (!Number.isInteger(min) || !Number.isInteger(max) || max < min) {
        throw new TypeError(`nextRange 参数非法：[${String(min)}, ${String(max)}]`);
      }
      return min + Math.floor(next() * (max - min + 1));
    },
    /** 概率判定。 */
    chance(p) {
      return next() < p;
    },
    /**
     * 按权重挑选。items 为 [{ weight, ... }]，返回选中项。
     * 权重和为 0 时返回第一项（而非抛错），保证生成流程不中断。
     */
    pickWeighted(items) {
      if (!Array.isArray(items) || items.length === 0) {
        throw new TypeError('pickWeighted 需要非空数组');
      }
      let total = 0;
      for (const item of items) total += item.weight;
      if (total <= 0) return items[0];
      let roll = next() * total;
      for (const item of items) {
        roll -= item.weight;
        if (roll < 0) return item;
      }
      return items[items.length - 1];
    },
    /** 从数组中等概率挑选一个元素。 */
    pick(array) {
      if (!Array.isArray(array) || array.length === 0) {
        throw new TypeError('pick 需要非空数组');
      }
      return array[Math.floor(next() * array.length)];
    },
    /**
     * Fisher-Yates 原地洗牌。返回新数组，不修改入参。
     * 确定性：同状态同输入必得同输出。
     */
    shuffle(array) {
      const out = array.slice();
      for (let i = out.length - 1; i > 0; i -= 1) {
        const j = Math.floor(next() * (i + 1));
        const tmp = out[i];
        out[i] = out[j];
        out[j] = tmp;
      }
      return out;
    },
    getState() {
      return state;
    },
    setState(n) {
      state = toUint32(assertNonNegativeInteger(n, 'prng state'));
    },
  };
}

/** FNV-1a 32 位哈希，用于把字符串混入种子。 */
function fnv1a(str) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return toUint32(hash);
}

/**
 * 子种子派生（裁决 2 的核心）：纯函数，无状态。
 *
 * 这是"探索顺序不影响生成结果"的保证：地图流、遭遇流、战斗流各自从
 * (baseSeed, ...parts) 独立派生，玩家来回走动不会改变任何一条流的消费序列。
 *
 * @param {number} baseSeed 主种子
 * @param {...(string|number)} parts 派生维度（层号、节点 ID、尝试序号等）
 * @returns {number} 32 位整数子种子
 */
export function deriveSeed(baseSeed, ...parts) {
  let hash = toUint32(baseSeed) ^ 0x9e3779b9;
  for (const part of parts) {
    const chunk = typeof part === 'number' ? toUint32(part) : fnv1a(String(part));
    hash ^= chunk;
    hash = Math.imul(hash, 0x85ebca6b);
    hash = toUint32(hash ^ (hash >>> 13));
  }
  hash = Math.imul(hash, 0xc2b2ae35);
  hash = toUint32(hash ^ (hash >>> 16));
  // 避免 0 状态（Mulberry32 在 0 上仍可用，但规避特殊值更稳）
  return hash === 0 ? 0x1a2b3c4d : hash;
}

/** 地图流：按层派生。同种子同层，布局恒定。 */
export function mapStream(baseSeed, floorNumber) {
  return mulberry32(deriveSeed(baseSeed, 'map', floorNumber));
}

/** 遭遇流：按层+节点派生。同节点的怪物配置/商店商品恒定，与到访顺序无关。 */
export function encounterStream(baseSeed, floorNumber, nodeId) {
  return mulberry32(deriveSeed(baseSeed, 'encounter', floorNumber, nodeId));
}

/** 战斗流：按层+节点+尝试序号派生。 */
export function battleStream(baseSeed, floorNumber, nodeId, attemptIndex = 0) {
  return mulberry32(deriveSeed(baseSeed, 'battle', floorNumber, nodeId, attemptIndex));
}

/** 玩家初始属性流。 */
export function playerStream(baseSeed) {
  return mulberry32(deriveSeed(baseSeed, 'player'));
}

/**
 * 生成一个随机主种子。
 *
 * 这是全项目唯一允许触碰物理时钟的位置（规格 6.1）：Date.now() 混合一次后
 * 立即丢弃，之后所有随机性都由产出的整数种子驱动。
 */
export function randomSeed() {
  // 本文件已在 eslint.config.js 中单独放宽 Date.now，无需 inline disable
  const now = Date.now();
  return deriveSeed(toUint32(now), 'bootstrap', toUint32(now >>> 7));
}

/** 校验并规范化用户输入的种子。 */
export function normalizeSeed(input) {
  if (typeof input === 'number' && Number.isFinite(input)) {
    return toUint32(Math.trunc(input));
  }
  const text = String(input ?? '').trim();
  if (text === '') return null;
  if (/^-?\d+$/.test(text)) {
    const parsed = Number(text);
    if (Number.isSafeInteger(parsed)) return toUint32(parsed);
  }
  // 非数字输入：作为字符串哈希，让玩家能用"某个词"当种子
  return fnv1a(text);
}

export { fnv1a, toUint32 };
