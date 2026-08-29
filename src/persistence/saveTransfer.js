/**
 * 存档导出 / 导入（单个 JSON 文件）。
 *
 * 为什么值得做：本作的一切都能靠"种子 + 内容指纹 + 序列"复现，但**玩家的进度本身**
 * 没法带走 —— 换浏览器、换机器、清缓存就没了。一个 JSON 文件是最省事的载体：
 * 可读、可 diff、可手工修（虽然我们不保证修坏后的体验）。
 *
 * 安全边界：导入的是**数据**，但它会直接进状态，所以必须逐项校验：
 *   · 拒绝非有限数（NaN/Infinity 会让血条与伤害算出 NaN 并一路传染）
 *   · 拒绝 `__proto__` / `constructor` / `prototype` 键（JSON.parse 会把它们当普通
 *     自有属性建出来，塞进 draft 后可能干扰属性查找）
 *   · 长度上限（防止一个 10 万条目的 inventory 把界面卡死）
 *   · schemaVersion 必须匹配（沿用 deserializeRun 的拒读语义）
 * 导入**不校验数值是否"合理"**（1 血通关 999 层是玩家自己的事），只校验形状。
 */

import { SCHEMA_VERSION } from '../core/constants.js';
import { levelFromTotalExp } from '../core/progression.js';
import { deserializeRun } from './schema.js';

export const EXPORT_FORMAT = 'fate-loop-save';
export const EXPORT_VERSION = 1;
/** 单文件最多能带几个槽位（"导出全部"用）。 */
export const MAX_RECORDS_PER_FILE = 8;

const LIMITS = Object.freeze({
  string: 400,
  array: 400,
  inventory: 200,
  slots: MAX_RECORDS_PER_FILE,
  statMax: 1e9,
});

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 递归找禁用键与非有限数。返回 null 表示干净。 */
function scanValue(value, path) {
  if (typeof value === 'number' && !Number.isFinite(value)) return `${path}：非有限数 ${String(value)}`;
  if (typeof value === 'string' && value.length > LIMITS.string) return `${path}：字符串过长`;
  if (Array.isArray(value)) {
    if (value.length > LIMITS.array) return `${path}：数组过长`;
    for (let i = 0; i < value.length; i += 1) {
      const problem = scanValue(value[i], `${path}[${i}]`);
      if (problem !== null) return problem;
    }
    return null;
  }
  if (isPlainObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(key)) return `${path}.${key}：禁用键`;
      const problem = scanValue(child, `${path}.${key}`);
      if (problem !== null) return problem;
    }
  }
  return null;
}

function nonNegativeInt(value, label, max = LIMITS.statMax) {
  if (!Number.isInteger(value) || value < 0 || value > max) return `${label} 必须是非负整数`;
  return null;
}

/** 校验一条 run（serializeRun 的形状）。返回错误信息或 null。 */
function validateRun(run) {
  if (!isPlainObject(run)) return 'run 必须是对象';
  if (run.schemaVersion !== SCHEMA_VERSION) {
    return `存档版本不兼容：文件为 v${String(run.schemaVersion)}，当前引擎为 v${SCHEMA_VERSION}`;
  }
  const checks = [
    nonNegativeInt(Number.isInteger(run.seed) ? run.seed : NaN, 'seed'),
    nonNegativeInt(run.floorNumber, 'floorNumber', 1_000_000) ?? (run.floorNumber < 1 ? 'floorNumber 至少为 1' : null),
    nonNegativeInt(run.exp, 'exp'),
    nonNegativeInt(run.fateShards, 'fateShards'),
  ].filter((x) => x !== null && x !== undefined);
  if (checks.length > 0) return checks[0];
  if (run.playerHp !== undefined && (!Number.isFinite(run.playerHp) || run.playerHp < 0)) return 'playerHp 非法';

  for (const key of ['gcdSequence', 'clearedNodeIds', 'visitedNodeIds']) {
    if (!Array.isArray(run[key])) return `${key} 必须是数组`;
    if (run[key].some((x) => typeof x !== 'string')) return `${key} 只能包含字符串`;
  }
  if (!Array.isArray(run.ogcdSlots)) return 'ogcdSlots 必须是数组';
  if (!isPlainObject(run.equipment)) return 'equipment 必须是对象';
  if (!Array.isArray(run.inventory)) return 'inventory 必须是数组';
  if (run.inventory.length > LIMITS.inventory) return `inventory 条目过多（上限 ${LIMITS.inventory}）`;

  for (const gear of [...Object.values(run.equipment), ...run.inventory]) {
    if (gear === null) continue;
    if (!isPlainObject(gear) || !isPlainObject(gear.stats)) return '装备结构非法';
    for (const [stat, value] of Object.entries(gear.stats)) {
      if (!Number.isFinite(value) || value < 0 || value > LIMITS.statMax) return `装备 ${stat} 非法`;
    }
  }
  return null;
}

/**
 * 把一条存档记录打包成可导出的对象。
 * @param {object} params
 * @param {string} params.slotId
 * @param {string} [params.label]
 * @param {object} params.record SaveService 读出的记录（{savedAt, contentHash, run}）
 */
export function buildExport({ slotId, label = null, record }) {
  return {
    format: EXPORT_FORMAT,
    exportVersion: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    slots: [
      {
        slotId,
        label,
        savedAt: record.savedAt ?? null,
        contentHash: record.contentHash ?? null,
        contentMods: record.contentMods ?? [],
        run: record.run ?? record.data ?? record,
      },
    ],
  };
}

/** 多个槽位打包成一个文件（"导出全部"）。 */
export function buildMultiExport(entries) {
  return {
    format: EXPORT_FORMAT,
    exportVersion: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    slots: entries.slice(0, MAX_RECORDS_PER_FILE).map((entry) => ({
      slotId: entry.slotId,
      label: entry.label ?? null,
      savedAt: entry.record.savedAt ?? null,
      contentHash: entry.record.contentHash ?? null,
      contentMods: entry.record.contentMods ?? [],
      run: entry.record.run ?? entry.record.data,
    })),
  };
}

/**
 * 解析并校验导入文本。
 * @returns {{ok:true, slots:Array}|{ok:false, reason:string}}
 */
export function parseImport(text) {
  if (typeof text !== 'string' || text.trim() === '') return { ok: false, reason: '文件是空的' };
  let payload;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    return { ok: false, reason: `不是合法的 JSON：${String(error?.message ?? error).slice(0, 120)}` };
  }
  const shapeProblem = scanValue(payload, '$');
  if (shapeProblem !== null) return { ok: false, reason: shapeProblem };
  if (!isPlainObject(payload)) return { ok: false, reason: '顶层必须是对象' };
  if (payload.format !== EXPORT_FORMAT) {
    return { ok: false, reason: `不是本游戏的存档文件（format=${String(payload.format)}）` };
  }
  if (payload.exportVersion !== EXPORT_VERSION) {
    return { ok: false, reason: `导出格式版本 ${String(payload.exportVersion)} 暂不支持` };
  }
  if (!Array.isArray(payload.slots) || payload.slots.length === 0) {
    return { ok: false, reason: '文件里没有槽位数据' };
  }
  if (payload.slots.length > MAX_RECORDS_PER_FILE) {
    return { ok: false, reason: `槽位数过多（上限 ${MAX_RECORDS_PER_FILE}）` };
  }
  for (const [index, slot] of payload.slots.entries()) {
    if (!isPlainObject(slot)) return { ok: false, reason: `第 ${index + 1} 个槽位不是对象` };
    if (typeof slot.slotId !== 'string' || slot.slotId === '') {
      return { ok: false, reason: `第 ${index + 1} 个槽位缺少 slotId` };
    }
    const problem = validateRun(slot.run);
    if (problem !== null) return { ok: false, reason: `槽位 ${slot.slotId}：${problem}` };
    // 走一遍既有的版本拒读逻辑，避免两套校验漂移
    try {
      deserializeRun(slot.run);
    } catch (error) {
      return { ok: false, reason: `槽位 ${slot.slotId}：${String(error?.message ?? error)}` };
    }
  }
  return { ok: true, slots: payload.slots };
}

/** 导入确认面板要展示的信息。 */
export function summarizeImportedSlot(slot) {
  return {
    slotId: slot.slotId,
    seed: slot.run?.seed,
    floorNumber: slot.run?.floorNumber,
    level: levelFromTotalExp(slot.run?.exp ?? 0),
    fateShards: slot.run?.fateShards,
    savedAt: slot.savedAt ?? null,
    contentHash: slot.contentHash ?? null,
  };
}
