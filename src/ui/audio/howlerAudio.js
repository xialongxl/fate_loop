/**
 * Howler 音频 sink（裁决 8）。
 *
 * 内部永不抛错：Howler 未安装、资源 404、浏览器自动播放策略拦截，全部静默降级为
 * 无声。这不是"容错"而是硬性设计约束 —— 音频层的任何异常都不得影响游戏进行。
 */

import { createThrottle } from './throttle.js';
import { SOUND_MANIFEST } from './soundMap.js';

export class HowlerAudio {
  kind = 'howler';
  #sounds = new Map();
  #throttle = createThrottle();
  #muted = false;
  #volume = 0.6;
  #HowlCtor = null;

  /**
   * 异步初始化。动态 import 使 Howler 成为可选依赖：
   * 即使包缺失，游戏依然完整可玩（只是无声）。
   */
  async init() {
    try {
      const mod = await import('howler');
      this.#HowlCtor = mod.Howl ?? mod.default?.Howl ?? null;
    } catch {
      this.#HowlCtor = null;
      return this;
    }
    this.preload();
    return this;
  }

  preload() {
    if (this.#HowlCtor === null) return;
    for (const entry of SOUND_MANIFEST) {
      try {
        this.#sounds.set(
          entry.id,
          new this.#HowlCtor({
            src: entry.src,
            volume: entry.volume,
            preload: false,
            // 资源缺失时静默：不打日志，避免控制台被 404 淹没
            onloaderror: () => {},
            onplayerror: () => {},
          }),
        );
      } catch {
        // 单个音效构造失败不影响其他
      }
    }
  }

  play(soundId, { volume } = {}) {
    try {
      if (this.#muted || this.#HowlCtor === null) return;
      if (!this.#throttle.allow(soundId)) return;

      const sound = this.#sounds.get(soundId);
      if (sound === undefined) {
        this.#throttle.release();
        return;
      }
      sound.volume((volume ?? 1) * this.#volume);
      sound.once('end', () => this.#throttle.release());
      sound.once('playerror', () => this.#throttle.release());
      sound.play();
    } catch {
      this.#throttle.release();
    }
  }

  setMuted(muted) {
    this.#muted = Boolean(muted);
    if (this.#muted) this.#throttle.reset();
  }

  get muted() {
    return this.#muted;
  }

  setVolume(volume) {
    this.#volume = Math.min(1, Math.max(0, Number(volume) || 0));
  }

  dispose() {
    for (const sound of this.#sounds.values()) {
      try {
        sound.unload();
      } catch {
        // 忽略
      }
    }
    this.#sounds.clear();
    this.#throttle.reset();
  }
}
