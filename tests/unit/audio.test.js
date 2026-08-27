/**
 * 音频层单测（此前是交接文档列出的测试缺口之一）。
 *
 * 音频的三条铁律都靠这里钉住：
 *   1. 不发消息 —— 没有登记资源就不该构造 Howl，也就不会产生 404
 *   2. 不影响逻辑 —— 节流器只读物理时钟，且必须在注入的假时钟下完全可测
 *   3. 缺 sink 不崩 —— nullAudio 与 play() 的空实现必须在任何调用下存活
 */

import { describe, expect, it } from 'vitest';
import {
  AUDIO_ASSETS,
  AUDIO_AVAILABLE_COUNT,
  SOUND_IDS,
  SOUND_MANIFEST,
} from '../../src/ui/audio/soundMap.js';
import { createThrottle, DEDUPE_WINDOW_MS, MAX_CONCURRENT } from '../../src/ui/audio/throttle.js';
import { nullAudio } from '../../src/ui/audio/nullAudio.js';

describe('音效清单', () => {
  it('每个 SOUND_ID 都在清单里，且 id 不重复', () => {
    const ids = SOUND_MANIFEST.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of Object.values(SOUND_IDS)) {
      expect(ids).toContain(id);
    }
  });

  it('未登记资源的条目 src 为空数组，而不是指向不存在文件的假路径', () => {
    for (const entry of SOUND_MANIFEST) {
      expect(Array.isArray(entry.src)).toBe(true);
      if (AUDIO_ASSETS[entry.id] === undefined) expect(entry.src).toEqual([]);
      else expect(entry.src.length).toBeGreaterThan(0);
    }
    expect(AUDIO_AVAILABLE_COUNT).toBe(
      SOUND_MANIFEST.filter((e) => e.src.length > 0).length,
    );
  });

  it('音量在 0~1 之间，UI 类音效比战斗类轻（避免连点刺耳）', () => {
    for (const entry of SOUND_MANIFEST) {
      expect(entry.volume).toBeGreaterThan(0);
      expect(entry.volume).toBeLessThanOrEqual(1);
      if (entry.id.startsWith('ui.')) expect(entry.volume).toBeLessThan(0.5);
    }
  });
});

describe('节流器（注入假时钟，因此完全确定）', () => {
  function withClock() {
    let t = 0;
    return { now: () => t, advance: (ms) => (t += ms), throttle: null };
  }

  it('同一音效在去重窗口内只允许一次，窗口过后重新放行', () => {
    const clock = withClock();
    const throttle = createThrottle({ now: clock.now });

    expect(throttle.allow('combat.hit')).toBe(true);
    clock.advance(DEDUPE_WINDOW_MS - 16);
    expect(throttle.allow('combat.hit')).toBe(false);
    clock.advance(20);
    expect(throttle.allow('combat.hit')).toBe(true);
  });

  it('不同音效互不压制', () => {
    const clock = withClock();
    const throttle = createThrottle({ now: clock.now });
    expect(throttle.allow('combat.hit')).toBe(true);
    expect(throttle.allow('combat.heal')).toBe(true);
  });

  it('并发上限 8 路：不 release 就耗尽，release 后恢复', () => {
    // 恒定时钟 + 每次用不同 soundId：绕开去重窗口，只看并发上限
    const throttle = createThrottle({ now: () => 1000 });

    for (let i = 0; i < MAX_CONCURRENT; i += 1) {
      expect(throttle.allow(`s${i}`)).toBe(true);
    }
    expect(throttle.activeCount).toBe(MAX_CONCURRENT);
    expect(throttle.allow('s99')).toBe(false);

    throttle.release();
    expect(throttle.allow('s99')).toBe(true);
  });

  it('release 不会把计数压成负数（重复释放是安全的）', () => {
    const clock = withClock();
    const throttle = createThrottle({ now: clock.now });
    throttle.allow('a');
    throttle.release();
    throttle.release();
    throttle.release();
    expect(throttle.activeCount).toBe(0);
  });

  it('reset 清空去重记录与并发计数', () => {
    const throttle = createThrottle({ now: () => 0 });
    throttle.allow('a');
    throttle.reset();
    expect(throttle.activeCount).toBe(0);
    expect(throttle.allow('a')).toBe(true); // 刚放过又被允许 = 去重窗口记录已清
  });
});

describe('nullAudio（MAX 模式与无头测试用它）', () => {
  it('接口形状与 HowlerAudio 一致，所有方法都可用', () => {
    expect(typeof nullAudio.play).toBe('function');
    expect(nullAudio.kind).toBe('null');
    expect(nullAudio.muted).toBe(true);
    expect(() => nullAudio.play('combat.hit', {})).not.toThrow();
    expect(() => nullAudio.setMuted(false)).not.toThrow();
    expect(() => nullAudio.setVolume(1)).not.toThrow();
    expect(() => nullAudio.preload()).not.toThrow();
    expect(() => nullAudio.dispose()).not.toThrow();
  });

  it('返回 undefined：调用方拿不到任何可参与状态的值（音频不得进逻辑表达式）', () => {
    expect(nullAudio.play('battle.victory', {})).toBeUndefined();
  });
});
