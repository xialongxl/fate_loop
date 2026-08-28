/**
 * 开局可用性守卫（确定性平衡回归）。
 *
 * 为什么要有这个文件：交接时发现的 P0-新 不是崩溃，而是「能跑但玩不了」——
 * 解锁表把全部 oGCD 顶到 79 级之后，1 级合法序列没有任何自保手段，
 * 实测胜率从旧（非法）默认的 90% 掉到 38%。这类问题单测全绿也发现不了。
 *
 * 本作全链路确定性，因此胜率可以固化成断言：给定这批种子，结果恒定。
 * 若将来动怪物数值、遭遇分布或解锁表，这条测试会变红 —— 那是提醒你看一眼
 * 「新玩家第一局还打得过吗」，不是要你回退改动。
 */

import { describe, expect, it } from 'vitest';
import { createHarness, loadOfficialPool } from '../helpers.js';
import { DEFAULT_GCD_SEQUENCE, DEFAULT_OGCD_SLOTS } from '../../src/main.js';
import { TEST_GCD_SEQUENCE, TEST_OGCD_SLOTS } from '../helpers.js';
import { buildUnlockTable, familyOf } from '../../src/core/progression.js';
import {
  NODE_TYPE,
  SKILL_FAMILIES,
  SKILL_TYPE,
  STARTER_GCD_COUNT,
  STARTER_OGCD_COUNT,
} from '../../src/core/constants.js';

const SEEDS = [1, 7, 42, 999, 20240101, 31337];
const FLOORS = [1, 2, 3];

/** 用给定序列把每层的所有战斗/精英节点打一遍，统计胜率与阵亡数。 */
async function simulate({ gcdSequence, ogcdSlots, floors = FLOORS, seeds = SEEDS }) {
  let wins = 0;
  let battles = 0;
  let deaths = 0;

  for (const seed of seeds) {
    for (const floor of floors) {
      const h = await createHarness({ seed, gcdSequence, ogcdSlots });
      h.flow.enterFloor(floor);
      const nodes = h.store
        .unsafeGetState()
        .mapNodes.filter((n) => n.type === NODE_TYPE.COMBAT || n.type === NODE_TYPE.ELITE);

      let died = false;
      for (const node of nodes) {
        h.store.update((draft) => {
          draft.currentNodeId = node.id;
        });
        h.flow.startBattle();
        h.engine.runToEnd();
        const result = h.flow.finishBattle();
        battles += 1;
        if (result.won) {
          wins += 1;
        } else {
          deaths += 1;
          died = true;
          break; // 死了就换种子，与真实体验一致
        }
      }
      if (died) break;
    }
  }

  return { wins, battles, deaths, rate: battles === 0 ? 0 : wins / battles };
}

describe('解锁表给 1 级留出两类手段', () => {
  it(`1 级解锁 ${STARTER_GCD_COUNT} 个 GCD 与 ${STARTER_OGCD_COUNT} 个 oGCD`, async () => {
    const pool = await loadOfficialPool();
    const table = buildUnlockTable(pool.skills);

    const atOne = [...pool.skills.values()].filter((s) => table.get(s.id) === 1);
    expect(atOne.filter((s) => s.type === SKILL_TYPE.GCD)).toHaveLength(STARTER_GCD_COUNT);
    expect(atOne.filter((s) => s.type === SKILL_TYPE.OGCD)).toHaveLength(STARTER_OGCD_COUNT);
  });

  it('1 级就有治疗类 oGCD（否则开局没有任何自保手段）', async () => {
    const pool = await loadOfficialPool();
    const table = buildUnlockTable(pool.skills);
    const healAtOne = [...pool.skills.values()].filter(
      (s) =>
        s.type === SKILL_TYPE.OGCD &&
        table.get(s.id) === 1 &&
        /heal|恢复|治疗|吸|wind|feast/i.test(`${s.name}${s.description}`),
    );
    expect(healAtOne.length).toBeGreaterThan(0);
  });

  it('默认开局序列覆盖全部流派（各一个），而不是全堆在物理系', async () => {
    const pool = await loadOfficialPool();
    const covered = DEFAULT_GCD_SEQUENCE.map((id) => familyOf(pool.skills.get(id)));
    expect([...new Set(covered)].sort()).toEqual([...SKILL_FAMILIES].sort());
  });

  it('测试脚手架用的序列也 1 级合法（否则 sanitizeSequence 会把它洗掉，白测）', async () => {
    const pool = await loadOfficialPool();
    const table = buildUnlockTable(pool.skills);
    const illegal = [
      ...TEST_GCD_SEQUENCE.filter((id) => (table.get(id) ?? 1) > 1),
      ...TEST_OGCD_SLOTS.filter((slot) => (table.get(slot.skillId) ?? 1) > 1).map((slot) => slot.skillId),
    ];
    expect(illegal).toEqual([]);
  });

  it('默认开局序列在 1 级全部合法', async () => {
    const pool = await loadOfficialPool();
    const table = buildUnlockTable(pool.skills);
    const illegal = [
      ...DEFAULT_GCD_SEQUENCE.map((id) => [id, table.get(id) ?? 1]),
      ...DEFAULT_OGCD_SLOTS.map((s) => [s.skillId, table.get(s.skillId) ?? 1]),
    ].filter(([, level]) => level > 1);

    expect(illegal).toEqual([]);
  });
});

describe('默认开局真的能打下第 1~3 层', () => {
  it('胜率不低于 70%，且不是靠空过场次凑的', async () => {
    const { wins, battles, rate } = await simulate({
      gcdSequence: DEFAULT_GCD_SEQUENCE,
      ogcdSlots: DEFAULT_OGCD_SLOTS,
    });

    expect(battles).toBeGreaterThan(20);
    console.info(`[balance] 默认开局胜率 ${(rate * 100).toFixed(0)}%（${wins}/${battles}）`);
    expect(rate).toBeGreaterThanOrEqual(0.7);
  }, 60_000);

  it('oGCD 在真实战斗里确实被释放过（解锁了却没触发等于没解锁）', async () => {
    // 战斗日志记的是伤害/治疗/状态结果，不含技能名，因此用「冷却时间戳是否被写入」
    // 来判断释放过没有：engine.begin 会把 ogcdReadyAtMs 重置成空 Map，
    // 只有真的释放过才会留下 readyAt。
    async function readyMapFor(gcd, ogcd) {
      const h = await createHarness({ seed: 20240101, gcdSequence: gcd, ogcdSlots: ogcd });
      h.flow.enterFloor(1);
      const node = h.store.unsafeGetState().mapNodes.find((n) => n.type === NODE_TYPE.COMBAT);
      h.store.update((draft) => {
        draft.currentNodeId = node.id;
      });
      h.flow.startBattle();
      h.engine.runToEnd();
      return h.store.getSnapshot().player.ogcdReadyAtMs;
    }

    const withOgcd = await readyMapFor(DEFAULT_GCD_SEQUENCE, DEFAULT_OGCD_SLOTS);
    expect(withOgcd.size).toBeGreaterThan(0);
    // suddenStrike 无施放条件，冷却转完就该再来一次
    expect(withOgcd.get('ogcd.suddenStrike') ?? 0).toBeGreaterThan(0);

    const withoutOgcd = await readyMapFor(DEFAULT_GCD_SEQUENCE, []);
    expect(withoutOgcd.size).toBe(0);
  });
});
