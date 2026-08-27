/**
 * 屏幕路由（阶段 9）。
 *
 * 契约：每个屏幕是 `{ element, render?(ctx), onEnter?(params), onExit?() }`。
 * 路由器只负责 hidden 切换与生命周期回调，不关心屏幕内部实现。
 *
 * 为什么不用 History API：本作是纯单机工具，没有可分享的 URL 语义，
 * 加 hash 路由只会带来「刷新后停在半路」的状态一致性问题。
 */

import { invariant } from '../utils/invariant.js';

export class ScreenRouter {
  #host;
  #screens = new Map();
  #current = null;
  #listeners = new Set();
  /** 返回栈：设置/图鉴这类「看完就回去」的屏幕用。 */
  #stack = [];

  constructor(host) {
    this.#host = host;
  }

  /**
   * 注册屏幕。element 会被立即挂载并隐藏。
   * @param {string} id SCREEN 枚举值
   * @param {object} screen
   */
  register(id, screen) {
    invariant(typeof id === 'string' && id !== '', 'register 需要屏幕 id');
    invariant(screen?.element instanceof Object, `屏幕 ${id} 必须提供 element`);
    screen.element.classList.add('screen');
    screen.element.dataset.screen = id;
    screen.element.hidden = true;
    this.#host.append(screen.element);
    this.#screens.set(id, screen);
    return this;
  }

  get current() {
    return this.#current;
  }

  has(id) {
    return this.#screens.has(id);
  }

  /** 订阅切屏事件，用于同步导航条高亮。 */
  subscribe(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * 切换到指定屏幕。
   * @param {string} id
   * @param {object} [options]
   * @param {object} [options.params] 传给 onEnter
   * @param {boolean} [options.push] 是否把当前屏压入返回栈
   */
  go(id, { params = null, push = false } = {}) {
    const next = this.#screens.get(id);
    invariant(next !== undefined, `未注册的屏幕：${id}`);
    if (this.#current === id) {
      // 同屏重入仍然要跑 onEnter：参数可能变了（例如从不同入口打开图鉴）
      next.onEnter?.(params);
      this.renderCurrent();
      return this;
    }

    if (push && this.#current !== null) this.#stack.push(this.#current);

    const previous = this.#current === null ? null : this.#screens.get(this.#current);
    previous?.onExit?.();
    if (previous !== null && previous !== undefined) previous.element.hidden = true;

    this.#current = id;
    next.element.hidden = false;
    next.onEnter?.(params);
    this.renderCurrent();

    for (const listener of this.#listeners) listener(id);
    // 切屏后把焦点交给新屏的首个标题，屏幕阅读器才知道上下文变了
    const heading = next.element.querySelector('h1, h2, [tabindex="-1"]');
    heading?.focus?.({ preventScroll: true });
    return this;
  }

  /** 返回上一屏。栈空时回退到 fallback。 */
  back(fallback) {
    const previous = this.#stack.pop();
    return this.go(previous ?? fallback);
  }

  /** 只重绘当前屏。切屏之外的高频状态更新都走这里。 */
  renderCurrent() {
    if (this.#current === null) return;
    this.#screens.get(this.#current)?.render?.();
  }

  clearStack() {
    this.#stack.length = 0;
    return this;
  }
}
