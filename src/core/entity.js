/**
 * 实体工厂（规格 5.2）。
 *
 * 时间字段全部采用"绝对到期时间戳"（裁决 1）：
 *   - gcdReadyAtMs      取代 gcdCounter
 *   - ogcdReadyAtMs     取代 ogcdCooldowns（存剩余值）
 *   - buffs[].expiresAtMs 取代 remainingMs
 * 只比较、不递减，因此 1x/4x/MAX 三种步长的结果逐位一致。
 */

import { FACTION, OGCD_SLOT_LIMIT } from './constants.js';
import { assertNonNegativeInteger, assertPositiveInteger, invariant } from '../utils/invariant.js';

/**
 * @param {object} spec
 * @param {string} spec.id
 * @param {string} spec.name
 * @param {number} spec.maxHp
 * @param {number} spec.attack
 * @param {number} spec.defense
 * @param {string} [spec.faction]
 * @param {string[]} [spec.gcdSequence]
 * @param {Array<{skillId:string, priority?:number}>} [spec.ogcdSlots]
 * @param {number} [spec.hp] 省略时等于 maxHp
 * @param {number} [spec.critChance] 暴击率（小数）。省略时由 damage 契约用默认值
 */
export function createEntity(spec) {
  invariant(typeof spec?.id === 'string' && spec.id !== '', '实体必须有非空 id');
  invariant(typeof spec.name === 'string' && spec.name !== '', `实体 ${spec.id} 必须有非空 name`);
  assertPositiveInteger(spec.maxHp, `实体 ${spec.id} 的 maxHp`);
  assertNonNegativeInteger(spec.attack, `实体 ${spec.id} 的 attack`);
  assertNonNegativeInteger(spec.defense, `实体 ${spec.id} 的 defense`);

  const gcdSequence = [...(spec.gcdSequence ?? [])];
  const ogcdSlots = (spec.ogcdSlots ?? []).slice(0, OGCD_SLOT_LIMIT).map((slot, index) => ({
    skillId: slot.skillId,
    priority: Number.isInteger(slot.priority) ? slot.priority : 0,
    slotIndex: index,
  }));

  const hp = spec.hp === undefined ? spec.maxHp : spec.hp;
  assertNonNegativeInteger(hp, `实体 ${spec.id} 的 hp`);

  return {
    id: spec.id,
    name: spec.name,
    faction: spec.faction ?? FACTION.MONSTER,
    maxHp: spec.maxHp,
    hp: Math.min(hp, spec.maxHp),
    attack: spec.attack,
    defense: spec.defense,
    /** 暴击率（小数）。damage 契约在未传显式 critChance 时读取此字段。 */
    critChance: Number.isFinite(spec.critChance) ? spec.critChance : 0.15,

    gcdSequence,
    /** 序列指针，指向下一个要释放的 GCD 技能。 */
    gcdIndex: 0,
    /** 绝对到期时间戳：virtualTime >= 此值即可行动。 */
    gcdReadyAtMs: 0,

    ogcdSlots,
    /** Map<skillId, readyAtMs> */
    ogcdReadyAtMs: new Map(),
    /** Map<buffId, { stacks, expiresAtMs }> */
    buffs: new Map(),

    /** 每实体独立统计，用于结算面板。 */
    stats: { damageDealt: 0, damageTaken: 0, healDone: 0, skillsCast: 0 },
  };
}

/** 实体是否存活。 */
export function isAlive(entity) {
  return entity.hp > 0;
}

/** GCD 是否就绪（裁决 1 的判定式）。 */
export function isGcdReady(entity, virtualTime) {
  return virtualTime >= entity.gcdReadyAtMs;
}

/** 指定 oGCD 是否就绪。未记录过视为就绪。 */
export function isOgcdReady(entity, skillId, virtualTime) {
  const readyAt = entity.ogcdReadyAtMs.get(skillId);
  return readyAt === undefined || virtualTime >= readyAt;
}

/** Buff 是否在场（惰性判定，无需每步递减）。 */
export function hasBuff(entity, buffId, virtualTime) {
  const buff = entity.buffs.get(buffId);
  return buff !== undefined && virtualTime < buff.expiresAtMs;
}

/** 取 Buff 层数，不在场返回 0。 */
export function getBuffStacks(entity, buffId, virtualTime) {
  const buff = entity.buffs.get(buffId);
  if (buff === undefined || virtualTime >= buff.expiresAtMs) return 0;
  return buff.stacks;
}

/**
 * 清理已过期 Buff。
 * 惰性判定已保证正确性，此函数只为控制 Map 体积，不影响逻辑结果。
 */
export function pruneExpiredBuffs(entity, virtualTime) {
  for (const [buffId, buff] of entity.buffs) {
    if (virtualTime >= buff.expiresAtMs) entity.buffs.delete(buffId);
  }
}

/** 取当前 GCD 序列指向的技能 ID。序列为空返回 null。 */
export function currentGcdSkillId(entity) {
  if (entity.gcdSequence.length === 0) return null;
  return entity.gcdSequence[entity.gcdIndex % entity.gcdSequence.length];
}

/** 推进 GCD 序列指针（循环队列）。 */
export function advanceGcdIndex(entity) {
  if (entity.gcdSequence.length === 0) return;
  entity.gcdIndex = (entity.gcdIndex + 1) % entity.gcdSequence.length;
}
