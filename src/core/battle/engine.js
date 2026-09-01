/**
 * 战斗引擎（规格 7.2 完整时序）。
 *
 * 确定性的三重保证：
 *   1. 时间只用绝对到期时间戳比较，不做累减（裁决 1）
 *   2. 所有毫秒值是 STEP_MS 整数倍（normalize 阶段强制，裁决 4）
 *   3. 随机数取自按 (层, 节点, 尝试序号) 派生的战斗流（裁决 2）
 *
 * 三者叠加的结果：无论按 16ms（1x）、64ms（4x）还是同步跑完（MAX）推进，
 * 逻辑步的序列完全相同，终态逐字段相等。这就是阶段 5 的跨速度对拍验收。
 *
 * 注意 4x 的实现：不是"一帧推进 64ms"，而是"一帧跑 4 个 16ms 的逻辑步"。
 * 前者会让 16ms 粒度的冷却判定被跳过，后者才与 1x 等价。
 */

import {
  BATTLE_TIMEOUT_MS,
  GAME_STATUS,
  MAX_MODE_STEP_LIMIT,
  SPEED_MODES,
  SPEED_STEP_MS,
  STEP_MS,
} from '../constants.js';
import { isAlive, pruneExpiredBuffs } from '../entity.js';
import {
  AUDIO_PLAY,
  BUFF_APPLY,
  COMBAT_LOG,
  DAMAGE_APPLY,
  HEAL_APPLY,
  STATE_QUERY,
} from '../../contracts/symbols.js';
import { battleStream } from '../prng.js';
import { applyOutcome, evaluateOutcome } from './resolution.js';
import { stepEntity } from './scheduler.js';
import { instantiateMonsters, pickEncounter } from './encounter.js';
import { FateError } from '../../utils/invariant.js';
import { deepClone, deepFreeze } from '../../utils/deepFreeze.js';

/** 按 id 查实体。与 contracts/index.js 里那份同语义 —— 这里复制一份是为了
 *  不让 core 的运行热路径反向依赖装配层模块。 */
function findEntity(state, entityId) {
  if (state.player?.id === entityId) return state.player;
  for (const monster of state.monsters) {
    if (monster.id === entityId) return monster;
  }
  return null;
}

export class BattleEngine {
  #store;
  #registry;
  #pool;
  #rng = null;
  #hooks = { before: [], after: [], battleStart: [] };
  #audioSink = null;
  #liveAudioSink = null;
  #silentSink = null;

  /**
   * @param {object} deps
   * @param {import('../store.js').Store} deps.store
   * @param {import('../../contracts/registry.js').Registry} deps.registry
   * @param {object} deps.pool 内容池（skills / monsters / encounters）
   */
  constructor({ store, registry, pool }) {
    this.#store = store;
    this.#registry = registry;
    this.#pool = pool;
  }

  /** 供契约读取当前战斗流。战斗外调用会抛错 —— 战斗外不应有随机消费。 */
  getRng() {
    if (this.#rng === null) {
      throw new FateError('战斗流未初始化：战斗外不得消费随机数', { code: 'RNG_NOT_READY' });
    }
    return this.#rng;
  }

  /** 注册 MAX 模式静音用的双 sink（裁决 8）。 */
  setAudioSinks({ live, silent = null }) {
    this.#liveAudioSink = live;
    this.#audioSink = live;
    this.#silentSink = silent;
    return this;
  }

  getAudioSink() {
    return this.#audioSink;
  }

  registerHook(phase, fn) {
    if (phase !== 'before' && phase !== 'after' && phase !== 'battleStart') {
      throw new FateError(`未知钩子阶段：${phase}`, { code: 'UNKNOWN_HOOK' });
    }
    this.#hooks[phase].push(fn);
    return this;
  }

  /**
   * 战斗初始化（规格 7.1）。玩家 HP 继承自探索状态。
   * @param {object} params
   * @param {string} params.nodeId
   * @param {'normal'|'elite'} params.tier
   */
  begin({ nodeId, tier, attemptIndex = 0 }) {
    const state = this.#store.unsafeGetState();

    const encounter = pickEncounter({
      seed: state.seed,
      floorNumber: state.floorNumber,
      nodeId,
      tier,
      encounters: this.#pool.encounters,
    });

    const monsters = instantiateMonsters({
      encounter,
      monsters: this.#pool.monsters,
      floorNumber: state.floorNumber,
      seed: state.seed,
      nodeId,
    });

    this.#rng = battleStream(state.seed, state.floorNumber, nodeId, attemptIndex);

    this.#store.update((draft) => {
      draft.virtualTime = 0;
      draft.status = GAME_STATUS.BATTLING;
      draft.winner = null;
      draft.battleEndReason = null;
      draft.monsters = monsters;
      draft.activeBattle = { nodeId, tier, attemptIndex, encounterId: encounter.id };
      draft.log = [];

      // 玩家的战斗态计时器归零，但 HP 继承（规格 7.1）
      draft.player.gcdReadyAtMs = 0;
      draft.player.gcdIndex = 0;
      draft.player.ogcdReadyAtMs = new Map();
      draft.player.buffs = new Map();
      draft.player.stats = { damageDealt: 0, damageTaken: 0, healDone: 0, skillsCast: 0 };
    });

    /**
     * 开战钩子。存在的理由不是性能，是**确定性**：第三方包可以用模块级
     * 变量持有跨次施放的记忆（官方技能全是无状态的），那种记忆会活过整场
     * 战斗，导致“同种子同序列但先打过一场”结果就不同。
     * 有这个钩子，包就能在每场开头自己清掉记忆，把“单场可复现”拿回来。
     *
     * 按注册顺序执行（不并发、不随机）—— 钩子顺序本身就是确定性的一部分。
     */
    if (this.#hooks.battleStart.length > 0) {
      const hookContext = this.#buildContext();
      for (const hook of this.#hooks.battleStart) {
        hook(hookContext, this.#store.unsafeGetState());
      }
    }

    return { encounter, monsters };
  }

  /** 契约上下文：模组通过它调用契约，不能直接触碰 #state。 */
  #buildContext() {
    const state = this.#store.unsafeGetState();
    const registry = this.#registry;
    const engine = this;
    /**
     * 当前正在施放的技能。由 scheduler 在每次 `execute` 前设进来，然后被抹到
     * damage / heal / applyBuff 的参数里 —— 这样**日志能说出是哪个技能**，
     * 而技能作者（包括第三方包）不用自己传 skillId：他们本来就拿不到自己的 id。
     */
    let activeSkill = null;
    const withSkill = (args) => ({ skillId: activeSkill, ...args });
    return {
      /** 仅供调度器使用；技能与包不应该碰它 */
      setActiveSkill(skillId) {
        activeSkill = skillId ?? null;
      },
      get virtualTime() {
        return state.virtualTime;
      },
      get floorNumber() {
        return state.floorNumber;
      },
      get(symbol) {
        return registry.get(symbol);
      },
      call(symbol, ...args) {
        return registry.call(symbol, ...args);
      },
      rng() {
        return engine.getRng().next();
      },

      /* ------------------------------------------------------------------
       * 高层能力别名。官方模组可以继续用 get(SYM.xxx)，但**第三方包只该看到
       * 这一层**：Symbol 是宿主内部标识，跨沙箱边界传不出去，也不该让包作者
       * 去猜。等价性由 tests/unit/fate-api.test.js 守住。
       * ---------------------------------------------------------------- */
      damage(args) {
        return registry.call(DAMAGE_APPLY, withSkill(args));
      },
      heal(args) {
        return registry.call(HEAL_APPLY, withSkill(args));
      },
      applyBuff(args) {
        return registry.call(BUFF_APPLY, withSkill(args));
      },
      /**
       * 按 id 取实体快照。
       * 为什么要有它：状态路径按 '.' 分段，而实体 id 本身就含点
       * （'mon.thunder.herald.t1#0'、'blade.jab'），所以 `query('monsters.' + id)`
       * 这类写法天生不可能工作 —— 必须走一等 API。
       */
      entity(entityId) {
        const found = findEntity(state, entityId);
        return found === null ? undefined : deepFreeze(deepClone(found));
      },
      /** 读某个实体身上的 Buff 层数（不在场返回 0）。模组作者不该自己碰 buffs Map。 */
      buffStacks(entity, buffId) {
        const live = findEntity(state, entity?.id ?? entity) ?? entity;
        const buff = live?.buffs instanceof Map ? live.buffs.get(buffId) : live?.buffs?.[buffId];
        if (buff === null || buff === undefined) return 0;
        return state.virtualTime < buff.expiresAtMs ? buff.stacks : 0;
      },
      hasBuff(entity, buffId) {
        return this.buffStacks(entity, buffId) > 0;
      },
      removeBuff({ targetId, buffId }) {
        const target = findEntity(state, targetId);
        if (target !== null) target.buffs.delete(buffId);
      },
      log(message) {
        registry.call(COMBAT_LOG, String(message));
      },
      sound(soundId) {
        registry.call(AUDIO_PLAY, { soundId });
      },
      query(selector) {
        return registry.call(STATE_QUERY, selector);
      },
    };
  }

  /**
   * 单次逻辑步（规格 7.2）。固定推进 STEP_MS。
   *
   * 时序：前置钩子 → oGCD/GCD 调度 → 后置钩子 → 过期 Buff 清理 → 终止判定
   *
   * 注意步骤顺序与规格 7.2 的差异：规格步骤 5 的"统一衰减"在裁决 1 下不再需要
   * （到期时间戳无需递减），退化为纯粹的 Map 体积控制，不影响逻辑结果。
   */
  step() {
    const state = this.#store.unsafeGetState();
    if (state.status !== GAME_STATUS.BATTLING) return false;

    const context = this.#buildContext();
    const skills = this.#pool.skills;
    const rng = this.getRng();

    for (const hook of this.#hooks.before) hook(context, state);

    const player = state.player;
    const monsters = state.monsters;

    // 行动顺序：玩家先、怪物按数组序。固定顺序是确定性的一部分
    let anyAction = false;
    if (isAlive(player)) {
      const acted = stepEntity(player, {
        skills,
        virtualTime: state.virtualTime,
        context,
        allies: [player],
        enemies: monsters,
        rng,
      });
      if (acted !== 'idle') anyAction = true;
    }

    for (const monster of monsters) {
      if (!isAlive(monster)) continue;
      const acted = stepEntity(monster, {
        skills,
        virtualTime: state.virtualTime,
        context,
        allies: monsters,
        enemies: [player],
        rng,
      });
      if (acted !== 'idle') anyAction = true;
    }

    for (const hook of this.#hooks.after) hook(context, state);

    if (!anyAction) state.metadata.emptyLoops += 1;

    pruneExpiredBuffs(player, state.virtualTime);
    for (const monster of monsters) pruneExpiredBuffs(monster, state.virtualTime);

    state.virtualTime += STEP_MS;

    const outcome = evaluateOutcome(state);
    if (outcome.finished) {
      applyOutcome(state, outcome);
      this.#playOutcomeSound(outcome);
      this.#store.notify();
      return false;
    }

    return true;
  }

  /**
   * 暂停 = 不再推进 virtualTime（而不是"推进但不结算"，后者会破坏确定性）。
   * 状态写进 GAME_STATUS.PAUSED，这样 UI 与存档看到的就是同一个真相。
   */
  pause() {
    const state = this.#store.unsafeGetState();
    if (state.status !== GAME_STATUS.BATTLING) return { ok: false, reason: 'notBattling' };
    this.#store.update((draft) => {
      draft.status = GAME_STATUS.PAUSED;
    });
    return { ok: true };
  }

  /** 恢复战斗。只在 PAUSED 下有效，绝不把已结束的战斗"救活"。 */
  resume() {
    const state = this.#store.unsafeGetState();
    if (state.status !== GAME_STATUS.PAUSED) return { ok: false, reason: 'notPaused' };
    this.#store.update((draft) => {
      draft.status = GAME_STATUS.BATTLING;
    });
    return { ok: true };
  }

  togglePause() {
    return this.#store.unsafeGetState().status === GAME_STATUS.PAUSED ? this.resume() : this.pause();
  }

  /** 是否处于「一场未完战斗被暂停」的状态。 */
  isPaused() {
    return this.#store.unsafeGetState().status === GAME_STATUS.PAUSED;
  }

  /** 1x / 4x：按倍率跑 N 个 16ms 逻辑步。 */
  runFrame(speed) {
    const stepMs = SPEED_STEP_MS[speed];
    if (stepMs === undefined) {
      throw new FateError(`runFrame 不支持速度模式 ${String(speed)}`, { code: 'BAD_SPEED' });
    }
    const stepCount = stepMs / STEP_MS;
    let running = true;
    for (let i = 0; i < stepCount && running; i += 1) {
      running = this.step();
    }
    this.#store.notify();
    return running;
  }

  /**
   * MAX：同步跑到结束。
   * 双重保护：虚拟时间上限（BATTLE_TIMEOUT_MS）+ 步数上限，防止契约实现异常死循环。
   * 全程静音（裁决 8）：几十毫秒内上千次伤害事件，逐事件放音会卡死音频线程。
   */
  runToEnd() {
    const previousSink = this.#audioSink;
    this.#audioSink = this.#silentSink;

    try {
      let steps = 0;
      while (this.step()) {
        steps += 1;
        if (steps > MAX_MODE_STEP_LIMIT) {
          throw new FateError('MAX 模式超过步数上限，疑似契约实现死循环', {
            code: 'MAX_MODE_RUNAWAY',
            details: { steps, virtualTime: this.#store.unsafeGetState().virtualTime },
          });
        }
      }
    } finally {
      this.#audioSink = previousSink;
    }

    // 结算音在恢复 sink 后播放
    const state = this.#store.unsafeGetState();
    this.#playOutcomeSound({ winner: state.winner, reason: state.battleEndReason });
    this.#store.notify();
    return state.winner;
  }

  #playOutcomeSound(outcome) {
    const sink = this.#audioSink;
    if (sink === null || sink === undefined) return;
    try {
      sink.play(outcome.winner === 'player' ? 'battle.victory' : 'battle.defeat', {});
    } catch {
      // 音频永不影响逻辑
    }
  }

  get timeoutMs() {
    return BATTLE_TIMEOUT_MS;
  }

  static get speedModes() {
    return SPEED_MODES;
  }
}
