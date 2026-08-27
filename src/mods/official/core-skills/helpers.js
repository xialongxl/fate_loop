/**
 * 技能构造助手。
 *
 * 目的：把"调用契约"这件事收敛到少数几个工厂函数里，让 60+ 技能定义保持声明式，
 * 同时保证所有副作用都走契约（规格 8.1）。
 *
 * 单位约定（裁决 4）：此处一律以秒书写，normalize 阶段转整数毫秒并校验 16ms 对齐。
 */

import { SKILL_RANGE, SKILL_TYPE } from '../../../core/constants.js';
import { SOUND_IDS } from '../../../ui/audio/soundMap.js';

/** 常用 GCD 时长（秒），全部为 16ms 的整数倍。 */
export const GCD = Object.freeze({
  FAST: 1.6,
  NORMAL: 2.4,
  SLOW: 3.2,
  HEAVY: 4.0,
});

/** 常用 oGCD 冷却（秒）。 */
export const CD = Object.freeze({
  SHORT: 12,
  MID: 30,
  LONG: 60,
  ULTIMATE: 120,
});

/**
 * 伤害型技能工厂。
 * @param {object} spec
 * @param {number} spec.multiplier 攻击力倍率
 */
export function damageSkill({
  id,
  name,
  description,
  type = SKILL_TYPE.GCD,
  gcdCost = GCD.NORMAL,
  cooldown,
  range = SKILL_RANGE.SINGLE,
  multiplier = 1,
  priority = 0,
  tags = [],
  condition = null,
  soundId = SOUND_IDS.HIT,
  onHit = null,
}) {
  return {
    id,
    name,
    description,
    type,
    gcdCost,
    cooldown,
    range,
    priority,
    tags,
    condition,
    soundId,
    power: multiplier,
    execute(context, self, targets) {
      const damage = context.get(SYM.damageApply);
      const audio = context.get(SYM.audioPlay);
      for (const target of targets) {
        const result = damage({
          sourceId: self.id,
          targetId: target.id,
          amount: self.attack * multiplier,
        });
        audio({ soundId: result.isCrit ? SOUND_IDS.CRIT : soundId });
        if (onHit !== null) onHit(context, self, target, result);
      }
    },
  };
}

/** 治疗型技能工厂。 */
export function healSkill({
  id,
  name,
  description,
  type = SKILL_TYPE.GCD,
  gcdCost = GCD.NORMAL,
  cooldown,
  range = SKILL_RANGE.SELF,
  ratio = 0.2,
  priority = 0,
  tags = [],
  condition = null,
}) {
  return {
    id,
    name,
    description,
    type,
    gcdCost,
    cooldown,
    range,
    priority,
    tags,
    condition,
    soundId: SOUND_IDS.HEAL,
    power: ratio,
    execute(context, self, targets) {
      const heal = context.get(SYM.healApply);
      const audio = context.get(SYM.audioPlay);
      const pool = targets.length === 0 ? [self] : targets;
      for (const target of pool) {
        heal({ sourceId: self.id, targetId: target.id, amount: target.maxHp * ratio });
      }
      audio({ soundId: SOUND_IDS.HEAL });
    },
  };
}

/** Buff 型技能工厂。 */
export function buffSkill({
  id,
  name,
  description,
  type = SKILL_TYPE.OGCD,
  gcdCost,
  cooldown = CD.MID,
  range = SKILL_RANGE.SELF,
  buffId,
  stacks = 1,
  buffDuration = 16,
  priority = 0,
  tags = [],
  condition = null,
}) {
  return {
    id,
    name,
    description,
    type,
    gcdCost,
    cooldown,
    range,
    priority,
    tags,
    condition,
    buffDuration,
    buffId,
    soundId: SOUND_IDS.BUFF,
    power: stacks,
    execute(context, self, targets) {
      const applyBuff = context.get(SYM.buffApply);
      const audio = context.get(SYM.audioPlay);
      const pool = range === SKILL_RANGE.SELF || targets.length === 0 ? [self] : targets;
      for (const target of pool) {
        applyBuff({
          targetId: target.id,
          buffId,
          stacks,
          durationMs: Math.round(buffDuration * 1000),
        });
      }
      audio({ soundId: SOUND_IDS.BUFF });
    },
  };
}

/** 伤害 + Buff 组合技能。 */
export function damageBuffSkill({
  id,
  name,
  description,
  type = SKILL_TYPE.GCD,
  gcdCost = GCD.NORMAL,
  cooldown,
  range = SKILL_RANGE.SINGLE,
  multiplier = 1,
  buffId,
  stacks = 1,
  buffDuration = 16,
  buffOnTarget = true,
  priority = 0,
  tags = [],
  condition = null,
}) {
  return {
    id,
    name,
    description,
    type,
    gcdCost,
    cooldown,
    range,
    priority,
    tags,
    condition,
    buffDuration,
    buffId,
    soundId: SOUND_IDS.HIT,
    power: multiplier,
    execute(context, self, targets) {
      const damage = context.get(SYM.damageApply);
      const applyBuff = context.get(SYM.buffApply);
      const audio = context.get(SYM.audioPlay);
      const durationMs = Math.round(buffDuration * 1000);

      for (const target of targets) {
        const result = damage({ sourceId: self.id, targetId: target.id, amount: self.attack * multiplier });
        audio({ soundId: result.isCrit ? SOUND_IDS.CRIT : SOUND_IDS.HIT });
        if (buffOnTarget) {
          applyBuff({ targetId: target.id, buffId, stacks, durationMs });
        }
      }
      if (!buffOnTarget) {
        applyBuff({ targetId: self.id, buffId, stacks, durationMs });
      }
    },
  };
}

/** 吸血型技能：造成伤害并按比例回复自身。 */
export function drainSkill({
  id,
  name,
  description,
  type = SKILL_TYPE.GCD,
  gcdCost = GCD.SLOW,
  cooldown,
  range = SKILL_RANGE.SINGLE,
  multiplier = 1,
  drainRatio = 0.4,
  priority = 0,
  tags = [],
  condition = null,
}) {
  return {
    id,
    name,
    description,
    type,
    gcdCost,
    cooldown,
    range,
    priority,
    tags,
    condition,
    soundId: SOUND_IDS.HIT,
    power: multiplier,
    execute(context, self, targets) {
      const damage = context.get(SYM.damageApply);
      const heal = context.get(SYM.healApply);
      const audio = context.get(SYM.audioPlay);
      let drained = 0;
      for (const target of targets) {
        const result = damage({ sourceId: self.id, targetId: target.id, amount: self.attack * multiplier });
        drained += result.dealt;
        audio({ soundId: result.isCrit ? SOUND_IDS.CRIT : SOUND_IDS.HIT });
      }
      if (drained > 0) {
        heal({ sourceId: self.id, targetId: self.id, amount: drained * drainRatio });
      }
    },
  };
}

/** 条件谓词助手。 */
export const when = Object.freeze({
  /** 自身生命低于比例。 */
  hpBelow: (ratio) => (context, self) => self.hp / self.maxHp < ratio,
  /** 自身生命高于比例。 */
  hpAbove: (ratio) => (context, self) => self.hp / self.maxHp > ratio,
  /** 敌人数量不少于 n。 */
  enemiesAtLeast: (n) => (context, self, targets) => targets.length >= n,
  /** 目标生命低于比例（取第一个目标）。 */
  targetHpBelow: (ratio) => (context, self, targets) =>
    targets.length > 0 && targets[0].hp / targets[0].maxHp < ratio,
  /** 虚拟时间已过 n 秒。 */
  afterSeconds: (n) => (context) => context.virtualTime >= n * 1000,
  /** 自身没有指定 Buff。 */
  lacksBuff: (buffId) => (context, self) => {
    const buff = self.buffs.get(buffId);
    return buff === undefined || context.virtualTime >= buff.expiresAtMs;
  },
  /** 自身持有指定 Buff。 */
  hasBuff: (buffId) => (context, self) => {
    const buff = self.buffs.get(buffId);
    return buff !== undefined && context.virtualTime < buff.expiresAtMs;
  },
  /** 组合：全部成立。 */
  all: (...predicates) => (context, self, targets) => predicates.every((p) => p(context, self, targets)),
  /** 组合：任一成立。 */
  any: (...predicates) => (context, self, targets) => predicates.some((p) => p(context, self, targets)),
});

/** 契约 Symbol 短名，供上面的工厂使用。 */
const SYM = Object.freeze({
  damageApply: Symbol.for('fate.contract.damage.apply'),
  healApply: Symbol.for('fate.contract.heal.apply'),
  stateQuery: Symbol.for('fate.contract.state.query'),
  prngNext: Symbol.for('fate.contract.prng.next'),
  buffApply: Symbol.for('fate.contract.buff.apply'),
  combatLog: Symbol.for('fate.contract.combat.log'),
  audioPlay: Symbol.for('fate.contract.audio.play'),
});

export { SYM };
