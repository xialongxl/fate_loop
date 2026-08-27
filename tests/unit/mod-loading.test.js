/**
 * 阶段 4 验收：模组加载六步法与 normalize。
 *
 * 关键约束：任一模组出错则整体加载失败。部分加载会留下悬空 ID 引用，
 * 排查成本远高于直接失败。
 */

import { describe, expect, it, vi } from 'vitest';
import { loadMods, createContentPool, validatePoolReferences } from '../../src/core/mods/loader.js';
import { applyPriority, topoSort } from '../../src/core/mods/graph.js';
import { validateManifest } from '../../src/core/mods/manifest.js';
import {
  normalizeBuff,
  normalizeEncounter,
  normalizeEvent,
  normalizeMonster,
  normalizeShopItem,
  normalizeSkill,
  toStepAlignedMs,
} from '../../src/core/mods/normalize.js';
import { Registry } from '../../src/contracts/registry.js';
import { SKILL_RANGE, SKILL_TYPE, STEP_MS } from '../../src/core/constants.js';
import { loadOfficialPool, officialModuleEntries } from '../helpers.js';

const SYM_A = Symbol.for('test.contract.a');
const SYM_B = Symbol.for('test.contract.b');
const SYM_C = Symbol.for('test.contract.c');

/** 构造一个测试模组条目。 */
function modEntry({ id, version = '1.0.0', provides = [], requires = [], setup, path }) {
  const dir = path ?? `/src/mods/official/${id}`;
  return {
    path: `${dir}/manifest.js`,
    dir,
    loadManifest: () => Promise.resolve({ default: { id, version, provides, requires } }),
    loadSetup: () => Promise.resolve({ setup: setup ?? (() => ({})) }),
  };
}

/** 最小合法技能。2.496s 而非 2.5s —— 2500 % 16 ≠ 0，会被裁决 4 拒绝。 */
function skillSpec(overrides = {}) {
  return {
    id: 'test.skill',
    name: '测试技能',
    type: SKILL_TYPE.GCD,
    gcdCost: 2.496,
    execute: () => {},
    ...overrides,
  };
}

describe('manifest 校验', () => {
  it('接受最小合法 manifest 并补全默认值', () => {
    const m = validateManifest({ id: 'a', version: '1.0.0' }, '/p/manifest.js');
    expect(m).toEqual({
      id: 'a',
      version: '1.0.0',
      type: 'content',
      provides: [],
      requires: [],
      path: '/p/manifest.js',
    });
  });

  it('拒绝非对象、缺 id、缺 version、非法 type', () => {
    expect(() => validateManifest(null, '/p')).toThrow(/必须默认导出对象/);
    expect(() => validateManifest({ version: '1' }, '/p')).toThrow(/缺少非空 id/);
    expect(() => validateManifest({ id: 'a' }, '/p')).toThrow(/缺少 version/);
    expect(() => validateManifest({ id: 'a', version: '1', type: 'plugin' }, '/p')).toThrow(/type 非法/);
  });

  it('provides / requires 必须是 Symbol 数组', () => {
    expect(() => validateManifest({ id: 'a', version: '1', provides: 'x' }, '/p')).toThrow(/必须是数组/);
    expect(() => validateManifest({ id: 'a', version: '1', requires: ['x'] }, '/p')).toThrow(
      /只能包含 Symbol/,
    );
  });
});

describe('拓扑排序与循环检测', () => {
  const manifest = (id, provides, requires) => ({ id, provides, requires, path: `/src/mods/official/${id}` });

  it('依赖先行', () => {
    const sorted = topoSort([
      manifest('consumer', [], [SYM_A]),
      manifest('provider', [SYM_A], []),
    ]);
    expect(sorted.map((m) => m.id)).toEqual(['provider', 'consumer']);
  });

  it('多层依赖链正确排序', () => {
    const sorted = topoSort([
      manifest('c', [], [SYM_B]),
      manifest('b', [SYM_B], [SYM_A]),
      manifest('a', [SYM_A], []),
    ]);
    expect(sorted.map((m) => m.id)).toEqual(['a', 'b', 'c']);
  });

  it('同层模组按 id 字典序，输出稳定（不依赖输入顺序）', () => {
    const input = [manifest('zeta', [], []), manifest('alpha', [], []), manifest('mid', [], [])];
    expect(topoSort(input).map((m) => m.id)).toEqual(['alpha', 'mid', 'zeta']);
    expect(topoSort([...input].reverse()).map((m) => m.id)).toEqual(['alpha', 'mid', 'zeta']);
  });

  it('循环依赖被检出并报出参与者', () => {
    expect(() =>
      topoSort([manifest('a', [SYM_A], [SYM_B]), manifest('b', [SYM_B], [SYM_A])]),
    ).toThrow(/存在循环/);
  });

  it('无人提供的依赖被检出', () => {
    expect(() => topoSort([manifest('a', [], [SYM_C])])).toThrow(/无人提供/);
  });

  it('同一契约被两个模组 provide 时报错（避免静默覆盖）', () => {
    expect(() => topoSort([manifest('a', [SYM_A], []), manifest('b', [SYM_A], [])])).toThrow(
      /被多个模组 provide/,
    );
  });

  it('自我依赖不构成循环', () => {
    expect(topoSort([manifest('a', [SYM_A], [SYM_A])]).map((m) => m.id)).toEqual(['a']);
  });

  it('applyPriority 把 mods/dev 排到最后但保持内部相对序', () => {
    const sorted = [
      { id: 'official.a', path: '/src/mods/official/a/manifest.js' },
      { id: 'dev.x', path: '/src/mods/dev/x/manifest.js' },
      { id: 'official.b', path: '/src/mods/official/b/manifest.js' },
      { id: 'dev.y', path: '/src/mods/dev/y/manifest.js' },
    ];
    expect(applyPriority(sorted).map((m) => m.id)).toEqual([
      'official.a',
      'official.b',
      'dev.x',
      'dev.y',
    ]);
  });
});

describe('loadMods 六步法', () => {
  it('按拓扑序执行 setup', async () => {
    const order = [];
    await loadMods({
      registry: new Registry(),
      modules: [
        modEntry({
          id: 'consumer',
          requires: [SYM_A],
          setup: () => {
            order.push('consumer');
            return {};
          },
        }),
        modEntry({
          id: 'provider',
          provides: [SYM_A],
          setup: () => {
            order.push('provider');
            return {};
          },
        }),
      ],
    });
    expect(order).toEqual(['provider', 'consumer']);
  });

  it('setup 收到 registry、契约映射与 modId', async () => {
    let received = null;
    await loadMods({
      registry: new Registry(),
      modules: [
        modEntry({
          id: 'probe',
          setup: (ctx) => {
            received = ctx;
            return {};
          },
        }),
      ],
    });
    expect(received.modId).toBe('probe');
    expect(received.registry).toBeInstanceOf(Registry);
    expect(received.contracts.damageApply).toBeTypeOf('symbol');
    expect(received.log).toBeTypeOf('function');
  });

  it('模组 id 重复时拒绝加载', async () => {
    await expect(
      loadMods({
        registry: new Registry(),
        modules: [modEntry({ id: 'dup' }), modEntry({ id: 'dup', path: '/src/mods/official/dup2' })],
      }),
    ).rejects.toThrow(/id 重复/);
  });

  it('setup 抛错时整体失败（不做部分加载）', async () => {
    await expect(
      loadMods({
        registry: new Registry(),
        modules: [
          modEntry({ id: 'good', setup: () => ({ skills: [skillSpec()] }) }),
          modEntry({
            id: 'bad',
            setup: () => {
              throw new Error('模组内部炸了');
            },
          }),
        ],
      }),
    ).rejects.toThrow(/setup 执行失败/);
  });

  it('缺少 setup 导出时报错', async () => {
    await expect(
      loadMods({
        registry: new Registry(),
        modules: [
          {
            path: '/src/mods/official/x/manifest.js',
            loadManifest: () => Promise.resolve({ default: { id: 'x', version: '1' } }),
            loadSetup: () => Promise.resolve({}),
          },
        ],
      }),
    ).rejects.toThrow(/必须导出 setup 函数/);
  });

  it('manifest 加载失败时报出路径', async () => {
    await expect(
      loadMods({
        registry: new Registry(),
        modules: [
          {
            path: '/src/mods/official/broken/manifest.js',
            loadManifest: () => Promise.reject(new Error('404')),
            loadSetup: () => Promise.resolve({ setup: () => ({}) }),
          },
        ],
      }),
    ).rejects.toThrow(/无法加载 manifest/);
  });

  it('后加载的模组覆盖同 id 内容（步骤 6 覆盖裁决）', async () => {
    const { pool } = await loadMods({
      registry: new Registry(),
      modules: [
        modEntry({
          id: 'base',
          provides: [SYM_A],
          setup: () => ({ skills: [skillSpec({ id: 'shared', name: '原版' })] }),
        }),
        modEntry({
          id: 'override',
          requires: [SYM_A],
          setup: () => ({ skills: [skillSpec({ id: 'shared', name: '覆盖版' })] }),
        }),
      ],
    });
    expect(pool.skills.get('shared').name).toBe('覆盖版');
    expect(pool.skills.get('shared').source).toBe('override');
  });

  it('返回的 loaded 清单含 id / version / path', async () => {
    const { loaded } = await loadMods({
      registry: new Registry(),
      modules: [modEntry({ id: 'solo', version: '2.1.0' })],
    });
    expect(loaded).toEqual([
      { id: 'solo', version: '2.1.0', path: '/src/mods/official/solo/manifest.js' },
    ]);
  });

  it('无模组时得到空内容池而非报错', async () => {
    const { pool, loaded } = await loadMods({ registry: new Registry(), modules: [] });
    expect(loaded).toEqual([]);
    expect(pool.skills.size).toBe(0);
    expect(pool.buffs.size).toBe(0);
  });
});

describe('内容池跨引用校验', () => {
  it('怪物引用不存在的技能被检出', () => {
    const pool = createContentPool();
    pool.monsters.set('m1', normalizeMonster(
      { id: 'm1', maxHp: 10, attack: 1, defense: 0, gcdSequence: ['不存在的技能'] },
      'test',
    ));
    expect(() => validatePoolReferences(pool)).toThrow(/悬空引用/);
  });

  it('怪物 oGCD 槽引用不存在的技能被检出', () => {
    const pool = createContentPool();
    pool.skills.set('s1', normalizeSkill(skillSpec({ id: 's1' }), 'test'));
    pool.monsters.set('m1', normalizeMonster(
      {
        id: 'm1',
        maxHp: 10,
        attack: 1,
        defense: 0,
        gcdSequence: ['s1'],
        ogcdSlots: [{ skillId: '幽灵技能' }],
      },
      'test',
    ));
    expect(() => validatePoolReferences(pool)).toThrow(/悬空引用/);
    // 顶层消息只报数量，具体哪个 ID 悬空在 details.problems 里
    try {
      validatePoolReferences(pool);
      expect.unreachable('应当抛错');
    } catch (error) {
      expect(error.details.problems.join('\n')).toMatch(/幽灵技能/);
    }
  });

  it('遭遇引用不存在的怪物被检出', () => {
    const pool = createContentPool();
    pool.encounters.set('e1', normalizeEncounter({ id: 'e1', monsterIds: ['幽灵怪'] }, 'test'));
    expect(() => validatePoolReferences(pool)).toThrow(/悬空引用/);
    try {
      validatePoolReferences(pool);
      expect.unreachable('应当抛错');
    } catch (error) {
      expect(error.details.problems.join('\n')).toMatch(/幽灵怪/);
    }
  });

  it('技能引用未注册的 Buff 被检出（否则技能零效果却无报错）', () => {
    const pool = createContentPool();
    pool.skills.set('s1', normalizeSkill(skillSpec({ id: 's1', buffId: 'buff.幽灵' }), 'test'));
    expect(() => validatePoolReferences(pool)).toThrow(/悬空引用/);
    try {
      validatePoolReferences(pool);
      expect.unreachable('应当抛错');
    } catch (error) {
      expect(error.details.problems.join('\n')).toMatch(/未注册的 Buff/);
    }
  });

  it('Buff 已注册时校验通过', () => {
    const pool = createContentPool();
    pool.buffs.set('buff.real', normalizeBuff({ id: 'buff.real', attackMul: 1.1 }, 'test'));
    pool.skills.set('s1', normalizeSkill(skillSpec({ id: 's1', buffId: 'buff.real' }), 'test'));
    expect(validatePoolReferences(pool)).toBe(true);
  });
});

describe('normalize：时间对齐（裁决 4）', () => {
  it('秒转整数毫秒', () => {
    expect(toStepAlignedMs(2.496, 'x', {})).toBe(2496);
    expect(toStepAlignedMs(0, 'x', {})).toBe(0);
  });

  it('非 16ms 整数倍被拒绝，并在错误信息里给出建议值', () => {
    // 1000 % 16 = 8，这是最容易踩的坑：整秒时长未必对齐
    expect(() => toStepAlignedMs(1, 'x', {})).toThrow(/1008ms/);
  });

  it('负数与非数被拒绝', () => {
    expect(() => toStepAlignedMs(-1, 'x', {})).toThrow(/非负有限数/);
    expect(() => toStepAlignedMs('2.5', 'x', {})).toThrow(/非负有限数/);
    expect(() => toStepAlignedMs(Infinity, 'x', {})).toThrow(/非负有限数/);
  });

  it('官方内容的全部时间量都是 STEP_MS 整数倍', async () => {
    const pool = await loadOfficialPool();
    for (const skill of pool.skills.values()) {
      expect(skill.gcdCostMs % STEP_MS, `${skill.id} gcdCostMs`).toBe(0);
      expect(skill.cooldownMs % STEP_MS, `${skill.id} cooldownMs`).toBe(0);
      if (skill.buffDurationMs !== undefined) {
        expect(skill.buffDurationMs % STEP_MS, `${skill.id} buffDurationMs`).toBe(0);
      }
    }
  });
});

describe('normalize：技能', () => {
  it('GCD 技能得到 gcdCostMs，cooldownMs 为 0', () => {
    const s = normalizeSkill(skillSpec({ gcdCost: 2.496 }), 'test');
    expect(s.gcdCostMs).toBe(2496);
    expect(s.cooldownMs).toBe(0);
  });

  it('oGCD 技能得到 cooldownMs，gcdCostMs 为 0', () => {
    const s = normalizeSkill(
      skillSpec({ type: SKILL_TYPE.OGCD, gcdCost: undefined, cooldown: 30 }),
      'test',
    );
    expect(s.cooldownMs).toBe(30000);
    expect(s.gcdCostMs).toBe(0);
  });

  it('产物被冻结，模组无法在运行期改写技能数据', () => {
    const s = normalizeSkill(skillSpec(), 'test');
    expect(Object.isFrozen(s)).toBe(true);
    expect(() => {
      s.power = 999;
    }).toThrow();
  });

  it('缺 id / 错 type / 缺 execute 都被拒绝', () => {
    expect(() => normalizeSkill({ type: SKILL_TYPE.GCD, execute: () => {} }, 't')).toThrow(/非空 id/);
    expect(() => normalizeSkill(skillSpec({ type: 'PASSIVE' }), 't')).toThrow(/必须是 'GCD' 或 'oGCD'/);
    expect(() => normalizeSkill(skillSpec({ execute: undefined }), 't')).toThrow(/必须提供 execute/);
  });

  it('async execute 被拒绝（规格 5.3：execute 必须同步）', () => {
    expect(() => normalizeSkill(skillSpec({ execute: async () => {} }), 't')).toThrow(/不能是 async/);
  });

  it('非法 range 与非函数 condition 被拒绝', () => {
    expect(() => normalizeSkill(skillSpec({ range: 'everyone' }), 't')).toThrow(/range 非法/);
    expect(() => normalizeSkill(skillSpec({ condition: 'hp<50' }), 't')).toThrow(/condition 必须是函数/);
  });

  it('range 默认单体，condition 默认 null', () => {
    const s = normalizeSkill(skillSpec(), 'test');
    expect(s.range).toBe(SKILL_RANGE.SINGLE);
    expect(s.condition).toBeNull();
  });

  it('buffId 非字符串时归一为 null', () => {
    expect(normalizeSkill(skillSpec({ buffId: 123 }), 't').buffId).toBeNull();
    expect(normalizeSkill(skillSpec(), 't').buffId).toBeNull();
  });
});

describe('normalize：Buff', () => {
  it('接受任一乘数字段并冻结', () => {
    const b = normalizeBuff({ id: 'b', defenseMul: 1.2, isDebuff: false }, 'test');
    expect(b.defenseMul).toBe(1.2);
    expect(b.isDebuff).toBe(false);
    expect(Object.isFrozen(b)).toBe(true);
  });

  it('未声明任何修正的 Buff 被拒绝（零效果 Buff 是设计错误）', () => {
    expect(() => normalizeBuff({ id: 'b', name: '空壳' }, 'test')).toThrow(/未声明任何修正/);
  });

  it('负数或非有限乘数被拒绝', () => {
    expect(() => normalizeBuff({ id: 'b', attackMul: -1 }, 't')).toThrow(/非负有限数/);
    expect(() => normalizeBuff({ id: 'b', healMul: NaN }, 't')).toThrow(/非负有限数/);
  });

  it('未声明的字段不出现在产物上（便于 resolveModifiers 跳过）', () => {
    const b = normalizeBuff({ id: 'b', attackMul: 1.1 }, 'test');
    expect('defenseMul' in b).toBe(false);
  });

  it('缺 id 被拒绝', () => {
    expect(() => normalizeBuff({ attackMul: 1.1 }, 't')).toThrow(/非空 id/);
  });
});

describe('normalize：怪物 / 遭遇 / 商品 / 事件', () => {
  it('怪物属性必须是非负整数，gcdSequence 非空', () => {
    const base = { id: 'm', maxHp: 100, attack: 10, defense: 5, gcdSequence: ['s'] };
    expect(normalizeMonster(base, 't').maxHp).toBe(100);
    expect(() => normalizeMonster({ ...base, maxHp: 10.5 }, 't')).toThrow(/非负整数/);
    expect(() => normalizeMonster({ ...base, attack: -1 }, 't')).toThrow(/非负整数/);
    expect(() => normalizeMonster({ ...base, gcdSequence: [] }, 't')).toThrow(/非空 gcdSequence/);
  });

  it('遭遇怪物数上限为 6（规格 7.1）', () => {
    const ids = (n) => Array.from({ length: n }, (_, i) => `m${i}`);
    expect(normalizeEncounter({ id: 'e', monsterIds: ids(6) }, 't').monsterIds).toHaveLength(6);
    expect(() => normalizeEncounter({ id: 'e', monsterIds: ids(7) }, 't')).toThrow(/不得超过 6/);
    expect(() => normalizeEncounter({ id: 'e', monsterIds: [] }, 't')).toThrow(/非空 monsterIds/);
  });

  it('遭遇层段缺省时覆盖全部层', () => {
    const e = normalizeEncounter({ id: 'e', monsterIds: ['m'] }, 't');
    expect(e.minFloor).toBe(1);
    expect(e.maxFloor).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('商品 cost 必须是非负整数且需要 apply', () => {
    const base = { id: 'i', cost: 50, apply: () => {} };
    expect(normalizeShopItem(base, 't').cost).toBe(50);
    expect(() => normalizeShopItem({ ...base, cost: -1 }, 't')).toThrow(/非负整数/);
    expect(() => normalizeShopItem({ ...base, apply: undefined }, 't')).toThrow(/必须提供 apply/);
  });

  it('事件必须有非空 choices，每个选项都要有 apply', () => {
    expect(() => normalizeEvent({ id: 'e', choices: [] }, 't')).toThrow(/非空 choices/);
    expect(() => normalizeEvent({ id: 'e', choices: [{ label: 'x' }] }, 't')).toThrow(/必须提供 apply/);
    const ev = normalizeEvent({ id: 'e', choices: [{ apply: () => {} }] }, 't');
    expect(ev.choices[0].label).toBe('继续');
    expect(Object.isFrozen(ev.choices)).toBe(true);
  });
});

describe('官方模组集成加载', () => {
  it('四个官方模组全部加载成功，内容量符合规格', async () => {
    const pool = await loadOfficialPool();
    const gcd = [...pool.skills.values()].filter((s) => s.type === SKILL_TYPE.GCD);
    const ogcd = [...pool.skills.values()].filter((s) => s.type === SKILL_TYPE.OGCD);

    expect(gcd).toHaveLength(60);
    expect(ogcd).toHaveLength(30);
    expect(pool.monsters.size).toBe(300);
    expect(pool.encounters.size).toBe(100);
    expect(pool.buffs.size).toBeGreaterThan(0);
    expect(pool.shopItems.size).toBeGreaterThan(0);
    expect(pool.events.size).toBeGreaterThan(0);
  });

  it('官方内容不手写派生属性（不变量 4：永久加成走 permanentBonus）', async () => {
    const pool = await loadOfficialPool();
    // maxHp / attack / defense / critChance 是 recalcPlayer 的产物，直接赋值等于写空气：
    // 下一次重算就消失。旧版商店的六个 upgrade 商品与部分事件就踩了这个坑。
    const writesDerived = (fn) =>
      /state\.player\.(maxHp|attack|defense|critChance)\s*(\+=|-=|\*=|=(?!=))/.test(fn.toString());

    const offenders = [];
    for (const item of pool.shopItems.values()) {
      if (writesDerived(item.apply)) offenders.push(item.id);
    }
    for (const event of pool.events.values()) {
      event.choices.forEach((choice, index) => {
        if (writesDerived(choice.apply)) offenders.push(`${event.id}[${index}]`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it('遭遇分档为 60 普通 + 40 精英', async () => {
    const pool = await loadOfficialPool();
    const encounters = [...pool.encounters.values()];
    expect(encounters.filter((e) => e.tier === 'normal')).toHaveLength(60);
    expect(encounters.filter((e) => e.tier === 'elite')).toHaveLength(40);
  });

  it('1~60 层每层都有可用的普通与精英遭遇（否则该层节点必然抢错）', async () => {
    const pool = await loadOfficialPool();
    const encounters = [...pool.encounters.values()];
    for (let floor = 1; floor <= 60; floor += 1) {
      for (const tier of ['normal', 'elite']) {
        const eligible = encounters.filter(
          (e) => e.tier === tier && floor >= e.minFloor && floor <= e.maxFloor,
        );
        expect(eligible.length, `第 ${floor} 层无可用 ${tier} 遭遇`).toBeGreaterThan(0);
      }
    }
  });

  it('官方内容无悬空引用', async () => {
    const pool = await loadOfficialPool();
    expect(validatePoolReferences(pool)).toBe(true);
  });

  it('通过真实 loadMods 走完六步法（非缓存路径）', async () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      const { pool, loaded } = await loadMods({
        registry: new Registry(),
        modules: officialModuleEntries(),
      });
      expect(loaded).toHaveLength(4);
      expect(pool.skills.size).toBe(90);
      // 拓扑序（不是字典序）：core-map 无依赖排最前，技能 → 怪物 → 遭遇 成依赖链
      expect(loaded.map((m) => m.id)).toEqual([
        'official.core-map',
        'official.core-skills',
        'official.core-monsters',
        'official.core-encounters',
      ]);
    } finally {
      spy.mockRestore();
    }
  });

  it('官方技能 ID 与怪物 ID 命名约定统一', async () => {
    const pool = await loadOfficialPool();
    for (const monster of pool.monsters.values()) {
      expect(monster.id, monster.id).toMatch(/^mon\.[a-z]+\.[a-z]+\.t\d$/);
    }
    for (const skill of pool.skills.values()) {
      expect(skill.id, skill.id).toMatch(/^[a-z]+\.[a-zA-Z]+$/);
    }
  });
});
