/**
 * no-op 音频 sink。用于 MAX 模式静音与无头测试环境。
 * 保持与 HowlerAudio 完全相同的接口形状，使引擎可以无感切换。
 */

export const nullAudio = Object.freeze({
  kind: 'null',
  play() {},
  setMuted() {},
  setVolume() {},
  get muted() {
    return true;
  },
  preload() {},
  dispose() {},
});
