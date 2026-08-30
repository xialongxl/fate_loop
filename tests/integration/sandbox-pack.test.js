/**
 * 沙箱包的**端到端**验证：包代码在 QuickJS 里跑 → 注册技能 → 进内容池 →
 * 被真实战斗引擎施放 → 打出真实伤害 → 结果仍然可复现。
 *
 * 这一份是整条 S2 路线的验收证明。单测只证明"跨界调用通了"，这里证明的是
 * "第三方包真的能改变战斗结果，而且没有把确定性弄坏"。
 */
import { describe, it, expect } from 'vitest';
import { loadOfficialPool, battleFingerprint } from '../helpers.js';
import { createContentPool } from '../../src/core/mods/loader.js';
import { createPack } from '../../src/core/mods/sandbox/pack.js';
import { installSandboxPacks } from '../../src/core/mods/sandbox/index.js';
import { Registry } from '../../src/contracts/registry.js';
import { registerDefaultContracts } from '../../src/contracts/index.js';
import { Store } from '../../src/core/store.js';
import { createInitialState } from '../../src/core/initialState.js';
import { BattleEngine } from '../../src/core/battle/engine.js';
import { computeContentFingerprint } from '../../src/persistence/contentFingerprint.js';

const clock = () => performance.now();

/** 克隆官方池：装包会就地改池，不能污染其它用例共享的那份。 */
async function freshPool() {
  const official = await loadOfficialPool();
  const copy = createContentPool();
  for (const kind of Object.keys(copy)) copy[kind] = new Map(official[kind]);
  return copy;
}

const NOVA_PACK = () =>
  createPack({
    id: 'poc.nova',
    version: '1.0.0',
    files: {
      'main.js': `
import { begin, skill, family, SKILL_TYPE, SKILL_RANGE } from 'fate';
begin({ id: 'poc.nova', version: '1.0.0', title: '新星包', author: 'poc' });
family({ id: 'astral', label: '星界' });
skill({
  id: 'poc.nova.burst',
  name: '星爆',
  description: '第三方包注入的全场伤害。',
  family: 'astral',
  type: SKILL_TYPE.GCD,
  gcdCost: 2.4,
  range: SKILL_RANGE.ALL_ENEMIES,
  tags: ['arcane'],
  execute: (ctx, self, targets) => {
    const power = ctx.entity(self.id)?.attack ?? self.attack;
    for (const t of targets) {
      ctx.damage({ sourceId: self.id, targetId: t.id, amount: Math.round(power * 1.6), element: 'arcane' });
    }
    ctx.log('星爆横扫全场');
  },
});
`,
    },
  });

async function battleWith(pool, gcdSequence, seed = 20260830) {
  const store = new Store(
    createInitialState(seed, { gcdSequence, ogcdSlots: [{ skillId: 'ogcd.secondWind', priority: 95 }] }),
  );
  const registry = new Registry();
  let engine = null;
  registerDefaultContracts({
    store,
    getRng: () => engine.getRng(),
    getBuffTable: () => pool.buffs,
    getAudioSink: () => null,
    registry,
  });
  engine = new BattleEngine({ store, registry, pool });
  engine.begin({ nodeId: 'node_poc', tier: 'normal' });
  engine.runToEnd();
  return store.getSnapshot();
}

describe('沙箱包 → 真实战斗', () => {
  it('包注册的技能进了内容池，来源标记为包 id，且能被官方解锁/UI 认出来', async () => {
    const pool = await freshPool();
    const { ok, failed } = await installSandboxPacks({ entries: [{ pack: NOVA_PACK() }], pool, clock });
    expect(failed).toEqual([]);
    expect(ok).toHaveLength(1);
    expect(ok[0].provided).toMatchObject({ skills: 1, families: 1 });

    const skill = pool.skills.get('poc.nova.burst');
    expect(skill, '技能应已在池中').toBeDefined();
    expect(skill.source).toBe('poc.nova');
    expect(typeof skill.execute).toBe('function');
    expect(pool.families.get('astral')).toMatchObject({ label: '星界', source: 'poc.nova' });
  });

  it('包技能真的在引擎里施放并造成伤害（不是"看上去注册了"）', async () => {
    const pool = await freshPool();
    await installSandboxPacks({ entries: [{ pack: NOVA_PACK() }], pool, clock });

    const withPack = await battleWith(pool, ['poc.nova.burst']);
    expect(withPack.winner).toBe('player');
    expect(withPack.log.some((l) => l.message.includes('星爆横扫全场'))).toBe(true);
    expect(withPack.player.stats.skillsCast).toBeGreaterThan(0);
    expect(withPack.metadata.totalDamage).toBeGreaterThan(0);
    // 怪物全灭才算数：沙箱 execute 的副作用确实作用到了真实实体
    expect(withPack.monsters.every((m) => m.hp <= 0)).toBe(true);
  });

  it('同一包同一种子两次跑，结果逐字节一致（墙钟预算不影响可复现性）', async () => {
    const pack = NOVA_PACK();
    const runOnce = async () => {
      const pool = await freshPool();
      await installSandboxPacks({ entries: [{ pack }], pool, clock });
      return battleFingerprint(await battleWith(pool, ['poc.nova.burst']));
    };
    expect(await runOnce()).toEqual(await runOnce());
  });

  it('装了包之后内容指纹变化（存档必须能区分"有没有装这个包"）', async () => {
    const bare = await freshPool();
    const bareFp = computeContentFingerprint(bare, { mods: [{ id: 'core', version: '1' }] });

    const pooled = await freshPool();
    const { loaded } = await installSandboxPacks({ entries: [{ pack: NOVA_PACK() }], pool: pooled, clock });
    const packFp = computeContentFingerprint(pooled, {
      mods: [{ id: 'core', version: '1' }],
      packs: loaded,
    });
    expect(packFp.hash).not.toBe(bareFp.hash);
    expect(packFp.packs[0]).toMatchObject({ id: 'poc.nova', version: '1.0.0' });
    expect(packFp.packs[0].sha256).toMatch(/^[0-9a-f]{8,}$/);
  });

  it('坏包不连坐：悬空引用只废它自己，官方内容与同批别的包照装', async () => {
    const pool = await freshPool();
    const bad = createPack({
      id: 'poc.bad',
      version: '1.0.0',
      files: {
        'main.js': `
import { begin, encounter } from 'fate';
begin({ id: 'poc.bad', version: '1.0.0' });
encounter({ id: 'poc.bad.wipe', tier: 'normal', monsterIds: ['monster.does.not.exist'] });
`,
      },
    });
    const good = NOVA_PACK();
    const { ok, failed } = await installSandboxPacks({ entries: [{ pack: bad }, { pack: good }], pool, clock });

    expect(failed).toHaveLength(1);
    expect(failed[0].id).toBe('poc.bad');
    expect(failed[0].reason).toMatch(/不存在|悬空/);
    expect(ok.map((r) => r.id)).toEqual(['poc.nova']);
    expect(pool.skills.has('poc.nova.burst')).toBe(true);
    expect(pool.encounters.has('poc.bad.wipe')).toBe(false);
    // 官方内容没被碰坏：原样还能整场跑
    const snapshot = await battleWith(pool, ['blade.jab', 'poc.nova.burst']);
    expect(snapshot.winner).toBe('player');
  });

  it('包覆盖官方技能会被记录下来（玩家得知道装了的东西改了什么）', async () => {
    const pool = await freshPool();
    const overridePack = createPack({
      id: 'poc.override',
      version: '1.0.0',
      files: {
        'main.js': `
import { begin, skill } from 'fate';
begin({ id: 'poc.override', version: '1.0.0' });
skill({ id: 'blade.jab', name: '被改过的突刺', type: 'GCD', gcdCost: 2.4,
  execute: (ctx, self, targets) => { for (const t of targets) ctx.damage({ sourceId: self.id, targetId: t.id, amount: 1 }); } });
`,
      },
    });
    const before = pool.skills.get('blade.jab');
    expect(before.name).not.toBe('被改过的突刺');
    expect(before.source).toBe('official.core-skills');

    const { overrides } = await installSandboxPacks({ entries: [{ pack: overridePack }], pool, clock });
    // 覆盖被记下来：UI 要能告诉玩家"这个包改了官方技能 X"
    expect(overrides).toEqual([{ id: 'blade.jab', kind: 'skills', was: 'official.core-skills', by: 'poc.override' }]);
    expect(pool.skills.get('blade.jab')).toMatchObject({ name: '被改过的突刺', source: 'poc.override' });
  });
});
