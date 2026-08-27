/** 固定容量环形缓冲。用于战斗日志（规格 8.2，容量 100）。 */

export class RingBuffer {
  #items;
  #capacity;
  #next = 0;
  #size = 0;

  constructor(capacity) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new TypeError(`RingBuffer 容量必须是正整数，实际为 ${String(capacity)}`);
    }
    this.#capacity = capacity;
    this.#items = new Array(capacity);
  }

  push(item) {
    this.#items[this.#next] = item;
    this.#next = (this.#next + 1) % this.#capacity;
    if (this.#size < this.#capacity) this.#size += 1;
    return this;
  }

  /** 按写入顺序（旧 → 新）返回数组。 */
  toArray() {
    if (this.#size < this.#capacity) {
      return this.#items.slice(0, this.#size);
    }
    return [...this.#items.slice(this.#next), ...this.#items.slice(0, this.#next)];
  }

  clear() {
    this.#items = new Array(this.#capacity);
    this.#next = 0;
    this.#size = 0;
    return this;
  }

  get size() {
    return this.#size;
  }

  get capacity() {
    return this.#capacity;
  }
}
