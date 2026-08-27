/**
 * audio.play 契约实现（裁决 8）。
 *
 * 与确定性完全隔离的四条硬规则：
 *   1. 返回 void，不报成败 —— 调用方无法从它获取任何信息，故不可能影响战斗分支。
 *   2. 不消费随机数，不读 virtualTime 以外的状态，不写 #state。
 *   3. 内部永不抛错：初始化失败、资源缺失、浏览器自动播放策略拦截，均静默降级为无声。
 *   4. 抽掉整个音频模块后，确定性单测必须仍全绿。
 *
 * MAX 模式静音由引擎切换 sink 实现（见 engine.js），此处不感知速度模式。
 */

export function createAudioPlay({ getSink }) {
  return function audioPlay(payload) {
    try {
      const sink = getSink();
      if (sink === null || sink === undefined) return;
      const soundId = typeof payload === 'string' ? payload : payload?.soundId;
      if (typeof soundId !== 'string' || soundId === '') return;
      sink.play(soundId, typeof payload === 'object' ? payload : {});
    } catch {
      // 规则 3：音频永不影响游戏进行
    }
  };
}
