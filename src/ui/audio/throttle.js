/**
 * 音效节流阀（裁决 8）。
 *
 * 两道限制：
 *   1. 同一 soundId 在 50ms 窗口内去重 —— 4x 模式下同类事件密集触发时防止刺耳堆叠
 *   2. 全局并发上限 8 路，超出时丢弃新声音（不打断旧声音）
 *
 * 使用 performance.now() 是允许的：只位于 ui/audio/**，不参与任何逻辑判定，
 * 且 MAX 模式下整个 sink 被替换为 nullAudio，物理时钟根本不会被读到。
 */

const DEDUPE_WINDOW_MS = 50;
const MAX_CONCURRENT = 8;

export function createThrottle({ now = () => performance.now() } = {}) {
  const lastPlayed = new Map();
  let active = 0;

  return {
    /** @returns {boolean} 是否允许播放 */
    allow(soundId) {
      const t = now();
      const last = lastPlayed.get(soundId);
      if (last !== undefined && t - last < DEDUPE_WINDOW_MS) return false;
      if (active >= MAX_CONCURRENT) return false;
      lastPlayed.set(soundId, t);
      active += 1;
      return true;
    },
    release() {
      active = Math.max(0, active - 1);
    },
    get activeCount() {
      return active;
    },
    reset() {
      lastPlayed.clear();
      active = 0;
    },
  };
}

export { DEDUPE_WINDOW_MS, MAX_CONCURRENT };
