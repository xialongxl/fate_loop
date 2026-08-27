/**
 * 阶段 8 成长系统单测：经验曲线、等级派生、技能解锁表。
 *
 * 重点验证「单一数据源」不变量：level 完全由 exp 决定，任何路径下二者不可能不一致。
 */

import { describe, expect, it } from 'vitest';
import {
  baseStatsAtLevel,
  battleExpReward,
  buildUnlockTable,
  expProgress,
  expToNextLevel,
  isSkillUnlocked,
  levelFromTotalExp,
  totalExpForLevel,
  unlockedSkillIds,
} from '../../src/core/progression.js';
import {
  EXP_CURVE,
  GROWTH_PER_LEVEL,
  MAX_LEVEL,
  PLAYER_BASE,
  STARTER_SKILL_COUNT,
} from '../../src/core/constants.js';
import { loadOfficialPool } from '../helpers.js';

describe('经验曲线', () => {
  it('1 级所需经验等于 BASE', () => {
    expect(expToNextLevel(1)).toBe(EXP_CURVE.BASE);
  });

  it('严格单调递增（不存在“升级变便宜”的层级）', () => {
    for (let lv = 1; lv < MAX_LEVEL - 1; lv += 1) {
      expect(expToNextLevel(lv + 1)).toBeGreaterThan(expToNextLevel(lv));
    }
  });

  it('分段点不产生断崖：段首增幅不超过段内平均增幅的 2 倍', () => {
    // 40 级与 80 级是分段点。用「相邻两级比值」检查连续性
    for (const boundary of [EXP_CURVE.EARLY_MAX, EXP_CURVE.MID_MAX]) {
      const ratioAtBoundary = expToNextLevel(boundary) / expToNextLevel(boundary - 1);
      expect(ratioAtBoundary).toBeGreaterThan(1);
      expect(ratioAtBoundary).toBeLessThan(1.3);
    }
  });

  it('满级后所需经验为 Infinity', () => {
    expect(expToNextLevel(MAX_LEVEL)).toBe(Infinity);
    expect(expToNextLevel(MAX_LEVEL + 50)).toBe(Infinity);
  });

  it('非法入参回退到 1 级', () => {
    expect(expToNextLevel(0)).toBe(EXP_CURVE.BASE);
    expect(expToNextLevel(-5)).toBe(EXP_CURVE.BASE);
    expect(expToNextLevel(Number.NaN)).toBe(EXP_CURVE.BASE);
  });
});

describe('等级派生（exp 是唯一真相源）', () => {
  it('0 经验为 1 级', () => {
    expect(levelFromTotalExp(0)).toBe(1);
    expect(levelFromTotalExp(-100)).toBe(1);
  });

  it('恰好达到阈值即升级，差 1 点不升级', () => {
    const need = expToNextLevel(1);
    expect(levelFromTotalExp(need - 1)).toBe(1);
    expect(levelFromTotalExp(need)).toBe(2);
  });

  it('totalExpForLevel 与 levelFromTotalExp 互为逆运算', () => {
    for (const level of [1, 2, 5, 17, 40, 41, 79, 80, 81, 119, MAX_LEVEL]) {
      const total = totalExpForLevel(level);
      expect(levelFromTotalExp(total)).toBe(level);
      if (level > 1) {
        // 再差 1 点就应该停在上一级（1 级无上一级，跳过）
        expect(levelFromTotalExp(total - 1)).toBe(level - 1);
      }
    }
  });

  it('经验封顶在满级，超额经验不再提升等级', () => {
    const maxTotal = totalExpForLevel(MAX_LEVEL);
    expect(levelFromTotalExp(maxTotal)).toBe(MAX_LEVEL);
    expect(levelFromTotalExp(maxTotal * 10)).toBe(MAX_LEVEL);
  });

  it('是单调函数：经验增加时等级不会下降', () => {
    let previous = 1;
    for (let exp = 0; exp < 200_000; exp += 977) {
      const level = levelFromTotalExp(exp);
      expect(level).toBeGreaterThanOrEqual(previous);
      previous = level;
    }
  });
});

describe('等级属性', () => {
  it('1 级等于 PLAYER_BASE', () => {
    const stats = baseStatsAtLevel(1);
    expect(stats.maxHp).toBe(PLAYER_BASE.maxHp);
    expect(stats.attack).toBe(PLAYER_BASE.attack);
    expect(stats.defense).toBe(PLAYER_BASE.defense);
    expect(stats.critChance).toBeCloseTo(PLAYER_BASE.critChance, 10);
  });

  it('每级增幅严格等于 GROWTH_PER_LEVEL', () => {
    const a = baseStatsAtLevel(30);
    const b = baseStatsAtLevel(31);
    expect(b.maxHp - a.maxHp).toBe(GROWTH_PER_LEVEL.maxHp);
    expect(b.attack - a.attack).toBe(GROWTH_PER_LEVEL.attack);
    expect(b.defense - a.defense).toBe(GROWTH_PER_LEVEL.defense);
    expect((b.critChance - a.critChance) * 100).toBeCloseTo(GROWTH_PER_LEVEL.crit, 10);
  });

  it('等级超过 MAX_LEVEL 时夹到满级属性', () => {
    expect(baseStatsAtLevel(MAX_LEVEL + 20)).toEqual(baseStatsAtLevel(MAX_LEVEL));
  });
});

describe('经验进度（UI 进度条数据）', () => {
  it('刚升级时进度为 0', () => {
    const progress = expProgress(totalExpForLevel(10));
    expect(progress.level).toBe(10);
    expect(progress.current).toBe(0);
    expect(progress.ratio).toBe(0);
    expect(progress.maxed).toBe(false);
  });

  it('ratio 恒在 [0,1] 区间内', () => {
    for (let exp = 0; exp < 500_000; exp += 3571) {
      const progress = expProgress(exp);
      expect(progress.ratio).toBeGreaterThanOrEqual(0);
      expect(progress.ratio).toBeLessThanOrEqual(1);
    }
  });

  it('满级时 maxed 为 true 且 ratio 为 1', () => {
    const progress = expProgress(totalExpForLevel(MAX_LEVEL));
    expect(progress.maxed).toBe(true);
    expect(progress.ratio).toBe(1);
    expect(progress.need).toBe(0);
  });
});

describe('战斗经验奖励', () => {
  it('是纯函数：同参数必得同结果', () => {
    const args = { monsterCount: 3, floorNumber: 7, isElite: false };
    expect(battleExpReward(args)).toBe(battleExpReward(args));
  });

  it('精英恰为普通的 2 倍', () => {
    const base = battleExpReward({ monsterCount: 2, floorNumber: 5, isElite: false });
    const elite = battleExpReward({ monsterCount: 2, floorNumber: 5, isElite: true });
    // floor 取整可能造成 ±1 误差，用范围断言
    expect(elite).toBeGreaterThanOrEqual(base * 2 - 1);
    expect(elite).toBeLessThanOrEqual(base * 2 + 1);
  });

  it('层数越深奖励越高', () => {
    const shallow = battleExpReward({ monsterCount: 2, floorNumber: 1, isElite: false });
    const deep = battleExpReward({ monsterCount: 2, floorNumber: 20, isElite: false });
    expect(deep).toBeGreaterThan(shallow);
  });

  it('最少给 1 点经验', () => {
    expect(battleExpReward({ monsterCount: 0, floorNumber: 1, isElite: false })).toBeGreaterThanOrEqual(1);
  });
});

describe('技能解锁表', () => {
  it('前 STARTER_SKILL_COUNT 个技能在 1 级解锁', async () => {
    const pool = await loadOfficialPool();
    const table = buildUnlockTable(pool.skills);
    const atLevelOne = [...table.values()].filter((lv) => lv === 1);
    expect(atLevelOne.length).toBe(STARTER_SKILL_COUNT);
  });

  it('覆盖全部技能，无遗漏', async () => {
    const pool = await loadOfficialPool();
    const table = buildUnlockTable(pool.skills);
    expect(table.size).toBe(pool.skills.size);
    for (const skillId of pool.skills.keys()) {
      expect(table.has(skillId)).toBe(true);
    }
  });

  it('解锁等级都在 [1, MAX_LEVEL] 内', async () => {
    const pool = await loadOfficialPool();
    const table = buildUnlockTable(pool.skills);
    for (const level of table.values()) {
      expect(level).toBeGreaterThanOrEqual(1);
      expect(level).toBeLessThanOrEqual(MAX_LEVEL);
    }
  });

  it('1 级至少能配出可用的 GCD 序列（否则开局无法战斗）', async () => {
    const pool = await loadOfficialPool();
    const table = buildUnlockTable(pool.skills);
    const gcdAtOne = [...pool.skills.values()].filter(
      (s) => s.type === 'GCD' && table.get(s.id) === 1,
    );
    expect(gcdAtOne.length).toBeGreaterThan(0);
  });

  it('构建结果与 Map 插入顺序无关（排序键必须稳定）', async () => {
    const pool = await loadOfficialPool();
    const forward = buildUnlockTable(pool.skills);
    // 反向插入构造同内容的 Map
    const reversed = new Map([...pool.skills.entries()].reverse());
    const backward = buildUnlockTable(reversed);

    expect(backward.size).toBe(forward.size);
    for (const [skillId, level] of forward) {
      expect(backward.get(skillId)).toBe(level);
    }
  });

  it('isSkillUnlocked 对未登记技能一律放行（模组自定义技能不受限）', () => {
    const table = new Map([['a', 10]]);
    expect(isSkillUnlocked(table, 'a', 9)).toBe(false);
    expect(isSkillUnlocked(table, 'a', 10)).toBe(true);
    expect(isSkillUnlocked(table, 'mod.custom', 1)).toBe(true);
  });

  it('unlockedSkillIds 单调增长且按字典序返回', async () => {
    const pool = await loadOfficialPool();
    const table = buildUnlockTable(pool.skills);

    let previousCount = 0;
    for (const level of [1, 10, 40, 80, MAX_LEVEL]) {
      const ids = unlockedSkillIds(table, pool.skills, level);
      expect(ids.length).toBeGreaterThanOrEqual(previousCount);
      expect([...ids].sort()).toEqual(ids);
      previousCount = ids.length;
    }
    // 满级解锁全部
    expect(unlockedSkillIds(table, pool.skills, MAX_LEVEL).length).toBe(pool.skills.size);
  });
});
