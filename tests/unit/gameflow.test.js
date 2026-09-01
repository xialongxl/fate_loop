/**
 * GameFlow 探索流程单测（阶段 6 + 阶段 8 的编排层）。
 *
 * 为什么先补这块：GameFlow 是 UI 与内核之间唯一的协调层，阶段 9 接线会大量
 * 调用它，而它此前零覆盖 —— 交接文档里的 P0-3（商店永久属性被 recalc 抹掉）
 * 正是这片空白藏住的。下面「永久属性」一节把它固化为回归测试。
 *
 * 约定：
 *   - 地图由种子决定，因此测试固定种子，并用 goto() 直接把玩家放到目标节点，
 *     避免为了走到商店而写一串寻路（移动规则本身在 moveTo 一节单测）。
 *   - 强制战败用空序列（打不出伤害 → 判负），不去改 HP：HP 是派生值，
 *     硬改会被任何一次 recalc 覆盖，测试会变成在测 recalc 的副作用。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { createHarness } from '../helpers.js';
import { AUTO_SAVE_SLOT } from '../../src/core/constants.js';
import {
  GAME_STATUS,
  GROWTH_PER_LEVEL,
  INVENTORY_CAPACITY,
  NODE_TYPE,
  REST_HEAL_RATIO,
  SHARD_REWARD_COMBAT,
  SHARD_REWARD_ELITE_MULTIPLIER,
  SHOP_GEAR_COUNT,
  SHOP_OFFER_COUNT,
  SPEED_MODES,
  VICTORY_FLOOR,
  WINNER,
} from '../../src/core/constants.js';
import { enhanceCost, rollEquipment, salvageValue } from '../../src/core/equipment.js';
import { mulberry32 } from '../../src/core/prng.js';
import { levelFromTotalExp, totalExpForLevel } from '../../src/core/progression.js';
import { recalcPlayer } from '../../src/core/derived.js';
import { LOOT_MIN_RARITY, rollBattleLoot } from '../../src/core/loot.js';
import { serializeRun } from '../../src/persistence/schema.js';

const SEED = 20240101;

/** 装配一局并进入第 1 层，附带若干测试脚手架。 */
async function boot(options = {}) {
  const h = await createHarness({ seed: SEED, ...options });
  h.flow.enterFloor(1);

  const st = () => h.store.unsafeGetState();
  return {
    ...h,
    st,
    /** 直接落位到某节点（同步登记到访，模拟真实移动后的状态）。 */
    goto(node) {
      h.store.update((d) => {
        d.currentNodeId = node.id;
        d.visitedNodeIds.add(node.id);
      });
      return node;
    },
    of: (type) => st().mapNodes.filter((n) => n.type === type),
    first: (type) => st().mapNodes.find((n) => n.type === type),
    byId: (id) => st().mapNodes.find((n) => n.id === id),
    shards(amount) {
      h.store.update((d) => {
        d.fateShards = amount;
      });
    },
    /** 塞一件装备进背包（forceSlot 让主属性可预期）。 */
    addGear(idSuffix, { slot = 'weapon', rarity = 3, floorNumber = 1 } = {}) {
      const gear = rollEquipment({
        rng: mulberry32(rarity * 7 + floorNumber),
        floorNumber,
        idSuffix,
        forceSlot: slot,
        forceRarity: rarity,
      });
      h.store.update((d) => {
        d.player.inventory.push(gear);
      });
      return gear;
    },
  };
}

/** 取某节点的一个邻居。 */
function neighborOf(state, nodeId) {
  const id = (state.mapAdjacency[nodeId] ?? [])[0];
  return id === undefined ? null : state.mapNodes.find((n) => n.id === id);
}

/**
 * 把玩家放到一个「货架上真的在卖这件商品」的商店节点。
 * 货架由 (种子, 层, nodeId) 派生，因此这里可以跨层找；找不到就是内容有问题。
 */
function gotoShopSelling(g, itemId, { maxFloors = 6 } = {}) {
  for (let floor = g.st().floorNumber; floor <= maxFloors; floor += 1) {
    for (const shop of g.of(NODE_TYPE.SHOP)) {
      g.goto(shop);
      if (g.flow.getShopOffers().offers.some((o) => o.id === itemId)) return true;
    }
    g.flow.enterFloor(floor + 1);
  }
  return false;
}

/** 同步跑完当前战斗。 */
function settle(h) {
  h.engine.runToEnd();
  return h.st();
}

let g;
beforeEach(async () => {
  g = await boot();
});

// ============================================================
// 进入楼层
// ============================================================

describe('enterFloor', () => {
  it('生成地图、把玩家放到起点并进入探索态', () => {
    const s = g.st();
    expect(s.status).toBe(GAME_STATUS.EXPLORING);
    expect(s.floorNumber).toBe(1);
    expect(s.mapNodes.length).toBeGreaterThan(0);
    expect(s.currentNodeId).toBe(s.startNodeId);
    expect(s.visitedNodeIds.has(s.startNodeId)).toBe(true);
    expect(s.clearedNodeIds.size).toBe(0);
    expect(s.shopStates.size).toBe(0);
    expect(s.monsters).toEqual([]);
    expect(s.activeBattle).toBeNull();
    expect(s.winner).toBeNull();
    expect(s.log.some((l) => l.message.includes('进入第 1 层'))).toBe(true);
  });

  it('起点与邻居已揭示，远处节点未揭示', () => {
    const s = g.st();
    expect(g.byId(s.startNodeId).isRevealed).toBe(true);
    expect(neighborOf(s, s.startNodeId).isRevealed).toBe(true);
    expect(s.mapNodes.some((n) => !n.isRevealed)).toBe(true);
  });

  it('同种子两次进入得到逐项相同的地图', async () => {
    const other = await boot();
    const a = g.st();
    const b = other.st();
    expect(b.mapNodes.map((n) => [n.id, n.type, n.gridX, n.gridY])).toEqual(
      a.mapNodes.map((n) => [n.id, n.type, n.gridX, n.gridY]),
    );
    expect(b.mapAdjacency).toEqual(a.mapAdjacency);
    expect(b.startNodeId).toBe(a.startNodeId);
    expect(b.exitNodeId).toBe(a.exitNodeId);
  });

  it('不同种子得到不同地图（种子确实驱动生成）', async () => {
    const other = await boot({ seed: 777 });
    const sig = (state) => `${state.gridWidth}x${state.gridHeight}|${state.startNodeId}|${state.exitNodeId}`;
    expect(sig(other.st())).not.toBe(sig(g.st()));
  });

  it('清理上一场战斗的残留状态', async () => {
    const h = await boot();
    h.goto(h.first(NODE_TYPE.COMBAT));
    h.flow.startBattle();
    h.engine.runToEnd();
    h.flow.finishBattle();

    h.flow.enterFloor(5);
    const s = h.st();
    expect(s.floorNumber).toBe(5);
    expect(s.monsters).toEqual([]);
    expect(s.activeBattle).toBeNull();
    expect(s.status).toBe(GAME_STATUS.EXPLORING);
  });

  it('缺少地图生成器时抛错而不是静默崩溃', async () => {
    const h = await boot();
    const generator = h.pool.mapGenerators.get('official.grid');
    h.pool.mapGenerators.delete('official.grid');
    try {
      expect(() => h.flow.enterFloor(2)).toThrow(/地图生成器/);
    } finally {
      h.pool.mapGenerators.set('official.grid', generator);
    }
    expect(() => h.flow.enterFloor(2)).not.toThrow();
  });
});

// ============================================================
// 移动
// ============================================================

describe('moveTo', () => {
  it('允许移动到相邻节点并更新位置', () => {
    const s = g.st();
    const target = neighborOf(s, s.currentNodeId);
    expect(g.flow.moveTo(target.id).ok).toBe(true);
    expect(g.st().currentNodeId).toBe(target.id);
  });

  it('拒绝非相邻与不存在的节点，且不改变位置', () => {
    const s = g.st();
    const reachable = new Set([s.currentNodeId, ...(s.mapAdjacency[s.currentNodeId] ?? [])]);
    const far = s.mapNodes.find((n) => !reachable.has(n.id));
    const before = s.currentNodeId;

    expect(g.flow.moveTo(far.id)).toEqual({ ok: false, reason: 'notAdjacent' });
    expect(g.flow.moveTo('node_999_999')).toEqual({ ok: false, reason: 'notAdjacent' });
    expect(g.st().currentNodeId).toBe(before);
  });

  it('非探索状态下不能移动', () => {
    g.flow.startBattle();
    const s = g.st();
    expect(g.flow.moveTo(neighborOf(s, s.currentNodeId).id)).toEqual({
      ok: false,
      reason: 'notExploring',
    });
  });

  it('死路不可进入（生成器对死路只做单向接线）', () => {
    const s = g.st();
    const deadEnd = g.first(NODE_TYPE.DEAD_END);
    expect(deadEnd).toBeDefined();
    // 死路列出邻居是为了地图上能画出「此路不通」的连线，但邻居不反向列出它，
    // 因此 areAdjacent 天然拒绝向死路移动（generator.js 里写明了这一设计）
    expect(s.mapAdjacency[deadEnd.id].length).toBeGreaterThan(0);
    for (const neighbor of s.mapAdjacency[deadEnd.id]) {
      expect(s.mapAdjacency[neighbor]).not.toContain(deadEnd.id);
    }
    expect(g.flow.moveTo(deadEnd.id)).toEqual({ ok: false, reason: 'notAdjacent' });
  });

  it('首次到访计入 nodesVisited，重访不重复计数', () => {
    const s = g.st();
    const target = neighborOf(s, s.currentNodeId);
    const before = s.metadata.nodesVisited;

    expect(g.flow.moveTo(target.id).ok).toBe(true);
    expect(g.st().metadata.nodesVisited).toBe(before + 1);

    g.flow.moveTo(s.startNodeId);
    g.flow.moveTo(target.id);
    expect(g.st().metadata.nodesVisited).toBe(before + 1);
  });

  it('进入未清理的战斗节点触发战斗，清理后不再触发', async () => {
    const h = await boot();
    const combat = h.first(NODE_TYPE.COMBAT);
    const from = neighborOf(h.st(), combat.id);
    expect(from).toBeDefined();
    h.goto(from);

    expect(h.flow.moveTo(combat.id)).toEqual({ ok: true, triggeredBattle: true });

    h.flow.startBattle();
    settle(h);
    h.flow.finishBattle();
    expect(h.byId(combat.id).isCleared).toBe(true);

    h.goto(from);
    expect(h.flow.moveTo(combat.id)).toEqual({ ok: true, triggeredBattle: false });
  });

  it('进入非战斗节点不触发战斗，并揭开邻居视野', () => {
    const s = g.st();
    const target = neighborOf(s, s.currentNodeId);
    expect(g.flow.moveTo(target.id)).toEqual({ ok: true, triggeredBattle: false });
    for (const id of s.mapAdjacency[target.id]) {
      expect(g.byId(id).isRevealed).toBe(true);
    }
  });
});

// ============================================================
// 战斗与结算
// ============================================================

describe('startBattle / finishBattle', () => {
  it('胜利：清理节点、发碎片与经验、回到探索态', async () => {
    const h = await boot();
    const combat = h.first(NODE_TYPE.COMBAT);
    h.goto(combat);
    h.flow.startBattle();
    expect(h.st().status).toBe(GAME_STATUS.BATTLING);
    expect(h.st().activeBattle.nodeId).toBe(combat.id);

    const monsterCount = h.st().monsters.length;
    const expBefore = h.st().player.exp;
    expect(settle(h).status).toBe(GAME_STATUS.FINISHED);

    const result = h.flow.finishBattle();
    expect(result.won).toBe(true);
    expect(result.shards).toBe(SHARD_REWARD_COMBAT);
    // 第 1 层无楼层缩放：经验 = 每怪基础值 × 怪物数
    expect(result.exp).toBe(18 * monsterCount);

    const s = h.st();
    expect(s.player.exp).toBe(expBefore + result.exp);
    expect(s.status).toBe(GAME_STATUS.EXPLORING);
    expect(s.winner).toBeNull();
    expect(s.monsters).toEqual([]);
    expect(s.activeBattle).toBeNull();
    expect(s.clearedNodeIds.has(combat.id)).toBe(true);
    expect(s.metadata.battlesWon).toBe(1);
    expect(s.metadata.shardsEarned).toBe(result.shards);
    expect(s.metadata.expEarned).toBe(result.exp);
    expect(s.lastBattleReward.exp).toBe(result.exp);
  });

  it('结算不白送回血：HP 保持战斗结束时的值', async () => {
    const h = await boot();
    h.goto(h.first(NODE_TYPE.COMBAT));
    h.flow.startBattle();
    const after = settle(h);
    expect(after.winner).toBe(WINNER.PLAYER);

    h.flow.finishBattle();
    expect(h.st().player.hp).toBe(after.player.hp);
    expect(h.st().player.hp).toBeLessThan(h.st().player.maxHp);
  });

  it('精英节点双倍碎片与双倍经验', async () => {
    const h = await boot();
    const elite = h.first(NODE_TYPE.ELITE);
    h.goto(elite);
    h.flow.startBattle();
    expect(h.st().activeBattle.tier).toBe('elite');
    const monsterCount = h.st().monsters.length;
    settle(h);

    const result = h.flow.finishBattle();
    expect(result.shards).toBe(SHARD_REWARD_COMBAT * SHARD_REWARD_ELITE_MULTIPLIER);
    expect(result.exp).toBe(18 * monsterCount * 2);
  });

  it('跨过经验门槛时等级与上限提升，HP 按「保持缺失量」补齐', async () => {
    const h = await boot();
    h.store.update((d) => {
      d.player.exp = totalExpForLevel(2) - 1; // 差 1 点到 2 级
      recalcPlayer(d.player);
    });
    expect(h.st().player.level).toBe(1);
    const maxBefore = h.st().player.maxHp;

    h.goto(h.first(NODE_TYPE.COMBAT));
    h.flow.startBattle();
    settle(h);
    const result = h.flow.finishBattle();

    const s = h.st();
    expect(result.levelAfter).toBeGreaterThan(result.levelBefore);
    expect(s.player.level).toBe(2);
    expect(levelFromTotalExp(s.player.exp)).toBe(2);
    expect(s.player.maxHp).toBe(maxBefore + GROWTH_PER_LEVEL.maxHp);
    expect(s.log.some((l) => l.message.includes('等级提升'))).toBe(true);
  });

  it('战利品入包并记入 metadata', async () => {
    const h = await boot();
    const node = h
      .st()
      .mapNodes.find(
        (n) =>
          n.type === NODE_TYPE.COMBAT &&
          rollBattleLoot({ seed: SEED, floorNumber: 1, nodeId: n.id, isElite: false }).length > 0,
      );
    expect(node).toBeDefined();

    h.goto(node);
    h.flow.startBattle();
    settle(h);
    const result = h.flow.finishBattle();

    const expected = rollBattleLoot({ seed: SEED, floorNumber: 1, nodeId: node.id, isElite: false });
    expect(h.st().player.inventory.map((x) => x.id)).toEqual(expected.map((x) => x.id));
    expect(result.loot.map((x) => x.id)).toEqual(expected.map((x) => x.id));
    expect(h.st().metadata.gearFound).toBe(expected.length);
    expect(h.st().lastBattleReward.discarded).toBe(0);
  });

  it('背包满时战利品自动折算成碎片，不阻塞流程', async () => {
    const h = await boot();
    const node = h
      .st()
      .mapNodes.find(
        (n) =>
          n.type === NODE_TYPE.COMBAT &&
          rollBattleLoot({ seed: SEED, floorNumber: 1, nodeId: n.id, isElite: false }).length > 0,
      );
    const drop = rollBattleLoot({ seed: SEED, floorNumber: 1, nodeId: node.id, isElite: false })[0];

    h.store.update((d) => {
      for (let i = 0; i < INVENTORY_CAPACITY; i += 1) {
        d.player.inventory.push(
          rollEquipment({ rng: mulberry32(i), floorNumber: 1, idSuffix: `full.${i}`, forceRarity: 0 }),
        );
      }
    });
    const shardsBefore = h.st().fateShards;

    h.goto(node);
    h.flow.startBattle();
    settle(h);
    const result = h.flow.finishBattle();

    const s = h.st();
    expect(s.player.inventory.length).toBe(INVENTORY_CAPACITY);
    expect(result.loot).toEqual([]);
    expect(s.lastBattleReward.discarded).toBe(1);
    expect(s.metadata.gearFound).toBe(0);
    expect(s.fateShards).toBe(shardsBefore + SHARD_REWARD_COMBAT + salvageValue(drop));
    expect(s.log.some((l) => l.message.includes('背包已满'))).toBe(true);
  });

  it('战败：记录永久死亡，不回到探索态、不给奖励', async () => {
    const h = await boot({ gcdSequence: [], ogcdSlots: [] });
    const node = h.first(NODE_TYPE.COMBAT);
    h.goto(node);
    h.flow.startBattle();
    const after = settle(h);
    expect(after.winner).toBe(WINNER.MONSTERS);

    const shardsBefore = h.st().fateShards;
    const expBefore = h.st().player.exp;
    expect(h.flow.finishBattle()).toEqual({ settled: true, won: false, outcome: 'death' });

    const s = h.st();
    expect(s.status).toBe(GAME_STATUS.FINISHED);
    expect(s.clearedNodeIds.has(node.id)).toBe(false);
    expect(s.fateShards).toBe(shardsBefore);
    expect(s.player.exp).toBe(expBefore);
    expect(s.metadata.battlesWon).toBe(0);
  });

  it('战斗未结束时不做结算', () => {
    g.flow.startBattle();
    g.engine.runFrame(SPEED_MODES.X1);
    expect(g.flow.finishBattle()).toEqual({ settled: false });
  });

  it('同一场战斗不会被重复结算', async () => {
    const h = await boot();
    h.goto(h.first(NODE_TYPE.COMBAT));
    h.flow.startBattle();
    settle(h);
    expect(h.flow.finishBattle().won).toBe(true);

    const shards = h.st().fateShards;
    expect(h.flow.finishBattle()).toEqual({ settled: false });
    expect(h.st().fateShards).toBe(shards);
  });
});

// ============================================================
// 休息节点
// ============================================================

describe('useRest', () => {
  it('恢复 REST_HEAL_RATIO 比例的生命，且一次性', () => {
    const rest = g.first(NODE_TYPE.REST);
    g.goto(rest);
    g.store.update((d) => {
      d.player.hp = 100;
    });
    const expected = Math.floor(g.st().player.maxHp * REST_HEAL_RATIO);

    const result = g.flow.useRest();
    expect(result.ok).toBe(true);
    expect(result.healed).toBe(expected);
    expect(g.st().player.hp).toBe(100 + expected);
    expect(g.byId(rest.id).isCleared).toBe(true);
    expect(g.st().clearedNodeIds.has(rest.id)).toBe(true);

    expect(g.flow.useRest()).toEqual({ ok: false, reason: 'alreadyUsed' });
  });

  it('不会超过生命上限', () => {
    const maxHp = g.st().player.maxHp;
    g.goto(g.first(NODE_TYPE.REST));
    g.store.update((d) => {
      d.player.hp = maxHp - 1;
    });
    g.flow.useRest();
    expect(g.st().player.hp).toBe(maxHp);
  });

  it('非休息节点拒绝', () => {
    g.goto(g.first(NODE_TYPE.COMBAT));
    expect(g.flow.useRest()).toEqual({ ok: false, reason: 'notRestNode' });
  });
});

// ============================================================
// 商店
// ============================================================

describe('商店', () => {
  it('商品列表由种子派生，重复读取恒定（来回走动不刷新）', () => {
    g.goto(g.first(NODE_TYPE.SHOP));
    const first = g.flow.getShopOffers();
    expect(first.offers.length).toBe(SHOP_OFFER_COUNT);
    expect(new Set(first.offers.map((o) => o.id)).size).toBe(first.offers.length);
    expect(g.flow.getShopOffers().offers.map((o) => o.id)).toEqual(first.offers.map((o) => o.id));
  });

  it('读取货架不扣碎片', () => {
    g.goto(g.first(NODE_TYPE.SHOP));
    const before = g.st().fateShards;
    g.flow.getShopOffers();
    expect(g.st().fateShards).toBe(before);
  });

  it('非商店节点返回 null', () => {
    g.goto(g.first(NODE_TYPE.COMBAT));
    expect(g.flow.getShopOffers()).toBeNull();
  });

  it('购买：扣碎片并施加效果', () => {
    g.goto(g.first(NODE_TYPE.SHOP));
    const [offer] = g.flow.getShopOffers().offers;
    g.shards(1000);
    const before = g.st().fateShards;

    expect(g.flow.purchase(offer.id)).toEqual({ ok: true });
    expect(g.st().fateShards).toBe(before - offer.cost);
    expect(g.st().shopStates.get(g.st().currentNodeId).purchasedIds.has(offer.id)).toBe(true);
    expect(g.st().log.some((l) => l.message.includes('购买了'))).toBe(true);
  });

  it('恢复类商品立即生效且不超过上限', () => {
    g.shards(1000);

    expect(gotoShopSelling(g, 'shop.full.restore')).toBe(true);
    g.store.update((d) => {
      d.player.hp = 1;
    });
    expect(g.flow.purchase('shop.full.restore')).toEqual({ ok: true });
    expect(g.st().player.hp).toBe(g.st().player.maxHp);

    expect(gotoShopSelling(g, 'shop.heal.small')).toBe(true);
    const maxHp = g.st().player.maxHp;
    g.store.update((d) => {
      d.player.hp = 1;
    });
    expect(g.flow.purchase('shop.heal.small')).toEqual({ ok: true });
    const healed = g.st().player.hp;
    expect(healed).toBeGreaterThan(1);
    expect(healed).toBeLessThanOrEqual(maxHp);

    expect(gotoShopSelling(g, 'shop.heal.large')).toBe(true);
    expect(g.flow.purchase('shop.heal.large').ok).toBe(true);
    expect(g.st().player.hp).toBeLessThanOrEqual(g.st().player.maxHp);
  });

  it('只卖货架上的商品：买未上架的直接被拒且不扣碎片', () => {
    const shop = g.first(NODE_TYPE.SHOP);
    g.goto(shop);
    const offers = g.flow.getShopOffers().offers;
    const onShelf = new Set(offers.map((o) => o.id));
    const offShelf = [...g.pool.shopItems.keys()].find((id) => !onShelf.has(id));
    expect(offShelf).toBeDefined();
    g.shards(1000);
    const before = g.st().fateShards;

    expect(g.flow.purchase(offShelf)).toEqual({ ok: false, reason: 'notOnShelf' });
    expect(g.st().fateShards).toBe(before);
    expect(g.st().player.maxHp).toBe(g.st().player.maxHp);
  });

  it('拒绝：重复购买 / 碎片不足 / 未知商品 / 非商店节点 / 未读货架', () => {
    const shop = g.first(NODE_TYPE.SHOP);
    g.goto(shop);
    const offers = g.flow.getShopOffers().offers;
    const offer = offers[0];
    g.shards(offer.cost);

    expect(g.flow.purchase(offer.id)).toEqual({ ok: true });
    expect(g.flow.purchase(offer.id)).toEqual({ ok: false, reason: 'alreadyPurchased' });

    const expensive = offers.slice(1).find((o) => o.cost > g.st().fateShards);
    if (expensive !== undefined) {
      const shards = g.st().fateShards;
      expect(g.flow.purchase(expensive.id)).toEqual({ ok: false, reason: 'insufficientShards' });
      expect(g.st().fateShards).toBe(shards);
    }
    expect(g.flow.purchase('shop.nope')).toEqual({ ok: false, reason: 'noSuchItem' });

    g.goto(g.first(NODE_TYPE.COMBAT));
    expect(g.flow.purchase(offer.id)).toEqual({ ok: false, reason: 'notShopNode' });
  });

  it('未读过的商店节点拒绝购买（shopNotOpened）', () => {
    const other = g.of(NODE_TYPE.SHOP)[1] ?? g.first(NODE_TYPE.SHOP);
    g.goto(other);
    g.st().shopStates.delete(other.id);
    g.shards(1000);
    expect(g.flow.purchase('shop.heal.small')).toEqual({ ok: false, reason: 'shopNotOpened' });
  });

  it('已购记录在货架重建后仍生效（读档只存 purchasedIds）', () => {
    const shop = g.first(NODE_TYPE.SHOP);
    g.goto(shop);
    const offer = g.flow.getShopOffers().offers[0];
    g.shards(1000);
    g.flow.purchase(offer.id);

    // 模拟读档：offers 清空，只留已购记录
    g.store.update((d) => {
      d.shopStates.set(shop.id, { offers: [], purchasedIds: new Set([offer.id]) });
    });
    const rebuilt = g.flow.getShopOffers();
    expect(rebuilt.offers.map((o) => o.id)).toContain(offer.id);
    expect(rebuilt.purchasedIds.has(offer.id)).toBe(true);
    expect(g.flow.purchase(offer.id)).toEqual({ ok: false, reason: 'alreadyPurchased' });
  });

  it('不同商店节点按 nodeId 独立派生货架', () => {
    const shops = g.of(NODE_TYPE.SHOP);
    expect(shops.length).toBeGreaterThan(1);
    const signatures = new Set();
    for (const shop of shops) {
      g.goto(shop);
      signatures.add(g.flow.getShopOffers().offers.map((o) => o.id).join(','));
    }
    expect(signatures.size).toBeGreaterThan(1);
  });

  describe('装备货架', () => {
    it('上架件数固定、id 唯一、重复读取恒定、品质有下限', () => {
      g.goto(g.first(NODE_TYPE.SHOP));
      const shelf = g.flow.getShopGear();
      expect(shelf.length).toBe(SHOP_GEAR_COUNT);
      expect(new Set(shelf.map((s) => s.gear.id)).size).toBe(shelf.length);
      expect(g.flow.getShopGear()).toEqual(shelf);
      expect(shelf.every((s) => s.gear.rarityIndex >= LOOT_MIN_RARITY.shop)).toBe(true);
      expect(shelf.every((s) => s.price > 0)).toBe(true);
    });

    it('非商店节点货架为空', () => {
      g.goto(g.first(NODE_TYPE.COMBAT));
      expect(g.flow.getShopGear()).toEqual([]);
    });

    it('purchaseGear：扣碎片入包；碎片不足与背包满时拒绝', () => {
      g.goto(g.first(NODE_TYPE.SHOP));
      const [item] = g.flow.getShopGear();
      g.shards(item.price);

      const before = g.st().player.inventory.length;
      expect(g.flow.purchaseGear(item.gear)).toEqual({ ok: true, price: item.price });
      expect(g.st().fateShards).toBe(0);
      expect(g.st().player.inventory.length).toBe(before + 1);
      expect(g.st().metadata.gearFound).toBe(1);

      g.shards(0);
      expect(g.flow.purchaseGear(item.gear)).toEqual({ ok: false, reason: 'insufficientShards' });

      g.shards(item.price);
      g.store.update((d) => {
        d.player.inventory.length = INVENTORY_CAPACITY;
      });
      expect(g.flow.purchaseGear(item.gear)).toEqual({ ok: false, reason: 'inventoryFull' });
      expect(g.st().fateShards).toBe(item.price);
    });
  });
});

// ============================================================
// 永久属性（P0-3 回归）
//
// maxHp / attack / defense 是派生值，任何一次 recalcPlayer 都会覆盖手写值。
// 「永久提升」必须先落到 permanentBonus，再参与派生，否则就是一次性幻觉。
// ============================================================

const STAT_FIELDS = ['maxHp', 'attack', 'defense', 'hp'];

const pickStats = (player) => Object.fromEntries(STAT_FIELDS.map((k) => [k, player[k]]));

describe('永久属性提升要能穿过 recalcPlayer', () => {
  /** 购买一件永久属性商品，随后强制触发一次重算。 */
  function buyThenRecalc(itemId, { hp } = {}) {
    expect(gotoShopSelling(g, itemId)).toBe(true);
    g.shards(1000);
    if (hp !== undefined) {
      g.store.update((d) => {
        d.player.hp = hp;
      });
    }
    const before = pickStats(g.st().player);
    const result = g.flow.purchase(itemId);
    const bought = pickStats(g.st().player);
    g.store.update((d) => {
      recalcPlayer(d.player);
    });
    return { result, before, bought, after: pickStats(g.st().player) };
  }

  const CASES = [
    { id: 'shop.stat.maxHp', delta: { maxHp: 60, attack: 0, defense: 0 } },
    { id: 'shop.stat.attack', delta: { maxHp: 0, attack: 8, defense: 0 } },
    { id: 'shop.stat.defense', delta: { maxHp: 0, attack: 0, defense: 4 } },
    { id: 'shop.stat.balanced', delta: { maxHp: 30, attack: 4, defense: 2 } },
    { id: 'shop.stat.glass', delta: { maxHp: -40, attack: 16, defense: 0 } },
    { id: 'shop.stat.bulwark', delta: { maxHp: 100, attack: -4, defense: 6 } },
  ];

  it.each(CASES)('$id 的提升在重算后保持不变', ({ id, delta }) => {
    const { result, before, bought, after } = buyThenRecalc(id);
    expect(result.ok).toBe(true);

    for (const key of ['maxHp', 'attack', 'defense']) {
      expect(bought[key] - before[key], `${key} 购买即时`).toBe(delta[key]);
      expect(after[key] - before[key], `${key} 重算后`).toBe(delta[key]);
    }
    // 派生值恒等：hp 不得超过上限，也不得被抹成 0
    expect(after.hp).toBeGreaterThan(0);
    expect(after.hp).toBeLessThanOrEqual(after.maxHp);
  });

  it('受伤时买加上限商品只补上限，不白送回血（保持缺失量）', () => {
    expect(gotoShopSelling(g, 'shop.stat.maxHp')).toBe(true);
    g.shards(1000);
    const maxBefore = g.st().player.maxHp;
    g.store.update((d) => {
      d.player.hp = maxBefore - 100;
    });

    g.flow.purchase('shop.stat.maxHp');
    const s = g.st();
    expect(s.player.maxHp).toBe(maxBefore + 60);
    expect(s.player.maxHp - s.player.hp).toBe(100);
  });

  it('买减上限商品时 hp 被夹到新上限且至少为 1', () => {
    expect(gotoShopSelling(g, 'shop.stat.glass')).toBe(true);
    g.shards(1000);
    const maxBefore = g.st().player.maxHp;
    g.store.update((d) => {
      d.player.hp = 5;
    });

    g.flow.purchase('shop.stat.glass');
    const s = g.st();
    expect(s.player.maxHp).toBe(maxBefore - 40);
    expect(s.player.hp).toBeGreaterThanOrEqual(1);
    expect(s.player.hp).toBeLessThanOrEqual(s.player.maxHp);
  });

  it('通过真实流程验证：购买 → 打赢一场 → 加成仍在', async () => {
    expect(gotoShopSelling(g, 'shop.stat.maxHp')).toBe(true);
    g.shards(1000);
    const maxBefore = g.st().player.maxHp;
    const atkBefore = g.st().player.attack;
    g.flow.purchase('shop.stat.maxHp');
    g.flow.purchase('shop.stat.attack');

    g.goto(g.first(NODE_TYPE.COMBAT));
    g.flow.startBattle();
    settle(g);
    const result = g.flow.finishBattle();
    expect(result.won).toBe(true);
    // 第 1 层普通战经验不足以升级，因此 maxHp 差值只应来自那次购买
    expect(g.st().player.level).toBe(1);
    expect(g.st().player.maxHp).toBe(maxBefore + 60);
    expect(g.st().player.attack).toBe(atkBefore + 8);
    expect(g.st().player.permanentBonus).toMatchObject({ maxHp: 60, attack: 8 });
  });

  it('永久属性写入存档并能读档还原', () => {
    expect(gotoShopSelling(g, 'shop.stat.bulwark')).toBe(true);
    g.shards(1000);
    g.flow.purchase('shop.stat.bulwark');

    const save = serializeRun(g.st());
    expect(save.permanentBonus).toMatchObject({ maxHp: 100, attack: -4, defense: 6 });
  });
});

// ============================================================
// 事件
// ============================================================

describe('事件', () => {
  it('同一节点的选项恒定（遭遇流派生）', () => {
    const node = g.first(NODE_TYPE.EVENT);
    g.goto(node);
    const first = g.flow.getEvent();
    expect(first).not.toBeNull();
    expect(g.flow.getEvent().id).toBe(first.id);
    expect(first.choices.length).toBeGreaterThan(0);
    expect(first.choices.every((c) => typeof c.label === 'string')).toBe(true);
  });

  it('非事件节点与已处理节点返回 null', () => {
    g.goto(g.first(NODE_TYPE.COMBAT));
    expect(g.flow.getEvent()).toBeNull();

    const node = g.first(NODE_TYPE.EVENT);
    g.goto(node);
    const event = g.flow.getEvent();
    g.flow.resolveEvent(event.id, 0);
    expect(g.flow.getEvent()).toBeNull();
  });

  it('选择选项：施加效果并把节点标记为已处理', () => {
    const node = g.first(NODE_TYPE.EVENT);
    g.goto(node);
    const shardsBefore = g.st().fateShards;

    const result = g.flow.resolveEvent('event.stele', 0);
    expect(result).toEqual({ ok: true });
    const s = g.st();
    expect(s.fateShards).toBe(shardsBefore + 25);
    expect(s.metadata.shardsEarned).toBe(25);
    expect(g.byId(node.id).isCleared).toBe(true);
    expect(s.clearedNodeIds.has(node.id)).toBe(true);
    expect(s.log.some((l) => l.message.includes('歧路石碑'))).toBe(true);
  });

  it('拒绝：未知事件 / 未知选项', () => {
    expect(g.flow.resolveEvent('event.nope', 0)).toEqual({ ok: false, reason: 'noSuchEvent' });
    expect(g.flow.resolveEvent('event.stele', 99)).toEqual({ ok: false, reason: 'noSuchChoice' });
  });

  it('事件后 hp 被夹回上限内', () => {
    g.store.update((d) => {
      d.player.hp = 10;
    });
    g.flow.resolveEvent('event.satchel', 1);
    const s = g.st();
    expect(s.player.hp).toBeGreaterThan(10);
    expect(s.player.hp).toBeLessThanOrEqual(s.player.maxHp);
  });

  it('事件给的永久属性同样要穿过重算', async () => {
    const CASES = [
      { id: 'event.well', index: 0, delta: { maxHp: 40, attack: 0, defense: 0 } },
      { id: 'event.well', index: 1, delta: { maxHp: 0, attack: 6, defense: 0 }, shards: 20 },
      { id: 'event.mural', index: 0, delta: { maxHp: 0, attack: 5, defense: 3 } },
      { id: 'event.shrine', index: 1, delta: { maxHp: 0, attack: 0, defense: -5 } },
    ];
    for (const { id, index, delta, shards = 0 } of CASES) {
      const h = await boot();
      const before = pickStats(h.st().player);
      h.shards(shards);
      expect(h.flow.resolveEvent(id, index)).toEqual({ ok: true });
      h.store.update((d) => {
        recalcPlayer(d.player);
      });
      const after = pickStats(h.st().player);
      for (const key of ['maxHp', 'attack', 'defense']) {
        expect(after[key] - before[key], `${id}[${index}] ${key}`).toBe(delta[key]);
      }
    }
  });
});

// ============================================================
// 下层
// ============================================================

describe('descend', () => {
  it('不在出口时拒绝', () => {
    expect(g.flow.descend()).toEqual({ ok: false, reason: 'notAtExit' });
    expect(g.st().floorNumber).toBe(1);
  });

  it('在出口时下层：楼层 +1、生成新地图、保留资源', () => {
    g.goto(g.byId(g.st().exitNodeId));
    g.shards(123);
    const expBefore = g.st().player.exp;

    expect(g.flow.descend()).toEqual({ ok: true, floorNumber: 2 });

    const s = g.st();
    expect(s.floorNumber).toBe(2);
    expect(s.metadata.floorsCleared).toBe(1);
    expect(s.currentNodeId).toBe(s.startNodeId);
    expect(s.clearedNodeIds.size).toBe(0);
    expect(s.visitedNodeIds.size).toBe(1);
    expect(s.shopStates.size).toBe(0);
    expect(s.status).toBe(GAME_STATUS.EXPLORING);
    expect(s.fateShards).toBe(123);
    expect(s.player.exp).toBe(expBefore);
  });

  it('不能回头：新层的起点不是出口，因此再次 descend 被拒', () => {
    g.goto(g.byId(g.st().exitNodeId));
    g.flow.descend();
    const s = g.st();
    expect(s.currentNodeId).not.toBe(s.exitNodeId);
    expect(g.flow.descend()).toEqual({ ok: false, reason: 'notAtExit' });
  });

  it('同一 seed 的同一层地图可复现（地图不入存档的依据）', async () => {
    const signature = (state) => state.mapNodes.map((n) => `${n.id}:${n.type}`).join('|');
    const a = await boot();
    const b = await boot();
    a.flow.enterFloor(7);
    b.flow.enterFloor(7);

    expect(signature(a.st())).toBe(signature(b.st()));
    // 层数参与派生，因此不同层不得得到相同地图
    expect(signature(a.st())).not.toBe(signature(g.st()));
  });
});

// ============================================================
// 装备管理
// ============================================================

describe('装备管理', () => {
  it('equip：从背包装入对应槽位并提升派生属性', () => {
    const gear = g.addGear('t.weapon', { slot: 'weapon', rarity: 4 });
    const before = pickStats(g.st().player);

    expect(g.flow.equip(gear.id)).toEqual({ ok: true, slot: 'weapon' });

    const s = g.st();
    expect(s.player.equipment.weapon.id).toBe(gear.id);
    expect(s.player.inventory.some((x) => x.id === gear.id)).toBe(false);
    expect(s.player.attack).toBe(before.attack + gear.stats.attack);
  });

  it('equip：替换时旧件退回背包（不丢装备）', () => {
    const first = g.addGear('t.weapon1', { slot: 'weapon', rarity: 2 });
    const second = g.addGear('t.weapon2', { slot: 'weapon', rarity: 4 });
    g.flow.equip(first.id);
    const sizeBefore = g.st().player.inventory.length;

    g.flow.equip(second.id);
    const s = g.st();
    expect(s.player.equipment.weapon.id).toBe(second.id);
    expect(s.player.inventory.map((x) => x.id)).toContain(first.id);
    expect(s.player.inventory.length).toBe(sizeBefore);
  });

  it('equip：背包里没有的 id 被拒绝', () => {
    expect(g.flow.equip('eq.missing')).toEqual({ ok: false, reason: 'notInInventory' });
    expect(g.st().player.equipment.weapon).toBeNull();
  });

  it('unequip：退回背包并重算属性；空槽拒绝', () => {
    const gear = g.addGear('t.chest', { slot: 'chest', rarity: 3 });
    g.flow.equip(gear.id);
    const equipped = pickStats(g.st().player);

    expect(g.flow.unequip('chest')).toEqual({ ok: true });
    const s = g.st();
    expect(s.player.equipment.chest).toBeNull();
    expect(s.player.inventory.map((x) => x.id)).toContain(gear.id);
    expect(s.player.maxHp).toBeLessThan(equipped.maxHp);

    expect(g.flow.unequip('chest')).toEqual({ ok: false, reason: 'emptySlot' });
  });

  it('unequip：背包满时拒绝，避免默默弄丢装备', () => {
    const gear = g.addGear('t.ring', { slot: 'ring' });
    g.flow.equip(gear.id);
    g.store.update((d) => {
      d.player.inventory.length = INVENTORY_CAPACITY;
    });
    expect(g.flow.unequip('ring')).toEqual({ ok: false, reason: 'inventoryFull' });
    expect(g.st().player.equipment.ring.id).toBe(gear.id);
  });

  it('salvage：移除装备并回收碎片', () => {
    const gear = g.addGear('t.feet', { slot: 'feet', rarity: 2 });
    const before = g.st().fateShards;

    expect(g.flow.salvage(gear.id)).toEqual({ ok: true, gained: salvageValue(gear) });
    const s = g.st();
    expect(s.fateShards).toBe(before + salvageValue(gear));
    expect(s.player.inventory.some((x) => x.id === gear.id)).toBe(false);

    expect(g.flow.salvage(gear.id)).toEqual({ ok: false, reason: 'notInInventory' });
  });

  it('enhance：扣碎片、等级 +1、属性上升（背包件）', () => {
    const gear = g.addGear('t.enh', { slot: 'weapon', rarity: 3 });
    const cost = enhanceCost(gear);
    g.shards(cost + 5);
    const attackBefore = gear.stats.attack;
    const playerAttackBefore = g.st().player.attack;

    const result = g.flow.enhance(gear.id);
    expect(result.ok).toBe(true);
    expect(result.level).toBe(1);
    expect(result.cost).toBe(cost);

    const s = g.st();
    expect(s.fateShards).toBe(5);
    const enhanced = s.player.inventory.find((x) => x.id === gear.id);
    expect(enhanced.enhanceLevel).toBe(1);
    expect(enhanced.stats.attack).toBeGreaterThan(attackBefore);
    // 未穿戴的装备不得影响派生属性
    expect(s.player.attack).toBe(playerAttackBefore);
  });

  it('enhance：已穿戴装备强化后立即反映到面板', () => {
    const gear = g.addGear('t.enh2', { slot: 'weapon', rarity: 3 });
    g.flow.equip(gear.id);
    g.shards(10_000);
    const before = g.st().player.attack;

    g.flow.enhance(gear.id);
    expect(g.st().player.attack).toBeGreaterThan(before);
    expect(g.st().player.equipment.weapon.enhanceLevel).toBe(1);
  });

  it('enhance：碎片不足时既不扣碎片也不改装备', () => {
    const gear = g.addGear('t.enh3', { slot: 'weapon', rarity: 5 });
    g.shards(0);
    const cost = enhanceCost(gear);

    expect(g.flow.enhance(gear.id)).toEqual({ ok: false, reason: 'insufficientShards' });
    expect(g.st().fateShards).toBe(0);
    expect(g.st().player.inventory.find((x) => x.id === gear.id).enhanceLevel).toBe(0);
    expect(cost).toBeGreaterThan(0);
  });

  it('enhance：到达上限后拒绝继续，未知 id 拒绝', () => {
    const gear = g.addGear('t.enh4', { slot: 'weapon' });
    g.shards(1_000_000);
    for (let i = 0; i < 10; i += 1) expect(g.flow.enhance(gear.id).ok).toBe(true);
    expect(g.flow.enhance(gear.id)).toEqual({ ok: false, reason: 'maxEnhance' });
    expect(g.flow.enhance('eq.nope')).toEqual({ ok: false, reason: 'noSuchGear' });
  });
});

// ============================================================
// 读档恢复
// ============================================================

describe('restoreRun', () => {
  /** 造一局有进度的存档：打过仗、买过东西、下过一层。 */
  async function makeSave() {
    const h = await boot();
    h.goto(h.first(NODE_TYPE.COMBAT));
    h.flow.startBattle();
    settle(h);
    h.flow.finishBattle();

    const shop = h.first(NODE_TYPE.SHOP);
    h.goto(shop);
    h.shards(1000);
    h.flow.getShopOffers();
    h.flow.purchase('shop.stat.maxHp');

    const gear = h.addGear('t.save', { slot: 'chest', rarity: 3 });
    h.flow.equip(gear.id);
    h.goto(h.byId(h.st().exitNodeId));
    h.flow.descend();

    return serializeRun(h.st());
  }

  it('还原楼层、位置、资源、成长与进展', async () => {
    const save = await makeSave();
    const t = await boot({ seed: 987654321 });
    expect(t.flow.restoreRun(save)).toEqual({ ok: true, floorNumber: 2 });

    const s = t.st();
    expect(s.seed).toBe(save.seed);
    expect(s.floorNumber).toBe(2);
    expect(s.currentNodeId).toBe(save.currentNodeId);
    expect(s.status).toBe(GAME_STATUS.EXPLORING);
    expect(s.fateShards).toBe(save.fateShards);
    expect(s.player.exp).toBe(save.exp);
    expect(s.player.seedBonus).toEqual(save.seedBonus);
    expect(s.player.permanentBonus).toMatchObject(save.permanentBonus);
    expect(s.player.maxHp).toBeGreaterThan(0);
    expect(s.player.inventory.map((x) => x.id)).toEqual(save.inventory.map((x) => x.id));
    expect(Object.values(s.player.equipment).filter(Boolean).map((x) => x.id)).toEqual([
      save.equipment.chest.id,
    ]);
    expect(s.clearedNodeIds).toEqual(new Set(save.clearedNodeIds));
    expect(s.visitedNodeIds).toEqual(new Set(save.visitedNodeIds));
    expect(s.gcdSequence ?? s.player.gcdSequence).toEqual(save.gcdSequence);
    expect(s.log.some((l) => l.message.includes('读取存档'))).toBe(true);
  });

  it('地图由种子重建，揭示与清理状态按存档重放', async () => {
    const save = await makeSave();
    const t = await boot({ seed: 987654321 });
    t.flow.restoreRun(save);

    // 不存地图，只存种子+层数：重建结果必须与源局逐项一致
    const ref = await boot({ seed: save.seed });
    ref.flow.enterFloor(save.floorNumber);
    const signature = (state) => state.mapNodes.map((n) => `${n.id}:${n.type}:${n.gridX},${n.gridY}`);
    expect(signature(t.st())).toEqual(signature(ref.st()));

    for (const id of save.visitedNodeIds) {
      expect(t.byId(id).isRevealed).toBe(true);
    }
    for (const id of save.clearedNodeIds) {
      expect(t.byId(id).isCleared).toBe(true);
    }
  });

  it('已购记录随存档还原，不能二次购买', async () => {
    // 商店进度是「每层重置」的（enterFloor 清空 shopStates），
    // 因此这里在不下层的前提下存读档。
    const h = await boot();
    expect(gotoShopSelling(h, 'shop.heal.small')).toBe(true);
    const shop = h.st().currentNodeId; // 辅助函数停在卖这件商品的那个商店上
    h.shards(1000);
    expect(h.flow.purchase('shop.heal.small')).toEqual({ ok: true });
    const save = serializeRun(h.st());
    const purchased = (save.shopPurchases.find(([, ids]) => ids.includes('shop.heal.small')) ?? [
      null,
    ])[0];
    expect(purchased).toBe(shop);

    const t = await boot({ seed: 5 });
    t.flow.restoreRun(save);
    t.goto(t.byId(purchased));
    t.shards(10_000);
    expect(t.flow.getShopOffers().purchasedIds.has('shop.heal.small')).toBe(true);
    expect(t.flow.purchase('shop.heal.small')).toEqual({ ok: false, reason: 'alreadyPurchased' });
  });

  it('存档里越界的 hp 被夹到 [1, maxHp]', async () => {
    const save = await makeSave();
    const t = await boot({ seed: 5 });
    t.flow.restoreRun({ ...save, playerHp: 9_999_999 });
    expect(t.st().player.hp).toBe(t.st().player.maxHp);

    const t2 = await boot({ seed: 5 });
    t2.flow.restoreRun({ ...save, playerHp: -50 });
    expect(t2.st().player.hp).toBe(1);
  });

  it('读档后可以继续正常游玩', async () => {
    const save = await makeSave();
    const t = await boot({ seed: 5 });
    t.flow.restoreRun(save);

    const s = t.st();
    const neighbor = neighborOf(s, s.currentNodeId);
    expect(neighbor).not.toBeNull();
    expect(t.flow.moveTo(neighbor.id).ok).toBe(true);

    // 出口相邻时下层，否则走到出口再下层
    const exit = t.byId(t.st().exitNodeId);
    t.goto(exit);
    expect(t.flow.descend()).toEqual({ ok: true, floorNumber: 3 });
  });

  it('读档后清过的战斗节点不再触发战斗', async () => {
    const save = await makeSave();
    const t = await boot({ seed: 5 });
    t.flow.restoreRun(save);

    const clearedCombat = [...t.st().clearedNodeIds]
      .map((id) => t.byId(id))
      .find((n) => n !== undefined && n.type === NODE_TYPE.COMBAT);
    if (clearedCombat === undefined) return;

    const from = neighborOf(t.st(), clearedCombat.id);
    t.goto(from);
    expect(t.flow.moveTo(clearedCombat.id)).toEqual({ ok: true, triggeredBattle: false });
  });
});

// ============================================================
// 解锁校验（P1-2 的运行时那道防御）
// ============================================================

describe('序列合法性校验（未解锁技能进不了战斗）', () => {
  /** 找一个 1 级用不了、高等级才解锁的技能。 */
  function lockedSkill(h) {
    const table = h.flow.unlockTable;
    return [...h.pool.skills.values()].find((s) => (table.get(s.id) ?? 1) > 1);
  }

  it('GameFlow 自带解锁表，覆盖全部技能', async () => {
    const h = await boot();
    expect(h.flow.unlockTable).toBeInstanceOf(Map);
    expect(h.flow.unlockTable.size).toBe(h.pool.skills.size);
  });

  it('startBattle 前会把未解锁技能踢出序列并记进日志', async () => {
    const h = await boot();
    const locked = lockedSkill(h);
    const lockedIsOgcd = locked.type === 'oGCD';
    h.store.update((d) => {
      if (lockedIsOgcd) {
        d.player.ogcdSlots.push({ skillId: locked.id, priority: 50, slotIndex: 9 });
      } else {
        d.player.gcdSequence.push(locked.id);
      }
    });

    h.goto(h.first(NODE_TYPE.COMBAT));
    h.flow.startBattle();

    const player = h.st().player;
    expect(player.gcdSequence).not.toContain(locked.id);
    expect(player.ogcdSlots.map((s) => s.skillId)).not.toContain(locked.id);
    // 注意：engine.begin 会把日志重置成战斗日志，所以这里不断言通知文本；
    // 通知走 UI 的 toast（main.js 在 startBattle 前先自己洗一次拿 removed）
  });

  it('sanitizeSequence 返回被剔除项，且槽位下标重排连续', async () => {
    const h = await boot();
    const locked = lockedSkill(h);
    h.store.update((d) => {
      d.player.ogcdSlots = [
        { skillId: 'ogcd.secondWind', priority: 95, slotIndex: 4 },
        { skillId: locked.id, priority: 50, slotIndex: 7 },
        { skillId: 'ogcd.suddenStrike', priority: 30, slotIndex: 12 },
      ];
    });

    const { removed, level } = h.flow.sanitizeSequence();
    expect(removed).toEqual([locked.id]);
    expect(level).toBe(1);
    expect(h.st().player.ogcdSlots.map((s) => s.slotIndex)).toEqual([0, 1]);
    expect(h.st().player.ogcdSlots.map((s) => s.skillId)).toEqual([
      'ogcd.secondWind',
      'ogcd.suddenStrike',
    ]);
  });

  it('等级够高的角色用同一套序列不会被误删', async () => {
    const h = await boot();
    const locked = lockedSkill(h);
    h.store.update((d) => {
      d.player.exp = totalExpForLevel(120);
      d.player.gcdSequence = [locked.id];
      recalcPlayer(d.player);
    });

    expect(h.flow.sanitizeSequence().removed).toEqual([]);
    expect(h.st().player.gcdSequence).toEqual([locked.id]);
  });

  it('读档时同样清洗：伪造一份越级存档也带不进战斗', async () => {
    const source = await boot();
    const locked = lockedSkill(source);
    source.store.update((d) => {
      d.player.gcdSequence = ['blade.jab', locked.id];
    });
    const save = serializeRun(source.st());
    expect(save.gcdSequence).toContain(locked.id);

    const t = await boot({ seed: 5 });
    t.flow.restoreRun(save);
    expect(t.st().player.gcdSequence).toEqual(['blade.jab']);
    expect(t.st().log.some((l) => l.message.includes('未解锁'))).toBe(true);
  });
});

// ============================================================
// 通关与无尽（P1-6）
// ============================================================

describe('通关与无尽', () => {
  /** 直接落到终点层的出口（enterFloor 可指定层数，不必真的一层层爬）。 */
  async function atVictoryExit(floor = VICTORY_FLOOR) {
    const h = await boot();
    h.flow.enterFloor(floor);
    const exit = h.byId(h.st().exitNodeId);
    h.goto(exit);
    return h;
  }

  it('终点层的出口即通关：FINISHED + winner=PLAYER，且不会生成下一层', async () => {
    const h = await atVictoryExit();
    const floorBefore = h.st().floorNumber;

    const result = h.flow.descend();
    expect(result).toEqual({ ok: true, victory: true, floorNumber: floorBefore });

    const s = h.st();
    expect(s.status).toBe(GAME_STATUS.FINISHED);
    expect(s.winner).toBe(WINNER.PLAYER);
    expect(s.battleEndReason).toBe('victory');
    expect(s.floorNumber).toBe(floorBefore);
    expect(s.victoryAchieved).toBe(true);
    expect(s.metadata.floorsCleared).toBe(1);
    expect(s.log.some((l) => l.message.includes('轮回通关'))).toBe(true);
  });

  it('未到终点层时 descend 只是下层，绝不出现 victory', async () => {
    const h = await atVictoryExit(VICTORY_FLOOR - 1);
    expect(h.flow.descend()).toEqual({ ok: true, floorNumber: VICTORY_FLOOR });
    const s = h.st();
    expect(s.victoryAchieved).toBe(false);
    expect(s.status).toBe(GAME_STATUS.EXPLORING);
  });

  it('通关结算不是一场战斗：finishBattle 必须拒绝而不是踩空 activeBattle', async () => {
    const h = await atVictoryExit();
    h.flow.descend();
    expect(h.st().activeBattle).toBeNull();
    expect(h.flow.finishBattle()).toEqual({ settled: false });
  });

  it('继续挑战无尽：回到探索态，之后下层不再触发第二次结算', async () => {
    const h = await atVictoryExit();
    h.flow.descend();

    expect(h.flow.continueEndless()).toEqual({ ok: true, floorNumber: VICTORY_FLOOR });
    expect(h.st().status).toBe(GAME_STATUS.EXPLORING);
    expect(h.st().winner).toBeNull();

    // 仍在出口：再点就是真正下层
    const second = h.flow.descend();
    expect(second.victory).toBeUndefined();
    expect(h.st().floorNumber).toBe(VICTORY_FLOOR + 1);

    // 无尽段里没有第二次通关
    h.flow.enterFloor(VICTORY_FLOOR + 5);
    h.goto(h.byId(h.st().exitNodeId));
    expect(h.flow.descend()).toEqual({ ok: true, floorNumber: VICTORY_FLOOR + 6 });
    expect(h.st().victoryAchieved).toBe(true);
  });

  it('continueEndless 在没有通关可续时拒绝', async () => {
    const h = await boot();
    expect(h.flow.continueEndless()).toEqual({ ok: false, reason: 'nothingToContinue' });
  });

  it('通关标记随存档往返：从第 51 层读档再下层不会补一次通关', async () => {
    const h = await atVictoryExit();
    h.flow.descend();
    h.flow.continueEndless();
    h.flow.descend(); // → 51 层
    const save = serializeRun(h.st());
    expect(save.victoryAchieved).toBe(true);

    const t = await boot({ seed: 5 });
    t.flow.restoreRun(save);
    expect(t.st().victoryAchieved).toBe(true);
    expect(t.st().floorNumber).toBe(VICTORY_FLOOR + 1);

    t.goto(t.byId(t.st().exitNodeId));
    expect(t.flow.descend().victory).toBeUndefined();
    expect(t.st().floorNumber).toBe(VICTORY_FLOOR + 2);
  });

  it('缺 victoryAchieved 的旧存档按未通关处理', async () => {
    const h = await boot();
    const save = serializeRun(h.st());
    delete save.victoryAchieved;

    const t = await boot({ seed: 5 });
    t.flow.restoreRun(save);
    expect(t.st().victoryAchieved).toBe(false);
  });

  it('通关写历史并清自动槽；无尽段死亡另记一条带标记的记录', async () => {
    const { SaveService } = await import('../../src/persistence/saveService.js');
    const saves = new SaveService();
    const info = await saves.init();
    const h = await boot({ saveService: saves });
    h.flow.enterFloor(VICTORY_FLOOR);
    h.goto(h.byId(h.st().exitNodeId));
    h.flow.descend();
    await new Promise((resolve) => setTimeout(resolve, 0));

    let history = await saves.loadHistory();
    expect(history).toHaveLength(1);
    expect(history[0].outcome).toBe('victory');
    expect(history[0].floorReached).toBe(VICTORY_FLOOR);
    expect(history[0].victoryAchieved).toBe(true);
    expect(await saves.loadSlot(AUTO_SAVE_SLOT)).toBeNull();

    // 继续无尽后打不赢 → 另记一条 death，且带着"先通关过"的标记
    h.flow.continueEndless();
    h.store.update((d) => {
      d.player.gcdSequence = [];
      d.player.ogcdSlots = [];
    });
    h.goto(h.first(NODE_TYPE.COMBAT));
    h.flow.startBattle();
    settle(h);
    h.flow.finishBattle();
    await new Promise((resolve) => setTimeout(resolve, 0));

    history = await saves.loadHistory();
    expect(history[0].outcome).toBe('death');
    expect(history[0].victoryAchieved).toBe(true);
    expect(history).toHaveLength(2);
    void info;
  });

  it('无尽可以跑到内容池覆盖不到的深度（官方模板最深 999 层）', async () => {
    const h = await boot();
    h.flow.enterFloor(1200);
    h.goto(h.first(NODE_TYPE.COMBAT));
    expect(() => h.flow.startBattle()).not.toThrow();
    const monster = h.st().monsters[0];
    expect(monster.hp).toBeGreaterThan(0);
    // 深层缩放仍然生效
    expect(monster.hp).toBeGreaterThan(50);
  });
});

describe('读档不得毁掉自动存档', () => {
  /** 攒一点真实进度：打赢两场。 */
  async function runWithProgress(h) {
    h.flow.enterFloor(1);
    const nodes = h.st().mapNodes.filter((n) => n.type === NODE_TYPE.COMBAT).slice(0, 3);
    for (const node of nodes) {
      h.goto(node);
      h.flow.startBattle();
      settle(h);
      const result = h.flow.finishBattle();
      if (!result.won) break;
    }
    return h.st();
  }

  it('restoreRun 中途不写档，结束时写回的必须等于读出来的', async () => {
    const { SaveService } = await import('../../src/persistence/saveService.js');
    const saves = new SaveService();
    await saves.init();

    const source = await boot({ saveService: saves });
    await runWithProgress(source);
    await saves.flush();

    const before = await saves.loadSlot('auto');
    expect(before).not.toBeNull();
    expect(before.run.exp).toBeGreaterThan(0);
    expect(before.run.clearedNodeIds.length).toBeGreaterThan(0);

    // 新会话读这份档，然后**什么都不做**（旧实现里这一步会把自动档覆盖成空局）
    const reader = await boot({ seed: 4242, saveService: saves });
    reader.flow.restoreRun(before.run);
    await saves.flush();

    const after = await saves.loadSlot('auto');
    expect(after.run.exp).toBe(before.run.exp);
    expect(after.run.fateShards).toBe(before.run.fateShards);
    expect(after.run.clearedNodeIds).toEqual(before.run.clearedNodeIds);
    expect(after.run.currentNodeId).toBe(before.run.currentNodeId);
    expect(after.run.equipment).toEqual(before.run.equipment);
  });

  it('enterFloor 默认仍写自动档（下层照常存档）', async () => {
    const { SaveService } = await import('../../src/persistence/saveService.js');
    const saves = new SaveService();
    await saves.init();
    const h = await boot({ saveService: saves });
    // 必须先攒**真实进度**：门控就是"没进度不写"，用空局测这条会测到个空档。
    // （以前这里没攒进度，断言读到的是**上一条测试留下的档** —— 巧合而绿。）
    await runWithProgress(h);
    await saves.flush();
    const first = await saves.loadSlot('auto');
    expect(first, '有进度的局应当写自动档').not.toBeNull();
    const floorBefore = first.run.floorNumber;

    h.flow.enterFloor(floorBefore + 1);
    await saves.flush();
    expect((await saves.loadSlot('auto')).run.floorNumber).toBe(floorBefore + 1);

    h.flow.enterFloor(floorBefore + 2, { save: false });
    await saves.flush();
    expect((await saves.loadSlot('auto')).run.floorNumber).toBe(floorBefore + 1); // 显式不写就不写
  });

  it('空局（没打过仗没拿过东西）不写自动档 —— 门控存在的唯一理由', async () => {
    const { SaveService } = await import('../../src/persistence/saveService.js');
    const { resetAdapterCache, pickAdapter } = await import('../../src/persistence/storageAdapter.js');
    resetAdapterCache();
    const { adapter } = await pickAdapter({ modded: false });
    await adapter.clear();
    const saves = new SaveService();
    await saves.init();
    const h = await boot({ saveService: saves });
    await saves.flush();
    expect(await saves.loadSlot('auto')).toBeNull();
    // 走到第 2 层也不算（旧逻辑的 floorNumber>1 就是在这里毁档的）
    h.flow.enterFloor(2);
    await saves.flush();
    expect(await saves.loadSlot('auto')).toBeNull();
  });
});

describe('没有进度的新局不得覆盖自动存档', () => {
  async function savesWithSavedRun() {
    const { SaveService } = await import('../../src/persistence/saveService.js');
    const saves = new SaveService();
    await saves.init();
    // 先造一局有进度的档
    const h = await boot({ saveService: saves });
    h.flow.enterFloor(1);
    for (const node of h.st().mapNodes.filter((n) => n.type === NODE_TYPE.COMBAT).slice(0, 2)) {
      h.goto(node);
      h.flow.startBattle();
      settle(h);
      if (!h.flow.finishBattle().won) break;
    }
    await saves.flush();
    return { saves, h };
  }

  it('开新局（一步没走）不覆盖自动档', async () => {
    const { saves } = await savesWithSavedRun();
    const before = await saves.loadSlot('auto');
    expect(before.run.exp).toBeGreaterThan(0);

    const fresh = await boot({ seed: 99, saveService: saves });
    fresh.flow.enterFloor(1); // startNewRun 走的就是这一步
    await saves.flush();

    const after = await saves.loadSlot('auto');
    expect(after.run.exp).toBe(before.run.exp);
    expect(after.run.clearedNodeIds).toEqual(before.run.clearedNodeIds);
  });

  it('新局一旦打出进度就正常覆盖（自动档不能永远停在旧局）', async () => {
    const { saves } = await savesWithSavedRun();
    const fresh = await boot({ seed: 99, saveService: saves });
    fresh.flow.enterFloor(1);
    await saves.flush();
    expect((await saves.loadSlot('auto')).run.floorNumber).toBe(1);

    // 下层 = 明确进度 ⇒ 这次该覆盖
    fresh.goto(fresh.byId(fresh.st().exitNodeId));
    fresh.flow.descend();
    await saves.flush();
    expect((await saves.loadSlot('auto')).run.floorNumber).toBe(2);
  });

  it('读档后的自动档写入不受门控影响（读进来的档本身就有进度）', async () => {
    const { saves } = await savesWithSavedRun();
    const before = await saves.loadSlot('auto');
    const reader = await boot({ seed: 7, saveService: saves });
    reader.flow.restoreRun(before.run);
    await saves.flush();
    const after = await saves.loadSlot('auto');
    expect(after.run.exp).toBe(before.run.exp);
    expect(after.run.floorNumber).toBe(before.run.floorNumber);
  });
});
