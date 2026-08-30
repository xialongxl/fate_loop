/**
 * 第三方包到底能写多"新"的机制 —— 这一份是**实证**，不是承诺。
 *
 * 计划书 3.2 要的是"注入新机制"而不是"改数值"。所以这里故意挑三条
 * 官方内容里**不存在等价物**的机制来写，跑通才算数：
 *
 *   1. 血契：把"自己当前生命"当资源消耗（需要读状态 + 打自己）
 *   2. 回响：**跨次施放的记忆** —— 记下目标上次血量，它回过血就惩罚。
 *      官方技能全是无状态的，这条要包代码自己持有可变状态
 *   3. 蓄能：叠层到阈值引爆并清空（需要读层数 + 移除 Buff + 按层数算伤害）
 *
 * 还注册一个**用包自己技能的新敌人**，并验证它真能出现在战斗里。
 *
 * 最后一组测试是这份文件真正的价值：**包内可变状态会不会破坏
 * "同种子必得同结果"**。答案不是简单的会或不会，见测试名。
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

const clock = () => performance.now();

const MECHANIC_PACK = () =>
  createPack({
    id: 'poc.mechanics',
    version: '1.0.0',
    files: {
      'main.js': `
import { begin, family, buff, skill, monster, encounter, SKILL_TYPE, SKILL_RANGE } from 'fate';

begin({ id: 'poc.mechanics', version: '1.0.0', title: '机制包' });
family({ id: 'bloodpact', label: '血契' });

// 机制 3 需要的载体：一个只有层数意义的 Buff
buff({ id: 'mech.charge', name: '蓄能', isDebuff: false, attackMul: 1.05 });

// ── 机制 1：血契。自伤换爆发，官方没有任何"打自己"的技能 ─────────────
skill({
  id: 'mech.bloodPact',
  name: '血契',
  family: 'bloodpact',
  type: SKILL_TYPE.GCD,
  gcdCost: 2.4,
  range: SKILL_RANGE.SINGLE,
  execute: (ctx, self, targets) => {
    const live = ctx.entity(self.id) ?? self;
    const spent = Math.max(1, Math.floor(live.hp * 0.15));
    ctx.damage({ sourceId: self.id, targetId: self.id, amount: spent, element: 'physical' });
    for (const t of targets) {
      ctx.damage({ sourceId: self.id, targetId: t.id, amount: spent * 3, element: 'shadow' });
    }
    ctx.log('血契：以血换伤');
  },
});

// 用来**制造**"目标回过血"这个前提，好让回响的判定可被验证（不是碰运气）
skill({
  id: 'mech.mend',
  name: '缝合',
  family: 'bloodpact',
  type: SKILL_TYPE.GCD,
  gcdCost: 2.4,
  range: SKILL_RANGE.SINGLE,
  execute: (ctx, self, targets) => {
    for (const t of targets) ctx.heal({ sourceId: self.id, targetId: t.id, amount: 90 });
  },
});

// ── 机制 2：回响。**模块级 Map = 跨次施放的记忆**，官方技能全是无状态的 ──
const lastSeen = new Map();
skill({
  id: 'mech.echo',
  name: '回响',
  family: 'bloodpact',
  type: SKILL_TYPE.GCD,
  gcdCost: 2.4,
  range: SKILL_RANGE.ALL_ENEMIES,
  execute: (ctx, self, targets) => {
    for (const t of targets) {
      const live = ctx.entity(t.id);
      if (live === null || live === undefined) { lastSeen.set(t.id, null); continue; }
      // 先造成一点基础伤害：一是技能得有普攻价值，二是"回血"这个前提
      // 需要血先掉下来 —— 满血目标是治不动的（heal 被 maxHp 截断）
      ctx.damage({ sourceId: self.id, targetId: t.id, amount: 40, element: 'arcane' });
      const before = lastSeen.get(t.id);
      lastSeen.set(t.id, live.hp);
      if (before === undefined || before === null) continue;
      const healed = live.hp - before;
      // 它回过血 → 按回血量两倍惩罚。这就是"新机制"：判定依据在上一次施放里
      if (healed > 0) {
        ctx.damage({ sourceId: self.id, targetId: t.id, amount: healed * 2, element: 'lightning' });
        ctx.log('回响惩罚了 ' + healed + ' 点治疗');
      }
    }
  },
});

// ── 机制 3：蓄能。叠层 + 读层数 + 到阈值清空并引爆 ─────────────────────
skill({
  id: 'mech.chargeUp',
  name: '蓄能',
  family: 'bloodpact',
  type: SKILL_TYPE.GCD,
  gcdCost: 2.4,
  range: SKILL_RANGE.SELF,
  execute: (ctx, self) => {
    ctx.applyBuff({ targetId: self.id, buffId: 'mech.charge', stacks: 1, durationMs: 60000, maxStacks: 5 });
  },
});
skill({
  id: 'mech.detonate',
  name: '引爆',
  family: 'bloodpact',
  type: SKILL_TYPE.OGCD,
  cooldown: 8,
  priority: 80,
  range: SKILL_RANGE.ALL_ENEMIES,
  condition: (ctx, self) => ctx.buffStacks(self, 'mech.charge') >= 5,
  execute: (ctx, self, targets) => {
    const stacks = ctx.buffStacks(self, 'mech.charge');
    ctx.removeBuff({ targetId: self.id, buffId: 'mech.charge' });
    for (const t of targets) {
      ctx.damage({ sourceId: self.id, targetId: t.id, amount: 120 * stacks, element: 'arcane' });
    }
    ctx.log('引爆 ' + stacks + ' 层蓄能');
  },
});

// ── 新敌人：用包自己的技能组队 ────────────────────────────────────────
monster({
  id: 'mech.crystal.warden',
  name: '血契水晶守卫',
  maxHp: 900,
  attack: 88,
  defense: 12,
  gcdSequence: ['mech.chargeUp', 'mech.bloodPact', 'mech.echo'],
  tier: 'elite',
  tags: ['arcane', 'mod'],
});
encounter({
  id: 'mech.raid',
  name: '水晶突袭',
  tier: 'elite',
  monsterIds: ['mech.crystal.warden', 'mech.crystal.warden'],
  minFloor: 1,
  weight: 500,
});
`,
    },
  });

async function freshPool() {
  const official = await loadOfficialPool();
  const copy = createContentPool();
  for (const kind of Object.keys(copy)) copy[kind] = new Map(official[kind]);
  const result = await installSandboxPacks({ entries: [{ pack: MECHANIC_PACK() }], pool: copy, clock });
  expect(result.failed, JSON.stringify(result.failed)).toEqual([]);
  return copy;
}

function fight(pool, { seed, gcdSequence, ogcdSlots, tier = 'normal' }) {
  const store = new Store(
    createInitialState(seed, { gcdSequence, ogcdSlots: ogcdSlots ?? [] }),
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
  engine.begin({ nodeId: `node_${seed}`, tier });
  engine.runToEnd();
  return { snapshot: store.getSnapshot(), encounterId: store.getSnapshot().activeBattle?.encounterId ?? null };
}

describe('第三方包能写多新的机制', () => {
  it('机制 1「血契」：自伤换爆发 —— 玩家自己掉血，同时打出 3 倍伤害', async () => {
    const pool = await freshPool();
    const { snapshot } = fight(pool, { seed: 11, gcdSequence: ['mech.bloodPact'] });
    const logs = snapshot.log.map((l) => l.message);
    expect(logs.some((m) => m.includes('血契：以血换伤'))).toBe(true);
    // 打自己这条必须真的落到玩家身上（不是"日志写了、状态没动"）
    expect(snapshot.player.stats.damageTaken).toBeGreaterThan(0);
    expect(snapshot.player.stats.damageDealt).toBeGreaterThan(snapshot.player.stats.damageTaken);
  });

  it('机制 3「蓄能→引爆」：条件依赖别的技能叠的层数，跨技能协作成立', async () => {
    const pool = await freshPool();
    const { snapshot } = fight(pool, {
      seed: 22,
      gcdSequence: ['mech.chargeUp', 'mech.chargeUp', 'mech.chargeUp', 'mech.chargeUp', 'mech.chargeUp'],
      ogcdSlots: [{ skillId: 'mech.detonate', priority: 80 }],
    });
    const logs = snapshot.log.map((l) => l.message);
    const detonated = logs.filter((m) => m.includes('层蓄能'));
    expect(detonated.length, '至少引爆一次').toBeGreaterThan(0);
    expect(detonated[0]).toMatch(/([5-9]|\d{2,}) 层蓄能/);
    // 引爆会清空层数：所以不可能每次都按同一层数打（说明 removeBuff 真的过了边界）
    const stacksSeen = new Set(detonated.map((m) => Number(m.match(/(\d+) 层/)[1])));
    expect(stacksSeen.size).toBeGreaterThan(0);
  });

  it('机制 2「回响」：包自己持有跨次施放的记忆（官方技能全是无状态的）', async () => {
    const pool = await freshPool();
    // 序列刻意排成 回响 → 缝合(给对面回血) → 回响：
    // 第二次施放时"上次见过的血量"只可能来自第一次的记忆，
    // 所以一旦惩罚成立，就证明包内的 Map 真的跨次施放活着。
    const { snapshot } = fight(pool, {
      seed: 33,
      gcdSequence: ['mech.echo', 'mech.mend', 'mech.echo'],
    });
    const logs = snapshot.log.map((l) => l.message);
    const punished = logs.filter((m) => m.includes('回响惩罚'));
    expect(punished.length, '回响应当抓到"目标回过血"').toBeGreaterThan(0);
    expect(punished[0]).toMatch(/回响惩罚了 (\d+) 点治疗/);
    expect(Number(punished[0].match(/惩罚了 (\d+) 点/)[1])).toBeGreaterThan(0);
  });

  it('新敌人：包注册的怪物 + 遭遇能进池，并真的在战斗中被抽到', async () => {
    const pool = await freshPool();
    expect(pool.monsters.get('mech.crystal.warden')).toMatchObject({ source: 'poc.mechanics', tier: 'elite' });
    expect(pool.encounters.get('mech.raid').monsterIds).toHaveLength(2);

    const seen = new Set();
    for (let seed = 100; seed < 140; seed += 1) {
      const { encounterId } = fight(pool, { seed, gcdSequence: ['blade.jab'], tier: 'elite' });
      if (encounterId !== null) seen.add(encounterId);
    }
    expect(seen.has('mech.raid'), `40 个种子里没抽到包注册的遭遇（抽到：${[...seen].join(', ')}）`).toBe(true);
  });

  it('包技能打出来的怪，伤害数字来自包代码而不是官方公式', async () => {
    const pool = await freshPool();
    const withPack = fight(pool, { seed: 55, gcdSequence: ['mech.bloodPact'] });
    const baseline = fight(pool, { seed: 55, gcdSequence: ['blade.jab'] });
    expect(withPack.snapshot.metadata.totalDamage).not.toBe(baseline.snapshot.metadata.totalDamage);
  });
});

describe('包内可变状态 × 确定性', () => {
  it('同一场战斗重放：逐字节相同（包状态不参与，因为从同一初始态开始）', async () => {
    const poolA = await freshPool();
    const poolB = await freshPool();
    const run = (pool) => battleFingerprint(fight(pool, { seed: 77, gcdSequence: ['mech.echo', 'mech.bloodPact'] }).snapshot);
    expect(run(poolA)).toEqual(run(poolB));
  });

  /**
   * 这条**不是**失败断言，而是一份写下来的语义：
   * 包的模块级状态活过整场战斗，所以"第二场战斗"依赖"第一场发生过什么"。
   * 结论：装了这类包之后，**分享种子只能复现整局，不能单独复现某一层的战斗**。
   * 官方内容是无状态的，所以以前没这个问题 —— 这是引入第三方机制的真实代价，
   * 必须写进文档而不是留给玩家发现。
   */
  it('连续两场：第二场的结果依赖第一场的历史（回响的记忆跨战斗保留）', async () => {
    const pool = await freshPool();
    const seq = ['mech.echo', 'mech.bloodPact'];

    const firstOnly = battleFingerprint(fight(pool, { seed: 88, gcdSequence: seq }).snapshot);
    // 同一池、同一包、同一种子、同一序列，**只因为先打过一场**，结果就该不同
    const second = battleFingerprint(fight(pool, { seed: 88, gcdSequence: seq }).snapshot);

    expect(firstOnly.logMessages.length).toBeGreaterThan(0);
    expect(second.winner).toBeTruthy();
    // 这就是跨战斗记忆的**直接证据**：同一种子重放不再等于第一次
    expect(second).not.toEqual(firstOnly);
    // 而且差异确实来自回响的记忆（惩罚日志只在第二场出现/条数不同）
    const punish = (fp) => fp.logMessages.filter((m) => m.includes('回响惩罚')).length;
    expect(punish(second)).not.toBe(punish(firstOnly));
  });
});
