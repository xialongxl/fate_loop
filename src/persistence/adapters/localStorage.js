/**
 * LocalStorage 适配器（降级路径）。
 * 触发场景：隐私模式禁用 IndexedDB、配额耗尽、旧浏览器。
 */

const PREFIX = 'fate-loop:';

export class LocalStorageAdapter {
  kind = 'localstorage';

  async isAvailable() {
    try {
      if (typeof localStorage === 'undefined' || localStorage === null) return false;
      const probe = `${PREFIX}__probe__`;
      localStorage.setItem(probe, '1');
      localStorage.removeItem(probe);
      return true;
    } catch {
      return false;
    }
  }

  async get(key) {
    const raw = localStorage.getItem(PREFIX + key);
    if (raw === null) return undefined;
    try {
      return JSON.parse(raw);
    } catch {
      return undefined;
    }
  }

  async set(key, value) {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  }

  async delete(key) {
    localStorage.removeItem(PREFIX + key);
  }

  async keys() {
    const out = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key !== null && key.startsWith(PREFIX)) out.push(key.slice(PREFIX.length));
    }
    return out.sort();
  }

  async clear() {
    for (const key of await this.keys()) {
      await this.delete(key);
    }
  }
}
