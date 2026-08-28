/**
 * StorageAdapter 接口与探测选择（裁决 7）。
 *
 * @typedef {object} StorageAdapter
 * @property {(key:string)=>Promise<any>} get
 * @property {(key:string, value:any)=>Promise<void>} set
 * @property {(key:string)=>Promise<void>} delete
 * @property {()=>Promise<string[]>} keys
 * @property {()=>Promise<boolean>} isAvailable
 * @property {string} kind
 */

import { IndexedDbAdapter } from './adapters/indexedDb.js';
import { LocalStorageAdapter } from './adapters/localStorage.js';
import { MemoryAdapter } from './adapters/memory.js';

let cached = null;

/**
 * 探测并缓存可用适配器：IndexedDB → LocalStorage → Memory。
 * 降级时返回 degraded 标记，UI 应提示"存档仅保留在本浏览器，可能被清理"。
 */
/**
 * @param {object} [options]
 * @param {boolean} [options.force] 忽略缓存重探
 * @param {boolean} [options.modded] 启用了运行时包 ⇒ 用独立命名空间（另一个库/前缀）
 */
export async function pickAdapter({ force = false, modded = false } = {}) {
  if (cached !== null && !force && cached.modded === modded) return cached;

  const namespace = modded ? 'modded' : 'vanilla';
  const candidates = [
    new IndexedDbAdapter(namespace),
    new LocalStorageAdapter(namespace),
    new MemoryAdapter(namespace),
  ];
  /** 每一档的探测结果。降级时必须能说出"是被什么挡住的"。 */
  const attempts = [];

  for (const adapter of candidates) {
    let ok = false;
    try {
      ok = await adapter.isAvailable();
      if (!ok && adapter.kind === 'indexeddb') {
        // 「另一个标签页占着旧版本连接」导致的 onblocked 是瞬时状态：
        // 等一小段时间再试一次，别因为一次撞车就永久退回 localStorage。
        await new Promise((resolve) => setTimeout(resolve, 300));
        ok = await adapter.isAvailable();
      }
    } catch (error) {
      adapter.lastError = String(error?.message ?? error);
      ok = false;
    }
    if (ok) {
      cached = { adapter, degraded: adapter.kind !== 'indexeddb', attempts, modded };
      return cached;
    }
    attempts.push({ kind: adapter.kind, reason: adapter.lastError ?? '探测返回不可用' });
  }

  cached = {
    adapter: new MemoryAdapter(namespace),
    degraded: true,
    modded,
    attempts: [...attempts, { kind: 'memory', reason: '全部后端不可用，仅存内存（刷新即丢）' }],
  };
  return cached;
}

export function resetAdapterCache() {
  cached = null;
}

/** LocalStorageAdapter 的键前缀（搬家时要剥掉）。 */
const LS_PREFIX = 'fate-loop:';

/**
 * 一次性搬家：把降级期间写进 localStorage 的数据搬到 IndexedDB。
 *
 * 为什么必须有：版本锁那个 bug 会让浏览器整整一段时间都跑在 localStorage 上，
 * 修好之后主用后端又变回 IndexedDB —— 不搬的话玩家刷新一次就看到"存档全空了"，
 * 而数据其实一条没丢，只是躺在另一个后端里。
 *
 * 只搬 IndexedDB 里还没有的键（不覆盖），搬完保留 localStorage 原件当备份：
 * 静默删用户数据不是这个模块的权限。
 *
 * @returns {Promise<{moved:number, skipped:number}>}
 */
export async function migrateLocalToIndexedDb(idbAdapter) {
  if (typeof localStorage === 'undefined' || localStorage === null) return { moved: 0, skipped: 0 };

  let moved = 0;
  let skipped = 0;
  const total = Number(localStorage.length ?? 0);

  for (let i = 0; i < total; i += 1) {
    const fullKey = localStorage.key(i);
    if (typeof fullKey !== 'string' || !fullKey.startsWith(LS_PREFIX)) continue;
    const key = fullKey.slice(LS_PREFIX.length);
    if (key === '' || key.startsWith('__')) continue; // 探测键等内部项
    try {
      const existing = await idbAdapter.get(key);
      if (existing !== undefined && existing !== null) {
        skipped += 1;
        continue;
      }
      const raw = localStorage.getItem(fullKey);
      if (raw === null) continue;
      await idbAdapter.set(key, JSON.parse(raw));
      moved += 1;
    } catch {
      skipped += 1;
    }
  }

  return { moved, skipped };
}

export { IndexedDbAdapter, LocalStorageAdapter, MemoryAdapter };
