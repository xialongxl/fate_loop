/**
 * 局内成长：等级、经验、技能解锁（阶段 8）。
 *
 * 作用域是「局内」——每局从 1 级重开，死亡即清空（用户决定 run_only）。
 * 因此本模块不碰持久化，只提供纯函数 + 一个写状态的 grantExp。
 *
 * 确定性：全为纯整数/纯函数运算，不消费随机数。等级只由累计经验决定，
 * 因此存档只需存 exp 一个字段，level 可随时重算 —— 二者不可能不一致。
 */

import {
  EXP_CURVE,
  EXP_REWARD,
  GROWTH_PER_LEVEL,
  MAX_LEVEL,
  PLAYER_BASE,
  SKILL_TYPE,
  SKILL_UNLOCK_MAX_LEVEL,
  STARTER_GCD_COUNT,
  STARTER_OGCD_COUNT,
} from './constants.js';

/**
 * 升到「下一级」所需经验（即从 level 升到 level+1）。
 *
 * 三段式：低段 1.14 倍增，中段 1.11，高段 1.08。段间用「接续上一段末值」而非
 * 重新起算，避免 Fate_echo 那种在分段点出现断崖的问题。
 *
 * @param {number} level 当前等级
 * @returns {number} 所需经验；已满级返回 Infinity
 */
export function expToNextLevel(level) {
  const lv = Math.max(1, Math.floor(level) || 1);
  if (lv >= MAX_LEVEL) return Infinity;

  const { BASE, EARLY_MAX, EARLY_RATE, MID_MAX, MID_RATE, LATE_RATE } = EXP_CURVE;

  if (lv < EARLY_MAX) {
    return Math.floor(BASE * EARLY_RATE ** (lv - 1));
  }
  // 40 级时的低段末值，作为中段起点
  const earlyEnd = BASE * EARLY_RATE ** (EARLY_MAX - 1);
  if (lv < MID_MAX) {
    return Math.floor(earlyEnd * MID_RATE ** (lv - EARLY_MAX + 1));
  }
  const midEnd = earlyEnd * MID_RATE ** (MID_MAX - EARLY_MAX + 1);
  return Math.floor(midEnd * LATE_RATE ** (lv - MID_MAX + 1));
}

/** 从 1 级累计到指定等级所需的总经验。 */
export function totalExpForLevel(level) {
  const target = Math.min(MAX_LEVEL, Math.max(1, Math.floor(level) || 1));
  let total = 0;
  for (let lv = 1; lv < target; lv += 1) total += expToNextLevel(lv);
  return total;
}

/** 累计经验 → 等级。单调、纯函数，是 level 的唯一真相来源。 */
export function levelFromTotalExp(totalExp) {
  const exp = Math.max(0, Math.floor(totalExp) || 0);
  let level = 1;
  let consumed = 0;
  while (level < MAX_LEVEL) {
    const need = expToNextLevel(level);
    if (exp - consumed < need) break;
    consumed += need;
    level += 1;
  }
  return level;
}

/**
 * 等级对应的基础属性（不含装备与 Buff）。
 * @returns {{maxHp:number, attack:number, defense:number, critChance:number}}
 */
export function baseStatsAtLevel(level) {
  const lv = Math.min(MAX_LEVEL, Math.max(1, Math.floor(level) || 1));
  const n = lv - 1;
  return {
    maxHp: PLAYER_BASE.maxHp + n * GROWTH_PER_LEVEL.maxHp,
    attack: PLAYER_BASE.attack + n * GROWTH_PER_LEVEL.attack,
    defense: PLAYER_BASE.defense + n * GROWTH_PER_LEVEL.defense,
    critChance: PLAYER_BASE.critChance + (n * GROWTH_PER_LEVEL.crit) / 100,
  };
}

/** 当前等级内的经验进度，用于 UI 进度条。 */
export function expProgress(totalExp) {
  const level = levelFromTotalExp(totalExp);
  const consumed = totalExpForLevel(level);
  const need = expToNextLevel(level);
  const current = Math.max(0, Math.floor(totalExp) || 0) - consumed;
  return {
    level,
    current,
    need: need === Infinity ? 0 : need,
    ratio: need === Infinity ? 1 : Math.min(1, current / need),
    maxed: level >= MAX_LEVEL,
  };
}

/**
 * 战斗胜利的经验奖励。纯函数，不消费随机数 —— 奖励必须可预期。
 * @param {object} params
 * @param {number} params.monsterCount
 * @param {number} params.floorNumber
 * @param {boolean} params.isElite
 */
export function battleExpReward({ monsterCount, floorNumber, isElite }) {
  const floorScale = 1 + (Math.max(1, floorNumber) - 1) * EXP_REWARD.FLOOR_SCALE;
  const base = EXP_REWARD.PER_MONSTER * Math.max(1, monsterCount) * floorScale;
  return Math.max(1, Math.floor(base * (isElite ? EXP_REWARD.ELITE_MULTIPLIER : 1)));
}

/**
 * 技能解锁等级表。
 *
 * 排序键必须稳定且与内容池的 Map 插入顺序无关，否则同一份内容在不同加载顺序下
 * 会算出不同的解锁等级。每类内部用 (代价, id) 二级排序：GCD 看 gcdCostMs、
 * oGCD 看 cooldownMs，代价相同按 id 字典序 —— 「代价低者先解锁」。
 *
 * 名额按类型分开（STARTER_GCD_COUNT / STARTER_OGCD_COUNT）：前若干名落在 1 级，
 * 其余在同类型内在 [2, SKILL_UNLOCK_MAX_LEVEL] 上均匀铺开。
 * 不混类排（曾经混类排）：那会把全部 oGCD 顶到 79 级之后。
 *
 * 类型不认识的技能（模组乱填）一律 1 级可用 —— 未知不限制，宁放不拦。
 *
 * @param {Map<string, object>} skills 内容池技能表
 * @returns {Map<string, number>} skillId → 解锁等级
 */
export function buildUnlockTable(skills) {
  const table = new Map();
  const all = [...skills.values()];

  const buckets = [
    { type: SKILL_TYPE.GCD, starter: STARTER_GCD_COUNT, cost: (s) => s.gcdCostMs ?? 0 },
    { type: SKILL_TYPE.OGCD, starter: STARTER_OGCD_COUNT, cost: (s) => s.cooldownMs ?? 0 },
  ];

  const claimed = new Set();
  for (const { type, starter, cost } of buckets) {
    const list = all
      .filter((skill) => skill.type === type && !claimed.has(skill.id))
      .sort((a, b) => {
        if (cost(a) !== cost(b)) return cost(a) - cost(b);
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      });
    for (const skill of list) claimed.add(skill.id);

    const gated = Math.max(0, list.length - starter);
    const span = SKILL_UNLOCK_MAX_LEVEL - 1;
    list.forEach((skill, index) => {
      if (index < starter) {
        table.set(skill.id, 1);
        return;
      }
      // 第 i 个受限技能落在 2 .. SKILL_UNLOCK_MAX_LEVEL 上
      const i = index - starter + 1;
      const level = gated <= 1 ? SKILL_UNLOCK_MAX_LEVEL : 1 + Math.ceil((i * span) / gated);
      table.set(skill.id, Math.min(SKILL_UNLOCK_MAX_LEVEL, Math.max(2, level)));
    });
  }

  // 未知类型（模组写错 type）不设门槛：拦了会在战斗里造成永久空转
  for (const skill of all) {
    if (!claimed.has(skill.id)) table.set(skill.id, 1);
  }

  return table;
}

/** 技能在给定等级是否已解锁。未在表中的技能视为已解锁（模组自定义技能不受限）。 */
export function isSkillUnlocked(unlockTable, skillId, level) {
  const required = unlockTable.get(skillId);
  return required === undefined || level >= required;
}

/** 给定等级下已解锁的技能 ID 集合。 */
export function unlockedSkillIds(unlockTable, skills, level) {
  const ids = [];
  for (const skillId of skills.keys()) {
    if (isSkillUnlocked(unlockTable, skillId, level)) ids.push(skillId);
  }
  return ids.sort();
}
