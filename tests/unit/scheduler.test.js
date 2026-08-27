/**
 * 战斗调度单测（scheduler.js）。
 *
 * 为什么单独测：oGCD 抢占与平局打破是确定性里最精细的一块，此前只被整场战斗
 * 测试间接覆盖 —— 一旦有人把排序键改成「Map 迭代顺序」，整场测试可能仍然绿，
 * 直到某个种子某个倍速下才分叉。这里把裁决 3 与平局规则逐条钉住。
 *
 * 技能用手工构造的最小对象，不依赖内容池：测的是调度，不是数值。
 */

import { describe, expect, it } from 'vitest';
import {
  resolveTargets,
  selectOgcd,
  stepEntity,
} from '../../src/core/battle/scheduler.js';
import { createEntity } from '../../src/core/entity.js';
import { SKILL_RANGE, SKILL_TYPE, STEP_MS } from '../../src/core/constants.js';
import { mulberry32 } from '../../src/core/prng.js';

/** 本步做过什么的记录器。 */
/** 记录每次 execute 的调用（技能名、施放者、目标），用于断言「到底放了什么」。 */
function createSpy() {
  const casts = [];
  return {
    casts,
    handler: (id) => (context, self, targets) => {
      casts.push({ id, by: self.id, targets: targets.map((t) => t.id) });
    },
  };
}

function gcdSkill(id, { cost = 1600, range = SKILL_RANGE.SINGLE, condition = null, onCast } = {}) {
  return {
    id,
    type: SKILL_TYPE.GCD,
    range,
    power: 1,
    tags: [],
    gcdCostMs: cost,
    cooldownMs: 0,
    condition,
    execute: onCast ?? (() => {}),
  };
}

function ogcdSkill(id, { cooldown = 8000, priority = 0, condition = null, range = SKILL_RANGE.SINGLE, onCast } = {}) {
  return {
    id,
    type: SKILL_TYPE.OGCD,
    range,
    power: 1,
    tags: [],
    gcdCostMs: 0,
    cooldownMs: cooldown,
    priority,
    condition,
    execute: onCast ?? (() => {}),
  };
}

const alwaysTrue = () => true;
const alwaysFalse = () => false;

function makeEntity(overrides = {}) {
  return createEntity({
    id: 'p',
    name: '测试者',
    maxHp: 1000,
    attack: 10,
    defense: 0,
    ...overrides,
  });
}

function enemies(...specs) {
  return specs.map((s, i) => createEntity({ id: `e${i}`, name: `敌${i}`, maxHp: 100, attack: 1, defense: 0, ...s }));
}

describe('selectOgcd：抢占选择', () => {
  it('没有槽位或技能未登记时不选', () => {
    const entity = makeEntity();
    const ctx = { skills: new Map(), virtualTime: 0, context: {}, targets: [] };
    expect(selectOgcd(entity, ctx)).toBeNull();

    entity.ogcdSlots = [{ skillId: 'nope', priority: 10, slotIndex: 0 }];
    expect(selectOgcd(entity, ctx)).toBeNull();
  });

  it('冷却未转完的不参与（绝对时间戳比较，不递减）', () => {
    const a = ogcdSkill('a', { cooldown: 8000 });
    const skills = new Map([[a.id, a]]);
    const entity = makeEntity({ ogcdSlots: [{ skillId: 'a', priority: 10, slotIndex: 0 }] });
    entity.ogcdReadyAtMs.set('a', 8000);

    expect(selectOgcd(entity, { skills, virtualTime: 7984, context: {}, targets: [] })).toBeNull();
    expect(selectOgcd(entity, { skills, virtualTime: 8000, context: {}, targets: [] }).skill.id).toBe('a');
  });

  it('condition 为假的不参与', () => {
    const locked = ogcdSkill('locked', { condition: alwaysFalse });
    const open = ogcdSkill('open', { condition: alwaysTrue, priority: 99 });
    const skills = new Map([
      [locked.id, locked],
      [open.id, open],
    ]);
    const entity = makeEntity({
      ogcdSlots: [
        { skillId: 'locked', priority: 100, slotIndex: 0 },
        { skillId: 'open', priority: 1, slotIndex: 1 },
      ],
    });

    expect(selectOgcd(entity, { skills, virtualTime: 0, context: {}, targets: [] }).skill.id).toBe('open');
  });

  it('槽位优先级压过技能自带优先级（玩家的排序意图优先）', () => {
    const hi = ogcdSkill('hi', { priority: 90 });
    const lo = ogcdSkill('lo', { priority: 5 });
    const skills = new Map([
      [hi.id, hi],
      [lo.id, lo],
    ]);
    const entity = makeEntity({
      ogcdSlots: [
        { skillId: 'hi', priority: 1, slotIndex: 0 },
        { skillId: 'lo', priority: 80, slotIndex: 1 },
      ],
    });

    expect(selectOgcd(entity, { skills, virtualTime: 0, context: {}, targets: [] }).skill.id).toBe('lo');
  });

  it('优先级全等时按 skillId 字典序，且与 Map/槽位插入顺序无关', () => {
    const build = (order) => {
      const list = ['zeal', 'abc', 'mid'].map((id) => ogcdSkill(id, { priority: 10 }));
      const skills = new Map();
      for (const skill of order === 'forward' ? list : list.reverse()) skills.set(skill.id, skill);
      const entity = makeEntity({
        ogcdSlots: ['zeal', 'abc', 'mid']
          .filter((id) => order === 'forward' || id !== 'mid')
          .concat(order === 'forward' ? [] : ['mid'])
          .map((skillId, slotIndex) => ({ skillId, priority: 10, slotIndex })),
      });
      return selectOgcd(entity, { skills, virtualTime: 0, context: {}, targets: [] }).skill.id;
    };

    expect(build('forward')).toBe('abc');
    expect(build('reverse')).toBe('abc');
  });

  it('槽位优先级为 0 时回落到技能自带优先级', () => {
    const strong = ogcdSkill('strong', { priority: 70 });
    const weak = ogcdSkill('weak', { priority: 3 });
    const skills = new Map([
      [weak.id, weak],
      [strong.id, strong],
    ]);
    const entity = makeEntity({
      ogcdSlots: [
        { skillId: 'weak', priority: 0, slotIndex: 0 },
        { skillId: 'strong', priority: 0, slotIndex: 1 },
      ],
    });

    expect(selectOgcd(entity, { skills, virtualTime: 0, context: {}, targets: [] }).skill.id).toBe('strong');
  });
});

describe('resolveTargets：目标解析', () => {
  const base = () => {
    const self = makeEntity({ id: 'p' });
    const foes = enemies({}, {}, {});
    return { self, allies: [self], enemies: foes, rng: mulberry32(7) };
  };

  it('self / allEnemies / allAllies / single 各自正确', () => {
    const { self, allies, enemies: foes, rng } = base();
    const resolve = (range) => resolveTargets({ range }, self, { allies, enemies: foes, rng }).map((e) => e.id);

    expect(resolve(SKILL_RANGE.SELF)).toEqual(['p']);
    expect(resolve(SKILL_RANGE.ALL_ENEMIES)).toEqual(['e0', 'e1', 'e2']);
    expect(resolve(SKILL_RANGE.ALL_ALLIES)).toEqual(['p']);
    expect(resolve(SKILL_RANGE.SINGLE)).toEqual(['e0']);
    // 未知 range 回退到单体默认，不抛错
    expect(resolve('nonsense')).toEqual(['e0']);
  });

  it('死人不当目标', () => {
    const { self, allies, enemies: foes, rng } = base();
    foes[0].hp = 0;
    allies[0].hp = 0;
    expect(resolveTargets({ range: SKILL_RANGE.ALL_ENEMIES }, self, { allies, enemies: foes, rng }).map((e) => e.id)).toEqual(['e1', 'e2']);
    expect(resolveTargets({ range: SKILL_RANGE.ALL_ALLIES }, self, { allies, enemies: foes, rng })).toEqual([]);
  });

  it('randomEnemy 同种子同流必得同一目标，且确实消费随机数', () => {
    const { self, allies, enemies: foes } = base();
    const pick = (seed) =>
      resolveTargets({ range: SKILL_RANGE.RANDOM_ENEMY }, self, {
        allies,
        enemies: foes,
        rng: mulberry32(seed),
      })[0].id;

    expect(pick(42)).toBe(pick(42));
    const spread = new Set([1, 2, 3, 4, 5, 6, 7, 8].map(pick));
    expect(spread.size).toBeGreaterThan(1);
    expect([...spread].every((id) => ['e0', 'e1', 'e2'].includes(id))).toBe(true);
  });

  it('没有存活敌人时一律返回空数组，而不是 [undefined]', () => {
    const self = makeEntity({ id: 'p' });
    const dead = enemies({ hp: 0 });
    for (const range of Object.values(SKILL_RANGE)) {
      if (range === SKILL_RANGE.SELF || range === SKILL_RANGE.ALL_ALLIES) continue;
      expect(resolveTargets({ range }, self, { allies: [self], enemies: dead, rng: mulberry32(1) })).toEqual([]);
    }
  });
});

describe('stepEntity：每实体每步至多一个 oGCD（裁决 3）', () => {
  it('oGCD 命中时本步不再推进 GCD，但写入冷却与施放计数', () => {
    const skills = new Map([
      ['g.slash', gcdSkill('g.slash', { cost: 1600 })],
      ['o.burst', ogcdSkill('o.burst', { cooldown: 8000 })],
    ]);
    const player = makeEntity({
      gcdSequence: ['g.slash'],
      ogcdSlots: [{ skillId: 'o.burst', priority: 50, slotIndex: 0 }],
    });
    const args = { skills, context: {}, allies: [player], enemies: enemies({}), rng: mulberry32(1) };

    expect(stepEntity(player, { ...args, virtualTime: 0 })).toBe('ogcd');
    expect(player.gcdIndex).toBe(0); // GCD 指针没动
    expect(player.gcdReadyAtMs).toBe(0); // 也没被消耗
    expect(player.ogcdReadyAtMs.get('o.burst')).toBe(8000);
    expect(player.stats.skillsCast).toBe(1);

    // 下一帧冷却未好，于是才轮到 GCD
    expect(stepEntity(player, { ...args, virtualTime: STEP_MS })).toBe('gcd');
    expect(player.gcdReadyAtMs).toBe(STEP_MS + 1600);
    expect(player.stats.skillsCast).toBe(2);
  });


  it('抢占作用域是「每实体每步」而不是「全局每步一个」', () => {
    const mk = (id) =>
      makeEntity({
        id,
        ogcdSlots: [{ skillId: 'o.hit', priority: 50, slotIndex: 0 }],
      });
    const spy = createSpy();
    const skills = new Map([['o.hit', ogcdSkill('o.hit', { cooldown: 4000, onCast: spy.handler('o.hit') })]]);
    const a = mk('a');
    const b = mk('b');
    const args = (allies, self) => ({
      skills,
      virtualTime: 0,
      context: {},
      allies,
      enemies: enemies({}),
      rng: mulberry32(3),
      self,
    });

    expect(stepEntity(a, args([a, b], a))).toBe('ogcd');
    expect(stepEntity(b, args([a, b], b))).toBe('ogcd');
    expect(spy.casts.map((c) => c.by)).toEqual(['a', 'b']);
  });

  it('死亡实体直接 idle，不做任何事', () => {
    const spy = createSpy();
    const dead = makeEntity({ id: 'p', hp: 0, gcdSequence: ['g.a'], ogcdSlots: [{ skillId: 'o.a', priority: 1, slotIndex: 0 }] });
    const skills = new Map([
      ['g.a', gcdSkill('g.a', { onCast: spy.handler('g.a') })],
      ['o.a', ogcdSkill('o.a', { onCast: spy.handler('o.a') })],
    ]);

    expect(
      stepEntity(dead, { skills, virtualTime: 0, context: {}, allies: [dead], enemies: enemies({}), rng: mulberry32(1) }),
    ).toBe('idle');
    expect(spy.casts).toEqual([]);
    expect(dead.gcdIndex).toBe(0);
  });

  it('GCD 未就绪时 idle；就绪时按 gcdCostMs 写入绝对到期时刻', () => {
    const skills = new Map([['g.a', gcdSkill('g.a', { cost: 3200 })]]);
    const player = makeEntity({ gcdSequence: ['g.a'] });
    const step = (virtualTime) =>
      stepEntity(player, { skills, virtualTime, context: {}, allies: [player], enemies: enemies({}), rng: mulberry32(1) });

    expect(step(0)).toBe('gcd');
    expect(player.gcdReadyAtMs).toBe(3200);
    expect(step(3184)).toBe('idle');
    expect(step(3200)).toBe('gcd');
    expect(player.gcdReadyAtMs).toBe(6400);
  });

  it('序列是循环队列：走完一圈回到起点', () => {
    const spy = createSpy();
    const skills = new Map([
      ['g.a', gcdSkill('g.a', { cost: 1600, onCast: spy.handler('g.a') })],
      ['g.b', gcdSkill('g.b', { cost: 1600, onCast: spy.handler('g.b') })],
    ]);
    const player = makeEntity({ gcdSequence: ['g.a', 'g.b'] });
    const args = { skills, context: {}, allies: [player], enemies: enemies({}), rng: mulberry32(1) };

    let t = 0;
    const actions = [];
    for (let i = 0; i < 4; i += 1) {
      actions.push(stepEntity(player, { ...args, virtualTime: t }));
      t = player.gcdReadyAtMs;
    }
    expect(actions).toEqual(['gcd', 'gcd', 'gcd', 'gcd']);
    expect(spy.casts.map((c) => c.id)).toEqual(['g.a', 'g.b', 'g.a', 'g.b']);
  });

  it('条件不满足时只推进指针、本步不行动（下一技能因此更早被尝试）', () => {
    const spy = createSpy();
    const skills = new Map([
      ['g.locked', gcdSkill('g.locked', { condition: alwaysFalse, onCast: spy.handler('g.locked') })],
      ['g.open', gcdSkill('g.open', { condition: alwaysTrue, onCast: spy.handler('g.open') })],
    ]);
    const player = makeEntity({ gcdSequence: ['g.locked', 'g.open'] });
    const args = { skills, context: {}, allies: [player], enemies: enemies({}), rng: mulberry32(1) };

    expect(stepEntity(player, { ...args, virtualTime: 0 })).toBe('idle');
    expect(player.gcdIndex).toBe(1);
    expect(spy.casts).toEqual([]);

    expect(stepEntity(player, { ...args, virtualTime: 0 })).toBe('gcd');
    expect(spy.casts.map((c) => c.id)).toEqual(['g.open']);
  });

  it('悬空技能 ID 会推进指针而不是卡死（模组被卸载时的兜底）', () => {
    const skills = new Map([['g.real', gcdSkill('g.real', {})]]);
    const player = makeEntity({ gcdSequence: ['g.missing', 'g.real'] });
    const args = { skills, context: {}, allies: [player], enemies: enemies({}), rng: mulberry32(1) };

    expect(stepEntity(player, { ...args, virtualTime: 0 })).toBe('idle');
    expect(player.gcdIndex).toBe(1);
    expect(stepEntity(player, { ...args, virtualTime: 0 })).toBe('gcd');
  });

  it('空序列与空技能库时永远 idle，不抛错', () => {
    const player = makeEntity({ gcdSequence: [] });
    expect(
      stepEntity(player, { skills: new Map(), virtualTime: 0, context: {}, allies: [player], enemies: [], rng: mulberry32(1) }),
    ).toBe('idle');
  });
});
