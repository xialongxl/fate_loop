/**
 * 阶段 2 验收：契约层与注册表。
 *
 * 重点验证「模组可覆盖任意契约」这一自举原则，以及 audio.play 与确定性的隔离。
 */

import { describe, expect, it } from 'vitest';
import { Registry, registerDefaultContracts } from '../../src/contracts/index.js';
import {
  AUDIO_PLAY,
  BUFF_APPLY,
  COMBAT_LOG,
  CONTRACT_MAP,
  CORE_CONTRACTS,
  DAMAGE_APPLY,
  HEAL_APPLY,
  PRNG_NEXT,
  STATE_QUERY,
  contractName,
} from '../../src/contracts/symbols.js';
import { Store } from '../../src/core/store.js';
import { createInitialState } from '../../src/core/initialState.js';
import { createEntity } from '../../src/core/entity.js';
import { LOG_CAPACITY } from '../../src/core/constants.js';

/** 最小可用装配：不加载模组，只要契约能跑。 */
function makeFixture({ buffTable, rngValues = [0.5], sink } = {}) {
  const store = new Store(createInitialState(42));
  let cursor = 0;
  const rng = { next: () => rngValues[cursor++ % rngValues.length] };

  const played = [];
  const registry = registerDefaultContracts({
    store,
    getRng: () => rng,
    getBuffTable: () => buffTable,
    getAudioSink: () => sink ?? { play: (id, opts) => played.push({ id, opts }) },
  });

  store.update((draft) => {
    draft.monsters = [
      createEntity({ id: 'target#0', name: '靶子', maxHp: 1000, attack: 50, defense: 0 }),
    ];
  });

  return {
    store,
    registry,
    played,
    target: () => store.unsafeGetState().monsters[0],
    player: () => store.unsafeGetState().player,
    /** Buff 修正读的是 store 里的 virtualTime，不是调用参数 */
    setTime: (t) => store.updateSilent((d) => {
      d.virtualTime = t;
    }),
  };
}

describe('契约 Symbol 定义', () => {
  it('7 个契约全部就位且用 Symbol.for 注册（跨模块实例可共享）', () => {
    expect(CORE_CONTRACTS).toHaveLength(7);
    for (const symbol of CORE_CONTRACTS) {
      expect(typeof symbol).toBe('symbol');
      // Symbol.for 的符号可被 keyFor 反查；Symbol() 不能。模组以独立 ESM
      // 加载时可能拿到另一份 symbols.js，全局符号表是唯一的共享保证
      expect(Symbol.keyFor(symbol)).toBeTypeOf('string');
    }
  });

  it('契约名以 fate.contract. 前缀命名，无重复', () => {
    const names = CORE_CONTRACTS.map(contractName);
    expect(new Set(names).size).toBe(7);
    for (const name of names) {
      expect(name.startsWith('fate.contract.')).toBe(true);
    }
  });

  it('CONTRACT_MAP 覆盖全部 7 个契约，供模组声明覆盖', () => {
    expect(Object.keys(CONTRACT_MAP)).toHaveLength(7);
    expect(CONTRACT_MAP.damageApply).toBe(DAMAGE_APPLY);
    expect(CONTRACT_MAP.healApply).toBe(HEAL_APPLY);
    expect(CONTRACT_MAP.prngNext).toBe(PRNG_NEXT);
    expect(CONTRACT_MAP.audioPlay).toBe(AUDIO_PLAY);
    expect(new Set(Object.values(CONTRACT_MAP))).toEqual(new Set(CORE_CONTRACTS));
  });
});

describe('Registry 覆盖语义', () => {
  it('后注册覆盖先注册，并记录被覆盖者', () => {
    const reg = new Registry();
    reg.register(DAMAGE_APPLY, () => 1, { source: 'core' });
    reg.register(DAMAGE_APPLY, () => 2, { source: 'mod.a' });

    expect(reg.get(DAMAGE_APPLY)()).toBe(2);
    expect(reg.overrideHistory().at(-1)).toMatchObject({ source: 'mod.a', overrode: 'core' });
  });

  it('未注册的契约抛出 UnknownContractError 且信息含契约名', () => {
    const reg = new Registry();
    expect(reg.has(HEAL_APPLY)).toBe(false);
    expect(() => reg.get(HEAL_APPLY)).toThrow(/heal\.apply/);
  });

  it('拒绝非 Symbol 标识与非函数实现', () => {
    const reg = new Registry();
    expect(() => reg.register('damage', () => {})).toThrow(/必须是 Symbol/);
    expect(() => reg.register(DAMAGE_APPLY, { apply() {} })).toThrow(/必须是函数/);
  });

  it('describe() 按契约名排序，输出稳定', () => {
    const { registry } = makeFixture();
    const keys = registry.describe().map((d) => d.key);
    expect(keys).toEqual([...keys].sort());
    expect(keys).toHaveLength(7);
  });

  it('registerDefaultContracts 注册齐全部 7 项', () => {
    const { registry } = makeFixture();
    for (const symbol of CORE_CONTRACTS) {
      expect(registry.has(symbol), contractName(symbol)).toBe(true);
    }
  });

  it('clear() 清空实现与历史', () => {
    const { registry } = makeFixture();
    registry.clear();
    expect(registry.describe()).toHaveLength(0);
    expect(registry.overrideHistory()).toHaveLength(0);
  });
});

describe('damage.apply 默认实现', () => {
  it('防御按 100/(100+def) 递减收益减伤', () => {
    const { registry, target } = makeFixture({ rngValues: [0.99] }); // 不暴击
    const damage = registry.get(DAMAGE_APPLY);

    damage({ sourceId: 'player', targetId: 'target#0', amount: 100 });
    expect(target().hp).toBe(900); // defense 0 → 无减伤

    target().defense = 100;
    damage({ sourceId: 'player', targetId: 'target#0', amount: 100 });
    expect(target().hp).toBe(850); // 100 * 100/200 = 50
  });

  it('伤害下限为 1 点，且 HP 不会降到负数', () => {
    const { registry, target } = makeFixture({ rngValues: [0.99] });
    const damage = registry.get(DAMAGE_APPLY);

    damage({ sourceId: 'player', targetId: 'target#0', amount: 0 });
    expect(target().hp).toBe(999);

    damage({ sourceId: 'player', targetId: 'target#0', amount: 99999 });
    expect(target().hp).toBe(0);
  });

  it('暴击按 1.5 倍结算', () => {
    const { registry, target } = makeFixture({ rngValues: [0] }); // 必暴击
    const result = registry.get(DAMAGE_APPLY)({
      sourceId: 'player',
      targetId: 'target#0',
      amount: 100,
    });
    expect(result.isCrit).toBe(true);
    expect(result.dealt).toBe(150);
    expect(target().hp).toBe(850);
  });

  it('canCrit 为 false 时不消费随机数（消费时机必须由输入完全决定）', () => {
    const { registry } = makeFixture({ rngValues: [0, 0.99] });
    const damage = registry.get(DAMAGE_APPLY);

    // 若 canCrit:false 仍消费随机数，这一发会吃掉 0，下一发就读到 0.99 而不暴击
    damage({ sourceId: 'player', targetId: 'target#0', amount: 10, canCrit: false });
    const second = damage({ sourceId: 'player', targetId: 'target#0', amount: 10 });
    expect(second.isCrit).toBe(true);
  });

  it('已死亡目标不受击也不消费随机数', () => {
    const { registry, target } = makeFixture({ rngValues: [0] });
    target().hp = 0;

    const dead = registry.get(DAMAGE_APPLY)({
      sourceId: 'player',
      targetId: 'target#0',
      amount: 100,
    });
    expect(dead).toEqual({ dealt: 0, isCrit: false, targetHp: 0, lethal: false });

    // 随机流未被推进：复活后第一发仍读到 0（暴击）
    target().hp = 1000;
    expect(registry.get(DAMAGE_APPLY)({ sourceId: 'p', targetId: 'target#0', amount: 100 }).isCrit).toBe(true);
  });

  it('攻击方 damageDealtMul 与受击方 damageTakenMul 都生效', () => {
    const buffTable = new Map([
      ['buff.charged', { id: 'buff.charged', damageDealtMul: 2 }],
      ['debuff.burning', { id: 'debuff.burning', damageTakenMul: 1.5 }],
    ]);
    const { registry, target, player } = makeFixture({ buffTable, rngValues: [0.99] });

    player().buffs.set('buff.charged', { stacks: 1, expiresAtMs: 99999 });
    target().buffs.set('debuff.burning', { stacks: 1, expiresAtMs: 99999 });

    // 100 * 2（dealt）* 1（无防御）* 1.5（taken）= 300
    const result = registry.get(DAMAGE_APPLY)({
      sourceId: 'player',
      targetId: 'target#0',
      amount: 100,
    });
    expect(result.dealt).toBe(300);
  });

  it('多层 Buff 线性叠加而非指数叠加', () => {
    const buffTable = new Map([['buff.charged', { id: 'buff.charged', damageDealtMul: 1.1 }]]);
    const { registry, player } = makeFixture({ buffTable, rngValues: [0.99] });

    player().buffs.set('buff.charged', { stacks: 3, expiresAtMs: 99999 });
    // 1 + 0.1*3 = 1.3 倍（而非 1.1^3 = 1.331）
    const result = registry.get(DAMAGE_APPLY)({ sourceId: 'player', targetId: 'target#0', amount: 100 });
    expect(result.dealt).toBe(130);
  });

  it('已过期的 Buff 不产生任何修正', () => {
    const buffTable = new Map([['buff.charged', { id: 'buff.charged', damageDealtMul: 5 }]]);
    const { registry, player, setTime } = makeFixture({ buffTable, rngValues: [0.99] });

    player().buffs.set('buff.charged', { stacks: 1, expiresAtMs: 1000 });
    setTime(2000);
    const result = registry.get(DAMAGE_APPLY)({ sourceId: 'player', targetId: 'target#0', amount: 100 });
    expect(result.dealt).toBe(100);
  });

  it('buffTable 中不存在的 buffId 被静默忽略（不抛错）', () => {
    const { registry, player } = makeFixture({ buffTable: new Map(), rngValues: [0.99] });
    player().buffs.set('buff.ghost', { stacks: 3, expiresAtMs: 99999 });
    expect(() =>
      registry.get(DAMAGE_APPLY)({ sourceId: 'player', targetId: 'target#0', amount: 100 }),
    ).not.toThrow();
  });

  it('统计写入 metadata 与双方 stats，且击杀标记正确', () => {
    const { registry, store, target, player } = makeFixture({ rngValues: [0.99] });
    registry.get(DAMAGE_APPLY)({ sourceId: 'player', targetId: 'target#0', amount: 100 });

    expect(store.unsafeGetState().metadata.totalDamage).toBe(100);
    expect(player().stats.damageDealt).toBe(100);
    expect(target().stats.damageTaken).toBe(100);

    const killing = registry.get(DAMAGE_APPLY)({
      sourceId: 'player',
      targetId: 'target#0',
      amount: 99999,
    });
    expect(killing.lethal).toBe(true);
    // 溢出伤害不计入统计：实际只扣了剩余的 900
    expect(store.unsafeGetState().metadata.totalDamage).toBe(1000);
  });

  it('非法 amount 与不存在的目标都抛 ContractViolationError', () => {
    const { registry } = makeFixture();
    const damage = registry.get(DAMAGE_APPLY);
    expect(() => damage({ sourceId: 'p', targetId: 'target#0', amount: NaN })).toThrow(/必须是有限数/);
    expect(() => damage({ sourceId: 'p', targetId: '不存在', amount: 1 })).toThrow(/找不到目标实体/);
  });
});

describe('heal.apply 默认实现', () => {
  it('治疗不超过最大 HP，溢出部分不计入统计', () => {
    const { registry, store, target } = makeFixture();
    target().hp = 990;
    const result = registry.get(HEAL_APPLY)({ sourceId: 'player', targetId: 'target#0', amount: 100 });

    expect(target().hp).toBe(1000);
    expect(result.healed).toBe(10);
    expect(store.unsafeGetState().metadata.totalHeal).toBe(10);
  });

  it('healMul 修正生效', () => {
    const buffTable = new Map([['buff.blessed', { id: 'buff.blessed', healMul: 2 }]]);
    const { registry, target } = makeFixture({ buffTable });
    target().hp = 500;
    target().buffs.set('buff.blessed', { stacks: 1, expiresAtMs: 99999 });

    registry.get(HEAL_APPLY)({ sourceId: 'player', targetId: 'target#0', amount: 100 });
    expect(target().hp).toBe(700);
  });

  it('对已死亡实体治疗无效（死亡不可逆）', () => {
    const { registry, target } = makeFixture();
    target().hp = 0;
    expect(registry.get(HEAL_APPLY)({ sourceId: 'p', targetId: 'target#0', amount: 500 })).toEqual({
      healed: 0,
      targetHp: 0,
    });
  });

  it('负数治疗量被拒绝（不得用治疗当伤害后门）', () => {
    const { registry } = makeFixture();
    expect(() =>
      registry.get(HEAL_APPLY)({ sourceId: 'p', targetId: 'target#0', amount: -100 }),
    ).toThrow(/非负有限数/);
  });
});

describe('buff.apply 默认实现（裁决 1）', () => {
  it('首次施加写入层数与绝对到期时间戳', () => {
    const { registry, target, setTime } = makeFixture();
    setTime(1008);
    registry.get(BUFF_APPLY)({ targetId: 'target#0', buffId: 'buff.x', stacks: 2, durationMs: 8000 });
    expect(target().buffs.get('buff.x')).toEqual({ stacks: 2, expiresAtMs: 9008 });
  });

  it('重复施加叠加层数并按新时长刷新到期时间', () => {
    const { registry, target, setTime } = makeFixture();
    const apply = registry.get(BUFF_APPLY);

    apply({ targetId: 'target#0', buffId: 'buff.x', durationMs: 10000 });
    setTime(1600);
    apply({ targetId: 'target#0', buffId: 'buff.x', durationMs: 10000 });

    // 层数累加，到期时间以最后一次施加为基准（刷新语义）
    expect(target().buffs.get('buff.x')).toEqual({ stacks: 2, expiresAtMs: 11600 });
  });

  it('已过期的同名 Buff 重新施加时层数从零起算', () => {
    const { registry, target, setTime } = makeFixture();
    const apply = registry.get(BUFF_APPLY);

    apply({ targetId: 'target#0', buffId: 'buff.x', stacks: 5, durationMs: 1600 });
    setTime(3200); // 已过期
    apply({ targetId: 'target#0', buffId: 'buff.x', stacks: 1, durationMs: 1600 });

    expect(target().buffs.get('buff.x').stacks).toBe(1);
  });

  it('maxStacks 封顶', () => {
    const { registry, target } = makeFixture();
    const apply = registry.get(BUFF_APPLY);
    for (let i = 0; i < 10; i += 1) {
      apply({ targetId: 'target#0', buffId: 'buff.x', durationMs: 16000, maxStacks: 3 });
    }
    expect(target().buffs.get('buff.x').stacks).toBe(3);
  });

  it('非 16ms 整数倍的时长被拒绝（裁决 4 的运行时防线）', () => {
    const { registry } = makeFixture();
    expect(() =>
      registry.get(BUFF_APPLY)({ targetId: 'target#0', buffId: 'buff.x', durationMs: 1000 }),
    ).toThrow(/整数倍/);
  });

  it('空 buffId 被拒绝', () => {
    const { registry } = makeFixture();
    expect(() => registry.get(BUFF_APPLY)({ targetId: 'target#0', buffId: '', durationMs: 16 })).toThrow(
      /非空 buffId/,
    );
  });
});

describe('combat.log 默认实现', () => {
  it('日志带虚拟时间戳，超过容量自动裁剪最旧', () => {
    const { registry, store, setTime } = makeFixture();
    const log = registry.get(COMBAT_LOG);
    const total = LOG_CAPACITY + 20;

    for (let i = 0; i < total; i += 1) {
      setTime(i * 16);
      log(`事件 ${i}`);
    }

    const entries = store.unsafeGetState().log;
    expect(entries).toHaveLength(LOG_CAPACITY);
    expect(entries.at(-1)).toEqual({ t: (total - 1) * 16, message: `事件 ${total - 1}` });
    expect(entries[0].message).toBe('事件 20');
  });
});

describe('prng.next 与 state.query', () => {
  it('prng.next 透传当前活动流', () => {
    const { registry } = makeFixture({ rngValues: [0.25, 0.75] });
    const next = registry.get(PRNG_NEXT);
    expect(next()).toBe(0.25);
    expect(next()).toBe(0.75);
  });

  it('无选择器时返回全状态只读快照，模组无法篡改', () => {
    const { registry, store } = makeFixture();
    const view = registry.get(STATE_QUERY)();

    expect(view.floorNumber).toBe(store.unsafeGetState().floorNumber);
    expect(Object.isFrozen(view)).toBe(true);
    expect(() => {
      view.floorNumber = 999;
    }).toThrow();
    expect(store.unsafeGetState().floorNumber).not.toBe(999);
  });

  it('支持字符串路径与函数选择器', () => {
    const { registry } = makeFixture();
    const query = registry.get(STATE_QUERY);

    expect(query('player.name')).toBe('序列编织者');
    expect(query('player.不存在.更深')).toBeUndefined();
    expect(query((s) => s.monsters.length)).toBe(1);
  });

  it('非法选择器抛错', () => {
    const { registry } = makeFixture();
    expect(() => registry.get(STATE_QUERY)(123)).toThrow(/选择器必须是/);
  });
});

describe('audio.play 与确定性隔离（裁决 8）', () => {
  it('返回 void 且不消费随机数', () => {
    const { registry, played } = makeFixture({ rngValues: [0.1, 0.2, 0.3] });
    const next = registry.get(PRNG_NEXT);

    const before = next();
    const result = registry.get(AUDIO_PLAY)('ui.click');
    const after = next();

    expect(result).toBeUndefined();
    expect(played).toHaveLength(1);
    // 音频调用夹在两次 next 之间，随机序列不得被打乱
    expect(before).toBe(0.1);
    expect(after).toBe(0.2);
  });

  it('接受字符串或 {soundId} 两种入参形态', () => {
    const { registry, played } = makeFixture();
    const play = registry.get(AUDIO_PLAY);
    play('ui.click');
    play({ soundId: 'battle.hit', volume: 0.5 });

    expect(played.map((p) => p.id)).toEqual(['ui.click', 'battle.hit']);
    expect(played[1].opts).toMatchObject({ volume: 0.5 });
  });

  it('无效 soundId 被静默丢弃', () => {
    const { registry, played } = makeFixture();
    const play = registry.get(AUDIO_PLAY);
    play(undefined);
    play({});
    play('');
    expect(played).toHaveLength(0);
  });

  it('sink 抛错时也不向上传播（音频永不影响逻辑）', () => {
    const { registry } = makeFixture({
      sink: {
        play() {
          throw new Error('音频设备被占用');
        },
      },
    });
    expect(() => registry.get(AUDIO_PLAY)('ui.click')).not.toThrow();
  });

  it('sink 为 null 时静默丢弃（无音频环境可用）', () => {
    const store = new Store(createInitialState(1));
    const registry = registerDefaultContracts({ store, getRng: () => null, getAudioSink: () => null });
    expect(() => registry.get(AUDIO_PLAY)('ui.click')).not.toThrow();
  });
});

describe('契约被模组覆盖后核心走新实现', () => {
  it('覆盖 damage.apply 可完全改写伤害公式', () => {
    const { registry, target } = makeFixture();
    registry.register(
      DAMAGE_APPLY,
      ({ amount }) => {
        target().hp = Math.max(0, target().hp - amount * 10);
        return { dealt: amount * 10, isCrit: false, targetHp: target().hp, lethal: false };
      },
      { source: 'mod.hardcore' },
    );

    const result = registry.call(DAMAGE_APPLY, { sourceId: 'p', targetId: 'target#0', amount: 10 });
    expect(result.dealt).toBe(100);
    expect(target().hp).toBe(900);
    expect(registry.describe().find((d) => d.key.endsWith('damage.apply')).source).toBe('mod.hardcore');
  });

  it('覆盖 prng.next 可注入固定序列（模组做可复现测试的手段）', () => {
    const { registry } = makeFixture({ rngValues: [0.5] });
    registry.register(PRNG_NEXT, () => 0.42, { source: 'mod.test' });
    expect(registry.call(PRNG_NEXT)).toBe(0.42);
  });
});
