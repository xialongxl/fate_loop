/**
 * 熔炼规则的**跳局默认值**（P2b）。
 *
 * 一句话：规则本身仍是**局内**的（存进 run 存档、随 filterHash 留痕），
 * 但玩家可以「设为默认」，让**下一局开局就带上这套规则**。
 *
 * 为什么不干脆把规则做成跳局设置（参考项目就是 localStorage 全局）：
 * 它会改变本局背包→属性→后续战斗，属于"这一局的决策"，必须能跟着存档走，
 * 否则读老档时"当时的规则"就无从考证（P2 的那条确定性讨论就是为了这件事）。
 * 但"每局都要重配一遍"确实反直觉 —— 所以做成**默认值播种**：
 *   新局：从默认播种 → 玩家可临时改 → 改的是本局；想长期生效就再点一次「设为默认」。
 *
 * 存储位置与 `atm.js`/`packs.js` 同一条理由：**永远在 vanilla 命名空间**。
 * 它是"玩家这个人"的配置，不随"装没装包"切库。
 */

import { defaultLootFilter, normalizeLootFilter } from '../core/lootFilter.js';
import { pickAdapter } from './storageAdapter.js';

export const FILTER_DEFAULTS_KEY = 'lootFilter:default';

export class FilterDefaultsService {
  #adapter = null;
  #value = null;
  #onError = null;

  constructor({ onError = null } = {}) {
    this.#onError = onError;
  }

  async init() {
    if (this.#value !== null) return this;
    try {
      const { adapter } = await pickAdapter({ modded: false });
      this.#adapter = adapter;
      const stored = await adapter.get(FILTER_DEFAULTS_KEY);
      // null 与"全默认"要分得开：没设过默认 ⇒ 新局保持「不自动熔炼」；
      // 设过一套关着的规则 ⇒ 也照它播种（玩家可能就想存一套"开着但很宽"的）
      this.#value = stored === null || stored === undefined ? null : normalizeLootFilter(stored);
    } catch {
      this.#value = null;
      this.#onError?.('读不到熔炼默认规则，本次新局不播种');
    }
    return this;
  }

  /** 当前默认值；null = 没设过（新局不播种）。 */
  get value() {
    return this.#value === null ? null : { ...this.#value };
  }

  async set(filter) {
    this.#value = normalizeLootFilter(filter ?? defaultLootFilter());
    try {
      if (this.#adapter === null) await this.init();
      await this.#adapter.set(FILTER_DEFAULTS_KEY, this.#value);
      return { ok: true };
    } catch (error) {
      this.#onError?.(`熔炼默认规则没能写入存储（${String(error?.message ?? error)}），下一局不会带上它`);
      return { ok: false, reason: 'persistFailed' };
    }
  }

  async clear() {
    this.#value = null;
    try {
      if (this.#adapter !== null) await this.#adapter.delete(FILTER_DEFAULTS_KEY);
      return { ok: true };
    } catch (error) {
      this.#onError?.(`熔炼默认规则没能清掉（${String(error?.message ?? error)}）`);
      return { ok: false, reason: 'persistFailed' };
    }
  }
}
