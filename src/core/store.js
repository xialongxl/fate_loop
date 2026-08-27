/**
 * 状态容器（规格 5.1）。
 *
 * 裁决 5：视图状态（缩放/平移）不在此处，独立于 ui/map/viewState.js。
 * 因此任意两次 getSnapshot() 只要种子与操作序列相同，就必须逐字段相等 —— 这是
 * 阶段 1 与阶段 5 确定性单测的断言基础。
 */

import { deepClone, deepFreeze } from '../utils/deepFreeze.js';
import { invariant } from '../utils/invariant.js';

export class Store {
  #state;
  #listeners = new Set();
  #updating = false;

  constructor(initialState) {
    invariant(initialState !== null && typeof initialState === 'object', 'Store 需要初始状态对象');
    this.#state = initialState;
  }

  /**
   * 返回深冻结的状态克隆。用于确定性断言与 UI 渲染。
   * 克隆而非直接冻结内部状态，避免引擎自身的合法写入被冻结阻断。
   */
  getSnapshot() {
    return deepFreeze(deepClone(this.#state));
  }

  /**
   * 直接读取内部状态。仅供引擎内部（契约实现、战斗引擎）使用，不暴露给模组。
   * 模组只能通过 state.query 契约获得只读视图。
   */
  unsafeGetState() {
    return this.#state;
  }

  /**
   * 同步修改状态。mutator 直接操作 draft（即内部状态本身）。
   * 禁止嵌套调用，防止 listener 中再次 update 造成通知风暴。
   */
  update(mutator) {
    invariant(typeof mutator === 'function', 'update 需要函数参数');
    invariant(!this.#updating, 'update 不可嵌套调用');
    this.#updating = true;
    try {
      mutator(this.#state);
    } finally {
      this.#updating = false;
    }
    this.#notify();
    return this;
  }

  /** 静默修改：不触发订阅者。用于战斗引擎的高频单步推进。 */
  updateSilent(mutator) {
    invariant(typeof mutator === 'function', 'updateSilent 需要函数参数');
    mutator(this.#state);
    return this;
  }

  /** 手动触发一次通知。配合 updateSilent 批量修改后调用。 */
  notify() {
    this.#notify();
    return this;
  }

  subscribe(listener) {
    invariant(typeof listener === 'function', 'subscribe 需要函数参数');
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** 重置为新状态，切断旧引用（规格 13 内存保护）。 */
  replace(nextState) {
    invariant(nextState !== null && typeof nextState === 'object', 'replace 需要状态对象');
    this.#state = nextState;
    this.#notify();
    return this;
  }

  #notify() {
    if (this.#listeners.size === 0) return;
    const snapshot = this.getSnapshot();
    for (const listener of this.#listeners) {
      listener(snapshot);
    }
  }
}
