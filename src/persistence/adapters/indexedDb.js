/**
 * IndexedDB 适配器（主用）。
 *
 * 不引入 idb / Dexie：本项目只需要 get/set/delete/keys 四个操作，
 * 原生 API 包一层 Promise 即可，不值得为此加运行时依赖。
 */

/**
 * 库名按命名空间分开：装了运行时包（modded）的运行写另一个库，
 * 这样最坏情况从"毁掉你所有存档"降到"毁掉一个沙箱库"。
 * 见 docs/模组沙箱与包格式设计.md §7.2。
 */
const DB_NAMES = Object.freeze({ vanilla: 'fate-loop', modded: 'fate-loop-modded' });
/** 期望的最低版本。只用于自愈时算下一个版本号，绝不拿它当 open 的参数（见 #openDb）。 */
const DB_MIN_VERSION = 1;
const STORE_NAME = 'kv';

export class IndexedDbAdapter {
  kind = 'indexeddb';
  #db;
  constructor(namespace = 'vanilla') {
    this.namespace = namespace === 'modded' ? 'modded' : 'vanilla';
    this.#db = DB_NAMES[this.namespace];
  }
  /** 最近一次探测失败的原因。降级提示要说清"为什么"，光说"降级"没法排查。 */
  lastError = null;
  #dbPromise = null;

  /**
   * 打开指定版本；version 为 undefined 时打开浏览器里的当前版本。
   * @param {number|undefined} version 绝不传"比现存版本低"的号，见 #openDb
   */
  #rawOpen(version) {
    return new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined' || indexedDB === null) {
        reject(new Error('IndexedDB 不可用'));
        return;
      }
      const request =
        version === undefined ? indexedDB.open(this.#db) : indexedDB.open(this.#db, version);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('IndexedDB 打开失败'));
      request.onblocked = () => reject(new Error('IndexedDB 打开被阻塞：请关闭本站的其他标签页'));
    });
  }

  /**
   * 打开库。**必须不带版本号去开**：
   *
   * 曾经这里写的是 `open(name, DB_VERSION=1)`，而下面的自愈逻辑可能已经把用户的库
   * 提到版本 2 —— 再请求版本 1 会抛 `VersionError: The requested version (1) is
   * less than the existing version (2)`，于是每次加载都失败，永久降级到 localStorage。
   * 不带版本即"打开当前版本"，新库会以版本 1 创建并触发 onupgradeneeded，
   * 老库（含被自愈提过版本的）也能正常打开。
   */
  #openDb() {
    if (this.#dbPromise !== null) return this.#dbPromise;

    this.#dbPromise = (async () => {
      let db = await this.#rawOpen(undefined);

      // 自愈：库已存在但缺少对象仓库时，onupgradeneeded 不会触发，
      // 后续 transaction() 会抛 NotFoundError。此时提版本号强制走一次升级。
      // 触发场景：早期版本用过别的仓库名、升级事务曾被中止、或用户手工删过仓库。
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const nextVersion = Math.max(DB_MIN_VERSION, db.version) + 1;
        db.close();
        this.#dbPromise = null;
        db = await this.#rawOpen(nextVersion);
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          throw new Error(`IndexedDB 仓库 ${STORE_NAME} 创建失败`);
        }
      }

      // 另一标签页触发升级时主动让位，避免长期持有旧连接把对方 block 住
      db.onversionchange = () => {
        db.close();
        this.#dbPromise = null;
      };

      return db;
    })();

    // 失败不缓存被拒绝的 promise，否则一次瞬时故障会永久禁用 IndexedDB
    this.#dbPromise.catch(() => {
      this.#dbPromise = null;
    });

    return this.#dbPromise;
  }

  async isAvailable() {
    try {
      const db = await this.#openDb();
      const ok = db !== null && db !== undefined && db.objectStoreNames.contains(STORE_NAME);
      if (!ok) this.lastError = '库能打开但缺少 kv 仓库';
      return ok;
    } catch (error) {
      this.lastError = String(error?.message ?? error);
      return false;
    }
  }

  /**
   * 在一个事务里跑 fn，并以「请求的 result」而非「请求对象」兑现。
   *
   * 注意：不能在 tx.oncomplete 之后再给 request 挂 onsuccess —— 那时事件早已派发完，
   * 处理器永不触发，await 会永久挂起。所以必须在请求发出的同时就捕获结果。
   */
  async #withStore(mode, fn) {
    const db = await this.#openDb();
    return new Promise((resolve, reject) => {
      let tx;
      try {
        tx = db.transaction(STORE_NAME, mode);
      } catch (error) {
        // 连接已失效（仓库缺失/库被删除）时丢弃缓存，下次调用重新打开并自愈
        this.#dbPromise = null;
        reject(error);
        return;
      }

      const store = tx.objectStore(STORE_NAME);
      let result;
      try {
        const request = fn(store);
        if (request !== undefined && request !== null) {
          request.onsuccess = () => {
            result = request.result;
          };
        }
      } catch (error) {
        tx.abort();
        reject(error);
        return;
      }

      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB 事务失败'));
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB 事务被中止'));
    });
  }

  async get(key) {
    return this.#withStore('readonly', (store) => store.get(key));
  }

  async set(key, value) {
    await this.#withStore('readwrite', (store) => store.put(value, key));
  }

  async delete(key) {
    await this.#withStore('readwrite', (store) => store.delete(key));
  }

  async keys() {
    const result = await this.#withStore('readonly', (store) => store.getAllKeys());
    return [...(result ?? [])].map(String).sort();
  }

  async clear() {
    await this.#withStore('readwrite', (store) => store.clear());
  }
}
