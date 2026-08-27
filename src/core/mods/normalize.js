/**
 * authoring → runtime 规范化（裁决 4）。
 *
 * 模组作者以秒书写（cooldown: 3.0），加载时转为整数毫秒并强制校验必须是
 * STEP_MS 的整数倍。这条硬约束让"步长推进"与"到期时间戳比较"永远等价 ——
 * 是跨速度模式确定性的根基。
 */

import { SKILL_RANGE, SKILL_TYPE, STEP_MS } from '../constants.js';
import { ModLoadError } from '../../utils/invariant.js';

/** 秒 → 整数毫秒，并校验为 STEP_MS 的整数倍。 */
function toStepAlignedMs(seconds, label, context) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) {
    throw new ModLoadError(`${label} 必须是非负有限数（单位：秒），实际为 ${String(seconds)}`, context);
  }
  const ms = Math.round(seconds * 1000);
  if (ms % STEP_MS !== 0) {
    throw new ModLoadError(
      `${label} 换算为 ${ms}ms，不是 ${STEP_MS}ms 的整数倍。请改为 ${
        Math.round(ms / STEP_MS) * STEP_MS
      }ms（${(Math.round(ms / STEP_MS) * STEP_MS) / 1000} 秒）以保证确定性`,
      { ...context, seconds, ms },
    );
  }
  return ms;
}

const VALID_RANGES = new Set(Object.values(SKILL_RANGE));

/** 规范化单个技能定义。返回冻结的 runtime 形态。 */
export function normalizeSkill(skill, source) {
  const context = { skillId: skill?.id, source };

  if (typeof skill?.id !== 'string' || skill.id === '') {
    throw new ModLoadError('技能必须有非空 id', context);
  }
  if (skill.type !== SKILL_TYPE.GCD && skill.type !== SKILL_TYPE.OGCD) {
    throw new ModLoadError(`技能 ${skill.id} 的 type 必须是 'GCD' 或 'oGCD'`, context);
  }
  if (typeof skill.execute !== 'function') {
    throw new ModLoadError(`技能 ${skill.id} 必须提供 execute 函数`, context);
  }
  if (skill.execute.constructor.name === 'AsyncFunction') {
    throw new ModLoadError(`技能 ${skill.id} 的 execute 不能是 async（规格 5.3）`, context);
  }
  if (skill.condition !== undefined && skill.condition !== null && typeof skill.condition !== 'function') {
    throw new ModLoadError(`技能 ${skill.id} 的 condition 必须是函数或 null`, context);
  }
  const range = skill.range ?? SKILL_RANGE.SINGLE;
  if (!VALID_RANGES.has(range)) {
    throw new ModLoadError(`技能 ${skill.id} 的 range 非法：${String(range)}`, context);
  }

  const normalized = {
    id: skill.id,
    name: skill.name ?? skill.id,
    description: skill.description ?? '',
    type: skill.type,
    range,
    priority: Number.isInteger(skill.priority) ? skill.priority : 0,
    power: Number.isFinite(skill.power) ? skill.power : 0,
    tags: Object.freeze([...(skill.tags ?? [])]),
    condition: skill.condition ?? null,
    execute: skill.execute,
    soundId: skill.soundId ?? null,
    buffId: typeof skill.buffId === 'string' ? skill.buffId : null,
    source,
  };

  if (skill.type === SKILL_TYPE.GCD) {
    // GCD 技能：gcdCost 必填（秒）
    normalized.gcdCostMs = toStepAlignedMs(skill.gcdCost ?? 2.5, `技能 ${skill.id} 的 gcdCost`, context);
    normalized.cooldownMs = 0;
  } else {
    // oGCD 技能：cooldown 必填（秒），不占 GCD
    normalized.cooldownMs = toStepAlignedMs(skill.cooldown ?? 30, `技能 ${skill.id} 的 cooldown`, context);
    normalized.gcdCostMs = 0;
  }

  if (skill.buffDuration !== undefined) {
    normalized.buffDurationMs = toStepAlignedMs(
      skill.buffDuration,
      `技能 ${skill.id} 的 buffDuration`,
      context,
    );
  }

  return Object.freeze(normalized);
}

/** 规范化怪物定义。 */
export function normalizeMonster(monster, source) {
  const context = { monsterId: monster?.id, source };
  if (typeof monster?.id !== 'string' || monster.id === '') {
    throw new ModLoadError('怪物必须有非空 id', context);
  }
  for (const field of ['maxHp', 'attack', 'defense']) {
    if (!Number.isInteger(monster[field]) || monster[field] < 0) {
      throw new ModLoadError(`怪物 ${monster.id} 的 ${field} 必须是非负整数`, context);
    }
  }
  if (!Array.isArray(monster.gcdSequence) || monster.gcdSequence.length === 0) {
    throw new ModLoadError(`怪物 ${monster.id} 必须提供非空 gcdSequence`, context);
  }

  return Object.freeze({
    id: monster.id,
    name: monster.name ?? monster.id,
    maxHp: monster.maxHp,
    attack: monster.attack,
    defense: monster.defense,
    gcdSequence: Object.freeze([...monster.gcdSequence]),
    ogcdSlots: Object.freeze((monster.ogcdSlots ?? []).map((s) => Object.freeze({ ...s }))),
    tier: monster.tier ?? 'normal',
    tags: Object.freeze([...(monster.tags ?? [])]),
    source,
  });
}

/** 规范化遭遇模板。 */
export function normalizeEncounter(encounter, source) {
  const context = { encounterId: encounter?.id, source };
  if (typeof encounter?.id !== 'string' || encounter.id === '') {
    throw new ModLoadError('遭遇模板必须有非空 id', context);
  }
  if (!Array.isArray(encounter.monsterIds) || encounter.monsterIds.length === 0) {
    throw new ModLoadError(`遭遇模板 ${encounter.id} 必须提供非空 monsterIds`, context);
  }
  if (encounter.monsterIds.length > 6) {
    throw new ModLoadError(`遭遇模板 ${encounter.id} 的怪物数不得超过 6（规格 7.1）`, context);
  }

  return Object.freeze({
    id: encounter.id,
    name: encounter.name ?? encounter.id,
    tier: encounter.tier ?? 'normal',
    monsterIds: Object.freeze([...encounter.monsterIds]),
    minFloor: Number.isInteger(encounter.minFloor) ? encounter.minFloor : 1,
    maxFloor: Number.isInteger(encounter.maxFloor) ? encounter.maxFloor : Number.MAX_SAFE_INTEGER,
    weight: Number.isFinite(encounter.weight) ? encounter.weight : 10,
    source,
  });
}

/**
 * 规范化 Buff 定义。
 * 乘数字段均为可选，但至少得有一个 —— 一个什么都不做的 Buff 删一个本体。
 */
export function normalizeBuff(buff, source) {
  const context = { buffId: buff?.id, source };
  if (typeof buff?.id !== 'string' || buff.id === '') {
    throw new ModLoadError('Buff 必须有非空 id', context);
  }

  const MUL_FIELDS = ['attackMul', 'defenseMul', 'damageTakenMul', 'damageDealtMul', 'healMul'];
  const normalized = {
    id: buff.id,
    name: buff.name ?? buff.id,
    description: buff.description ?? '',
    isDebuff: buff.isDebuff === true,
    source,
  };

  let hasEffect = false;
  for (const field of MUL_FIELDS) {
    const value = buff[field];
    if (value === undefined) continue;
    if (!Number.isFinite(value) || value < 0) {
      throw new ModLoadError(`Buff ${buff.id} 的 ${field} 必须是非负有限数`, context);
    }
    normalized[field] = value;
    hasEffect = true;
  }

  if (!hasEffect) {
    throw new ModLoadError(
      `Buff ${buff.id} 未声明任何修正（${MUL_FIELDS.join(' / ')} 至少需一项）`,
      context,
    );
  }

  return Object.freeze(normalized);
}

/** 规范化商店商品。 */
export function normalizeShopItem(item, source) {
  const context = { itemId: item?.id, source };
  if (typeof item?.id !== 'string' || item.id === '') {
    throw new ModLoadError('商店商品必须有非空 id', context);
  }
  if (!Number.isInteger(item.cost) || item.cost < 0) {
    throw new ModLoadError(`商店商品 ${item.id} 的 cost 必须是非负整数`, context);
  }
  if (typeof item.apply !== 'function') {
    throw new ModLoadError(`商店商品 ${item.id} 必须提供 apply 函数`, context);
  }

  return Object.freeze({
    id: item.id,
    name: item.name ?? item.id,
    description: item.description ?? '',
    cost: item.cost,
    kind: item.kind ?? 'buff',
    weight: Number.isFinite(item.weight) ? item.weight : 10,
    apply: item.apply,
    source,
  });
}

/** 规范化事件定义。 */
export function normalizeEvent(event, source) {
  const context = { eventId: event?.id, source };
  if (typeof event?.id !== 'string' || event.id === '') {
    throw new ModLoadError('事件必须有非空 id', context);
  }
  if (!Array.isArray(event.choices) || event.choices.length === 0) {
    throw new ModLoadError(`事件 ${event.id} 必须提供非空 choices`, context);
  }
  for (const choice of event.choices) {
    if (typeof choice.apply !== 'function') {
      throw new ModLoadError(`事件 ${event.id} 的选项 ${String(choice.label)} 必须提供 apply 函数`, context);
    }
  }

  return Object.freeze({
    id: event.id,
    name: event.name ?? event.id,
    text: event.text ?? '',
    weight: Number.isFinite(event.weight) ? event.weight : 10,
    choices: Object.freeze(
      event.choices.map((c) =>
        Object.freeze({ label: c.label ?? '继续', description: c.description ?? '', apply: c.apply }),
      ),
    ),
    source,
  });
}

export { toStepAlignedMs };
