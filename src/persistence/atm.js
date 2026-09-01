/**
 * ATM 的持久化 —— 本项目**第一个跨局的数值**。
 *
 * 为什么它必须放在 vanilla 库里、而不是跟着存档切命名空间：
 * `SaveService` 会按「装没装运行时包」选库（vanilla / modded）。ATM 余额属于
 * 玩家这个人，不属于某一局、更不属于某一套内容集 —— 跟着切库就会出现
 * 「装了个包，存款不见了」。这与 `packs.js` 的注册表是同一个道理：
 * **跨局的东西必须永远在同一个可寻址的位置**。
 *
 * 写盘策略：先改内存、再异步落盘（玩家在商店里点"存"不该为一次 IDB 写等待）。
 * 落盘失败必须**响**：那是"钱可能没保住"，静默等于把钱变没了 ——
 * 所以上一层要接 `onPersistError`，而不是 `catch {}` 了事。
 */

import { emptyAtm, normalizeAtm } from '../core/atm.js';
import { pickAdapter } from './storageAdapter.js';

export const ATM_KEY = 'atm';

export class AtmService {
  #adapter = null;
  #state = emptyAtm();
  #loaded = false;
  #onPersistError = null;

  constructor({ onPersistError = null } = {}) {
    this.#onPersistError = onPersistError;
  }

  async init() {
    if (this.#loaded) return this;
    try {
      const { adapter } = await pickAdapter({ modded: false });
      this.#adapter = adapter;
      this.#state = normalizeAtm(await adapter.get(ATM_KEY));
    } catch {
      // 读不到盘 ⇒ 按空账处理（游戏照玩），但要说出来：静默变零最吓人
      this.#state = emptyAtm();
      this.#onPersistError?.('读不到 ATM 数据，本次按空账处理');
    }
    this.#loaded = true;
    return this;
  }

  get adapterKind() {
    return this.#adapter?.kind ?? 'none';
  }

  /** 内存里的当前账（同步读，UI 每帧要用）。返回副本，改不坏内部状态。 */
  get state() {
    return { ...this.#state };
  }

  /**
   * 写入新账（内存立即生效，落盘异步）。
   * @returns {Promise<{ok:boolean, reason?:string}>} 调用方可以不等它（fire-and-forget），
   *   但要接住返回的 promise 以便测试与错误上报
   */
  async save(next) {
    this.#state = normalizeAtm(next);
    if (this.#adapter === null) {
      await this.init();
    }
    try {
      await this.#adapter.set(ATM_KEY, this.#state);
      return { ok: true };
    } catch (error) {
      this.#onPersistError?.(`ATM 没能写入存储（${String(error?.message ?? error)}），本次余额只在内存里`);
      return { ok: false, reason: 'persistFailed' };
    }
  }

  /** 清空跨局资产（设置屏"全部清空"用；调用方必须在确认文案里点名它）。 */
  async clear() {
    this.#state = emptyAtm();
    try {
      if (this.#adapter !== null) await this.#adapter.delete(ATM_KEY);
      return { ok: true };
    } catch (error) {
      this.#onPersistError?.(`ATM 没能从存储清掉（${String(error?.message ?? error)}）`);
      return { ok: false, reason: 'persistFailed' };
    }
  }

  /** 导入合并后的结果直接落盘（saveTransfer 用）。 */
  async replace(next) {
    return this.save(next);
  }
}
