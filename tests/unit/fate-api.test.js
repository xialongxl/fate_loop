/**
 * `'fate'` API 契约测试（S1.5）。
 *
 * 为什么单独一份：`fate-shim.js` 是第三方包唯一能看到的能力面。它一旦和引擎
 * 实际提供的东西漂移，包作者就会在沙箱里撞到"文档说有、运行时没有"——那是最难查
 * 的一类 bug。所以这里把契约从**两端各测一次**：
 *   · 声明侧：shim 的导出键 == fateApiKeys()
 *   · 实现侧：引擎真的往 ctx 上挂了 CTX_CAPABILITIES 那些能力；
 *             GameFlow 真的往 apply 的第二参数挂上 STATE_OPERATIONS
 * S2 做沙箱注入时，必须再加一条"注入模块的键 == fateApiKeys()"。
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as fate from '../../src/mods/fate-shim.js';
import {
  CTX_CAPABILITIES,
  STATE_OPERATIONS,
  fateApiKeys,
} from '../../src/mods/fate-shim.js';
import { normalizeSkill } from '../../src/core/mods/normalize.js';
import { createHarness } from '../helpers.js';

describe('声明侧：shim 自身的形状', () => {
  it('fateApiKeys() 列出的每一项都真的能从 fate 拿到', () => {
    const missing = fateApiKeys().filter((key) => fate[key] === undefined);
    expect(missing).toEqual([]);
  });

  it('begin 之前注册会明确报错（而不是静默丢内容）', async () => {
    // 拿一个全新的模块实例：本文件其它用例已经 begin 过，共享实例的 currentId 不是 null
    const fresh = await import('../../src/mods/fate-shim.js?noBegin=1');
    expect(() => fresh.skill({ id: 'x', type: 'GCD', execute() {} })).toThrow(/fate\.begin/);
    expect(() => fresh.begin({ id: 'ok', version: '1' })).not.toThrow();
    expect(() => fresh.skill({ id: 'x', type: 'GCD', execute() {} })).not.toThrow();
  });

  it('drainRegistrations 非破坏性：同一个包取两次结果相同', () => {
    fate.begin({ id: 'test.repeat', version: '1.0.0' });
    fate.skill({ id: 'test.repeat.a', type: 'GCD', gcdCost: 1.6, execute() {} });
    fate.finish();
    const first = fate.drainRegistrations('test.repeat');
    const second = fate.drainRegistrations('test.repeat');
    expect(second.skills.map((x) => x.id)).toEqual(first.skills.map((x) => x.id));
    expect(first.skills).toHaveLength(1);
  });

  it('两个包共用同一个 shim 时不互相吞注册', () => {
    fate.begin({ id: 'test.packA', version: '1.0.0' });
    fate.skill({ id: 'a.one', type: 'GCD', gcdCost: 1.6, execute() {} });
    fate.begin({ id: 'test.packB', version: '1.0.0' });
    fate.skill({ id: 'b.one', type: 'GCD', gcdCost: 1.6, execute() {} });

    const a = fate.drainRegistrations('test.packA');
    const b = fate.drainRegistrations('test.packB');
    expect(a.skills.map((x) => x.id)).toEqual(['a.one']);
    expect(b.skills.map((x) => x.id)).toEqual(['b.one']);
  });

  it('注册缺 id 直接抛错，报错里带是哪个 API', () => {
    fate.begin({ id: 'test.bad', version: '1.0.0' });
    expect(() => fate.skill({ type: 'GCD', execute() {} })).toThrow(/fate\.skill/);
    expect(() => fate.monster(null)).toThrow(/fate\.monster/);
  });
});

describe('实现侧：引擎与 GameFlow 真的提供这些能力', () => {
  /** 用探针技能把 ctx 抓出来。 */
  async function captureContext() {
    const h = await createHarness({ seed: 5 });
    const probe = normalizeSkill(
      {
        id: 'probe.ctx',
        name: '探针',
        type: 'GCD',
        gcdCost: 1.6,
        range: 'single',
        execute(ctx) {
          captureContext.captured = ctx;
        },
      },
      'probe',
    );
    h.pool.skills.set(probe.id, probe);
    h.store.update((d) => {
      d.player.gcdSequence = [probe.id];
      d.player.ogcdSlots = [];
    });
    h.flow.enterFloor(1);
    h.engine.begin({ nodeId: 'node_probe', tier: 'normal' });
    h.engine.step();
    expect(captureContext.captured).toBeDefined();
    return captureContext.captured;
  }

  it('ctx 上挂着 CTX_CAPABILITIES 声明的每一项', async () => {
    const ctx = await captureContext();
    const missing = CTX_CAPABILITIES.filter((key) => ctx[key] === undefined);
    expect(missing).toEqual([]);
  });

  it('ctx.damage / ctx.heal 真能改状态（高层别名不是摆设）', async () => {
    const ctx = await captureContext();
    const state = ctx.query();
    expect(state).toBeTruthy();
    const target = ctx.query('monsters')[0];
    const before = target.hp;
    const result = ctx.damage({ sourceId: 'player', targetId: target.id, amount: 30 });
    expect(result.dealt).toBeGreaterThan(0);
    expect(ctx.entity(target.id).hp).toBeLessThan(before);
    ctx.heal({ sourceId: 'player', targetId: target.id, amount: 5 });
    expect(ctx.entity(target.id).hp).toBeLessThanOrEqual(target.maxHp);
    // 路径按 '.' 分段，而实体 id 含点 ⇒ 这种写法必须返回 undefined（别再试图"修好"它）
    expect(ctx.query(`monsters.${target.id}.hp`)).toBeUndefined();
  });

  it('ctx.applyBuff / removeBuff 成对可用', async () => {
    const ctx = await captureContext();
    const target = ctx.query('monsters')[0];
    ctx.applyBuff({ targetId: target.id, buffId: 'probe.buff', stacks: 2, durationMs: 8000 });
    expect(ctx.buffStacks(target, 'probe.buff')).toBe(2);
    expect(ctx.hasBuff(target, 'probe.buff')).toBe(true);
    ctx.removeBuff({ targetId: target.id, buffId: 'probe.buff' });
    expect(ctx.buffStacks(target, 'probe.buff')).toBe(0);
    expect(ctx.hasBuff(target, 'probe.buff')).toBe(false);
  });

  it('ctx.log 与 ctx.sound 不抛错（sound 在无音频资源时静默）', async () => {
    const ctx = await captureContext();
    expect(() => ctx.log('探针日志')).not.toThrow();
    expect(() => ctx.sound('combat.hit')).not.toThrow();
  });

  /** 用探针事件的 apply 抓 ops。 */
  async function captureOps() {
    const h = await createHarness({ seed: 7 });
    h.pool.events.set('probe.event', Object.freeze({
      id: 'probe.event',
      name: '探针',
      text: '',
      weight: 10,
      choices: [Object.freeze({ label: '拿', description: '', apply: (state, ops) => { captureOps.captured = ops; } })],
    }));
    h.flow.enterFloor(1);
    h.flow.resolveEvent('probe.event', 0);
    expect(captureOps.captured).toBeDefined();
    return captureOps.captured;
  }

  it('apply(state, ops) 的 ops 覆盖 STATE_OPERATIONS 声明的每一项', async () => {
    const ops = await captureOps();
    const missing = STATE_OPERATIONS.filter((key) => ops[key] === undefined);
    expect(missing).toEqual([]);
  });

  it('ops 的行为符合声明：永久加成撑得过重算、spendShards 不够不扣钱', async () => {
    const h = await createHarness({ seed: 13 });
    h.pool.shopItems.set('probe.ops', Object.freeze({
      id: 'probe.ops',
      name: '探针',
      description: '',
      cost: 10,
      kind: 'upgrade',
      weight: 10,
      apply(state, o) {
        o.permanentBonus({ attack: 7 });
        o.gainShards(3);
        o.spendShards(1000); // 碎片不够：必须返回 false 且什么都不扣
      },
    }));
    h.flow.enterFloor(1);
    const shop = h.store.unsafeGetState().mapNodes.find((n) => n.type === 'shop');
    h.store.update((d) => { d.currentNodeId = shop.id; d.fateShards = 20; });
    const offers = h.flow.getShopOffers();
    offers.offers.push({ id: 'probe.ops', name: '探针', description: '', cost: 10 });

    expect(h.flow.purchase('probe.ops')).toEqual({ ok: true });
    // 触发一次重算：ops.permanentBonus 给的东西必须活下来（P0-3 那条铁律）
    h.store.update((d) => { d.player.exp += 1; });
    const after = h.store.unsafeGetState();
    expect(after.player.permanentBonus.attack).toBe(7);
    // 20 - 10(买价) + 3(gainShards)，spendShards 那 1000 一分没扣
    expect(after.fateShards).toBe(13);
  });
});

describe('第三方写法的边界（dev/ 目录必须"长得像"第三方包）', () => {
  const DEV_DIR = 'src/mods/dev';

  function jsFiles(dir) {
    const out = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...jsFiles(p));
      else if (entry.name.endsWith('.js')) out.push(p);
    }
    return out;
  }

  it('src/mods/dev/** 只 import「fate」与相对路径（可信层特权不算进示例）', () => {
    const offenders = [];
    for (const file of jsFiles(DEV_DIR)) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
        const spec = match[1];
        const ok = spec === 'fate' || spec.startsWith('./') || spec.startsWith('../');
        if (!ok) offenders.push(`${file} → ${spec}`);
      }
      // 动态 import 也算
      for (const match of source.matchAll(/import\(\s*['"]([^'"]+)['"]/g)) {
        const spec = match[1];
        if (!(spec === 'fate' || spec.startsWith('./') || spec.startsWith('../'))) {
          offenders.push(`${file} → import(${spec})`);
        }
      }
    }
    // 这条测试存在的理由：示例包是"第三方作者的样板"。它一旦 import 了 core，
    // 抄它的人就会写出压成 zip 后加载不了的包 —— 看着能抄、其实装不上。
    expect(offenders).toEqual([]);
  });

  it('示例包能被沙箱式加载（setup 只依赖 fate 与相对路径 ⇒ drain 出来的形状合法）', async () => {
    const mod = await import('../../src/mods/dev/example-pack/setup.js');
    const result = mod.setup();
    expect(result.skills.length).toBeGreaterThanOrEqual(5);
    expect(result.families.map((f) => f.id)).toContain('void');
    expect(result.monsters.length).toBeGreaterThanOrEqual(2);
    // 再取一次必须相同：同一个包被加载两次（测试、热重载）不能变空
    expect(mod.setup().skills.length).toBe(result.skills.length);
  });
});
