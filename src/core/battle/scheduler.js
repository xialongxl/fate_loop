/**
 * 战斗调度（规格 7.2 步骤 2~3，裁决 3）。
 *
 * 裁决 3 的关键：oGCD 抢占作用域是"每实体每步至多一个"，不是全局一个。
 * 平局打破用 (priority 降序, skillId 字典序) —— 字典序是必须的，否则同优先级
 * 技能的执行顺序会依赖 Map 迭代顺序，那是实现细节，不可依赖。
 */

import {
  advanceGcdIndex,
  currentGcdSkillId,
  isAlive,
  isGcdReady,
  isOgcdReady,
} from '../entity.js';
import { SKILL_RANGE } from '../constants.js';

/**
 * 为单个实体挑选本步要释放的 oGCD。
 * @returns {object|null} 选中的技能，无候选返回 null
 */
export function selectOgcd(entity, { skills, virtualTime, context, targets }) {
  if (entity.ogcdSlots.length === 0) return null;

  const candidates = [];
  for (const slot of entity.ogcdSlots) {
    const skill = skills.get(slot.skillId);
    if (skill === undefined) continue;
    if (!isOgcdReady(entity, slot.skillId, virtualTime)) continue;
    if (skill.condition !== null && !skill.condition(context, entity, targets)) continue;
    candidates.push({ skill, slot });
  }

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    // 槽位优先级优先于技能自带优先级：玩家的排序意图应当胜出
    const pa = a.slot.priority !== 0 ? a.slot.priority : a.skill.priority;
    const pb = b.slot.priority !== 0 ? b.slot.priority : b.skill.priority;
    if (pb !== pa) return pb - pa;
    return a.skill.id < b.skill.id ? -1 : a.skill.id > b.skill.id ? 1 : 0;
  });

  return candidates[0];
}

/** 按 range 解析目标列表。randomEnemy 消费一次战斗流随机数。 */
export function resolveTargets(skill, self, { allies, enemies, rng }) {
  const liveEnemies = enemies.filter(isAlive);
  const liveAllies = allies.filter(isAlive);

  switch (skill.range) {
    case SKILL_RANGE.SELF:
      return [self];
    case SKILL_RANGE.ALL_ENEMIES:
      return liveEnemies;
    case SKILL_RANGE.ALL_ALLIES:
      return liveAllies;
    case SKILL_RANGE.RANDOM_ENEMY:
      return liveEnemies.length === 0 ? [] : [liveEnemies[rng.nextInt(liveEnemies.length)]];
    case SKILL_RANGE.SINGLE:
    default:
      // 单体默认打第一个存活敌人：确定性且符合"自动战斗"预期
      return liveEnemies.length === 0 ? [] : [liveEnemies[0]];
  }
}

/**
 * 推进单个实体一步（规格 7.2 步骤 2~3）。
 * @returns {'ogcd'|'gcd'|'idle'} 本步该实体做了什么
 */
export function stepEntity(entity, { skills, virtualTime, context, allies, enemies, rng }) {
  if (!isAlive(entity)) return 'idle';

  const targetsForCondition = enemies.filter(isAlive);

  // 步骤 2：oGCD 扫描。命中则本步该实体不再推进 GCD（裁决 3）
  const picked = selectOgcd(entity, { skills, virtualTime, context, targets: targetsForCondition });
  if (picked !== null) {
    const { skill } = picked;
    const targets = resolveTargets(skill, entity, { allies, enemies, rng });
    skill.execute(context, entity, targets);
    entity.ogcdReadyAtMs.set(skill.id, virtualTime + skill.cooldownMs);
    entity.stats.skillsCast += 1;
    return 'ogcd';
  }

  // 步骤 3：GCD 处理
  if (!isGcdReady(entity, virtualTime)) return 'idle';

  const skillId = currentGcdSkillId(entity);
  if (skillId === null) return 'idle';
  const skill = skills.get(skillId);
  if (skill === undefined) {
    // 悬空技能 ID：跳过并推进指针，避免卡死。加载期的跨引用校验应已拦住此情况
    advanceGcdIndex(entity);
    return 'idle';
  }

  if (skill.condition !== null && !skill.condition(context, entity, targetsForCondition)) {
    // 条件不满足：推进指针，尝试序列中下一个技能，但本步不再行动
    advanceGcdIndex(entity);
    return 'idle';
  }

  const targets = resolveTargets(skill, entity, { allies, enemies, rng });
  skill.execute(context, entity, targets);
  entity.gcdReadyAtMs = virtualTime + skill.gcdCostMs;
  entity.stats.skillsCast += 1;
  advanceGcdIndex(entity);
  return 'gcd';
}
