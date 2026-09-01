/**
 * 阶段 8 装备与掉落单测。
 *
 * 重点：装备生成必须是确定性的纯函数（同流同参必得同结果），
 * 且不得依赖 Date.now / Math.random —— 这是与 Fate_echo 的关键差异。
 */

import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../../src/core/prng.js';
import {
  createEmptyEquipment,
  describeGear,
  enhanceCost,
  enhanceGear,
  expectedRarityAtFloor,
  gearScore,
  rarityOf,
  rarityWeightsAtFloor,
  rollEquipment,
  salvageValue,
  slotKind,
  totalEquipmentStats,
} from '../../src/core/equipment.js';
import { gearPrice, LOOT_MIN_RARITY, rollBattleLoot, rollShopGear } from '../../src/core/loot.js';
import { derivePlayerStats, addPermanentBonus, permanentBonusOf, recalcPlayer } from '../../src/core/derived.js';
import { EQUIP_SLOTS, ENHANCE_MAX, GROWTH_PER_LEVEL, LOOT_RARITY_CURVE, RARITIES } from '../../src/core/constants.js';
import { createPlayer } from '../../src/core/initialState.js';
import { totalExpForLevel } from '../../src/core/progression.js';

const SEEDS = [1, 42, 1337, 20240101, 0x7fffffff, 999999];

describe('装备生成', () => {
  it('同流同参必得逐字段相同的装备（确定性）', () => {
    for (const seed of SEEDS) {
      const a = rollEquipment({ rng: mulberry32(seed), floorNumber: 5, idSuffix: 'x.0' });
      const b = rollEquipment({ rng: mulberry32(seed), floorNumber: 5, idSuffix: 'x.0' });
      expect(a).toEqual(b);
    }
  });

  it('id 由 idSuffix 决定，不含时间戳或随机数', () => {
    const gear = rollEquipment({ rng: mulberry32(7), floorNumber: 3, idSuffix: 'node_1_2.0' });
    expect(gear.id).toBe('eq.node_1_2.0');
  });

  it('槽位与品质都在合法集合内', () => {
    for (const seed of SEEDS) {
      const rng = mulberry32(seed);
      for (let i = 0; i < 40; i += 1) {
        const gear = rollEquipment({ rng, floorNumber: 1 + (i % 30), idSuffix: `s.${i}` });
        expect(EQUIP_SLOTS).toContain(gear.slot);
        expect(gear.rarityIndex).toBeGreaterThanOrEqual(0);
        expect(gear.rarityIndex).toBeLessThan(RARITIES.length);
      }
    }
  });

  it('所有属性都是非负整数（浮点会破坏跨速度对拍）', () => {
    for (const seed of SEEDS) {
      const rng = mulberry32(seed);
      for (let i = 0; i < 40; i += 1) {
        const gear = rollEquipment({ rng, floorNumber: 1 + i, idSuffix: `n.${i}` });
        for (const key of ['maxHp', 'attack', 'defense', 'crit']) {
          expect(Number.isInteger(gear.stats[key])).toBe(true);
          expect(gear.stats[key]).toBeGreaterThanOrEqual(0);
        }
        expect(Number.isInteger(gear.score)).toBe(true);
      }
    }
  });

  it('武器只给攻击，防具给防御与生命，首饰双属性', () => {
    for (const slot of EQUIP_SLOTS) {
      const gear = rollEquipment({
        rng: mulberry32(99),
        floorNumber: 10,
        idSuffix: `k.${slot}`,
        forceSlot: slot,
        forceRarity: 1, // 普通品质：affixMax 为 1，主属性倾向仍清晰
      });
      const kind = slotKind(slot);
      if (kind === 'weapon') {
        expect(gear.stats.attack).toBeGreaterThan(0);
      } else if (kind === 'armor') {
        expect(gear.stats.defense).toBeGreaterThan(0);
      } else {
        expect(gear.stats.attack + gear.stats.defense).toBeGreaterThan(0);
      }
    }
  });

  it('forceRarity 与 minRarity 都生效，minRarity 是下限而非覆盖', () => {
    const forced = rollEquipment({ rng: mulberry32(3), floorNumber: 1, idSuffix: 'f', forceRarity: 4 });
    expect(forced.rarityIndex).toBe(4);

    for (const seed of SEEDS) {
      const gear = rollEquipment({ rng: mulberry32(seed), floorNumber: 1, idSuffix: 'm', minRarity: 3 });
      expect(gear.rarityIndex).toBeGreaterThanOrEqual(3);
    }
  });

  it('层数越深，同品质装备越强', () => {
    const shallow = rollEquipment({
      rng: mulberry32(11),
      floorNumber: 1,
      idSuffix: 'a',
      forceSlot: 'weapon',
      forceRarity: 3,
    });
    const deep = rollEquipment({
      rng: mulberry32(11),
      floorNumber: 40,
      idSuffix: 'a',
      forceSlot: 'weapon',
      forceRarity: 3,
    });
    expect(deep.stats.attack).toBeGreaterThan(shallow.stats.attack);
  });

  it('品质越高装备越强（同层同槽同随机流）', () => {
    const scores = RARITIES.map((_, index) =>
      rollEquipment({
        rng: mulberry32(21),
        floorNumber: 10,
        idSuffix: 'q',
        forceSlot: 'weapon',
        forceRarity: index,
      }).stats.attack,
    );
    for (let i = 1; i < scores.length; i += 1) {
      expect(scores[i]).toBeGreaterThan(scores[i - 1]);
    }
  });

  it('缺少 idSuffix 时抛错，而不是生成重复 id', () => {
    expect(() => rollEquipment({ rng: mulberry32(1), floorNumber: 1, idSuffix: '' })).toThrow();
    expect(() => rollEquipment({ rng: mulberry32(1), floorNumber: 1 })).toThrow();
  });
});

/**
 * P0：品质权重的层数曲线。
 *
 * 这条守卫守的是一个「不报错、不变红、只是后期没得玩」的缺陷：
 * 旧实现只压制低档权重，高档权重是常数 ⇒ 40 层以后捡到传说的概率与第 1 层一样，
 * 装备成长停住。单看一次抽样看不出来，所以直接对「期望」下断言。
 */
describe('品质权重随层数抬升（P0 回归）', () => {
  it('第 1 层就是基准分布（改动不回头弄坏开局）', () => {
    const weights = rarityWeightsAtFloor(1);
    expect(weights.map((w) => w.weight)).toEqual(RARITIES.map((r) => r.weight));
  });

  it('品质下标 ≥2 的权重随层数单调不降，封顶前严格上升', () => {
    // progress = min(cap, (floor-1)/rampFloor)，所以封顶发生在第 rampFloor×cap+1 层
    const flatFrom = LOOT_RARITY_CURVE.rampFloor * LOOT_RARITY_CURVE.progressCap + 1;
    for (let floor = 2; floor <= 160; floor += 1) {
      const prev = rarityWeightsAtFloor(floor - 1);
      const now = rarityWeightsAtFloor(floor);
      for (let i = 2; i < now.length; i += 1) {
        expect(now[i].weight).toBeGreaterThanOrEqual(prev[i].weight);
      }
      const top = now.length - 1;
      // 到封顶（progressCap）后曲线钢平，这是设计决定而不是回归：
      // 无尽段还要往上跑 100+ 层，全靠 mult 与 √层数继续拉开，不靠概率继续送。
      if (floor <= flatFrom) expect(now[top].weight).toBeGreaterThan(prev[top].weight);
      else expect(now[top].weight).toBe(prev[top].weight);
    }
  });

  it('低档只降不升（高档的相对占比从两边同时挣出来）', () => {
    for (let floor = 1; floor <= 200; floor += 1) {
      const weights = rarityWeightsAtFloor(floor);
      expect(weights[0].weight).toBeLessThanOrEqual(RARITIES[0].weight);
      expect(weights[1].weight).toBeLessThanOrEqual(RARITIES[1].weight);
    }
  });

  it('品质期望随层数上升（旧实现下这条在第 44 层后平掉 —— 就是那个 bug）', () => {
    const marks = [1, 10, 25, 45, 90];
    const values = marks.map((f) => expectedRarityAtFloor(f));
    for (let i = 1; i < values.length; i += 1) {
      expect(values[i]).toBeGreaterThan(values[i - 1]);
    }
    // 封顶前的增量不能小于 1 个档位：否则“后期装备不再变好”会以另一种形式回来
    expect(values[values.length - 1]).toBeGreaterThan(values[0] + 1);
    // 封顶后保持平（设计决定）但不回退：无尽段靠 mult 梯子与 √层数继续拉开
    const flatFrom = LOOT_RARITY_CURVE.rampFloor * LOOT_RARITY_CURVE.progressCap + 1;
    expect(expectedRarityAtFloor(flatFrom + 9_000)).toBe(expectedRarityAtFloor(flatFrom));
  });

  it('权重表不消费随机数：同一层反复取表逐项相等', () => {
    expect(rarityWeightsAtFloor(37)).toEqual(rarityWeightsAtFloor(37));
  });

  it('抽样与权重表同向：深层同一批流上均值更高', () => {
    const meanAt = (floor) => {
      const rng = mulberry32(4242);
      let sum = 0;
      for (let i = 0; i < 400; i += 1) {
        sum += rollEquipment({ rng, floorNumber: floor, idSuffix: `p.${i}` }).rarityIndex;
      }
      return sum / 400;
    };
    expect(meanAt(45)).toBeGreaterThan(meanAt(5));
  });
});

/**
 * P1：品质从 6 档扩到 9 档。
 *
 * 这里守的不是"有九个元素"，而是三件扩档时最容易漏的事：
 *   ① 推导字段（cls / affixMax / index）不得与下标漂走 —— 加档时手抄就是债
 *   ② weight 梯子与 `GROWTH_BUDGET.loot` 是**联合解**的：单独改任何一边，
 *      顶档占比会跳到完全另一个量级（实测：沿用旧 ramp 会把终焉抬到 29%）
 *   ③ 装备名的拼法与品质一致（前缀就是品质名，不该出现旧形容词）
 */
describe('品质九档（P1）', () => {
  it('九档，且 cls / affixMax / index 全部由下标推导', () => {
    expect(RARITIES).toHaveLength(9);
    RARITIES.forEach((rarity, index) => {
      expect(rarity.index).toBe(index);
      expect(rarity.cls).toBe(`q${index}`);
      expect(rarity.affixMax).toBe(index);
    });
  });

  it('id 与中文名唯一、mult 严格上升（图鉴靠这两列区分九档）', () => {
    expect(new Set(RARITIES.map((r) => r.id)).size).toBe(RARITIES.length);
    expect(new Set(RARITIES.map((r) => r.name)).size).toBe(RARITIES.length);
    for (let i = 1; i < RARITIES.length; i += 1) {
      expect(RARITIES[i].mult).toBeGreaterThan(RARITIES[i - 1].mult);
    }
  });

  it('weight 是单峰平滑曲线：峰在「普通」，其后按固定公比衰减', () => {
    const weights = RARITIES.map((r) => r.weight);
    expect(weights[1]).toBeGreaterThan(weights[0]); // 峰值不是首档（开局不该狂掉破烂以外的东西）
    for (let i = 2; i < weights.length; i += 1) {
      expect(weights[i]).toBeLessThan(weights[i - 1]);
      const ratio = weights[i] / weights[i - 1];
      // 0.35~0.50 就是"1/2.4 左右"的允许带。重排成非等比（旧形状是 0.42/0.33/0.21
      // 一路变陡，中段鼓包）会在这里报红 —— 那是"调了一个地方"的报警。
      expect(ratio).toBeGreaterThan(0.35);
      expect(ratio).toBeLessThan(0.5);
    }
  });

  it('顶档占比落在设计带内（这组数与 weight 梯子是联合解的）', () => {
    const share = (floor, index) => {
      const weights = rarityWeightsAtFloor(floor);
      const total = weights.reduce((sum, w) => sum + w.weight, 0);
      return weights[index].weight / total;
    };
    const top = RARITIES.length - 1;
    // 终焉：开局近乎不存在，45 层是"彩票"，90 层才开场，无尽深处才成主力
    expect(share(1, top)).toBeLessThan(0.002);
    expect(share(45, top)).toBeGreaterThanOrEqual(0.01);
    expect(share(45, top)).toBeLessThan(0.02);
    expect(share(90, top)).toBeGreaterThanOrEqual(0.04);
    expect(share(90, top)).toBeLessThan(0.07);
    expect(share(200, top)).toBeGreaterThan(0.08);
    // 前 25 层不该看到顶三档成气候（否则新三档只是把老档挤没了）
    const top3Early = [7, 8, 6].reduce((sum, i) => sum + share(25, i), 0);
    expect(top3Early).toBeLessThan(0.06);
  });

  it('每一档的装备名都是「品质名 + 空格 + 部位名」', () => {
    RARITIES.forEach((rarity, index) => {
      const gear = rollEquipment({
        rng: mulberry32(7),
        floorNumber: 5,
        idSuffix: `n.${index}`,
        forceSlot: 'weapon',
        forceRarity: index,
      });
      expect(gear.name.startsWith(`${rarity.name} `)).toBe(true);
      expect(gear.name.length).toBeGreaterThan(rarity.name.length + 1);
    });
  });

  it('词缀条数随档上升，终焉单件确实比传说强一大截（不靠数值表口头说）', () => {
    const attackAt = (index) =>
      rollEquipment({
        rng: mulberry32(31),
        floorNumber: 45,
        idSuffix: 'q',
        forceSlot: 'weapon',
        forceRarity: index,
      }).stats.attack;
    const top = RARITIES.length - 1;
    expect(attackAt(top)).toBeGreaterThan(attackAt(5) * 2);
  });

  it('精英与商店的保底随九档上调（商店卖的就是"精英水平的货"）', () => {
    expect(LOOT_MIN_RARITY.elite).toBe(4);
    expect(LOOT_MIN_RARITY.shop).toBe(4);
  });
});

describe('评分与描述', () => {
  it('gearScore 是纯函数且单调于各项属性', () => {
    const base = {
      slot: 'weapon',
      stats: { maxHp: 0, attack: 10, defense: 0, crit: 0 },
    };
    const stronger = { slot: 'weapon', stats: { maxHp: 0, attack: 20, defense: 0, crit: 0 } };
    expect(gearScore(stronger)).toBeGreaterThan(gearScore(base));
    expect(gearScore(base)).toBe(gearScore(base));
  });

  it('describeGear 只列出非零属性', () => {
    const gear = { stats: { maxHp: 0, attack: 12, defense: 0, crit: 30 } };
    const text = describeGear(gear);
    expect(text).toContain('攻击 +12');
    expect(text).toContain('暴击 +3.0%');
    expect(text).not.toContain('防御');
    expect(text).not.toContain('生命');
  });

  it('rarityOf 对越界下标回退到最低品质', () => {
    expect(rarityOf({ rarityIndex: 999 })).toBe(RARITIES[0]);
  });
});

describe('强化', () => {
  function makeWeapon() {
    return rollEquipment({
      rng: mulberry32(5),
      floorNumber: 8,
      idSuffix: 'w',
      forceSlot: 'weapon',
      forceRarity: 3,
    });
  }

  it('费用随强化等级递增', () => {
    const gear = makeWeapon();
    const first = enhanceCost(gear);
    enhanceGear(gear, 10 ** 9);
    expect(enhanceCost(gear)).toBeGreaterThan(first);
  });

  it('碎片不足时拒绝且不修改装备', () => {
    const gear = makeWeapon();
    const before = { ...gear.stats };
    const result = enhanceGear(gear, 0);
    expect(result).toEqual({ ok: false, reason: 'insufficientShards' });
    expect(gear.stats).toEqual(before);
    expect(gear.enhanceLevel).toBe(0);
  });

  it('无失败率：碎片够就必定成功（确定性区不引入概率消耗）', () => {
    const gear = makeWeapon();
    for (let i = 0; i < ENHANCE_MAX; i += 1) {
      const result = enhanceGear(gear, 10 ** 9);
      expect(result.ok).toBe(true);
      expect(result.level).toBe(i + 1);
    }
    expect(gear.enhanceLevel).toBe(ENHANCE_MAX);
  });

  it('达到上限后拒绝继续强化', () => {
    const gear = makeWeapon();
    for (let i = 0; i < ENHANCE_MAX; i += 1) enhanceGear(gear, 10 ** 9);
    expect(enhanceGear(gear, 10 ** 9)).toEqual({ ok: false, reason: 'maxEnhance' });
  });

  it('每次强化主属性至少 +1（防止低数值卡在原地）', () => {
    const gear = rollEquipment({
      rng: mulberry32(2),
      floorNumber: 1,
      idSuffix: 'tiny',
      forceSlot: 'weapon',
      forceRarity: 0,
    });
    const before = gear.stats.attack;
    enhanceGear(gear, 10 ** 9);
    expect(gear.stats.attack).toBeGreaterThan(before);
  });

  it('强化后属性仍是整数', () => {
    const gear = makeWeapon();
    for (let i = 0; i < 5; i += 1) enhanceGear(gear, 10 ** 9);
    for (const key of ['maxHp', 'attack', 'defense', 'crit']) {
      expect(Number.isInteger(gear.stats[key])).toBe(true);
    }
  });

  it('强化提升分解价值', () => {
    const gear = makeWeapon();
    const before = salvageValue(gear);
    enhanceGear(gear, 10 ** 9);
    expect(salvageValue(gear)).toBeGreaterThan(before);
  });
});

describe('装备栏汇总', () => {
  it('空装备栏汇总为全零', () => {
    expect(totalEquipmentStats(createEmptyEquipment())).toEqual({
      maxHp: 0,
      attack: 0,
      defense: 0,
      crit: 0,
    });
  });

  it('汇总等于各件之和', () => {
    const equipment = createEmptyEquipment();
    equipment.weapon = { stats: { maxHp: 1, attack: 10, defense: 0, crit: 5 } };
    equipment.chest = { stats: { maxHp: 40, attack: 0, defense: 8, crit: 0 } };
    expect(totalEquipmentStats(equipment)).toEqual({ maxHp: 41, attack: 10, defense: 8, crit: 5 });
  });

  it('null 与 undefined 装备栏安全', () => {
    expect(totalEquipmentStats(null)).toEqual({ maxHp: 0, attack: 0, defense: 0, crit: 0 });
    expect(totalEquipmentStats(undefined)).toEqual({ maxHp: 0, attack: 0, defense: 0, crit: 0 });
  });
});

describe('派生属性', () => {
  it('level 完全由 exp 决定', () => {
    const equipment = createEmptyEquipment();
    expect(derivePlayerStats({ exp: 0, equipment }).level).toBe(1);
    expect(derivePlayerStats({ exp: totalExpForLevel(25), equipment }).level).toBe(25);
  });

  it('装备加成叠加进最终面板', () => {
    const equipment = createEmptyEquipment();
    const withoutGear = derivePlayerStats({ exp: 0, equipment });
    equipment.weapon = { stats: { maxHp: 0, attack: 50, defense: 0, crit: 0 } };
    const withGear = derivePlayerStats({ exp: 0, equipment });
    expect(withGear.attack - withoutGear.attack).toBe(50);
  });

  it('暴击率封顶 75%', () => {
    const equipment = createEmptyEquipment();
    equipment.weapon = { stats: { maxHp: 0, attack: 0, defense: 0, crit: 99_999 } };
    expect(derivePlayerStats({ exp: 0, equipment }).critChance).toBe(0.75);
  });

  it('recalcPlayer 按“保持缺失量”补齐，而非保持比例', () => {
    const player = createPlayer(42);
    const maxBefore = player.maxHp;
    player.hp = maxBefore - 100; // 缺 100
    player.exp = totalExpForLevel(5);

    recalcPlayer(player);
    expect(player.maxHp).toBeGreaterThan(maxBefore);
    // 缺失量仍是 100，而非按比例放大
    expect(player.maxHp - player.hp).toBe(100);
  });

  it('recalcPlayer 的 fullHeal 补满', () => {
    const player = createPlayer(42);
    player.hp = 1;
    recalcPlayer(player, { fullHeal: true });
    expect(player.hp).toBe(player.maxHp);
  });

  it('卸掉装备导致 maxHp 下降时 hp 被夹住且至少为 1', () => {
    const player = createPlayer(42);
    player.equipment.chest = { stats: { maxHp: 500, attack: 0, defense: 0, crit: 0 } };
    recalcPlayer(player, { fullHeal: true });
    const boosted = player.maxHp;

    player.equipment.chest = null;
    recalcPlayer(player);
    expect(player.maxHp).toBeLessThan(boosted);
    expect(player.hp).toBeGreaterThanOrEqual(1);
    expect(player.hp).toBeLessThanOrEqual(player.maxHp);
  });

  it('属性全为整数', () => {
    const player = createPlayer(7);
    player.exp = totalExpForLevel(63);
    recalcPlayer(player);
    expect(Number.isInteger(player.maxHp)).toBe(true);
    expect(Number.isInteger(player.attack)).toBe(true);
    expect(Number.isInteger(player.defense)).toBe(true);
  });
});

describe('永久加成（permanentBonus）', () => {
  it('createPlayer 给出全零的 permanentBonus', () => {
    expect(createPlayer(42).permanentBonus).toEqual({ maxHp: 0, attack: 0, defense: 0, crit: 0 });
  });

  it('addPermanentBonus 累加、支持负值，并忽略未知字段', () => {
    const player = createPlayer(42);
    addPermanentBonus(player, { maxHp: 60 });
    addPermanentBonus(player, { maxHp: -40, attack: 16, haste: 99 });
    expect(player.permanentBonus).toMatchObject({ maxHp: 20, attack: 16, defense: 0 });
  });

  it('permanentBonusOf 对缺失/非法字段兜底为整数 0', () => {
    expect(permanentBonusOf({})).toEqual({ maxHp: 0, attack: 0, defense: 0, crit: 0 });
    expect(permanentBonusOf(null)).toEqual({ maxHp: 0, attack: 0, defense: 0, crit: 0 });
    expect(permanentBonusOf({ permanentBonus: { maxHp: NaN, attack: 3.7 } }).maxHp).toBe(0);
    expect(permanentBonusOf({ permanentBonus: { attack: 3.7 } }).attack).toBe(3);
  });

  it('derivePlayerStats 把永久加成计入四项派生值', () => {
    const equipment = createEmptyEquipment();
    const plain = derivePlayerStats({ exp: 0, equipment });
    const boosted = derivePlayerStats({
      exp: 0,
      equipment,
      permanentBonus: { maxHp: 100, attack: 10, defense: 5, crit: 20 },
    });
    expect(boosted.maxHp).toBe(plain.maxHp + 100);
    expect(boosted.attack).toBe(plain.attack + 10);
    expect(boosted.defense).toBe(plain.defense + 5);
    expect(boosted.critChance).toBeCloseTo(plain.critChance + 0.02, 10);
  });

  it('永久加成的负值不会把面板压到非法区间', () => {
    const player = createPlayer(42);
    addPermanentBonus(player, { maxHp: -99999, attack: -99999, defense: -99999 });
    recalcPlayer(player);
    expect(player.maxHp).toBeGreaterThanOrEqual(1);
    expect(player.attack).toBeGreaterThanOrEqual(0);
    expect(player.defense).toBeGreaterThanOrEqual(0);
    expect(player.hp).toBeGreaterThanOrEqual(1);
  });

  it('recalcPlayer 幂等：重复重算不漂移（商店连续重算与读档都依赖这一点）', () => {
    const player = createPlayer(42);
    addPermanentBonus(player, { maxHp: 60, attack: 8 });
    recalcPlayer(player);
    const first = { maxHp: player.maxHp, attack: player.attack, hp: player.hp, level: player.level };
    for (let i = 0; i < 5; i += 1) recalcPlayer(player);
    expect({ maxHp: player.maxHp, attack: player.attack, hp: player.hp, level: player.level }).toEqual(first);
  });

  it('升级与永久加成互不干扰：两者都能存活', () => {
    const player = createPlayer(42);
    addPermanentBonus(player, { maxHp: 60 });
    recalcPlayer(player);
    const withBonus = player.maxHp;

    player.exp = totalExpForLevel(10);
    recalcPlayer(player);
    expect(player.maxHp).toBe(withBonus + 9 * GROWTH_PER_LEVEL.maxHp);
    expect(player.permanentBonus.maxHp).toBe(60);
  });
});

describe('掉落', () => {
  it('同 (seed, floor, nodeId) 掉落恒定 —— 与战斗过程无关', () => {
    const args = { seed: 12345, floorNumber: 4, nodeId: 'node_3_3', isElite: false };
    expect(rollBattleLoot(args)).toEqual(rollBattleLoot(args));
  });

  it('不同节点掉落不同（不会整层同一件）', () => {
    const a = rollBattleLoot({ seed: 1, floorNumber: 3, nodeId: 'node_1_1', isElite: true });
    const b = rollBattleLoot({ seed: 1, floorNumber: 3, nodeId: 'node_2_2', isElite: true });
    expect(a[0].id).not.toBe(b[0].id);
  });

  it('精英必掉 2 件且品质不低于保底', () => {
    for (const seed of SEEDS) {
      const loot = rollBattleLoot({ seed, floorNumber: 6, nodeId: 'node_5_5', isElite: true });
      expect(loot.length).toBe(2);
      for (const gear of loot) expect(gear.rarityIndex).toBeGreaterThanOrEqual(LOOT_MIN_RARITY.elite);
    }
  });

  it('普通战斗掉落 0 或 1 件', () => {
    for (const seed of SEEDS) {
      const loot = rollBattleLoot({ seed, floorNumber: 2, nodeId: 'node_1_2', isElite: false });
      expect(loot.length).toBeLessThanOrEqual(1);
    }
  });

  it('掉落 id 全局唯一（同一节点的多件之间也不重复）', () => {
    const loot = rollBattleLoot({ seed: 777, floorNumber: 9, nodeId: 'node_4_4', isElite: true });
    expect(new Set(loot.map((g) => g.id)).size).toBe(loot.length);
  });

  it('商店装备按 index 独立派生，同节点两件不同', () => {
    const a = rollShopGear({ seed: 5, floorNumber: 3, nodeId: 'node_2_2', index: 0 });
    const b = rollShopGear({ seed: 5, floorNumber: 3, nodeId: 'node_2_2', index: 1 });
    expect(a.id).not.toBe(b.id);
    expect(a.rarityIndex).toBeGreaterThanOrEqual(LOOT_MIN_RARITY.shop);
    expect(b.rarityIndex).toBeGreaterThanOrEqual(LOOT_MIN_RARITY.shop);
  });

  it('商店装备可重复读取且结果稳定', () => {
    const args = { seed: 5, floorNumber: 3, nodeId: 'node_2_2', index: 0 };
    expect(rollShopGear(args)).toEqual(rollShopGear(args));
  });

  it('售价随品质与层数上升，且有下限', () => {
    const cheap = gearPrice({ rarityIndex: 0, floorNumber: 1 });
    const rich = gearPrice({ rarityIndex: 5, floorNumber: 30 });
    expect(cheap).toBeGreaterThanOrEqual(8);
    expect(rich).toBeGreaterThan(cheap);
  });
});
