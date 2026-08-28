// @vitest-environment jsdom
/**
 * 存储后端搬家（降级期数据找回）单测。
 *
 * 背景：IndexedDB 版本锁那个 bug 会让浏览器整段时间跑在 localStorage 上；
 * 修好后主后端变回 IndexedDB，若不搬家，玩家刷新一次就看到"存档全空了"。
 * 这里锁三件事：搬得过来、不覆盖已有、探测键不跟着搬。
 */

import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { migrateLocalToIndexedDb, resetAdapterCache } from '../../src/persistence/storageAdapter.js';
import { IndexedDbAdapter } from '../../src/persistence/adapters/indexedDb.js';
import { LocalStorageAdapter } from '../../src/persistence/adapters/localStorage.js';
import { SaveService } from '../../src/persistence/saveService.js';
import { slotKey } from '../../src/persistence/schema.js';

const LS_PREFIX = 'fate-loop:'

function dropDb() {
  return new Promise((resolve) => {
    const request = indexedDB.deleteDatabase('fate-loop');
    request.onsuccess = request.onblocked = request.onerror = () => resolve();
  });
}

let idb;
beforeEach(async () => {
  localStorage.clear();
  await dropDb();
  resetAdapterCache();
  idb = new IndexedDbAdapter();
  expect(await idb.isAvailable()).toBe(true);
});

describe('migrateLocalToIndexedDb', () => {
  it('把 localStorage 里的记录搬进 IndexedDB，键名剥掉前缀', async () => {
    const ls = new LocalStorageAdapter();
    await ls.set(slotKey('slot1'), { slotId: 'slot1', data: { seed: 7 } });
    await ls.set('history', [{ seed: 7 }]);

    const result = await migrateLocalToIndexedDb(idb);
    expect(result.moved).toBe(2);
    expect(await idb.get(slotKey('slot1'))).toEqual({ slotId: 'slot1', data: { seed: 7 } });
    expect(await idb.get('history')).toEqual([{ seed: 7 }]);
  });

  it('不覆盖 IndexedDB 里已有的键', async () => {
    await idb.set(slotKey('slot1'), { slotId: 'slot1', data: { seed: 99 } });
    const ls = new LocalStorageAdapter();
    await ls.set(slotKey('slot1'), { slotId: 'slot1', data: { seed: 1 } });

    const result = await migrateLocalToIndexedDb(idb);
    expect(result).toEqual({ moved: 0, skipped: 1 });
    expect((await idb.get(slotKey('slot1'))).data.seed).toBe(99);
  });

  it('探测键与非本项目的键一律不动', async () => {
    localStorage.setItem(`${LS_PREFIX}__probe__`, '1');
    localStorage.setItem('someone-else:key', 'x');
    localStorage.setItem(`${LS_PREFIX}settings`, JSON.stringify({ volume: 0.2 }));

    const result = await migrateLocalToIndexedDb(idb);
    expect(result.moved).toBe(1);
    expect(await idb.get('settings')).toEqual({ volume: 0.2 });
    expect(await idb.get('__probe__')).toBeUndefined();
    expect(localStorage.getItem('someone-else:key')).toBe('x');
  });

  it('损坏的 JSON 不会中断搬家', async () => {
    localStorage.setItem(`${LS_PREFIX}settings`, '{不是 JSON');
    localStorage.setItem(`${LS_PREFIX}history`, JSON.stringify([{ ok: true }]));

    const result = await migrateLocalToIndexedDb(idb);
    expect(result.moved).toBe(1);
    expect(result.skipped).toBe(1);
    expect(await idb.get('history')).toEqual([{ ok: true }]);
  });
});

describe('SaveService 启动时自动搬家', () => {
  it('降级期写的存档在 init 后就能读到，并报告搬了几条', async () => {
    const ls = new LocalStorageAdapter();
    await ls.set(slotKey('slot2'), {
      slotId: 'slot2',
      savedAt: 123,
      data: { schemaVersion: 2, seed: 4242, floorNumber: 3 },
    });

    const service = new SaveService();
    const info = await service.init();
    expect(info.kind).toBe('indexeddb');
    expect(info.migrated.moved).toBe(1);

    const loaded = await service.loadSlot('slot2');
    expect(loaded.run.seed).toBe(4242);
    // 原件留在 localStorage 当备份：静默删用户数据不是这里的权限
    expect(await ls.get(slotKey('slot2'))).not.toBeNull();
  });
});
