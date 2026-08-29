/**
 * 阶段 7b / 9 持久化验收测试。
 *
 * 用 fake-indexeddb 跑真实的 IndexedDB 路径 —— MemoryAdapter 测不出
 * 「对象存储缺失」「事务已完成后再挂 onsuccess」这两类真实缺陷。
 */

// @vitest-environment jsdom

import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SaveService } from '../../src/persistence/saveService.js';
import { resetAdapterCache } from '../../src/persistence/storageAdapter.js';
import { MemoryAdapter } from '../../src/persistence/adapters/memory.js';
import { IndexedDbAdapter } from '../../src/persistence/adapters/indexedDb.js';
import {
  SAVE_SLOT_IDS,
  createHistoryEntry,
  defaultSettings,
  deserializeRun,
  isAutoSlot,
  serializeRun,
  slotKey,
  slotLabel,
  summarizeSave,
} from '../../src/persistence/schema.js';
import { AUTO_SAVE_SLOT, MANUAL_SAVE_SLOTS, SCHEMA_VERSION } from '../../src/core/constants.js';
import { createHarness } from '../helpers.js';
import { totalExpForLevel } from '../../src/core/progression.js';
import { rollEquipment } from '../../src/core/equipment.js';
import { mulberry32 } from '../../src/core/prng.js';
import { addPermanentBonus, recalcPlayer } from '../../src/core/derived.js';

/** 等待写队列落盘。SaveService 用 setTimeout(0) 调度 flush。 */
async function drain(service) {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await service.flush();
}

/**
 * 清空库。fake-indexeddb 在同一文件内跳过的测试之间是持久的，
 * 不清会让「未写过设置」这类断言读到前一个测试的残留。
 */
async function wipeStorage() {
  const adapter = new IndexedDbAdapter();
  try {
    for (const key of await adapter.keys()) await adapter.delete(key);
  } catch {
    // 库不存在时无需清理
  }
}

beforeEach(async () => {
  resetAdapterCache();
  await wipeStorage();
});

afterEach(() => {
  resetAdapterCache();
});

describe('schema：槽位定义', () => {
  it('槽位数为手动槽 + 1 个自动槽', () => {
    expect(SAVE_SLOT_IDS.length).toBe(MANUAL_SAVE_SLOTS + 1);
    expect(SAVE_SLOT_IDS.at(-1)).toBe(AUTO_SAVE_SLOT);
  });

  it('slotKey 加前缀，避免与 history / settings 键冲突', () => {
    expect(slotKey('slot1')).toBe('run:slot1');
    expect(slotKey(AUTO_SAVE_SLOT)).toBe('run:auto');
  });

  it('isAutoSlot 只对自动槽为真', () => {
    expect(isAutoSlot(AUTO_SAVE_SLOT)).toBe(true);
    expect(isAutoSlot('slot1')).toBe(false);
  });

  it('slotLabel 是可读中文', () => {
    expect(slotLabel(AUTO_SAVE_SLOT)).toBe('自动存档');
    expect(slotLabel('slot2')).toBe('存档位 2');
  });
});

describe('schema：序列化', () => {
  it('serializeRun 是纯函数，不含时间戳', async () => {
    const { store, flow } = await createHarness({ seed: 4242 });
    flow.enterFloor(1);
    const a = serializeRun(store.unsafeGetState());
    const b = serializeRun(store.unsafeGetState());
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).not.toContain('savedAt');
  });

  it('Set 序列化为已排序数组（同状态必得同字节）', async () => {
    const { store, flow } = await createHarness({ seed: 99 });
    flow.enterFloor(1);
    store.updateSilent((draft) => {
      draft.clearedNodeIds = new Set(['node_9_9', 'node_1_1', 'node_5_5']);
    });
    const save = serializeRun(store.unsafeGetState());
    expect(save.clearedNodeIds).toEqual(['node_1_1', 'node_5_5', 'node_9_9']);
  });

  it('通关标记入存档并出现在摘要里（老存档缺字段按未通关）', async () => {
    const { store, flow } = await createHarness({ seed: 77 });
    flow.enterFloor(1);
    expect(serializeRun(store.unsafeGetState()).victoryAchieved).toBe(false);
    expect(summarizeSave(serializeRun(store.unsafeGetState())).victoryAchieved).toBe(false);

    store.update((d) => { d.victoryAchieved = true; });
    const save = serializeRun(store.unsafeGetState());
    expect(save.victoryAchieved).toBe(true);
    expect(summarizeSave(save).victoryAchieved).toBe(true);

    delete save.victoryAchieved;
    expect(summarizeSave(save).victoryAchieved).toBe(false);
  });

  it('不存 level / 派生属性 —— exp 是唯一真相源', async () => {
    const { store, flow } = await createHarness({ seed: 7 });
    flow.enterFloor(1);
    const save = serializeRun(store.unsafeGetState());
    expect(save.exp).toBeDefined();
    expect(save.level).toBeUndefined();
    expect(save.playerMaxHp).toBeUndefined();
    expect(save.playerAttack).toBeUndefined();
    expect(save.playerDefense).toBeUndefined();
  });

  it('装备与背包完整往返', async () => {
    const { store, flow } = await createHarness({ seed: 55 });
    flow.enterFloor(1);
    const gear = rollEquipment({ rng: mulberry32(3), floorNumber: 2, idSuffix: 'test.0' });
    store.updateSilent((draft) => {
      draft.player.equipment[gear.slot] = gear;
      draft.player.inventory = [rollEquipment({ rng: mulberry32(4), floorNumber: 2, idSuffix: 'test.1' })];
    });

    const save = serializeRun(store.unsafeGetState());
    expect(save.equipment[gear.slot].id).toBe('eq.test.0');
    expect(save.equipment[gear.slot].stats).toEqual(gear.stats);
    expect(save.inventory).toHaveLength(1);
    // 未装备的槽位是显式 null，不是缺键
    for (const slot of Object.keys(save.equipment)) {
      expect(save.equipment[slot] === null || typeof save.equipment[slot] === 'object').toBe(true);
    }
  });

  it('deserializeRun 拒读版本不匹配的存档', () => {
    expect(deserializeRun(null)).toBeNull();
    expect(deserializeRun(undefined)).toBeNull();
    expect(() => deserializeRun({ schemaVersion: SCHEMA_VERSION - 1 })).toThrow(/版本不兼容/);
    expect(() => deserializeRun({ schemaVersion: 999 })).toThrow(/版本不兼容/);
    expect(deserializeRun({ schemaVersion: SCHEMA_VERSION, seed: 1 })).toEqual({
      schemaVersion: SCHEMA_VERSION,
      seed: 1,
    });
  });

  it('summarizeSave 对不兼容存档返回标记而不抛错', () => {
    expect(summarizeSave(null)).toBeNull();
    const broken = summarizeSave({ data: { schemaVersion: 1 }, savedAt: 123 });
    expect(broken.incompatible).toBe(true);
    expect(broken.savedAt).toBe(123);
  });

  it('summarizeSave 提取列表所需字段', async () => {
    const { store, flow } = await createHarness({ seed: 31337 });
    flow.enterFloor(3);
    const summary = summarizeSave({ savedAt: 5, data: serializeRun(store.unsafeGetState()) });
    expect(summary.incompatible).toBe(false);
    expect(summary.floorNumber).toBe(3);
    expect(summary.seed).toBe(31337);
    expect(summary.equippedCount).toBe(0);
  });

  it('createHistoryEntry 含等级与经验字段', async () => {
    const { store, flow } = await createHarness({ seed: 8 });
    flow.enterFloor(1);
    const entry = createHistoryEntry(store.unsafeGetState(), { outcome: 'death' });
    expect(entry.outcome).toBe('death');
    expect(entry.level).toBe(1);
    expect(entry.exp).toBe(0);
    expect(entry.schemaVersion).toBe(SCHEMA_VERSION);
  });

  it('defaultSettings 覆盖设置界面全部字段', () => {
    const settings = defaultSettings();
    for (const key of ['muted', 'volume', 'defaultSpeed', 'autoStartBattle', 'logLimit']) {
      expect(settings[key]).toBeDefined();
    }
  });
});

describe('MemoryAdapter', () => {
  it('读写删与 keys 排序', async () => {
    const adapter = new MemoryAdapter();
    expect(await adapter.isAvailable()).toBe(true);
    expect(await adapter.get('missing')).toBeUndefined();

    await adapter.set('b', { n: 1 });
    await adapter.set('a', { n: 2 });
    expect(await adapter.keys()).toEqual(['a', 'b']);

    await adapter.delete('a');
    expect(await adapter.get('a')).toBeUndefined();
  });

  it('存取都做结构化克隆（外部修改不污染已存值）', async () => {
    const adapter = new MemoryAdapter();
    const value = { list: [1, 2] };
    await adapter.set('k', value);
    value.list.push(3);
    expect((await adapter.get('k')).list).toEqual([1, 2]);
  });
});

describe('IndexedDbAdapter（fake-indexeddb）', () => {
  it('可用性探测通过并能读写', async () => {
    const adapter = new IndexedDbAdapter();
    expect(await adapter.isAvailable()).toBe(true);

    await adapter.set('probe', { hello: 'world' });
    expect(await adapter.get('probe')).toEqual({ hello: 'world' });

    await adapter.delete('probe');
    expect(await adapter.get('probe')).toBeUndefined();
  });

  it('缺失对象存储时自愈：删库后重新打开仍可写入', async () => {
    const adapter = new IndexedDbAdapter();
    await adapter.set('before', 1);

    // 模拟外部把库删掉（等价于用户在 DevTools 里清数据）
    await new Promise((resolve) => {
      const request = indexedDB.deleteDatabase('fate-loop');
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
      request.onblocked = () => resolve();
    });

    // 适配器应重新建库而不是永久失效
    const fresh = new IndexedDbAdapter();
    await fresh.set('after', 2);
    expect(await fresh.get('after')).toBe(2);
  });

  it('keys 返回已排序键', async () => {
    const adapter = new IndexedDbAdapter();
    await adapter.set('zeta', 1);
    await adapter.set('alpha', 1);
    const keys = await adapter.keys();
    expect([...keys].sort()).toEqual(keys);
  });
});

describe('SaveService：槽位读写', () => {
  it('init 报告适配器种类', async () => {
    const service = new SaveService();
    const info = await service.init();
    expect(info.kind).toBe('indexeddb');
    expect(info.degraded).toBe(false);
  });

  it('saveRun 写入自动槽', async () => {
    const { store, flow } = await createHarness({ seed: 1234 });
    const service = new SaveService();
    await service.init();

    flow.enterFloor(2);
    service.saveRun(store.unsafeGetState());
    await drain(service);

    const loaded = await service.loadSlot(AUTO_SAVE_SLOT);
    expect(loaded.run.floorNumber).toBe(2);
    expect(loaded.run.seed).toBe(1234);
    expect(Number.isFinite(loaded.savedAt)).toBe(true);
  });

  it('手动槽彼此独立，不互相覆盖', async () => {
    const { store, flow } = await createHarness({ seed: 777 });
    const service = new SaveService();
    await service.init();

    flow.enterFloor(1);
    service.saveToSlot('slot1', store.unsafeGetState());
    flow.enterFloor(5);
    service.saveToSlot('slot2', store.unsafeGetState());
    await drain(service);

    expect((await service.loadSlot('slot1')).run.floorNumber).toBe(1);
    expect((await service.loadSlot('slot2')).run.floorNumber).toBe(5);
    expect(await service.loadSlot('slot3')).toBeNull();
  });

  it('刚存就读能读到最新值（待写项优先）', async () => {
    const { store, flow } = await createHarness({ seed: 31 });
    const service = new SaveService();
    await service.init();

    flow.enterFloor(9);
    service.saveToSlot('slot1', store.unsafeGetState());
    // 故意不 drain：待写项仍在队列里
    const loaded = await service.loadSlot('slot1');
    expect(loaded.run.floorNumber).toBe(9);
  });

  it('同 key 合写：高频入队只落盘最后一份', async () => {
    const { store, flow } = await createHarness({ seed: 5 });
    const service = new SaveService();
    await service.init();

    for (let floor = 1; floor <= 5; floor += 1) {
      flow.enterFloor(floor);
      service.saveRun(store.unsafeGetState());
    }
    await drain(service);

    expect((await service.loadSlot(AUTO_SAVE_SLOT)).run.floorNumber).toBe(5);
  });

  it('listSlots 列出全部槽位，空槽标 empty', async () => {
    const { store, flow } = await createHarness({ seed: 606 });
    const service = new SaveService();
    await service.init();

    flow.enterFloor(4);
    service.saveToSlot('slot2', store.unsafeGetState());
    await drain(service);

    const slots = await service.listSlots();
    expect(slots.map((s) => s.slotId)).toEqual([...SAVE_SLOT_IDS]);

    const slot2 = slots.find((s) => s.slotId === 'slot2');
    expect(slot2.empty).toBe(false);
    expect(slot2.floorNumber).toBe(4);
    expect(slot2.auto).toBe(false);

    const auto = slots.find((s) => s.slotId === AUTO_SAVE_SLOT);
    expect(auto.empty).toBe(true);
    expect(auto.auto).toBe(true);
  });

  it('deleteSlot 同时清掉待写项（不会“删了又被写回来”）', async () => {
    const { store, flow } = await createHarness({ seed: 808 });
    const service = new SaveService();
    await service.init();

    flow.enterFloor(1);
    service.saveToSlot('slot1', store.unsafeGetState());
    await service.deleteSlot('slot1');
    await drain(service);

    expect(await service.loadSlot('slot1')).toBeNull();
  });

  it('clearRun 只清自动槽，手动槽保留', async () => {
    const { store, flow } = await createHarness({ seed: 909 });
    const service = new SaveService();
    await service.init();

    flow.enterFloor(1);
    service.saveToSlot('slot1', store.unsafeGetState());
    service.saveRun(store.unsafeGetState());
    await drain(service);

    await service.clearRun();
    expect(await service.loadSlot(AUTO_SAVE_SLOT)).toBeNull();
    expect(await service.loadSlot('slot1')).not.toBeNull();
  });
});

describe('SaveService：历史与设置', () => {
  it('历史记录最新在前且上限 50 条', async () => {
    const { store, flow } = await createHarness({ seed: 111 });
    const service = new SaveService();
    await service.init();
    flow.enterFloor(1);

    for (let i = 0; i < 55; i += 1) {
      store.updateSilent((draft) => {
        draft.floorNumber = i + 1;
      });
      await service.appendHistory(store.unsafeGetState(), { outcome: 'death' });
    }

    const history = await service.loadHistory();
    expect(history.length).toBe(50);
    expect(history[0].floorReached).toBe(55);
    expect(history.at(-1).floorReached).toBe(6);
  });

  it('clearHistory 清空', async () => {
    const { store, flow } = await createHarness({ seed: 222 });
    const service = new SaveService();
    await service.init();
    flow.enterFloor(1);

    await service.appendHistory(store.unsafeGetState(), { outcome: 'death' });
    await service.clearHistory();
    expect(await service.loadHistory()).toEqual([]);
  });

  it('设置缺失字段用默认值补齐（新增设置项不会让老存档缺键）', async () => {
    const service = new SaveService();
    await service.init();

    service.saveSettings({ muted: true });
    await drain(service);

    const settings = await service.loadSettings();
    expect(settings.muted).toBe(true);
    expect(settings.volume).toBe(defaultSettings().volume);
    expect(settings.defaultSpeed).toBe(defaultSettings().defaultSpeed);
  });

  it('未写过设置时返回全默认值', async () => {
    const service = new SaveService();
    await service.init();
    expect(await service.loadSettings()).toEqual(defaultSettings());
  });
});

describe('存档往返：restoreRun', () => {
  it('读档后地图、进度、装备、等级完全一致', async () => {
    const harness = await createHarness({ seed: 246810 });
    const service = new SaveService();
    await service.init();

    harness.flow.enterFloor(3);
    const gear = rollEquipment({ rng: mulberry32(9), floorNumber: 3, idSuffix: 'rt.0' });
    harness.store.updateSilent((draft) => {
      draft.player.exp = totalExpForLevel(12);
      draft.player.equipment[gear.slot] = gear;
      draft.player.inventory = [
        rollEquipment({ rng: mulberry32(10), floorNumber: 3, idSuffix: 'rt.1' }),
      ];
      draft.fateShards = 137;
      draft.clearedNodeIds = new Set([draft.startNodeId]);
      recalcPlayer(draft.player, { fullHeal: true });
    });

    const before = harness.store.getSnapshot();
    service.saveToSlot('slot1', harness.store.unsafeGetState());
    await drain(service);

    // 在一个全新的装配上恢复 —— 模拟重开浏览器
    const fresh = await createHarness({ seed: 1 });
    const { run } = await service.loadSlot('slot1');
    fresh.flow.restoreRun(run);
    const after = fresh.store.getSnapshot();

    expect(after.seed).toBe(before.seed);
    expect(after.floorNumber).toBe(before.floorNumber);
    expect(after.currentNodeId).toBe(before.currentNodeId);
    expect(after.fateShards).toBe(137);
    expect(after.player.level).toBe(12);
    expect(after.player.exp).toBe(before.player.exp);
    expect(after.player.maxHp).toBe(before.player.maxHp);
    expect(after.player.attack).toBe(before.player.attack);
    expect(after.player.defense).toBe(before.player.defense);
    expect(after.player.equipment[gear.slot].id).toBe(gear.id);
    expect(after.player.inventory).toHaveLength(1);
    // 地图不入存档，由 (seed, floor) 重建，必须逐节点一致
    expect(after.mapNodes.map((n) => n.id)).toEqual(before.mapNodes.map((n) => n.id));
    expect(after.mapNodes.map((n) => n.type)).toEqual(before.mapNodes.map((n) => n.type));
    expect(after.mapAdjacency).toEqual(before.mapAdjacency);
  });

  it('读档后 hp 不超过重算的 maxHp', async () => {
    const harness = await createHarness({ seed: 13579 });
    harness.flow.enterFloor(1);
    const save = serializeRun(harness.store.unsafeGetState());
    // 伪造一个超额 hp 的存档（等价于降级成长曲线后读老档）
    save.playerHp = 10 ** 6;

    const fresh = await createHarness({ seed: 2 });
    fresh.flow.restoreRun(save);
    const state = fresh.store.unsafeGetState();
    expect(state.player.hp).toBeLessThanOrEqual(state.player.maxHp);
    expect(state.player.hp).toBeGreaterThanOrEqual(1);
  });

  it('永久加成随存档往返，不靠重算丢失', async () => {
    const harness = await createHarness({ seed: 31337 });
    harness.flow.enterFloor(2);
    harness.store.update((draft) => {
      addPermanentBonus(draft.player, { maxHp: 100, attack: -4, defense: 6 });
      recalcPlayer(draft.player);
    });
    const before = harness.store.getSnapshot();

    const save = serializeRun(harness.store.unsafeGetState());
    expect(save.permanentBonus).toEqual({ maxHp: 100, attack: -4, defense: 6, crit: 0 });

    const fresh = await createHarness({ seed: 1 });
    fresh.flow.restoreRun(save);
    const after = fresh.store.unsafeGetState();
    expect(after.player.permanentBonus).toEqual(save.permanentBonus);
    expect(after.player.maxHp).toBe(before.player.maxHp);
    expect(after.player.attack).toBe(before.player.attack);
    expect(after.player.defense).toBe(before.player.defense);
  });

  it('缺 permanentBonus 的旧 v2 存档仍可读，按全零处理', async () => {
    const harness = await createHarness({ seed: 4242 });
    harness.flow.enterFloor(1);
    const save = serializeRun(harness.store.unsafeGetState());
    delete save.permanentBonus;

    const fresh = await createHarness({ seed: 9 });
    expect(() => fresh.flow.restoreRun(save)).not.toThrow();
    expect(fresh.store.unsafeGetState().player.permanentBonus).toEqual({
      maxHp: 0,
      attack: 0,
      defense: 0,
      crit: 0,
    });
  });

  it('读档恢复商店已购记录，且商品列表由种子重建', async () => {
    const harness = await createHarness({ seed: 24680 });
    harness.flow.enterFloor(1);
    const save = serializeRun(harness.store.unsafeGetState());
    save.shopPurchases = [['node_1_1', ['shop.tonic']]];

    const fresh = await createHarness({ seed: 3 });
    fresh.flow.restoreRun(save);
    const shopState = fresh.store.unsafeGetState().shopStates.get('node_1_1');
    expect(shopState.purchasedIds.has('shop.tonic')).toBe(true);
    // offers 为空数组 —— 由 getShopOffers 首次调用时按种子重建
    expect(shopState.offers).toEqual([]);
  });
});

describe('命名空间隔离与存档凭据（S1）', () => {
  it('存档记录带 contentHash，loadSlot 把它原样带出来', async () => {
    const service = new SaveService();
    await service.init();
    service.provideFingerprint(() => ({ hash: 'cafe1234', mods: [{ id: 'm', version: '1' }], packs: [] }));

    const { store, flow } = await createHarness({ seed: 12 });
    flow.enterFloor(1);
    service.saveToSlot('slot1', store.unsafeGetState());
    await service.flush();

    const loaded = await service.loadSlot('slot1');
    expect(loaded.contentHash).toBe('cafe1234');
    expect(loaded.contentMods).toEqual([{ id: 'm', version: '1' }]);
    const [first] = await service.listSlots();
    expect(first.contentHash).toBe('cafe1234');
  });

  it('modded 与 vanilla 是两个互不可见的库', async () => {
    const vanilla = new SaveService();
    await vanilla.init({ modded: false });
    const { store, flow } = await createHarness({ seed: 24 });
    flow.enterFloor(1);
    vanilla.saveToSlot('slot1', store.unsafeGetState());
    await vanilla.flush();

    const modded = new SaveService();
    await modded.init({ modded: true });
    expect(modded.modded).toBe(true);
    expect(await modded.loadSlot('slot1')).toBeNull(); // 看不见 vanilla 的档

    modded.saveToSlot('slot1', store.unsafeGetState());
    await modded.flush();
    expect(await modded.loadSlot('slot1')).not.toBeNull();
    const stillThere = await vanilla.loadSlot('slot1');
    expect(stillThere.savedAt).not.toBeNull();
  });

  it('没有注入指纹提供者时，存档照样能写（不因缺凭据而失败）', async () => {
    const service = new SaveService();
    await service.init();
    const { store, flow } = await createHarness({ seed: 36 });
    flow.enterFloor(1);
    service.saveToSlot('slot2', store.unsafeGetState());
    await service.flush();
    const loaded = await service.loadSlot('slot2');
    expect(loaded.contentHash).toBeNull();
    expect(loaded.run.seed).toBe(36);
  });
});

describe('降级原因要能被说出来（不能只说"降级"）', () => {
  it('IndexedDB 不可用时，attempts 里带着具体原因', async () => {
    const savedIdb = globalThis.indexedDB;
    delete globalThis.indexedDB;
    resetAdapterCache();
    try {
      const service = new SaveService();
      const info = await service.init();
      expect(info.kind).not.toBe('indexeddb');
      expect(info.degraded).toBe(true);
      const idb = info.attempts.find((a) => a.kind === 'indexeddb');
      expect(idb).toBeDefined();
      expect(idb.reason).toContain('IndexedDB');
    } finally {
      globalThis.indexedDB = savedIdb;
      resetAdapterCache();
    }
  });

  it('一切正常时 attempts 为空数组', async () => {
    resetAdapterCache();
    const service = new SaveService();
    const info = await service.init();
    expect(info.kind).toBe('indexeddb');
    expect(info.degraded).toBe(false);
    expect(info.attempts).toEqual([]);
  });
});

describe('IndexedDB 版本自愈不能反过来锁死自己', () => {
  /** 用指定版本直接建库（绕开适配器，模拟用户浏览器里已有的状态）。 */
  function openRaw(version, { withStore = true } = {}) {
    return new Promise((resolve, _reject) => {
      const request = indexedDB.open('fate-loop', version);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (withStore && !db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      };
      request.onsuccess = () => {
        request.result.close();
        resolve();
      };
      request.onerror = () => _reject(request.error ?? new Error('open 失败'));
    });
  }

  function dropDb() {
    // 删除失败/被阻塞都继续往下走：每个用例自己先 drop 再建，状态是干净的
    return new Promise((resolve) => {
      const request = indexedDB.deleteDatabase('fate-loop');
      request.onsuccess = request.onblocked = request.onerror = () => resolve();
    });
  }

  it('库已被自愈提到版本 2 时，适配器仍能打开并读写（旧实现会永久降级）', async () => {
    await dropDb();
    await openRaw(2);

    const adapter = new IndexedDbAdapter();
    expect(await adapter.isAvailable()).toBe(true);
    expect(adapter.lastError).toBeNull();

    await adapter.set('run:slot1', { hello: 'world' });
    expect(await adapter.get('run:slot1')).toEqual({ hello: 'world' });
    await dropDb();
    resetAdapterCache();
  });

  it('库存在但缺仓库时，自愈提版本后仍可用', async () => {
    await dropDb();
    await openRaw(1, { withStore: false });

    const adapter = new IndexedDbAdapter();
    expect(await adapter.isAvailable()).toBe(true);
    await adapter.set('k', 7);
    expect(await adapter.get('k')).toBe(7);
    await dropDb();
    resetAdapterCache();
  });

  it('全新浏览器环境下首次打开即建库建仓库', async () => {
    await dropDb();
    const adapter = new IndexedDbAdapter();
    expect(await adapter.isAvailable()).toBe(true);
    await adapter.set('a', 1);
    expect(await adapter.keys()).toEqual(['a']);
    await dropDb();
    resetAdapterCache();
  });
});

describe('上一局自动档备份（误点开局的后悔药）', () => {
  it('backupAutoSave 把自动档复制走，原档不动', async () => {
    const service = new SaveService();
    await service.init();
    const { store, flow } = await createHarness({ seed: 88 });
    flow.enterFloor(1);
    service.saveRun(store.unsafeGetState());
    await service.flush();

    expect(await service.backupAutoSave()).toEqual({ ok: true });
    const prev = await service.loadPrevAuto();
    expect(prev.run.seed).toBe(88);
    expect((await service.loadSlot('auto')).run.seed).toBe(88); // 原档还在

    // 备份不出现在存档列表里（它不是第四个格子）
    const slots = await service.listSlots();
    expect(slots.map((s) => s.slotId)).not.toContain('autoPrev');
  });

  it('没有自动档时备份是安全的空操作', async () => {
    const service = new SaveService();
    await service.init();
    expect(await service.backupAutoSave()).toEqual({ ok: false, reason: 'noAutoSave' });
    expect(await service.loadPrevAuto()).toBeNull();
  });

  it('读回备份后可删除；clearAll 一并清掉', async () => {
    const service = new SaveService();
    await service.init();
    const { store, flow } = await createHarness({ seed: 121 });
    flow.enterFloor(1);
    service.saveRun(store.unsafeGetState());
    await service.flush();
    await service.backupAutoSave();
    expect(await service.loadPrevAuto()).not.toBeNull();

    await service.deletePrevAuto();
    expect(await service.loadPrevAuto()).toBeNull();

    service.saveRun(store.unsafeGetState());
    await service.flush();
    await service.backupAutoSave();
    await service.clearAll();
    expect(await service.loadPrevAuto()).toBeNull();
    expect(await service.loadSlot('auto')).toBeNull();
  });
});
