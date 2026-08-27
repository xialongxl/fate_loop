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
  gearScore,
  rarityOf,
  rollEquipment,
  salvageValue,
  slotKind,
  totalEquipmentStats,
} from '../../src/core/equipment.js';
import { gearPrice, rollBattleLoot, rollShopGear } from '../../src/core/loot.js';
import { derivePlayerStats, recalcPlayer } from '../../src/core/derived.js';
import { EQUIP_SLOTS, ENHANCE_MAX, RARITIES } from '../../src/core/constants.js';
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

  it('精英必掉 2 件且品质不低于精良', () => {
    for (const seed of SEEDS) {
      const loot = rollBattleLoot({ seed, floorNumber: 6, nodeId: 'node_5_5', isElite: true });
      expect(loot.length).toBe(2);
      for (const gear of loot) expect(gear.rarityIndex).toBeGreaterThanOrEqual(2);
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
    expect(a.rarityIndex).toBeGreaterThanOrEqual(2);
    expect(b.rarityIndex).toBeGreaterThanOrEqual(2);
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
