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
export async function pickAdapter({ force = false } = {}) {
  if (cached !== null && !force) return cached;

  const candidates = [new IndexedDbAdapter(), new LocalStorageAdapter(), new MemoryAdapter()];
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
      cached = { adapter, degraded: adapter.kind !== 'indexeddb', attempts };
      return cached;
    }
    attempts.push({ kind: adapter.kind, reason: adapter.lastError ?? '探测返回不可用' });
  }

  cached = {
    adapter: new MemoryAdapter(),
    degraded: true,
    attempts: [...attempts, { kind: 'memory', reason: '全部后端不可用，仅存内存（刷新即丢）' }],
  };
  return cached;
}

export function resetAdapterCache() {
  cached = null;
}

export { IndexedDbAdapter, LocalStorageAdapter, MemoryAdapter };
