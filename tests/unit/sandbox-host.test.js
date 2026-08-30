/**
 * 沙箱宿主冒烟 + 边界测试（S2）。
 *
 * 这是"第三方能不能给游戏注入新机制"这件事的**唯一实证**：
 * 前面的设计文档、API 清单、shim 都只是纸面约定，只有这里真的把一段
 * 包代码放进 QuickJS、由它注册技能、再被宿主回调执行。
 *
 * 环境：默认 node（quickjs-emscripten 在 node 下能直接跑 wasm）。
 */
import { describe, it, expect, afterAll } from 'vitest';
import { createSandboxHost } from '../../src/core/mods/sandbox/host.js';
import { createPack, hashPack } from '../../src/core/mods/sandbox/pack.js';

const clock = () => performance.now();
const hosts = [];

async function host(options = {}) {
  const h = await createSandboxHost({ clock, ...options });
  hosts.push(h);
  return h;
}

afterAll(() => hosts.forEach((h) => h.dispose()));

const PACK_SOURCE = `
import { begin, skill, SKILL_TYPE, SKILL_RANGE } from 'fate';
begin({ id: 'poc.smoke', version: '1.0.0', title: '冒烟包' });

skill({
  id: 'poc.smoke.hit',
  name: '一击',
  description: '按攻击力倍率造成伤害，并留一条日志。',
  type: SKILL_TYPE.GCD,
  gcdCost: 2.4,
  range: SKILL_RANGE.SINGLE,
  execute: (ctx, self, targets) => {
    for (const t of targets) {
      ctx.damage({ sourceId: self.id, targetId: t.id, amount: Math.round(self.attack * 1.2), element: 'physical' });
    }
    ctx.log('沙箱技能开火');
  },
});

skill({
  id: 'poc.smoke.desperate',
  name: '背水',
  type: SKILL_TYPE.OGCD,
  cooldown: 12,
  priority: 50,
  condition: (ctx, self) => ctx.buffStacks(self, 'low.hp') === 0 && self.hp * 3 < self.maxHp,
  execute: (ctx, self, targets) => {
    ctx.heal({ targetId: self.id, amount: 100 });
    void targets;
  },
});
`;

function packOf(files = { 'main.js': PACK_SOURCE }, spec = {}) {
  return createPack({ id: 'poc.smoke', version: '1.0.0', files, ...spec });
}

/** 假 ctx：只记录跨界调用，不碰真实状态。 */
function fakeContext() {
  const calls = [];
  return {
    calls,
    virtualTime: 42000,
    floorNumber: 7,
    damage: (a) => calls.push(['damage', a]),
    heal: (a) => calls.push(['heal', a]),
    applyBuff: (a) => calls.push(['applyBuff', a]),
    removeBuff: (a) => calls.push(['removeBuff', a]),
    log: (m) => calls.push(['log', m]),
    sound: (s) => calls.push(['sound', s]),
    query: (q) => calls.push(['query', q]),
    entity: (id) => calls.push(['entity', id]),
    buffStacks: (e, b) => {
      calls.push(['buffStacks', e?.id ?? e, b]);
      return 0;
    },
    hasBuff: () => false,
    rng: () => 0.5,
  };
}

const SELF = { id: 'player', attack: 100, hp: 60, maxHp: 300, buffs: new Map([['x', { stacks: 2 }]]) };
const TARGETS = [{ id: 'e1', hp: 80 }, { id: 'e2', hp: 40 }];

describe('沙箱宿主 · 装包与执行', () => {
  it('包能注册技能，且 execute 是宿主可调的函数', async () => {
    const h = await host();
    const record = await h.installPack(packOf());
    expect(record.failed, record.failureReason ?? 'no failure').toBe(false);
    expect(record.manifest).toMatchObject({ id: 'poc.smoke', title: '冒烟包' });

    const specs = h.drainRegistrations(record);
    expect(specs.skills).toHaveLength(2);
    const hit = specs.skills.find((s) => s.id === 'poc.smoke.hit');
    expect(typeof hit.execute).toBe('function');
    expect(hit.gcdCost).toBe(2.4);
    expect(hit.name).toBe('一击');
    expect(hit.type).toBe('GCD');
  });

  it('跨界执行：包里的 execute 真的按倍率调用宿主 ctx.damage，并留日志', async () => {
    const h = await host();
    const record = await h.installPack(packOf());
    const [hit] = h.drainRegistrations(record).skills;
    const ctx = fakeContext();

    hit.execute(ctx, SELF, TARGETS);

    const damages = ctx.calls.filter((c) => c[0] === 'damage');
    expect(damages).toHaveLength(2);
    expect(damages[0][1]).toEqual({
      sourceId: 'player',
      targetId: 'e1',
      amount: 120,
      element: 'physical',
    });
    expect(ctx.calls.some((c) => c[0] === 'log' && c[1] === '沙箱技能开火')).toBe(true);
  });

  it('实体快照：Map 字段摊平成对象过界，包不会拿到活的宿主对象', async () => {
    const h = await host();
    const record = await h.installPack(
      packOf({
        'main.js': `
import { begin, skill } from 'fate';
begin({ id: 'poc.snapshot', version: '1.0.0' });
skill({ id: 'poc.snapshot.seeself', type: 'GCD', gcdCost: 2.4,
  execute: (ctx, self) => ctx.query('SELF=' + JSON.stringify([self.hp, self.maxHp, self.buffs.x.stacks, Object.keys(self).length])) });
`,
      }),
    );
    expect(record.failed, record.failureReason ?? 'no failure').toBe(false);
    const [skill] = h.drainRegistrations(record).skills;
    const ctx = fakeContext();
    skill.execute(ctx, SELF, []);
    const query = ctx.calls.find((c) => c[0] === 'query');
    expect(query[1]).toContain('SELF=[60,300,2,');
    // 改快照不会影响真对象
    expect(SELF.buffs instanceof Map).toBe(true);
  });

  it('condition 也跨界：包可以自己写触发条件', async () => {
    const h = await host();
    const record = await h.installPack(packOf());
    const specs = h.drainRegistrations(record).skills;
    const desperate = specs.find((s) => s.id === 'poc.smoke.desperate');
    expect(typeof desperate.condition).toBe('function');

    const ctx = fakeContext();
    // self.hp*3 < maxHp 成立（60*3=180 < 300），buffStacks 返回 0 ⇒ 条件应为 true
    expect(desperate.condition(ctx, SELF, [])).toBe(true);
    const ctx2 = fakeContext();
    const result = desperate.condition(ctx2, { ...SELF, hp: 300 }, []);
    expect(result).toBe(false);
    // 上面那次 condition 里查过 buffStacks ⇒ 说明宿主侧读状态的路径通了
    expect(ctx2.calls.some((c) => c[0] === 'buffStacks')).toBe(true);
  });

  it('多文件包：包内相对 import 生效（zip 之后要能跑的就是这个）', async () => {
    const h = await host();
    const record = await h.installPack(
      packOf(
        {
          'main.js': `
import { begin, skill } from 'fate';
import { HIT } from './lib/hit.js';
begin({ id: 'poc.multi', version: '1.0.0' });
skill(HIT);
`,
          'lib/hit.js': `
import { SKILL_TYPE } from 'fate';
export const HIT = {
  id: 'poc.multi.hit', type: SKILL_TYPE.GCD, gcdCost: 2.4,
  execute: (ctx, self, targets) => { for (const t of targets) ctx.damage({ sourceId: self.id, targetId: t.id, amount: 55 }); },
};
`,
        },
        { id: 'poc.multi' },
      ),
    );
    expect(record.failed, record.failureReason ?? 'no failure').toBe(false);
    const specs = h.drainRegistrations(record).skills;
    expect(specs).toHaveLength(1);
    const ctx = fakeContext();
    specs[0].execute(ctx, SELF, TARGETS);
    expect(ctx.calls.filter((c) => c[0] === 'damage')).toHaveLength(2);
  });

  it('死循环：墙钟预算掐断执行、标记失效并上报一次，之后空转（不把异常抛进战斗）', async () => {
    const reports = [];
    const h = await host({ budgetMs: 60, onPackFailure: (id, reason) => reports.push([id, reason]) });
    const record = await h.installPack(
      packOf({
        'main.js': `
import { begin, skill } from 'fate';
begin({ id: 'poc.loop', version: '1.0.0' });
skill({ id: 'poc.loop.forever', type: 'GCD', gcdCost: 2.4,
  execute: () => { let i = 0; while (true) { i += 1; } } });
`,
      }),
    );
    expect(record.failed, record.failureReason ?? 'no failure').toBe(false);
    const [skill] = h.drainRegistrations(record).skills;
    const started = performance.now();
    // 关键契约：包自己跑飞了，只能罚包，不能罚玩家正在打的那一局
    expect(skill.execute(fakeContext(), SELF, TARGETS)).toBeUndefined();
    const elapsed = performance.now() - started;
    // 墙钟预算生效：不能等到 POC 里那种 6 秒
    expect(elapsed).toBeLessThan(1500);
    // installed 的键是 pack.id（createPack 的 id），不是 VM 里 begin() 说的 id
    expect(h.getRecord('poc.smoke').failed).toBe(true);
    expect(h.getRecord('poc.smoke').failureReason).toMatch(/超时|打断/);
    expect(reports).toHaveLength(1);
    expect(reports[0][0]).toBe('poc.smoke');
    // 第二次直接空转，不再进 VM、也不再上报
    const ctx2 = fakeContext();
    skill.execute(ctx2, SELF, TARGETS);
    expect(ctx2.calls).toHaveLength(0);
    expect(reports).toHaveLength(1);
  });

  it('越界引用：import 包外模块直接拒绝该包', async () => {
    const h = await host();
    const record = await h.installPack(
      packOf({
        'main.js': `
import { begin } from 'fate';
import { secrets } from '../../core/constants.js';
begin({ id: 'poc.escape', version: '1.0.0' });
void secrets;
`,
      }),
    );
    expect(record.failed).toBe(true);
    expect(record.failureReason).toMatch(/包外模块|不存在/);
  });

  it('仍未开放的能力：fate.mapGenerator 给的是明确报错而不是 undefined is not a function', async () => {
    const h = await host();
    const record = await h.installPack(
      packOf({
        'main.js': `
import { begin, mapGenerator } from 'fate';
begin({ id: 'poc.mapgen', version: '1.0.0' });
mapGenerator({ id: 'official.grid', generate: () => ({ nodes: [] }) });
`,
      }),
    );
    expect(record.failed).toBe(true);
    expect(record.failureReason).toMatch(/尚未开放/);
  });

  it('shopItem 已开放：apply(state, ops) 走 ops 通道，且能在结算之外被拒绝', async () => {
    const h = await host();
    const record = await h.installPack(
      packOf({
        'main.js': `
import { begin, shopItem } from 'fate';
begin({ id: 'poc.shop', version: '1.0.0' });
shopItem({ id: 'poc.shop.potion', name: '药', cost: 10,
  apply: (state, ops) => { if (ops.spendShards(10)) ops.healRatio(0.3); ops.addMetadata('bought', 1); } });
`,
      }),
    );
    expect(record.failed, record.failureReason ?? 'no failure').toBe(false);
    const item = h.drainRegistrations(record).shopItems[0];
    expect(typeof item.apply).toBe('function');

    const calls = [];
    const ops = {
      shards: 25,
      spendShards: (n) => { calls.push(['spendShards', n]); return true; },
      healRatio: (r) => calls.push(['healRatio', r]),
      addMetadata: (k, v) => calls.push(['addMetadata', k, v]),
      permanentBonus: () => calls.push(['permanentBonus']),
      gainShards: () => {},
      setShards: () => {},
      hpCostRatio: () => {},
      fullHeal: () => {},
    };
    item.apply({ fateShards: 25, player: { hp: 10, maxHp: 100 } }, ops);
    expect(calls).toEqual([['spendShards', 10], ['healRatio', 0.3], ['addMetadata', 'bought', 1]]);

    // 在结算之外调 ops 必须报错（而不是安静地改到别的东西上）
    expect(() => item.apply({ player: {} }, null)).not.toThrow();
    expect(h.getRecord('poc.smoke').failed).toBe(true);
    expect(h.getRecord('poc.smoke').failureReason).toMatch(/ops\.|apply/);
  });

  it('event 已开放：choices[].apply 是嵌在数组里的函数，必须逐个跨界接上', async () => {
    const h = await host();
    const record = await h.installPack(
      packOf({
        'main.js': `
import { begin, event } from 'fate';
begin({ id: 'poc.evt', version: '1.0.0' });
event({ id: 'poc.evt.altar', name: '祭坛', text: '要血还是钱？',
  choices: [
    { label: '献血', apply: (state, ops) => { ops.hpCostRatio(0.2); ops.gainShards(30); } },
    { label: '祈祷', apply: (state, ops) => ops.permanentBonus({ attack: 3 }) },
  ] });
`,
      }),
    );
    expect(record.failed, record.failureReason ?? 'no failure').toBe(false);
    const evt = h.drainRegistrations(record).events[0];
    expect(evt.choices).toHaveLength(2);
    expect(typeof evt.choices[0].apply).toBe('function');
    expect(typeof evt.choices[1].apply).toBe('function');
    // 两个选择项不能接到同一个函数上（路径记错就会这样）
    expect(evt.choices[0].apply).not.toBe(evt.choices[1].apply);

    const calls = [];
    const ops = {
      shards: 0,
      hpCostRatio: (r) => calls.push(['hpCostRatio', r]),
      gainShards: (n) => calls.push(['gainShards', n]),
      permanentBonus: (b) => calls.push(['permanentBonus', b]),
      spendShards: () => false,
      healRatio: () => {},
      setShards: () => {},
      fullHeal: () => {},
      addMetadata: () => {},
    };
    evt.choices[0].apply({ player: { hp: 100, maxHp: 100 } }, ops);
    expect(calls).toEqual([['hpCostRatio', 0.2], ['gainShards', 30]]);
    calls.length = 0;
    evt.choices[1].apply({ player: {} }, ops);
    expect(calls).toEqual([['permanentBonus', { attack: 3 }]]);
  });

  it('数组项里白名单外的函数字段也要拒（静默丢=事件选不动）', async () => {
    const h = await host();
    const record = await h.installPack(
      packOf({
        'main.js': `
import { begin, event } from 'fate';
begin({ id: 'poc.stray2', version: '1.0.0' });
event({ id: 'poc.stray2.a', name: '怪祭坛', text: 'x',
  choices: [{ label: 'a', apply: () => {}, onPick: () => {} }] });
`,
      }),
    );
    expect(record.failed).toBe(true);
    expect(record.failureReason).toMatch(/choices\[0\]\.onPick 是函数/);
  });

  it('白名单外的函数字段：直接拒，不静默丢（静默丢=技能看着生效其实没生效）', async () => {
    const h = await host();
    const record = await h.installPack(
      packOf({
        'main.js': `
import { begin, skill } from 'fate';
begin({ id: 'poc.stray', version: '1.0.0' });
skill({ id: 'poc.stray.a', type: 'GCD', gcdCost: 2.4,
  execute: () => {}, onCrit: () => {} });
`,
      }),
    );
    expect(record.failed).toBe(true);
    expect(record.failureReason).toMatch(/onCrit 是函数/);
  });

  it('VM 里抛出的异常会被宿主接住并带出包 id', async () => {
    const h = await host();
    const record = await h.installPack(
      packOf({
        'main.js': `
import { begin, skill } from 'fate';
begin({ id: 'poc.throw', version: '1.0.0' });
throw new Error('包顶层就炸了');
skill({ id: 'poc.throw.a', type: 'GCD', gcdCost: 2.4, execute: () => {} });
`,
      }),
    );
    expect(record.failed).toBe(true);
    expect(record.failureReason).toMatch(/包顶层就炸了/);
    expect(record.registrations).toHaveLength(0);
  });

  it('重复安装同一个包：旧的被干净卸载，注册不累加', async () => {
    const h = await host();
    const first = await h.installPack(packOf());
    expect(h.drainRegistrations(first).skills).toHaveLength(2);
    const second = await h.installPack(packOf());
    expect(second.failed, second.failureReason ?? 'no failure').toBe(false);
    expect(h.drainRegistrations(second).skills).toHaveLength(2);
    expect(h.list()).toHaveLength(1);
  });

  it('无限递归：栈上限拦住，宿主进程/页面还活着', async () => {
    const h = await host();
    const record = await h.installPack(
      packOf({
        'main.js': `
import { begin, skill } from 'fate';
begin({ id: 'poc.recurse', version: '1.0.0' });
skill({ id: 'poc.recurse.deep', type: 'GCD', gcdCost: 2.4,
  execute: (ctx, self) => { const f = (n) => f(n + 1) + self.attack; ctx.query('r=' + f(0)); } });
`,
      }),
    );
    const [skill] = h.drainRegistrations(record).skills;
    // 栈溢出必须是能被接住的 JS 异常（宿主接得住），不能是把页面/进程一起带走
    expect(skill.execute(fakeContext(), SELF, [])).toBeUndefined();
    expect(h.getRecord('poc.smoke').failed).toBe(true);
    expect(h.getRecord('poc.smoke').failureReason).toMatch(/技能执行抛错|栈|stack|RangeError/);
    expect(h.list()).toHaveLength(1);
    // 还能继续用：另一个包装得上
    const other = await h.installPack(packOf({ 'main.js': `
import { begin, skill } from 'fate';
begin({ id: 'poc.after', version: '1.0.0' });
skill({ id: 'poc.after.a', type: 'GCD', gcdCost: 2.4, execute: (ctx) => ctx.log('还活着') });` }, { id: 'poc.after' }));
    expect(other.failed, other.failureReason ?? 'no failure').toBe(false);
  });
});

describe('包对象', () => {
  it('路径规范化拦逃逸', async () => {
    expect(() => createPack({ id: 'a.b', version: '1.0.0', files: { '../evil.js': 'x' } })).toThrow(/\.\./);
    expect(() => createPack({ id: 'a.b', version: '1.0.0', files: { '/etc/passwd.js': 'x' } })).toThrow(/绝对路径/);
    expect(() => createPack({ id: 'a.b', version: '1.0.0', files: { 'a.png': 'x' } })).toThrow(/不支持的文件类型/);
    expect(() => createPack({ id: 'a.b', version: '1.0.0', files: {} })).toThrow(/一个文件都没有/);
    expect(() => createPack({ id: 'a.b', version: '1.0.0', files: { 'main.js': '' }, entry: 'nope.js' })).toThrow(
      /入口文件不在包里/,
    );
    expect(() => createPack({ id: 'nobuild', version: '1.0.0', files: { 'main.js': '' } })).toThrow(/作者\.名字/);
    expect(() => createPack({ id: 'a.b', version: '1', files: { 'main.js': '' } })).toThrow(/三段数字/);
  });

  it('同内容同 hash、改一个字节就变；文件顺序不影响 hash', async () => {
    const a = packOf({ 'main.js': 'x', 'lib/b.js': 'y' });
    const b = packOf({ 'lib/b.js': 'y', 'main.js': 'x' });
    const c = packOf({ 'main.js': 'x2', 'lib/b.js': 'y' });
    expect(await hashPack(a)).toEqual(await hashPack(b));
    expect((await hashPack(a)).hex).not.toBe((await hashPack(c)).hex);
    expect(['sha256', 'fnv1a']).toContain((await hashPack(a)).algo);
  });
});
