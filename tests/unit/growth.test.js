/**
 * 成长预算总账（P3）的单测。
 *
 * 这个文件存在的**首要理由不是"测新功能"**，而是钉住一句话：
 *   P3 只把散在五处的旋钮收进一张表，**没有顺手改曲线**。
 * 所以第一件事是拿旧闭式逐项复算（下面第 1~2 例）—— 一旦有人"顺手调个数"，
 * 这里会红，逼他明说。第二件事是证明读表路径真的接在运行时上
 * （第 7~8 例）：接口存在但没人调用，等于没有接口（示例包 void.ruin 的教训）。
 */

import { describe, expect, it } from 'vitest';
import {
  GROWTH_BUDGET,
  GROWTH_PER_LEVEL,
  LOOT_RARITY_CURVE,
  MAX_LEVEL,
  PLAYER_BASE,
} from '../../src/core/constants.js';
import {
  GROWTH_MODE,
  monsterScaleAtFloor,
  playerBaseStatsAtLevel,
  playerGrowthAtLevel,
  playerGrowthTotal,
  targetMarginAtFloor,
  validateGrowthBudget,
} from '../../src/core/growth.js';
import { baseStatsAtLevel } from '../../src/core/progression.js';
import { derivePlayerStats } from '../../src/core/derived.js';
import { createEmptyEquipment } from '../../src/core/equipment.js';
import { instantiateMonsters } from '../../src/core/battle/encounter.js';

/** 旧的、P3 之前的闭式 —— 刻意在测试里重写一遍，作为"回归原点"。 */
const legacyBaseStats = (lv) => ({
  maxHp: PLAYER_BASE.maxHp + (lv - 1) * 28,
  attack: PLAYER_BASE.attack + (lv - 1) * 6,
  defense: PLAYER_BASE.defense + (lv - 1) * 4,
  critChance: PLAYER_BASE.critChance + ((lv - 1) * 0.25) / 100,
});
const legacyMonsterScale = (floor) => ({
  hp: 1 + (floor - 1) * 0.12,
  attack: 1 + (floor - 1) * 0.08,
});

describe('默认表逐项等于现状（P3 不改曲线的硬证据）', () => {
  it('baseStatsAtLevel 在 1..MAX_LEVEL 每一级都与旧闭式逐字段相等', () => {
    for (let lv = 1; lv <= MAX_LEVEL; lv += 1) {
      expect(baseStatsAtLevel(lv)).toEqual(legacyBaseStats(lv));
    }
  });

  it('monsterScaleAtFloor 在 1..200 每一层都与旧闭式逐位相等（含浮点末位）', () => {
    for (let floor = 1; floor <= 200; floor += 1) {
      const scale = monsterScaleAtFloor(floor);
      const legacy = legacyMonsterScale(floor);
      expect(scale.hp).toBe(legacy.hp);
      expect(scale.attack).toBe(legacy.attack);
      expect(scale.defense).toBe(1); // 防御不随层缩放（模板值直接入战）
    }
  });

  it('instantiateMonsters 走的是表：默认表下与旧闭式算出同一只怪', () => {
    const monsters = new Map([
      ['m.test', { name: '靶子', maxHp: 2100, attack: 120, defense: 14, gcdSequence: [], ogcdSlots: [] }],
    ]);
    const args = {
      encounter: { id: 'enc.test', monsterIds: ['m.test'], tier: 'normal' },
      monsters,
      floorNumber: 37,
      seed: 4242,
      nodeId: 'node_1_1',
    };
    const [beast] = instantiateMonsters(args);
    const legacy = legacyMonsterScale(37);
    const rngVariance = 1; // 浮点量级对比用：只关心缩放是否同源，见下界
    expect(beast.maxHp).toBeGreaterThanOrEqual(Math.floor(2100 * legacy.hp * 0.95 * rngVariance));
    expect(beast.maxHp).toBeLessThanOrEqual(Math.floor(2100 * legacy.hp * 1.05));
    expect(beast.attack).toBeLessThanOrEqual(Math.floor(120 * legacy.attack * 1.05));
    expect(beast.defense).toBe(14); // 防御未被楼层缩放弄脏
  });

  it('GROWTH_PER_LEVEL 是首段快照，不是第二份真相', () => {
    const first = GROWTH_BUDGET.player.perLevel[0];
    expect({ ...GROWTH_PER_LEVEL }).toEqual({
      maxHp: first.maxHp,
      attack: first.attack,
      defense: first.defense,
      crit: first.crit,
    });
  });

  it('LOOT_RARITY_CURVE 就是 GROWTH_BUDGET.loot（同一个对象，不会各自演化）', () => {
    expect(LOOT_RARITY_CURVE).toBe(GROWTH_BUDGET.loot);
  });
});

describe('分段表的数学', () => {
  /** 一份"两段"的假表：40 级以后每级成长减半。 */
  const splitBudget = Object.freeze({
    ...GROWTH_BUDGET,
    player: Object.freeze({
      base: PLAYER_BASE,
      perLevel: Object.freeze([
        Object.freeze({ fromLevel: 1, maxHp: 28, attack: 6, defense: 4, crit: 0.25 }),
        Object.freeze({ fromLevel: 40, maxHp: 14, attack: 3, defense: 2, crit: 0.1 }),
      ]),
    }),
  });

  it('playerGrowthAtLevel 按段取值', () => {
    expect(playerGrowthAtLevel(39, splitBudget).maxHp).toBe(28);
    expect(playerGrowthAtLevel(40, splitBudget).maxHp).toBe(14);
    expect(playerGrowthAtLevel(120, splitBudget).maxHp).toBe(14);
  });

  it('playerGrowthTotal 的闭式等于逐级 loop 求和（任何表都必须如此）', () => {
    for (const budget of [GROWTH_BUDGET, splitBudget]) {
      for (const to of [1, 2, 39, 40, 41, 88, MAX_LEVEL]) {
        const looped = { maxHp: 0, attack: 0, defense: 0, crit: 0 };
        for (let lv = 1; lv < to; lv += 1) {
          const step = playerGrowthAtLevel(lv, budget);
          looped.maxHp += step.maxHp;
          looped.attack += step.attack;
          looped.defense += step.defense;
          looped.crit += step.crit;
        }
        const closed = playerGrowthTotal(1, to, budget);
        expect(closed.maxHp).toBe(looped.maxHp);
        expect(closed.attack).toBe(looped.attack);
        expect(closed.defense).toBe(looped.defense);
        expect(closed.crit).toBeCloseTo(looped.crit, 10);
      }
    }
  });

  it('分段处不跳变：第 40 级相对第 39 级的增量正好是本段增量', () => {
    const at39 = playerGrowthTotal(1, 39, splitBudget).maxHp;
    const at40 = playerGrowthTotal(1, 40, splitBudget).maxHp;
    const at41 = playerGrowthTotal(1, 41, splitBudget).maxHp;
    expect(at40 - at39).toBe(28); // 第 39→40 这一跳仍归上一段
    expect(at41 - at40).toBe(14); // 第 40→41 起用新段
  });

  it('compound 段以"前段外推值"为起点，段界连续', () => {
    const budget = {
      ...GROWTH_BUDGET,
      monster: {
        ...GROWTH_BUDGET.monster,
        hp: [
          { fromFloor: 1, mode: GROWTH_MODE.LINEAR, rate: 0.12 },
          { fromFloor: 51, mode: GROWTH_MODE.COMPOUND, rate: 0.22 },
        ],
      },
    };
    const atBoundary = monsterScaleAtFloor(51, budget).hp;
    expect(atBoundary).toBeCloseTo(1 + 0.12 * 50, 10); // 没有跳档
    expect(monsterScaleAtFloor(52, budget).hp).toBeCloseTo(atBoundary * 1.22, 10);
    expect(monsterScaleAtFloor(53, budget).hp).toBeCloseTo(atBoundary * 1.22 * 1.22, 10);
  });

  it('hp 与 attack 用同一个底数时，两者比值恒定（血泪：分开配必有一条 TTK 漂走）', () => {
    const shared = {
      ...GROWTH_BUDGET,
      monster: {
        hp: [
          { fromFloor: 1, mode: GROWTH_MODE.LINEAR, rate: 0.12 },
          { fromFloor: 51, mode: GROWTH_MODE.COMPOUND, rate: 0.22 },
        ],
        attack: [
          { fromFloor: 1, mode: GROWTH_MODE.LINEAR, rate: 0.08 },
          { fromFloor: 51, mode: GROWTH_MODE.COMPOUND, rate: 0.22 },
        ],
        defense: GROWTH_BUDGET.monster.defense,
      },
    };
    // 51 层以后 hp/atk 各自的增长因子相同 ⇒ 两者各自除以自己的初值，比例只由初值决定
    const ratio = (floor) =>
      monsterScaleAtFloor(floor, shared).hp / monsterScaleAtFloor(floor, shared).attack;
    expect(ratio(200)).toBeCloseTo(ratio(60), 6);
  });

  it('纯函数：同参多次调用逐项相等（曲线不读随机数）', () => {
    expect(monsterScaleAtFloor(77)).toEqual(monsterScaleAtFloor(77));
    expect(playerGrowthTotal(1, 90)).toEqual(playerGrowthTotal(1, 90));
    expect(playerBaseStatsAtLevel(3)).toEqual(baseStatsAtLevel(3));
  });

  it('脏输入兜到 1 级 / 1 层，而不是算出 NaN', () => {
    expect(playerGrowthAtLevel(undefined).maxHp).toBe(28);
    expect(monsterScaleAtFloor(NaN).hp).toBe(1);
    expect(monsterScaleAtFloor(-5).hp).toBe(1);
  });
});

describe('表自检：半张表不能安静生效', () => {
  it('默认表通过校验', () => {
    expect(validateGrowthBudget()).toBe(true);
  });

  const broken = {
    '段起点没升序': (b) => ({
      ...b,
      monster: { ...b.monster, hp: [{ fromFloor: 40, mode: 'linear', rate: 0.12 }] },
    }),
    '玩家首段不从 1 级起': (b) => ({
      ...b,
      player: { ...b.player, perLevel: [{ fromLevel: 2, maxHp: 28, attack: 6, defense: 4, crit: 0.25 }] },
    }),
    'mode 写错': (b) => ({
      ...b,
      monster: { ...b.monster, hp: [{ fromFloor: 1, mode: 'geometric', rate: 0.12 }] },
    }),
    'rate 是负数': (b) => ({
      ...b,
      monster: { ...b.monster, attack: [{ fromFloor: 1, mode: 'linear', rate: -0.1 }] },
    }),
    'growth 字段是字符串': (b) => ({
      ...b,
      player: { ...b.player, perLevel: [{ fromLevel: 1, maxHp: '28', attack: 6, defense: 4, crit: 0.25 }] },
    }),
    '掉落曲线缺字段': (b) => ({ ...b, loot: { ...b.loot, rampFloor: undefined } }),
    'lowSuppressCap 超过 1': (b) => ({ ...b, loot: { ...b.loot, lowSuppressCap: 1.5 } }),
    '控制点 floor 不升序': (b) => ({
      ...b,
      targets: { ...b.targets, margin: [{ floor: 50, value: 2 }, { floor: 50, value: 3 }] },
    }),
  };

  it.each(Object.keys(broken))('%s 会被抓出来', (name) => {
    const tampered = broken[name](GROWTH_BUDGET);
    expect(() => validateGrowthBudget(tampered)).toThrow(/GROWTH_BUDGET 非法/);
  });
});

describe('运行时确实读表（接口不是纸面的）', () => {
  it('derivePlayerStats 的 breakdown.base 与 growth 表同源', () => {
    const stats = derivePlayerStats({ exp: 0, equipment: createEmptyEquipment() });
    expect(stats.breakdown.base).toEqual(playerBaseStatsAtLevel(stats.level));
  });

  it('targetMarginAtFloor：控制点上等于目标值，段内线性，两端夹住', () => {
    const points = GROWTH_BUDGET.targets.margin;
    for (const point of points) {
      expect(targetMarginAtFloor(point.floor)).toBeCloseTo(point.value, 10);
    }
    const a = points[0];
    const b = points[1];
    const mid = a.floor + Math.round((b.floor - a.floor) / 2);
    expect(targetMarginAtFloor(mid)).toBeCloseTo(
      a.value + ((mid - a.floor) / (b.floor - a.floor)) * (b.value - a.value),
      10,
    );
    expect(targetMarginAtFloor(0)).toBe(points[0].value);
    expect(targetMarginAtFloor(99_999)).toBe(points[points.length - 1].value);
  });
});
