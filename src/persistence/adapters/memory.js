/** 内存适配器：单测与 Node 环境用，无副作用。 */

export class MemoryAdapter {
  kind = 'memory';
  #map = new Map();
  constructor(namespace = 'vanilla') {
    this.namespace = namespace === 'modded' ? 'modded' : 'vanilla';
  }

  async isAvailable() {
    return true;
  }

  async get(key) {
    return this.#map.has(key) ? structuredClone(this.#map.get(key)) : undefined;
  }

  async set(key, value) {
    this.#map.set(key, structuredClone(value));
  }

  async delete(key) {
    this.#map.delete(key);
  }

  async keys() {
    return [...this.#map.keys()].sort();
  }

  async clear() {
    this.#map.clear();
  }
}
