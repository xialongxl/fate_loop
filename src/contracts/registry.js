/**
 * 契约注册表（规格 8.3）。
 * 后注册覆盖先注册；记录来源便于诊断"是哪个模组改了伤害公式"。
 */

import { UnknownContractError, invariant } from '../utils/invariant.js';
import { contractName } from './symbols.js';

export class Registry {
  #impls = new Map();
  #sources = new Map();
  #history = [];

  register(symbol, impl, { source = 'core' } = {}) {
    invariant(typeof symbol === 'symbol', '契约标识必须是 Symbol');
    invariant(typeof impl === 'function', `契约 ${contractName(symbol)} 的实现必须是函数`);

    const previous = this.#sources.get(symbol);
    this.#impls.set(symbol, impl);
    this.#sources.set(symbol, source);
    this.#history.push({ key: contractName(symbol), source, overrode: previous ?? null });
    return this;
  }

  get(symbol) {
    const impl = this.#impls.get(symbol);
    if (impl === undefined) throw new UnknownContractError(contractName(symbol));
    return impl;
  }

  has(symbol) {
    return this.#impls.has(symbol);
  }

  /** 调用契约的便捷方法。 */
  call(symbol, ...args) {
    return this.get(symbol)(...args);
  }

  /** 当前生效的契约清单。 */
  describe() {
    return [...this.#sources.entries()]
      .map(([symbol, source]) => ({ key: contractName(symbol), source }))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  /** 完整覆盖历史，用于排查冲突。 */
  overrideHistory() {
    return [...this.#history];
  }

  clear() {
    this.#impls.clear();
    this.#sources.clear();
    this.#history.length = 0;
    return this;
  }
}
