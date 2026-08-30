/**
 * 包注册的**商店商品**与**事件**能不能在游戏里真的用 —— S2b-2 的验收。
 *
 * 为什么单独一份：这两类内容的函数签名是 `apply(state, ops)`，和技能那套
 * (ctx, self, targets) 完全不同，而且它们发生在**探索模式**（改的是整局状态，
 * 不是战场）。最要命的一点：官方商品是直接改 `state` 的，而包拿到的是快照 ——
 * 所以这里同时验收"写快照必须响亮地失败，不能静默无效"。
 */
import { describe, it, expect } from 'vitest';
import { loadOfficialPool } from '../helpers.js';
import { createContentPool } from '../../src/core/mods/loader.js';
import { createPack } from '../../src/core/mods/sandbox/pack.js';
import { installSandboxPacks } from '../../src/core/mods/sandbox/index.js';
import { Registry } from '../../src/contracts/registry.js';
import { registerDefaultContracts } from '../../src/contracts/index.js';
import { Store } from '../../src/core/store.js';
import { createInitialState } from '../../src/core/initialState.js';
import { BattleEngine } from '../../src/core/battle/engine.js';
import { GameFlow } from '../../src/core/game.js';
import { NODE_TYPE } from '../../src/core/constants.js';

const clock = () => performance.now();

const PACK = () =>
  createPack({
    id: 'poc.shopgy',
    version: '1.0.0',
    files: {
      'main.js': `
import { begin, shopItem, event } from 'fate';
begin({ id: 'poc.shopgy', version: '1.0.0' });

shopItem({
  id: 'poc.shopgy.tonic', name: '星辉药剂', description: '回 40% 血并加 2 攻。', cost: 25,
  apply: (state, ops) => { ops.healRatio(0.4); ops.permanentBonus({ attack: 2 }); },
});

event({
  id: 'poc.shopgy.crossroads', name: '岔路祭坛', text: '两条路。',
  choices: [
    { label: '取走碎片', apply: (state, ops) => { ops.gainShards(40); ops.hpCostRatio(0.15); } },
    { label: '祈求耐力', apply: (state, ops) => ops.permanentBonus({ maxHp: 25 }) },
  ],
});
`,
    },
  });

async function boot(seed = 60606) {
  const official = await loadOfficialPool();
  const pool = createContentPool();
  for (const kind of Object.keys(pool)) pool[kind] = new Map(official[kind]);

  const store = new Store(createInitialState(seed, { gcdSequence: ['blade.jab'], ogcdSlots: [] }));
  const registry = new Registry();
  const engine = new BattleEngine({ store, registry, pool });
  registerDefaultContracts({
    store,
    getRng: () => engine.getRng(),
    getBuffTable: () => pool.buffs,
    getAudioSink: () => null,
    registry,
  });
  const result = await installSandboxPacks({ entries: [{ pack: PACK() }], pool, engine, clock });
  expect(result.failed, JSON.stringify(result.failed)).toEqual([]);
  const flow = new GameFlow({ store, engine, pool, saveService: null, audio: null });
  flow.enterFloor(1);

  const st = () => store.unsafeGetState();
  const standAt = (type) => {
    const node = st().mapNodes.find((n) => n.type === type);
    if (node === undefined) return null;
    store.update((d) => {
      d.currentNodeId = node.id;
      d.visitedNodeIds.add(node.id);
    });
    return node;
  };
  return { store, flow, pool, st, standAt, host: result.host };
}

describe('包注册的商品与事件', () => {
  it('商品进池且带 apply 函数；事件的选择项各自接上不同函数', async () => {
    const { pool } = await boot();
    const item = pool.shopItems.get('poc.shopgy.tonic');
    expect(item).toMatchObject({ source: 'poc.shopgy', cost: 25 });
    expect(typeof item.apply).toBe('function');

    const evt = pool.events.get('poc.shopgy.crossroads');
    expect(evt.choices).toHaveLength(2);
    expect(typeof evt.choices[0].apply).toBe('function');
    expect(evt.choices[0].apply).not.toBe(evt.choices[1].apply);
  });

  it('买得到：扣碎片由引擎负责，包只施加效果（healRatio + 永久攻击）', async () => {
    // 货架是种子派生的，所以先找一个把包商品摆上货架的局；
    // 注意**必须在同一个实例上购买** —— 上一版在别的实例上找货架、回来却买
    // 自己这个，等于测了个必然不存在的 shopState
    let hit = null;
    for (let i = 1; i <= 60 && hit === null; i += 1) {
      const attempt = await boot(i * 997 + 11);
      if (attempt.standAt(NODE_TYPE.SHOP) === null) continue;
      const shop = attempt.flow.getShopOffers();
      if (shop?.offers.some((o) => o.id === 'poc.shopgy.tonic') !== true) continue;

      attempt.store.update((d) => {
        d.fateShards = 100;
        d.player.hp = 10;
      });
      // 取**标量**而不是对象：unsafeGetState() 返回活对象，存引用等于事后读新值
      const attackBefore = attempt.st().player.attack;
      const result = attempt.flow.purchase('poc.shopgy.tonic');
      expect(result, `购买失败：${result.reason}`).toEqual({ ok: true });
      const after = attempt.st();
      expect(after.fateShards).toBe(75); // 引擎扣的 cost，不是包自己扣
      expect(after.player.hp).toBeGreaterThan(10); // ops.healRatio 生效了
      expect(after.player.attack).toBeGreaterThan(attackBefore); // 永久加成穿过 recalc
      hit = true;
    }
    expect(hit, '60 个种子里包商品从没上过货架（货架生成把包排除了？）').toBe(true);
  });

  it('事件两个选项分别生效：拿碎片扣血 / 加永久生命', async () => {
    const { store, flow, st, standAt } = await boot();
    const node = standAt(NODE_TYPE.EVENT);
    expect(node).not.toBeNull();
    store.update((d) => {
      d.fateShards = 0;
    });

    const picked = flow.getEvent();
    expect(picked).not.toBeNull();
    // 官方 + 包都在池里；直接对包事件求解，验证的是包的 apply 能走通
    const attackBefore = st().player.attack;
    const hpBefore = st().player.hp;
    const result = flow.resolveEvent('poc.shopgy.crossroads', 0);
    expect(result, `事件求解失败：${result.reason}`).toEqual({ ok: true });
    const after = st();
    expect(after.fateShards).toBe(40);
    expect(after.player.hp).toBeLessThan(hpBefore); // 扣了 15% 血
    expect(after.clearedNodeIds.has(node.id)).toBe(true);

    // 第二个选项：永久 maxHp 提升要能穿过 recalcPlayer 活下来（P0-3 那条路）
    node.isCleared = false;
    after.clearedNodeIds.delete(node.id);
    const maxBefore = after.player.maxHp;
    expect(flow.resolveEvent('poc.shopgy.crossroads', 1).ok).toBe(true);
    expect(st().player.maxHp).toBe(maxBefore + 25);
    expect(attackBefore).toBeGreaterThan(0);
  });

  it('包商品试图直接改 state 会**响亮失败**，不会静默无效', async () => {
    const official = await loadOfficialPool();
    const pool = createContentPool();
    for (const kind of Object.keys(pool)) pool[kind] = new Map(official[kind]);
    const store = new Store(createInitialState(7, { gcdSequence: ['blade.jab'], ogcdSlots: [] }));
    const registry = new Registry();
    const engine = new BattleEngine({ store, registry, pool });
    registerDefaultContracts({
      store,
      getRng: () => engine.getRng(),
      getBuffTable: () => pool.buffs,
      getAudioSink: () => null,
      registry,
    });
    const reports = [];
    const { createSandboxHost } = await import('../../src/core/mods/sandbox/host.js');
    const host = await createSandboxHost({ clock, onPackFailure: (id, reason) => reports.push([id, reason]) });
    const bad = createPack({
      id: 'poc.writable',
      version: '1.0.0',
      files: {
        'main.js': `
import { begin, shopItem } from 'fate';
begin({ id: 'poc.writable', version: '1.0.0' });
shopItem({ id: 'poc.writable.x', name: '假的', cost: 1,
  apply: (state) => { state.player.hp = 9999; } });
`,
      },
    });
    const result = await installSandboxPacks({ entries: [{ pack: bad }], pool, host });
    expect(result.failed).toEqual([]);
    const item = pool.shopItems.get('poc.writable.x');

    store.update((d) => {
      d.fateShards = 10;
    });
    // 直接调 apply：快照是冻住的，写它抛错 → 宿主接住、摘包、上报一次
    item.apply(store.unsafeGetState(), {
      shards: 10,
      healRatio: () => {},
      gainShards: () => {},
      spendShards: () => true,
      setShards: () => {},
      hpCostRatio: () => {},
      fullHeal: () => {},
      addMetadata: () => {},
      permanentBonus: () => {},
    });
    expect(store.unsafeGetState().player.hp).not.toBe(9999);
    expect(reports).toHaveLength(1);
    expect(reports[0][1]).toMatch(/read-only|readonly|Cannot assign/i);
    host.dispose();
  });
});
