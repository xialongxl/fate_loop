/**
 * 自动熔炼过滤器（P2）的单测。
 *
 * 有一件事这个文件**必须**证明，其余都是附带：
 *   **开关过滤器不改变任何一场战斗的指纹。**
 * 方案文档里那条"待决 A：自动分解会不会动摇确定性"就是这样被撤销的 ——
 * 掉落早就在 `${nodeId}:loot` 独立子流里 roll 完了，过滤器只决定"这件进不进包"。
 * 口头论证不算数，所以这里拿 battleFingerprint 逐项对拍钉住它：
 * 哪天有人把过滤逻辑塞进 `rollEquipment` 里"顺手重 roll"，这条会红。
 */

import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../../src/core/prng.js';
import {
  LOOT_FILTER_PRESETS,
  clearedFilter,
  defaultLootFilter,
  dryRunFilter,
  filterFromPreset,
  filterHashOf,
  filterSummary,
  gearVerdict,
  normalizeLootFilter,
  presetKeyOf,
  ruleForGear,
  rulePhrase,
} from '../../src/core/lootFilter.js';
import { rollEquipment, salvageValue } from '../../src/core/equipment.js';
import { RARITIES, NODE_TYPE } from '../../src/core/constants.js';
import { battleFingerprint, createHarness } from '../helpers.js';
import { serializeRun } from '../../src/persistence/schema.js';

/** 造一件确定品质的装备（forceRarity ⇒ 不看掉落曲线，测试才不会随曲线漂）。 */
function gearAt({ rarity, slot = 'weapon', floor = 10, seed = 7, stats = null }) {
  const gear = rollEquipment({
    rng: mulberry32(seed),
    floorNumber: floor,
    idSuffix: `t.${rarity}.${slot}`,
    forceSlot: slot,
    forceRarity: rarity,
  });
  // ⚠️ stats 要并进 gear.stats，不是并到顶层：写成 {...gear, crit: 5} 会造出
  // 一件“顶层有 crit、stats 里没 crit”的假装备，而判定读的是 stats.crit。
  return stats === null ? gear : { ...gear, stats: { ...gear.stats, ...stats } };
}

describe('规则规范化：不信任输入，但也不让规则坏了开不了机', () => {
  it('脏值全部夹回合法区间，未知字段丢弃', () => {
    const cleaned = normalizeLootFilter({
      enabled: true,
      minRarity: 999,
      requiredAffixes: ['haste', 'crit', 'crit'],
      minAffixValues: { crit: -4, attack: 12.9, nonsense: 5 },
      minScore: -1,
      meltAffixes: ['maxHp', 'bogus'],
      groups: { weapon: { minRarity: -1, nonsense: 1 }, bogusGroup: { minRarity: 3 } },
      slots: { ring: { minRarity: 9 }, bogusSlot: { minRarity: 8 } },
      keepIfBetterThanEquipped: 'yes',
    });
    expect(cleaned.minRarity).toBe(RARITIES.length - 1);
    expect(cleaned.requiredAffixes).toEqual(['crit']); // 去重 + 丢未知
    expect(cleaned.minAffixValues).toEqual({ attack: 12 }); // crit:-4 归零后不进 map
    expect(cleaned.minScore).toBe(0);
    expect(cleaned.meltAffixes).toEqual(['maxHp']);
    // -1 夹到 0 ⇒ 空规则 ⇒ 整条被丢（不让它占一行“≥破损”）
    expect(cleaned.groups.weapon).toBeUndefined();
    expect(cleaned.groups.bogusGroup).toBeUndefined();
    // ring 的 9 越界 → 夹到顶档而不是丢（数值越界夹，名字不认识丢）
    expect(cleaned.slots.ring.minRarity).toBe(RARITIES.length - 1);
    expect(cleaned.slots.bogusSlot).toBeUndefined();
    expect(cleaned.keepIfBetterThanEquipped).toBe(true); // 只认 false
  });

  it('undefined / null / 非对象都回落到「不自动熔炼」', () => {
    for (const raw of [undefined, null, 42, 'junk', []]) {
      const cleaned = normalizeLootFilter(raw);
      expect(cleaned.enabled).toBe(false);
      expect(cleaned).toEqual(defaultLootFilter());
    }
  });

  it('旧单条字段自动迁移（老档不改也能跑，但新格式是唯一真相）', () => {
    const cleaned = normalizeLootFilter({
      enabled: true,
      requireAffix: 'crit',
      minAffixValue: 5,
    });
    expect(cleaned.requiredAffixes).toEqual(['crit']);
    expect(cleaned.minAffixValues).toEqual({ crit: 5 });
    // 没设 requireAffix 时，孤零零的 minAffixValue 不会凭空变成一条隐形规则
    expect(normalizeLootFilter({ enabled: true, minAffixValue: 50 }).minAffixValues).toEqual({});
  });

  it('规范化是幂等的（读档→存档→再读档不该继续漂）', () => {
    const raw = { enabled: true, minRarity: 4, groups: { armor: { minRarity: 6, requireAffix: 'crit', minAffixValue: 3 } } };
    expect(normalizeLootFilter(normalizeLootFilter(raw))).toEqual(normalizeLootFilter(raw));
  });
});

describe('判定', () => {
  it('默认关闭时全部保留', () => {
    for (let rarity = 0; rarity < RARITIES.length; rarity += 1) {
      const verdict = gearVerdict(gearAt({ rarity }), { filter: defaultLootFilter() });
      expect(verdict.keep).toBe(true);
      expect(verdict.reason).toBe('off');
    }
  });

  it('品质阈值按「低于就熔」执行，边界值保留', () => {
    const filter = filterFromPreset('epic_up');
    expect(gearVerdict(gearAt({ rarity: 3 }), { filter }).keep).toBe(false);
    expect(gearVerdict(gearAt({ rarity: 4 }), { filter }).keep).toBe(true);
  });

  it('优先级是 逐槽 > 部位组 > 全局', () => {
    const filter = normalizeLootFilter({
      enabled: true,
      minRarity: 1,
      groups: { accessory: { minRarity: 5 } },
      slots: { ring: { minRarity: 3 } },
      keepIfBetterThanEquipped: false,
    });
    // 戒指：逐槽 3 覆盖组的 5
    expect(ruleForGear({ slot: 'ring' }, filter).minRarity).toBe(3);
    expect(gearVerdict(gearAt({ rarity: 3, slot: 'ring' }), { filter }).keep).toBe(true);
    expect(gearVerdict(gearAt({ rarity: 4, slot: 'pendant' }), { filter }).keep).toBe(false);
    // 武器走全局
    expect(ruleForGear({ slot: 'weapon' }, filter).minRarity).toBe(1);
    expect(gearVerdict(gearAt({ rarity: 0, slot: 'weapon' }), { filter }).keep).toBe(false);
  });

  it('词条门槛：多条同时必满足，每条独立下限，crit 用 0.1% 为单位', () => {
    // 用 crit + defense 做双条件：造的是武器，它天然没防御 ⇒ 能真的“缺一条”。
    // （拿 attack 当缺失项会假过 —— 武器基线本来就带 attack > 0）
    const filter = normalizeLootFilter({
      enabled: true,
      requiredAffixes: ['crit', 'defense'],
      minAffixValues: { crit: 5, defense: 20 },
      keepIfBetterThanEquipped: false,
    });
    // 缺 defense → missingAffix（哪怕 crit 超额满）。显式写 0：八条词缀的随机roll
    // 可能已经给了防御，不写死这条会变成"看运气过"的测试。
    expect(gearVerdict(gearAt({ rarity: 8, stats: { crit: 9, defense: 0 } }), { filter }).reason).toBe('missingAffix');
    // 两条都带了，但 crit 只有 3 < 5 → affixTooLow（与 missingAffix 是两种拒绝）
    const both = gearAt({ rarity: 8, stats: { crit: 3, defense: 40 } });
    expect(gearVerdict(both, { filter }).reason).toBe('affixTooLow');
    // 都够 → 留
    expect(gearVerdict(gearAt({ rarity: 8, stats: { crit: 25, defense: 40 } }), { filter }).keep).toBe(true);
    // crit=0 算"没带这条"，不是"带得不够"
    expect(gearVerdict(gearAt({ rarity: 8, stats: { crit: 0, defense: 40 } }), { filter }).reason)
      .toBe('missingAffix');
  });

  it('「带这条就熔」是硬否决，排在过渡装保护之前', () => {
    const filter = normalizeLootFilter({
      enabled: true,
      meltAffixes: ['maxHp'],
      keepIfBetterThanEquipped: true,
    });
    // 分数高到天上也没用：玩家说了带生命的不要
    const bigButHp = {
      ...gearAt({ rarity: 8, slot: 'weapon' }),
      stats: { maxHp: 500, attack: 1, defense: 0, crit: 0 },
      score: 999_999,
    };
    const verdict = gearVerdict(bigButHp, {
      filter,
      equipment: { weapon: { ...gearAt({ rarity: 1 }), score: 1 } },
    });
    expect(verdict.keep).toBe(false);
    expect(verdict.reason).toBe('meltAffix');
  });

  it('评分下限：品质过线但分数不够照样熔', () => {
    const filter = normalizeLootFilter({
      enabled: true,
      minRarity: 2,
      minScore: 5000,
      keepIfBetterThanEquipped: false,
    });
    expect(gearVerdict({ ...gearAt({ rarity: 6 }), score: 100 }, { filter }).reason).toBe('belowMinScore');
    expect(gearVerdict({ ...gearAt({ rarity: 6 }), score: 9000 }, { filter }).keep).toBe(true);
  });

  /**
   * P2b 修的真 bug：旧模型里 `{...base, ...slot}` 会把槽里没设的 minRarity 当成 0，
   * 于是"这个槽只想加一条词条要求"会静默把全局品质门槛清零。
   */
  it('逐槽只设它明说的字段，没设的往下继承而不是覆盖成零', () => {
    const filter = normalizeLootFilter({
      enabled: true,
      minRarity: 4,
      slots: { ring: { requiredAffixes: ['crit'] } },
      keepIfBetterThanEquipped: false,
    });
    const rule = ruleForGear({ slot: 'ring' }, filter);
    expect(rule.minRarity).toBe(4); // 继承全局，没被清成 -1/0
    expect(rule.requiredAffixes).toEqual(['crit']);
    expect(gearVerdict(gearAt({ rarity: 2, slot: 'ring' }), { filter }).reason).toBe('belowMinRarity');
    expect(gearVerdict(gearAt({ rarity: 5, slot: 'ring' }), { filter }).reason).toBe('missingAffix');
  });

  it('「比身上好就必留」排在品质阈值之前', () => {
    const filter = filterFromPreset('epic_up');
    const wornButBetter = { ...gearAt({ rarity: 0 }), score: 999_999 };
    const wornAndWorse = { ...gearAt({ rarity: 0 }), score: 1 };
    const equipped = { weapon: { ...gearAt({ rarity: 1 }), score: 100 } };
    expect(gearVerdict(wornButBetter, { filter, equipment: equipped }).reason).toBe('betterThanEquipped');
    expect(gearVerdict(wornAndWorse, { filter, equipment: equipped }).keep).toBe(false);
  });

  it('不传 equipment 时那条保护不假装生效（宁可少留，也不悄悄改语义）', () => {
    const filter = filterFromPreset('epic_up');
    const better = { ...gearAt({ rarity: 0 }), score: 999_999 };
    expect(gearVerdict(better, { filter }).keep).toBe(false);
  });

  it('关闭状态下连试算都不熔任何东西', () => {
    const inventory = [gearAt({ rarity: 0 }), gearAt({ rarity: 1 })];
    const run = dryRunFilter(defaultLootFilter(), { inventory, equipment: {} });
    expect(run.melted).toHaveLength(0);
    expect(run.kept).toHaveLength(2);
    expect(run.shards).toBe(0);
  });
});

describe('预设', () => {
  it('四个预设都在，且默认是「不自动熔炼」—— 自动熔炼是玩家主动开启的东西', () => {
    expect(LOOT_FILTER_PRESETS.map((p) => p.id)).toEqual(['off', 'junk', 'epic_up', 'crit_jewelry']);
    expect(defaultLootFilter().enabled).toBe(false);
    expect(presetKeyOf(defaultLootFilter())).toBe('off');
  });

  it('每个预设 round-trip：套上再认，认得出自己', () => {
    for (const preset of LOOT_FILTER_PRESETS) {
      const filter = filterFromPreset(preset.id);
      expect(filter).not.toBeNull();
      expect(presetKeyOf(filter)).toBe(preset.id);
    }
  });

  it('改过任何一个控件就脱离预设（下拉框不许说瞎话）', () => {
    const filter = filterFromPreset('junk');
    filter.minRarity = 3;
    expect(presetKeyOf(filter)).toBe('custom');
  });

  it('预设 id 写错返回 null，不是"静默变成一个空规则"', () => {
    expect(filterFromPreset('nope')).toBeNull();
  });

  it('「首饰要暴击」只紧首饰，不紧武器防具', () => {
    const filter = filterFromPreset('crit_jewelry');
    expect(gearVerdict(gearAt({ rarity: 2, slot: 'weapon' }), { filter }).keep).toBe(true);
    expect(gearVerdict(gearAt({ rarity: 4, slot: 'ring' }), { filter }).keep).toBe(false); // 无暴击
    const withCrit = gearAt({ rarity: 4, slot: 'ring' });
    withCrit.stats = { ...withCrit.stats, crit: 8 };
    expect(gearVerdict(withCrit, { filter }).keep).toBe(true);
  });

  it('清空规则回到「不自动熔炼」（预设行里那个 reset）', () => {
    const dirty = filterFromPreset('crit_jewelry');
    dirty.minScore = 900;
    const cleared = clearedFilter();
    expect(cleared.enabled).toBe(false);
    expect(cleared.slots).toEqual({});
    expect(presetKeyOf(cleared)).toBe('off');
    expect(cleared).not.toBe(dirty); // 不是把原对象改几个字段就算“清空”
  });
});

describe('摘要与指纹', () => {
  it('摘要说人话：出现品质名与条件名，不出现裸下标', () => {
    const text = filterSummary(filterFromPreset('epic_up'));
    expect(text).toContain('史诗');
    const rich = rulePhrase({
      minRarity: 4,
      requiredAffixes: ['crit'],
      minAffixValues: { crit: 5 },
      minScore: 3000,
      meltAffixes: ['maxHp'],
    });
    expect(rich).toContain('带生命则熔');
    expect(rich).toContain('须带暴击');
    expect(rich).toContain('评分≥3000');
  });

  it('同一规则同哈希，改一格就变；与 slots 对象的键序无关', () => {
    const a = filterFromPreset('crit_jewelry');
    const b = filterFromPreset('crit_jewelry');
    expect(filterHashOf(a)).toBe(filterHashOf(b));
    const reordered = {
      ...a,
      slots: { ring: a.slots.ring, pendant: a.slots.pendant, trinket: a.slots.trinket },
    };
    expect(filterHashOf(reordered)).toBe(filterHashOf(a));
    expect(filterHashOf({ ...a, minScore: 3 })).not.toBe(filterHashOf(a));
    expect(filterHashOf({ ...a, meltAffixes: ['maxHp'] })).not.toBe(filterHashOf(a));
    expect(filterHashOf({ ...a, keepIfBetterThanEquipped: false })).not.toBe(filterHashOf(a));
    expect(filterHashOf(a)).toMatch(/^[0-9a-f]{8}$/);
  });

  it('关闭状态的哈希稳定 —— 所有旧档兼平的"没开熔炼"都归到同一个值', () => {
    expect(filterHashOf(undefined)).toBe(filterHashOf(defaultLootFilter()));
  });
});

describe('试算是只读的', () => {
  it('不改背包、不改装备栏，碎片等于逐件 salvageValue 之和', () => {
    const inventory = [gearAt({ rarity: 0 }), gearAt({ rarity: 1 }), gearAt({ rarity: 4 })];
    const snapshot = JSON.parse(JSON.stringify(inventory.map((g) => g.id)));
    const eq = {};
    const run = dryRunFilter(filterFromPreset('epic_up'), { inventory, equipment: eq });
    expect(inventory.map((g) => g.id)).toEqual(snapshot);
    expect(eq).toEqual({});
    expect(run.kept.map((g) => g.rarityIndex)).toEqual([4]);
    expect(run.shards).toBe(
      salvageValue(inventory[0]) + salvageValue(inventory[1]),
    );
  });
});

// ============================================================
// 接进流程：真掉落、真日志、真存档
// ============================================================

/**
 * 在一个有精英节点的层上打一场，拿“战后指纹 + 结算后状态”。
 *
 * ⚠️ **每个变体都新建 harness**：同一个 harness 连着打两场，第二场的玩家
 * 已经吃过第一场的经验与掉落，指纹当然不同 —— 那会报成"过滤器改变了战斗"，
 * 而真正变了的是上一场结算。隔离到这个粒度，断言才只测过滤器本身。
 */
async function battleOnElite(seed, filter) {
  const h = await createHarness({ seed });
  let node = null;
  for (let floor = 1; floor <= 8 && node === null; floor += 1) {
    h.flow.enterFloor(floor);
    node = h.store.unsafeGetState().mapNodes.find((n) => n.type === NODE_TYPE.ELITE) ?? null;
  }
  expect(node, `seed ${seed} 前 8 层没有精英节点`).toBeTruthy();

  h.store.update((draft) => {
    draft.lootFilter = filter;
    draft.currentNodeId = node.id;
  });
  h.flow.startBattle();
  h.engine.runToEnd();
  const fingerprint = battleFingerprint(h.store.getSnapshot());
  h.flow.finishBattle();
  const state = h.store.getSnapshot();
  return {
    fingerprint,
    inventory: state.player.inventory.length,
    shards: state.fateShards,
    melted: state.metadata.gearMelted,
    log: state.log.map((entry) => entry.message),
    lastBattleReward: state.lastBattleReward,
  };
}

describe('熔炼规则接进战斗结算', () => {
  it('开关过滤器 ⇒ 战斗指纹逐项相等（过滤器不碰随机流）', async () => {
    const off = await battleOnElite(20240101, defaultLootFilter());
    const sameOff = await battleOnElite(20240101, filterFromPreset('off'));
    // 1) 脚手架自检：两个“等价于关闭”的变体必须逐项相同，否则下面那条是假绿
    expect(sameOff.fingerprint).toEqual(off.fingerprint);

    const epic = await battleOnElite(20240101, filterFromPreset('epic_up'));
    // 2) 关键断言：战斗本身的指纹不变
    expect(epic.fingerprint).toEqual(off.fingerprint);
    // 3) 背包只减不增、碎片只增不减（这个节点的精英不一定掉低档，只断“不逆”，
    //    严格版交给下面第 5 条）
    expect(epic.inventory).toBeLessThanOrEqual(off.inventory);
    expect(epic.shards).toBeGreaterThanOrEqual(off.shards);
    // 4) 熔掉的件数 + 留下的件数 = 掉落总数（两道关不重叠）
    expect(epic.melted + epic.inventory).toBe(off.inventory);

    // 5) 换成「只留顶档、关掉过渡装保护」：这次必须真的熔出东西
    const onlyTop = await battleOnElite(20240101, {
      enabled: true,
      minRarity: RARITIES.length - 1,
      keepIfBetterThanEquipped: false,
    });
    expect(onlyTop.fingerprint).toEqual(off.fingerprint);
    expect(onlyTop.inventory).toBe(0);
    expect(onlyTop.shards).toBeGreaterThan(off.shards);
  }, 60_000);

  it('开启后：低档掉落被熔、碎片入账、日志只多一条（不是每件一条）', async () => {
    const run = await battleOnElite(4242, filterFromPreset('epic_up'));
    const melted = run.lastBattleReward?.melted ?? [];
    for (const item of melted) {
      expect(item.shards).toBeGreaterThan(0);
    }
    expect(run.melted).toBe(melted.length);
    const meltLogs = run.log.filter((message) => message.includes('♻️'));
    // 精英掉 2 件：逐件写就是 2 条日志，LOG_CAPACITY 只有 100，会被挤成流水账
    expect(meltLogs.length).toBeLessThanOrEqual(1);
    if (melted.length > 0) {
      expect(meltLogs).toHaveLength(1);
      expect(meltLogs[0]).toContain(`♻️ 熔炼 ${melted.length} 件`);
      expect(meltLogs[0]).toContain('只留史诗以上');
    }
  }, 60_000);

  it('「包满溢出」与「按规则熔」是两件事，分开计不混成一个数字', async () => {
    const run = await battleOnElite(4242, defaultLootFilter());
    // 关着规则时：一件都不会进 melted，而 lastBattleReward.discarded 只在包满时才非零
    expect(run.lastBattleReward.melted).toEqual([]);
    expect(run.melted).toBe(0);
  });

  it('规则跟着存档往返；旧档缺字段 ⇒ 回到「不自动熔炼」', () => {
    const state = {
      seed: 1,
      floorNumber: 3,
      currentNodeId: 'a',
      startNodeId: 'a',
      exitNodeId: 'b',
      visitedNodeIds: new Set(['a']),
      clearedNodeIds: new Set(),
      shopStates: new Map(),
      fateShards: 10,
      victoryAchieved: false,
      metadata: { totalDamage: 0, totalHeal: 0, emptyLoops: 0, floorsCleared: 0, nodesVisited: 1, battlesWon: 0, shardsEarned: 0, expEarned: 0, gearFound: 0, gearMelted: 2, shardsFromMelt: 8 },
      player: {
        exp: 0,
        hp: 100,
        maxHp: 100,
        seedBonus: {},
        permanentBonus: {},
        gcdSequence: [],
        ogcdSlots: [],
        equipment: {},
        inventory: [],
        lootFilter: undefined,
      },
      lootFilter: filterFromPreset('crit_jewelry'),
    };
    const saved = serializeRun(state);
    expect(saved.lootFilter.slots.ring.minRarity).toBe(4);
    expect(saved.lootFilter.requiredAffixes).toEqual([]);
    expect(saved.lootFilterHash).toBe(filterHashOf(state.lootFilter));

    // 旧档：没有 lootFilter 字段 ⇒ normalize 兜到关闭
    const legacy = { ...saved, lootFilter: undefined, lootFilterHash: undefined };
    expect(normalizeLootFilter(legacy.lootFilter)).toEqual(defaultLootFilter());
  });
});
