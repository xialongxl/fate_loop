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
  for (const adapter of candidates) {
    let ok = false;
    try {
      ok = await adapter.isAvailable();
    } catch {
      ok = false;
    }
    if (ok) {
      cached = { adapter, degraded: adapter.kind !== 'indexeddb' };
      return cached;
    }
  }

  cached = { adapter: new MemoryAdapter(), degraded: true };
  return cached;
}

export function resetAdapterCache() {
  cached = null;
}

export { IndexedDbAdapter, LocalStorageAdapter, MemoryAdapter };
