/**
 * 探索流程编排（规格 6.3、6.4、7.4，决定 A）。
 *
 * 职责：把地图生成、移动、节点效果、战斗触发、层推进串起来。
 * 它是 UI 与引擎之间唯一的协调层 —— UI 只调这里的方法，不直接碰 Store。
 */

import {
  GAME_STATUS,
  INVENTORY_CAPACITY,
  NODE_TYPE,
  REST_HEAL_RATIO,
  SHARD_REWARD_COMBAT,
  SHARD_REWARD_ELITE_MULTIPLIER,
  SHOP_GEAR_COUNT,
  SHOP_OFFER_COUNT,
  VICTORY_FLOOR,
  WINNER,
} from './constants.js';
import { areAdjacent } from './map/adjacency.js';
import { revealAround, revealInitial } from './map/reveal.js';
import { encounterStream } from './prng.js';
import { battleExpReward, buildUnlockTable, isSkillUnlocked, levelFromTotalExp } from './progression.js';
import { addPermanentBonus, recalcPlayer, permanentBonusOf } from './derived.js';
import { deposit as atmDeposit, normalizeAtm, withdraw as atmWithdraw } from './atm.js';
import { hasMeaningfulProgress } from './runProgress.js';
import { createEmptyEquipment, enhanceGear, salvageValue } from './equipment.js';
import { gearPrice, rollBattleLoot, rollShopGear } from './loot.js';
import {
  dryRunFilter,
  filterFromPreset,
  filterSummary,
  gearVerdict,
  normalizeLootFilter,
} from './lootFilter.js';
import { pushLog } from '../contracts/defaults/log.js';
import { FateError } from '../utils/invariant.js';

export class GameFlow {
  #store;
  #engine;
  #pool;
  #saveService;
  #audio;
  #unlockTable;
  /** 跨局 ATM（没注入时 = 这台机器不存在，商店里也不得显示它的面板） */
  #atm;

  constructor({ store, engine, pool, saveService = null, audio = null, atm = null }) {
    this.#store = store;
    this.#engine = engine;
    this.#pool = pool;
    this.#saveService = saveService;
    this.#audio = audio;
    this.#atm = atm;
    /** 解锁表随内容池构建一次：序列屏、图鉴屏、战斗前的合法性清洗共用同一张表。
     *  把模组注册的流派一起传进去，否则新流派的技能会掉进 untagged 被排到最后。 */
    this.#unlockTable = buildUnlockTable(pool.skills, {
      families: [...pool.families.keys()],
    });
  }

  /** 技能解锁表（skillId → 解锁等级）。只读，UI 拿它渲染锁定态。 */
  get unlockTable() {
    return this.#unlockTable;
  }

  /** ATM 是否可用（没注入 = 不可用，商店得把那块面板整块藏掉）。 */
  get hasAtm() {
    return this.#atm !== null && this.#atm !== undefined;
  }

  /** 当前跨局账（内存快照，同步读）。 */
  atmAccount() {
    return this.#atm ? normalizeAtm(this.#atm.state) : normalizeAtm(null);
  }

  /**
   * 存碎片进 ATM（局内 → 跳局）。
   *
   * 与商店购买同一条约束：先验钱包再扣，扣钱与记账一起完成 ——
   * 半成的交易比不成交还糟（钱扣了没入账，或入账了钱还在）。
   * 落盘是异步的且**失败要响**（AtmService 会把错误交给装配层），不能 `catch {}`。
   */
  depositToAtm(rawAmount) {
    if (!this.hasAtm) return { ok: false, reason: 'noAtm' };
    const wallet = this.#store.unsafeGetState().fateShards;
    const result = atmDeposit(this.#atm.state, { amount: rawAmount, shards: wallet });
    if (!result.ok) return result;

    this.#store.update((draft) => {
      draft.fateShards -= result.spent;
      pushLog(draft, `存入 ATM ${result.spent} 枚碎片（余额 ${result.atm.balance}，历史累计 ${result.atm.total}）`);
    });
    void this.#atm.save(result.atm);
    this.#autoSave();
    this.#audio?.play('ui.purchase', {});
    return { ok: true, spent: result.spent, atm: result.atm };
  }

  /** 从 ATM 取回本局（1:1 无损；历史累计不动 —— 那就是“无损”的定义）。 */
  withdrawFromAtm(rawAmount) {
    if (!this.hasAtm) return { ok: false, reason: 'noAtm' };
    const result = atmWithdraw(this.#atm.state, { amount: rawAmount });
    if (!result.ok) return result;

    this.#store.update((draft) => {
      draft.fateShards += result.gained;
      pushLog(draft, `从 ATM 取出 ${result.gained} 枚碎片（余额 ${result.atm.balance}）`);
    });
    void this.#atm.save(result.atm);
    this.#autoSave();
    this.#audio?.play('ui.confirm', {});
    return { ok: true, gained: result.gained, atm: result.atm };
  }

  /**
   * 这一局是否已经产生"值得存"的进度。
   *
   * 为什么要有这个门：主菜单误点一次「新的轮回」就会把自动槽覆盖成空局，
   * 而自动槽正是「继续游戏」唯一的入口。用状态本身推导（而不是一个布尔标记），
   * 是因为标记会和 store.replace / restoreRun 的时序脱节，推导不会。
   *
   * 判定本身抽到 core/runProgress.js —— 因为 SaveService 备份旧档时要用
   * **同一个**标准。两边不一致过一次，代价是玩家丢档。
   */
  #hasProgress(state) {
    return hasMeaningfulProgress(state);
  }

  /** 写自动槽；没有值得存的进度时什么都不做（见 #hasProgress）。 */
  #autoSave() {
    if (this.#saveService === null) return;
    if (!this.#hasProgress(this.#store.unsafeGetState())) return;
    this.#saveService.saveRun(this.#store.unsafeGetState());
  }

  /**
   * 剔除序列里的未解锁技能。P1-2 的运行时那道防御。
   *
   * 为什么要：序列屏已经会拦，但存档可能来自旧版本、可能被手改、也可能
   * 来自一个技能数量不同的模组组合 —— 那时“把 94 级技能塞给 1 级角色”会真的生效。
   * 两个调用点：读档后、开战前。剔除而不是报错，是因为报错会让玩家卡在打不了仗。
   *
   * @returns {{removed:string[], level:number}} 被剔除的 skillId 与当时等级
   */
  sanitizeSequence() {
    const removed = [];
    let level = 1;
    this.#store.update((draft) => {
      level = this.#sanitizeDraft(draft, removed);
    });
    return { removed, level };
  }

  /**
   * 在给定 draft 上洗序列（供 update 内部直接调用，避开 Store 禁止嵌套 update 的限制）。
   * 等级取 `levelFromTotalExp(exp)`而不读 `player.level`：读档时 level 字段还是旧值，
   * 要等 recalcPlayer 才更新，而清洗得在那之前跑。
   */
  #sanitizeDraft(draft, removed) {
    const level = levelFromTotalExp(draft.player.exp ?? 0);
    const keep = (skillId) => {
      if (isSkillUnlocked(this.#unlockTable, skillId, level)) return true;
      removed.push(skillId);
      return false;
    };
    draft.player.gcdSequence = draft.player.gcdSequence.filter(keep);
    draft.player.ogcdSlots = draft.player.ogcdSlots.filter((slot) => keep(slot.skillId));
    // 重排 slotIndex，别让存档里留下 0、2、5 这种断档
    draft.player.ogcdSlots.forEach((slot, index) => {
      slot.slotIndex = index;
    });
    if (removed.length > 0) {
      pushLog(draft, `序列里有 ${removed.length} 个当前等级（Lv.${level}）未解锁的技能，已剔除`);
    }
    return level;
  }

  /**
   * 生成当前层地图并把玩家放到起点。
   * @param {number|null} [floorNumber] 目标层，省略则沿用当前层
   * @param {{save?: boolean}} [options] `save:false` 用于"恢复流程中间的那次调用"——
   *   默认会写自动档，而恢复中途玩家数据还没填回去，写下去就是一份空局。
   */
  enterFloor(floorNumber = null, { save = true } = {}) {
    const state = this.#store.unsafeGetState();
    const floor = floorNumber ?? state.floorNumber;
    const generator = this.#pool.mapGenerators.get('official.grid');
    if (generator === undefined) {
      throw new FateError('未注册地图生成器 official.grid', { code: 'NO_MAP_GENERATOR' });
    }

    const result = generator.generate({ seed: state.seed, floorNumber: floor });

    this.#store.update((draft) => {
      draft.floorNumber = floor;
      draft.mapNodes = result.nodes;
      draft.mapAdjacency = result.adjacency;
      draft.startNodeId = result.startNodeId;
      draft.exitNodeId = result.exitNodeId;
      draft.gridWidth = result.gridWidth;
      draft.gridHeight = result.gridHeight;
      draft.currentNodeId = result.startNodeId;
      draft.visitedNodeIds = new Set([result.startNodeId]);
      draft.clearedNodeIds = new Set();
      draft.shopStates = new Map();
      draft.status = GAME_STATUS.EXPLORING;
      draft.monsters = [];
      draft.activeBattle = null;
      draft.virtualTime = 0;
      draft.winner = null;

      revealInitial(draft.mapNodes, draft.mapAdjacency, result.startNodeId);
      draft.metadata.nodesVisited += 1;
      pushLog(draft, `进入第 ${floor} 层（${result.gridWidth}×${result.gridHeight}）`);
    });

    if (save) this.#autoSave();
    return result;
  }

  /**
   * 尝试移动到目标节点（规格 6.3）。
   * @returns {{ok:boolean, reason?:string, triggeredBattle?:boolean}}
   */
  moveTo(nodeId) {
    const state = this.#store.unsafeGetState();

    if (state.status !== GAME_STATUS.EXPLORING) {
      return { ok: false, reason: 'notExploring' };
    }
    if (!areAdjacent(state.mapAdjacency, state.currentNodeId, nodeId)) {
      return { ok: false, reason: 'notAdjacent' };
    }

    const node = state.mapNodes.find((n) => n.id === nodeId);
    if (node === undefined) return { ok: false, reason: 'noSuchNode' };
    if (node.type === NODE_TYPE.DEAD_END) return { ok: false, reason: 'deadEnd' };

    const isFirstVisit = !state.visitedNodeIds.has(nodeId);

    this.#store.update((draft) => {
      draft.currentNodeId = nodeId;
      if (isFirstVisit) {
        draft.visitedNodeIds.add(nodeId);
        draft.metadata.nodesVisited += 1;
      }
      revealAround(draft.mapNodes, draft.mapAdjacency, nodeId);
    });

    this.#audio?.play('ui.move', {});

    // 战斗触发：首次进入未清理的战斗/精英节点（规格 6.4）
    const isCombatNode = node.type === NODE_TYPE.COMBAT || node.type === NODE_TYPE.ELITE;
    if (isCombatNode && !state.clearedNodeIds.has(nodeId)) {
      return { ok: true, triggeredBattle: true };
    }

    return { ok: true, triggeredBattle: false };
  }

  /** 开始当前节点的战斗。 */
  startBattle() {
    const state = this.#store.unsafeGetState();
    const node = state.mapNodes.find((n) => n.id === state.currentNodeId);
    if (node === undefined) throw new FateError('当前节点不存在', { code: 'NO_CURRENT_NODE' });

    // 开战前最后一次洗序列：保证进战斗的序列在当前等级下全部合法
    this.sanitizeSequence();

    const tier = node.type === NODE_TYPE.ELITE ? 'elite' : 'normal';
    this.#audio?.play('battle.start', {});
    return this.#engine.begin({ nodeId: node.id, tier });
  }

  /**
   * 战斗结束后的结算（规格 7.4，决定 A，阶段 8 扩展经验与掉落）。
   * 胜 → 清理节点 + 碎片 + 经验 + 装备掉落；败 → 永久死亡。
   */
  finishBattle() {
    const state = this.#store.unsafeGetState();
    if (state.status !== GAME_STATUS.FINISHED) {
      return { settled: false };
    }

    const battle = state.activeBattle;
    if (battle === null || battle === undefined) {
      // 通关结算也会把状态写成 FINISHED + winner=PLAYER，但那不是一场战斗。
      // 少了这道守卫，rAF 循环会在通关后再调一次 finishBattle 并踩空。
      return { settled: false };
    }
    const won = state.winner === WINNER.PLAYER;

    if (!won) {
      // 永久死亡（规格 6.4）：不回到探索模式
      this.#saveService?.appendHistory(state, { outcome: 'death', atm: this.atmAccount() }).catch(() => {});
      this.#saveService?.clearRun().catch(() => {});
      return { settled: true, won: false, outcome: 'death' };
    }

    const node = state.mapNodes.find((n) => n.id === battle.nodeId);
    const isElite = node?.type === NODE_TYPE.ELITE;
    const shards = SHARD_REWARD_COMBAT * (isElite ? SHARD_REWARD_ELITE_MULTIPLIER : 1);
    const exp = battleExpReward({
      monsterCount: state.monsters.length,
      floorNumber: state.floorNumber,
      isElite,
    });
    const loot = rollBattleLoot({
      seed: state.seed,
      floorNumber: state.floorNumber,
      nodeId: battle.nodeId,
      isElite,
    });

    const levelBefore = state.player.level;
    let levelAfter = levelBefore;
    const kept = [];
    let discarded = 0;
    /** 被熔炼规则拦下的（与下面“包满溢出”分开计：两件不同的事，原因也不同） */
    const melted = [];

    this.#store.update((draft) => {
      draft.status = GAME_STATUS.EXPLORING;
      draft.winner = null;
      draft.monsters = [];
      draft.activeBattle = null;
      draft.clearedNodeIds.add(battle.nodeId);

      const target = draft.mapNodes.find((n) => n.id === battle.nodeId);
      if (target !== undefined) target.isCleared = true;

      draft.fateShards += shards;
      draft.metadata.shardsEarned += shards;
      draft.metadata.battlesWon += 1;

      // 经验：exp 是等级的唯一真相源，写完立即 recalc
      draft.player.exp += exp;
      draft.metadata.expEarned += exp;
      levelAfter = levelFromTotalExp(draft.player.exp);

      // 装备入包。两道关，顺序不能倒：
      //   1. 熔炼规则（P2）——拾取瞬间就判，被拦下的当场折成碎片
      //   2. 包满溢出（旧行为）——规则留下来的东西才轮得到它
      // 先规则后容量，是为了不让“包满了以故熔它”与“按规则该熔”混成一个数字。
      for (const gear of loot) {
        const verdict = gearVerdict(gear, {
          filter: draft.lootFilter,
          equipment: draft.player.equipment,
        });
        if (!verdict.keep) {
          const gain = salvageValue(gear);
          draft.fateShards += gain;
          draft.metadata.gearMelted += 1;
          draft.metadata.shardsFromMelt += gain;
          melted.push({ gear, shards: gain });
          continue;
        }
        if (draft.player.inventory.length >= INVENTORY_CAPACITY) {
          draft.fateShards += salvageValue(gear);
          discarded += 1;
          continue;
        }
        draft.player.inventory.push(gear);
        draft.metadata.gearFound += 1;
        kept.push(gear);
      }

      // 升级会提升 maxHp；按「保持缺失量」补齐，不白送回血
      recalcPlayer(draft.player);

      pushLog(draft, `战斗胜利，获得 ${shards} 枚命运碎片与 ${exp} 点经验`);
      if (levelAfter > levelBefore) {
        pushLog(draft, `等级提升：${levelBefore} → ${levelAfter}`);
      }
      for (const gear of kept) {
        pushLog(draft, `抬到装备：${gear.name}`);
      }
      if (melted.length > 0) {
        // 合一条而不是每件一条：LOG_CAPACITY 只有 100，而一场精英能掉 2 件。
        // 逐件列名会把战斗日志挤成流水账，而玩家要看的是“规则干了什么”。
        const gained = melted.reduce((sum, item) => sum + item.shards, 0);
        pushLog(
          draft,
          `♻️ 熔炼 ${melted.length} 件（${filterSummary(draft.lootFilter)}），回收 ${gained} 枚碎片`,
        );
      }
      if (discarded > 0) {
        pushLog(draft, `背包已满，${discarded} 件装备自动分解`);
      }

      draft.lastBattleReward = {
        shards,
        exp,
        levelBefore,
        levelAfter,
        loot: kept.map((g) => ({ id: g.id, name: g.name, rarityIndex: g.rarityIndex })),
        discarded,
        melted: melted.map((g) => ({ id: g.gear.id, name: g.gear.name, shards: g.shards })),
      };
    });

    if (levelAfter > levelBefore) this.#audio?.play('ui.confirm', {});

    this.#autoSave();
    return { settled: true, won: true, shards, exp, levelBefore, levelAfter, loot: kept };
  }

  /** 使用休息节点（决定 A：恢复 30% 最大 HP，一次性）。 */
  useRest() {
    const state = this.#store.unsafeGetState();
    const node = state.mapNodes.find((n) => n.id === state.currentNodeId);
    if (node?.type !== NODE_TYPE.REST) return { ok: false, reason: 'notRestNode' };
    if (node.isCleared) return { ok: false, reason: 'alreadyUsed' };

    let healed = 0;
    this.#store.update((draft) => {
      const target = draft.mapNodes.find((n) => n.id === draft.currentNodeId);
      const before = draft.player.hp;
      draft.player.hp = Math.min(
        draft.player.maxHp,
        before + Math.floor(draft.player.maxHp * REST_HEAL_RATIO),
      );
      healed = draft.player.hp - before;
      target.isCleared = true;
      draft.clearedNodeIds.add(target.id);
      pushLog(draft, `在${target.displayName}休息，恢复 ${healed} 点生命`);
    });

    this.#audio?.play('map.rest', {});
    this.#autoSave();
    return { ok: true, healed };
  }

  /**
   * 取当前节点的商店商品（决定 A）。
   * 用遭遇流按 nodeId 派生 —— 同种子同节点商品恒定，来回走动不会刷新。
   */
  getShopOffers() {
    const state = this.#store.unsafeGetState();
    const node = state.mapNodes.find((n) => n.id === state.currentNodeId);
    if (node?.type !== NODE_TYPE.SHOP) return null;

    // 读档恢复的 shopState 只有 purchasedIds，offers 为空 —— 需重建。
    // offers 由种子 + nodeId 派生，重建结果与当时逐项相同，因此不入存档。
    const existing = state.shopStates.get(node.id);
    if (existing !== undefined && existing.offers.length > 0) return existing;

    const rng = encounterStream(state.seed, state.floorNumber, `${node.id}:shop`);
    const pool = [...this.#pool.shopItems.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
    const offers = [];
    const chosen = new Set();

    let guard = 0;
    while (offers.length < SHOP_OFFER_COUNT && chosen.size < pool.length && guard < 64) {
      guard += 1;
      const item = rng.pickWeighted(pool);
      if (chosen.has(item.id)) continue;
      chosen.add(item.id);
      offers.push({ id: item.id, name: item.name, description: item.description, cost: item.cost });
    }

    const shopState = { offers, purchasedIds: existing?.purchasedIds ?? new Set() };
    this.#store.update((draft) => {
      draft.shopStates.set(node.id, shopState);
    });
    return shopState;
  }

  // ============================================================
  // 熔炼规则（P2）
  //
  // 三个入口都在本类（屏幕不许自己 store.update）：改规则、套预设、试算。
  // 它们都不消费随机数 —— 掉落早就在 `${nodeId}:loot` 子流里 roll 完了，
  // 过滤器只决定“这件进不进包”，所以开关它不改一场战斗的任何指纹。
  // ============================================================

  /** 当前规则（已规范化的副本，改不坏活状态）。 */
  lootFilter() {
    return normalizeLootFilter(this.#store.unsafeGetState().lootFilter);
  }

  /** 局部改规则（面板上每个控件都走这里）。 */
  setLootFilter(patch) {
    this.#store.update((draft) => {
      draft.lootFilter = normalizeLootFilter({ ...draft.lootFilter, ...patch });
    });
    this.#autoSave();
    return this.lootFilter();
  }

  /** 套预设（整体替换，不是叠加 —— 叠加会让“换一个预设”留下上一个的碎片）。 */
  applyLootFilterPreset(presetId) {
    const next = filterFromPreset(presetId);
    if (next === null) return { ok: false, reason: 'noSuchPreset' };
    this.#store.update((draft) => {
      draft.lootFilter = next;
    });
    this.#autoSave();
    return { ok: true, filter: next };
  }

  /** 只读试算：本局背包按当前规则会熔掉什么（不改任何状态）。 */
  previewLootFilter() {
    const state = this.#store.unsafeGetState();
    return dryRunFilter(state.lootFilter, {
      inventory: state.player.inventory,
      equipment: state.player.equipment,
    });
  }

  /**
   * 当前节点商店的装备货架（阶段 8）。
   * 纯函数：每次调用重算，不写状态。已购入的判定靠 shopState.purchasedIds。
   */
  getShopGear() {
    const state = this.#store.unsafeGetState();
    const node = state.mapNodes.find((n) => n.id === state.currentNodeId);
    if (node?.type !== NODE_TYPE.SHOP) return [];

    const gear = [];
    for (let i = 0; i < SHOP_GEAR_COUNT; i += 1) {
      const item = rollShopGear({
        seed: state.seed,
        floorNumber: state.floorNumber,
        nodeId: node.id,
        index: i,
      });
      gear.push({ gear: item, price: gearPrice(item) });
    }
    return gear;
  }

  /** 购买商品。 */
  purchase(itemId) {
    const state = this.#store.unsafeGetState();
    const node = state.mapNodes.find((n) => n.id === state.currentNodeId);
    if (node?.type !== NODE_TYPE.SHOP) return { ok: false, reason: 'notShopNode' };

    const shopState = state.shopStates.get(node.id);
    if (shopState === undefined) return { ok: false, reason: 'shopNotOpened' };
    if (shopState.purchasedIds.has(itemId)) return { ok: false, reason: 'alreadyPurchased' };

    const item = this.#pool.shopItems.get(itemId);
    if (item === undefined) return { ok: false, reason: 'noSuchItem' };
    // 只卖货架上的东西。货架由种子派生，“能买到的”与“看得见的”必须是同一个集合；
    // 读档后 offers 还没重建（空数组）时不拦，避免把合法购买变成「看不见就买不到」。
    if (shopState.offers.length > 0 && !shopState.offers.some((offer) => offer.id === itemId)) {
      return { ok: false, reason: 'notOnShelf' };
    }
    if (state.fateShards < item.cost) return { ok: false, reason: 'insufficientShards' };

    this.#store.update((draft) => {
      draft.fateShards -= item.cost;
      item.apply(draft, this.#stateOps(draft));
      // 永久属性走 permanentBonus，这里统一重算才能立刻反映到面板（P0-3）
      recalcPlayer(draft.player);
      draft.shopStates.get(node.id).purchasedIds.add(itemId);
      pushLog(draft, `购买了${item.name}（-${item.cost} 碎片）`);
    });

    this.#audio?.play('ui.purchase', {});
    this.#autoSave();
    return { ok: true };
  }

  /** 取当前节点的事件。用遭遇流按 nodeId 派生，选项恒定。 */
  getEvent() {
    const state = this.#store.unsafeGetState();
    const node = state.mapNodes.find((n) => n.id === state.currentNodeId);
    if (node?.type !== NODE_TYPE.EVENT) return null;
    if (node.isCleared) return null;

    const rng = encounterStream(state.seed, state.floorNumber, `${node.id}:event`);
    const pool = [...this.#pool.events.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
    if (pool.length === 0) return null;
    return rng.pickWeighted(pool);
  }

  /** 选择事件选项。 */
  resolveEvent(eventId, choiceIndex) {
    const event = this.#pool.events.get(eventId);
    if (event === undefined) return { ok: false, reason: 'noSuchEvent' };
    const choice = event.choices[choiceIndex];
    if (choice === undefined) return { ok: false, reason: 'noSuchChoice' };

    this.#store.update((draft) => {
      choice.apply(draft, this.#stateOps(draft));
      const node = draft.mapNodes.find((n) => n.id === draft.currentNodeId);
      if (node !== undefined) {
        node.isCleared = true;
        draft.clearedNodeIds.add(node.id);
      }
      // recalcPlayer 顺手把 hp 夹回 [1, maxHp]，无需再手写 clamp
      recalcPlayer(draft.player);
      pushLog(draft, `事件「${event.name}」：${choice.label}`);
    });

    this.#autoSave();
    return { ok: true };
  }

  /** 进入下一层（规格 6.4：不可返回上一层）。第 VICTORY_FLOOR 层的出口是终点。 */
  descend() {
    const state = this.#store.unsafeGetState();
    if (state.currentNodeId !== state.exitNodeId) {
      return { ok: false, reason: 'notAtExit' };
    }
    if (state.floorNumber >= VICTORY_FLOOR && !state.victoryAchieved) {
      return this.#settleVictory();
    }

    // 先把目标层数算下来：unsafeGetState() 返回的是活对象，enterFloor 会就地改它。
    // 若在 return 里再读 state.floorNumber，就会拿到改写后的值（+2）。
    const nextFloor = state.floorNumber + 1;
    this.#store.update((draft) => {
      draft.metadata.floorsCleared += 1;
    });
    this.#audio?.play('map.floorDown', {});
    this.enterFloor(nextFloor);
    return { ok: true, floorNumber: nextFloor };
  }

  /**
   * 通关结算（P1-6）。不再生成第 51 层：本局到此为止，玩家可以选「继续挑战无尽」。
   *
   * 与战败同为 FINISHED，但 winner 是 PLAYER；自动槽同样清掉 ——
   * 留着它会让「继续游戏」把玩家放回一个已经通关、再点出口就什么都不发生的节点。
   */
  #settleVictory() {
    const state = this.#store.unsafeGetState();
    const floor = state.floorNumber;

    this.#store.update((draft) => {
      draft.metadata.floorsCleared += 1;
      draft.victoryAchieved = true;
      draft.status = GAME_STATUS.FINISHED;
      draft.winner = WINNER.PLAYER;
      draft.battleEndReason = 'victory';
      draft.monsters = [];
      draft.activeBattle = null;
      pushLog(draft, `第 ${floor} 层的出口在你身后合拢 —— 轮回通关`);
    });

    this.#audio?.play('battle.victory', {});
    this.#saveService?.appendHistory(state, { outcome: 'victory', atm: this.atmAccount() }).catch(() => {});
    this.#saveService?.clearRun().catch(() => {});
    return { ok: true, victory: true, floorNumber: floor };
  }

  /**
   * 通关后选择继续：回到探索态，之后的下层不再触发第二次结算。
   * 层数与所有进度原样保留，因此无尽段的成绩仍会写进历史（带 victoryAchieved 标记）。
   */
  continueEndless() {
    const state = this.#store.unsafeGetState();
    if (state.victoryAchieved !== true || state.status !== GAME_STATUS.FINISHED) {
      return { ok: false, reason: 'nothingToContinue' };
    }

    this.#store.update((draft) => {
      draft.status = GAME_STATUS.EXPLORING;
      draft.winner = null;
      draft.battleEndReason = null;
      pushLog(draft, '你选择再走一轮 —— 从这里开始没有尽头');
    });

    this.#autoSave();
    return { ok: true, floorNumber: state.floorNumber };
  }

  /**
   * 绑定到某个 draft 的安全原语，作为 apply(state, ops) 的第二个参数传给
   * 商店商品与事件选项。
   *
   * 为什么要这层：第三方包的 apply 运行在沙箱里，拿不到 state 对象的写权限
   * （跨边界只能传可序列化值）。官方内容今天直接改 draft 字段是可信层的特权，
   * 但把"改什么"收敛成这 9 个操作之后，官方与第三方就能共用同一份语义 ——
   * 也顺手让"这个选项到底改了哪些东西"变成可枚举的。
   * 操作集合的来源：node tools/mod-shape-report.mjs 测出的 11 种状态操作。
   */
  #stateOps(draft) {
    const clampInt = (value, fallback = 0) =>
      Number.isFinite(value) ? Math.trunc(value) : fallback;
    return {
      /** 永久属性（唯一正确入口，见 derived.js 的单一数据源原则） */
      permanentBonus: (bonus) => addPermanentBonus(draft.player, bonus),
      get shards() {
        return draft.fateShards;
      },
      gainShards: (n) => {
        const amount = clampInt(n);
        draft.fateShards += amount;
        draft.metadata.shardsEarned += amount;
      },
      /** 够就扣并返回 true；不够什么都不做并返回 false */
      spendShards: (n) => {
        const amount = clampInt(n);
        if (amount < 0 || draft.fateShards < amount) return false;
        draft.fateShards -= amount;
        return true;
      },
      setShards: (n) => {
        draft.fateShards = Math.max(0, clampInt(n));
      },
      /** 按最大生命比例回血，夹在上限内 */
      healRatio: (ratio) => {
        const max = draft.player.maxHp;
        draft.player.hp = Math.min(max, draft.player.hp + Math.floor(max * Math.max(0, ratio)));
      },
      /** 按当前生命比例扣血，至少留 1 点 */
      hpCostRatio: (ratio) => {
        const hp = draft.player.hp;
        draft.player.hp = Math.max(1, hp - Math.floor(hp * Math.max(0, ratio)));
      },
      fullHeal: () => {
        draft.player.hp = draft.player.maxHp;
      },
      /** 统计字段（shardsEarned / battlesWon 之类） */
      addMetadata: (key, n) => {
        if (typeof draft.metadata[key] === 'number') draft.metadata[key] += clampInt(n);
      },
    };
  }

  /** 当前节点对象。 */
  currentNode() {
    const state = this.#store.unsafeGetState();
    return state.mapNodes.find((n) => n.id === state.currentNodeId) ?? null;
  }

  /**
   * 从存档恢复一局（阶段 9）。
   *
   * 地图不存在存档里 —— (seed, floorNumber) 就能重建出逐位相同的地图（裁决 2）。
   * 存档只记录玩家在地图上的位置与进展，回读后重放揭示。
   *
   * @param {object} run deserializeRun 的返回值
   */
  restoreRun(run) {
    // 种子必须先写入：enterFloor 从 state.seed 派生地图流。
    // 漏了这一步就会用当前局的种子重建地图，存档里的 currentNodeId 会指向不存在的节点。
    this.#store.update((draft) => {
      draft.seed = run.seed;
    });

    // 关键：这次 enterFloor 不能写档。它会把自动槽覆盖成"玩家数据还没恢复"的半成品
    // —— 磁盘毁了而内存是对的，读档后只要没再做别的操作就永久丢档（实测过）。
    this.enterFloor(run.floorNumber, { save: false });

    this.#store.update((draft) => {
      draft.fateShards = run.fateShards ?? 0;
      draft.metadata = { ...draft.metadata, ...(run.metadata ?? {}) };
      // 通关标记：不带回来的话，从第 51 层读档再下层会触发"第二次通关"
      draft.victoryAchieved = run.victoryAchieved === true;

      // 成长与装备：exp 是等级的唯一真相源，写完统一 recalc
      draft.player.exp = run.exp ?? 0;
      if (run.seedBonus !== undefined) draft.player.seedBonus = { ...run.seedBonus };
      // permanentBonus 是 v2 存档的可选字段：旧档缺它时保持全零（当时本就没有可存活的永久加成）
      draft.player.permanentBonus = permanentBonusOf({ permanentBonus: run.permanentBonus });
      draft.player.equipment = { ...createEmptyEquipment(), ...(run.equipment ?? {}) };
      draft.player.inventory = [...(run.inventory ?? [])];
      // 熔炼规则（P2）：旧档缺这个字段时 normalize 兼平为「不自动熔炼」，语义正确
      draft.lootFilter = normalizeLootFilter(run.lootFilter);
      draft.player.gcdSequence = [...(run.gcdSequence ?? [])];
      draft.player.ogcdSlots = (run.ogcdSlots ?? []).map((s, index) => ({
        skillId: s.skillId,
        priority: s.priority ?? 0,
        slotIndex: index,
      }));
      recalcPlayer(draft.player, { fullHeal: true });
      // 存档里的 hp 优先，但不得超过重算后的 maxHp
      if (Number.isFinite(run.playerHp)) {
        draft.player.hp = Math.max(1, Math.min(draft.player.maxHp, run.playerHp));
      }

      // 探索进展
      draft.visitedNodeIds = new Set(run.visitedNodeIds ?? [draft.startNodeId]);
      draft.clearedNodeIds = new Set(run.clearedNodeIds ?? []);
      draft.currentNodeId = run.currentNodeId ?? draft.startNodeId;

      for (const node of draft.mapNodes) {
        if (draft.clearedNodeIds.has(node.id)) node.isCleared = true;
      }

      // 重放揭示：每个到访过的节点都揭开周围，结果与当时一致
      revealInitial(draft.mapNodes, draft.mapAdjacency, draft.startNodeId);
      for (const nodeId of draft.visitedNodeIds) {
        revealAround(draft.mapNodes, draft.mapAdjacency, nodeId);
      }

      // 商店已购记录
      draft.shopStates = new Map();
      for (const [nodeId, purchased] of run.shopPurchases ?? []) {
        draft.shopStates.set(nodeId, { offers: [], purchasedIds: new Set(purchased) });
      }

      draft.status = GAME_STATUS.EXPLORING;
      draft.log = [];
      pushLog(draft, `读取存档：第 ${draft.floorNumber} 层，等级 ${draft.player.level}`);
      // 存档可能来自旧版本或被手改：洗掉当前等级用不了的技能。
      // 放在日志复位之后，否则这条通知会被上面那次 log = [] 抹掉。
      this.#sanitizeDraft(draft, []);
    });

    // 恢复完成后立刻写一次自动档：让磁盘与内存对齐，不再依赖"玩家之后做过点什么"
    this.#saveService?.saveRun(this.#store.unsafeGetState());

    // 商店商品列表是由种子派生的，重新 open 时会自动重建；
    // 上面只恢复了 purchasedIds，offers 为空数组则会在 getShopOffers 中重建。
    return { ok: true, floorNumber: this.#store.unsafeGetState().floorNumber };
  }

  // ============================================================
  // 装备管理（阶段 8）
  // 所有写入都以 recalcPlayer 收尾 —— 面板不得存在未重算的中间态。
  // ============================================================

  /** 从背包穿上一件装备，旧件退回背包。 */
  equip(gearId) {
    const state = this.#store.unsafeGetState();
    const gear = state.player.inventory.find((g) => g.id === gearId);
    if (gear === undefined) return { ok: false, reason: 'notInInventory' };

    this.#store.update((draft) => {
      const index = draft.player.inventory.findIndex((g) => g.id === gearId);
      const [moved] = draft.player.inventory.splice(index, 1);
      const previous = draft.player.equipment[moved.slot];
      draft.player.equipment[moved.slot] = moved;
      if (previous !== null && previous !== undefined) draft.player.inventory.push(previous);
      recalcPlayer(draft.player);
    });

    this.#audio?.play('ui.confirm', {});
    this.#autoSave();
    return { ok: true, slot: gear.slot };
  }

  /** 卸下指定槽位。背包满时拒绝，避免默默弄丢装备。 */
  unequip(slot) {
    const state = this.#store.unsafeGetState();
    const gear = state.player.equipment[slot];
    if (gear === null || gear === undefined) return { ok: false, reason: 'emptySlot' };
    if (state.player.inventory.length >= INVENTORY_CAPACITY) {
      return { ok: false, reason: 'inventoryFull' };
    }

    this.#store.update((draft) => {
      draft.player.inventory.push(draft.player.equipment[slot]);
      draft.player.equipment[slot] = null;
      recalcPlayer(draft.player);
    });

    this.#autoSave();
    return { ok: true };
  }

  /** 分解背包里的装备，换碎片。 */
  salvage(gearId) {
    const state = this.#store.unsafeGetState();
    const gear = state.player.inventory.find((g) => g.id === gearId);
    if (gear === undefined) return { ok: false, reason: 'notInInventory' };

    const gained = salvageValue(gear);
    this.#store.update((draft) => {
      const index = draft.player.inventory.findIndex((g) => g.id === gearId);
      draft.player.inventory.splice(index, 1);
      draft.fateShards += gained;
      pushLog(draft, `分解${gear.name}，回收 ${gained} 枚碎片`);
    });

    this.#autoSave();
    return { ok: true, gained };
  }

  /** 强化装备（背包与已穿戴均可）。 */
  enhance(gearId) {
    const state = this.#store.unsafeGetState();
    const found = this.#findGear(state, gearId);
    if (found === null) return { ok: false, reason: 'noSuchGear' };

    // 先在副本上试算费用，避免 update 中因碎片不足而半途回滚
    const probe = enhanceGear({ ...found.gear, stats: { ...found.gear.stats } }, state.fateShards);
    if (!probe.ok) return probe;

    let result = probe;
    this.#store.update((draft) => {
      const live = this.#findGear(draft, gearId);
      result = enhanceGear(live.gear, draft.fateShards);
      if (!result.ok) return;
      draft.fateShards -= result.cost;
      if (live.equipped) recalcPlayer(draft.player);
      pushLog(draft, `${live.gear.name} 强化至 +${result.level}（-${result.cost} 碎片）`);
    });

    this.#audio?.play('ui.purchase', {});
    this.#autoSave();
    return result;
  }

  /** 在装备栏与背包中查找。 */
  #findGear(state, gearId) {
    for (const slot of Object.keys(state.player.equipment)) {
      const gear = state.player.equipment[slot];
      if (gear !== null && gear !== undefined && gear.id === gearId) {
        return { gear, equipped: true, slot };
      }
    }
    const gear = state.player.inventory.find((g) => g.id === gearId);
    return gear === undefined ? null : { gear, equipped: false, slot: gear.slot };
  }

  /** 购买商店里的装备。 */
  purchaseGear(gear) {
    const state = this.#store.unsafeGetState();
    const price = gearPrice(gear);
    if (state.fateShards < price) return { ok: false, reason: 'insufficientShards' };
    if (state.player.inventory.length >= INVENTORY_CAPACITY) {
      return { ok: false, reason: 'inventoryFull' };
    }

    this.#store.update((draft) => {
      draft.fateShards -= price;
      draft.player.inventory.push(gear);
      draft.metadata.gearFound += 1;
      pushLog(draft, `购入${gear.name}（-${price} 碎片）`);
    });

    this.#audio?.play('ui.purchase', {});
    this.#autoSave();
    return { ok: true, price };
  }
}
