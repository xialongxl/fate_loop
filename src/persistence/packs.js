/**
 * 已安装第三方包的持久化。
 *
 * 一个必须先说清的**鸡生蛋问题**：装了包之后存档要写进隔离库（§7.2），
 * 但"装没装包"这件事本身必须**在知道答案之前就能读到** —— 所以包注册表
 * 永远放在 vanilla 库里，不进 modded 命名空间。它只是清单，不是进度，
 * 毁掉它的后果是"要重新装一次包"，而不是"没存档"。
 *
 * 存的是**包的全部源文件**（不是"从哪下载"）：GitHub Pages 上没有后端，
 * 玩家从别人那里拿到的就是一个文件，装完就得自包含地活下来。
 */

import { createPack, hashPack } from '../core/mods/sandbox/pack.js';
import { pickAdapter } from './storageAdapter.js';

export const MAX_INSTALLED_PACKS = 8;
const INDEX_KEY = 'packs:index';
const packKey = (id) => `pack:${id}`;

export class PackService {
  #adapter = null;
  #index = null;

  async init() {
    if (this.#adapter !== null) return this;
    const { adapter } = await pickAdapter({ modded: false });
    this.#adapter = adapter;
    const stored = await adapter.get(INDEX_KEY);
    this.#index = Array.isArray(stored) ? stored : [];
    return this;
  }

  get adapterKind() {
    return this.#adapter?.kind ?? 'none';
  }

  /** 清单（不含源文件，UI 列表用）。 */
  async list() {
    await this.init();
    return this.#index.map((row) => ({ ...row }));
  }

  async #writeIndex() {
    await this.#adapter.set(INDEX_KEY, this.#index);
  }

  /**
   * 安装（同 id 覆盖）。
   * @param {{id:string, version:string, files:Map<string,string>|Object, entry?:string, enabled?:boolean}} spec
   */
  async install(spec) {
    await this.init();
    let pack;
    try {
      pack = createPack(spec);
    } catch (error) {
      return { ok: false, reason: error?.message ?? String(error) };
    }
    const hash = await hashPack(pack);
    const existing = this.#index.find((row) => row.id === pack.id);
    if (existing === undefined && this.#index.length >= MAX_INSTALLED_PACKS) {
      return { ok: false, reason: `最多同时安装 ${MAX_INSTALLED_PACKS} 个包，请先卸载一个` };
    }

    const row = {
      id: pack.id,
      version: pack.version,
      entry: pack.entry,
      hash,
      title: spec.title ?? pack.id,
      author: spec.author ?? '未知',
      bytes: pack.bytes,
      files: pack.files.size,
      enabled: spec.enabled !== false,
      installedAt: Date.now(),
    };
    const record = {
      ...row,
      files: [...pack.files.entries()],
    };
    try {
      await this.#adapter.set(packKey(pack.id), record);
    } catch (error) {
      return { ok: false, reason: `写入失败（多半是配额不够）：${error?.message ?? String(error)}` };
    }
    if (existing === undefined) {
      this.#index.push(row);
    } else {
      Object.assign(existing, row);
    }
    await this.#writeIndex();
    return { ok: true, pack: row };
  }

  /** 读回一个可安装的包对象。文件缺失/损坏时返回 null（不抛：坏包不该让启动挂掉）。 */
  async load(id) {
    await this.init();
    const record = await this.#adapter.get(packKey(id));
    if (record === null || record === undefined) return null;
    try {
      const pack = createPack({
        id: record.id,
        version: record.version,
        entry: record.entry,
        files: new Map(record.files ?? []),
      });
      return { pack, meta: record };
    } catch {
      return null;
    }
  }

  /** 所有启用的包（按 id 排序，保证装配顺序确定 —— 顺序会影响覆盖结果）。 */
  async loadEnabled() {
    await this.init();
    const out = [];
    const broken = [];
    for (const row of [...this.#index].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
      if (row.enabled !== true) continue;
      const loaded = await this.load(row.id);
      if (loaded === null) {
        broken.push(row.id);
        continue;
      }
      out.push({ pack: loaded.pack, sha256: row.hash, meta: row });
    }
    return { entries: out, broken };
  }

  async setEnabled(id, enabled) {
    await this.init();
    const row = this.#index.find((r) => r.id === id);
    if (row === undefined) return false;
    row.enabled = Boolean(enabled);
    await this.#writeIndex();
    const record = await this.#adapter.get(packKey(id));
    if (record !== null && record !== undefined) {
      record.enabled = row.enabled;
      await this.#adapter.set(packKey(id), record);
    }
    return true;
  }

  async remove(id) {
    await this.init();
    const before = this.#index.length;
    this.#index = this.#index.filter((row) => row.id !== id);
    if (this.#index.length === before) return false;
    await this.#adapter.delete(packKey(id));
    await this.#writeIndex();
    return true;
  }

  /** 供"清除全部数据"用。 */
  async clearAll() {
    await this.init();
    for (const row of this.#index) await this.#adapter.delete(packKey(row.id));
    this.#index = [];
    await this.#adapter.delete(INDEX_KEY);
  }
}
