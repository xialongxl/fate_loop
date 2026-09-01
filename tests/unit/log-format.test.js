/**
 * 日志显示层的单测。
 *
 * 这里守的是三条容易被后来者破坏的规矩：
 *  1. 视角跟着主语走（敌方给自己挂 buff 不能写成"获得"）
 *  2. 措辞不进指纹（改文案不该让确定性对拍变红）
 *  3. 括号分工：技能/单位名【】、状态[]、说明（）
 */
import { describe, it, expect } from 'vitest';
import { logRows, logText, logEntryDigest, formatAmount, createLogResolver } from '../../src/ui/logFormat.js';

const resolve = createLogResolver({
  getSkills: () => new Map([
    ['blade.jab', { name: '突刺' }],
    ['void.mark', { name: '虚空印记' }],
  ]),
  getBuffs: () => new Map([
    ['void.mark', { name: '虚空印记', isDebuff: true }],
    ['storm.charge', { name: '蓄雷' }],
  ]),
});

const r = resolve({
  player: { id: 'player', name: '序列编织者' },
  monsters: [{ id: 'e1', name: '骤雷哨卫' }],
});

const text = (entry) => logText(entry, r);

describe('logRows / logText', () => {
  it('我方伤害：咏唱【技能】 → 目标 造成 N 伤害', () => {
    const line = text({ t: 1000, kind: 'damage', actorId: 'player', targetId: 'e1', skillId: 'blade.jab', amount: 204 });
    expect(line).toBe('咏唱 【突刺】 → 骤雷哨卫 造成 204 伤害');
  });

  it('敌方伤害换成"击中你！"，主语是单位名而不是技能名', () => {
    const line = text({ t: 1000, kind: 'damage', actorId: 'e1', targetId: 'player', skillId: 'blade.jab', amount: 96 });
    expect(line).toContain('【骤雷哨卫】');
    expect(line).toContain('击中你！');
    expect(line).not.toContain('咏唱');
  });

  it('暴击走 kind=crit 并带（暴击！）后缀', () => {
    const rows = logRows({ t: 1000, kind: 'crit', actorId: 'player', targetId: 'e1', amount: 318, crit: true }, r);
    expect(rows[0].kind).toBe('crit');
    expect(rows[0].icon).toBe('◆');
    expect(logText({ t: 1, kind: 'crit', actorId: 'player', targetId: 'e1', amount: 318, crit: true }, r)).toContain('（暴击！）');
  });

  it('击杀带（击杀）后缀，普通命中不带', () => {
    expect(text({ t: 1, kind: 'damage', actorId: 'player', targetId: 'e1', amount: 9, lethal: true }, r)).toContain('（击杀）');
    expect(text({ t: 1, kind: 'damage', actorId: 'player', targetId: 'e1', amount: 9 }, r)).not.toContain('击杀');
  });

  /** 这条是"视角跟着主语走"的钉子：同一个模板两边共用就会把敌人攒的层说成玩家获得 */
  it('增益的措辞按承受者是不是玩家分：获得 / 蓄起', () => {
    expect(text({ t: 1, kind: 'buff', targetId: 'player', buffId: 'storm.charge', stacks: 1 }, r)).toContain('获得');
    expect(text({ t: 1, kind: 'buff', targetId: 'player', buffId: 'storm.charge', stacks: 1 }, r)).not.toContain('蓄起');
    expect(text({ t: 1, kind: 'buff', targetId: 'e1', buffId: 'storm.charge', stacks: 1 }, r)).toContain('蓄起');
  });

  it('减益统一"被施加"，并且层数只在 >1 时显示', () => {
    expect(text({ t: 1, kind: 'debuff', targetId: 'e1', buffId: 'void.mark', stacks: 1 }, r)).toBe('骤雷哨卫 被施加 [虚空印记]');
    expect(text({ t: 1, kind: 'debuff', targetId: 'e1', buffId: 'void.mark', stacks: 3 }, r)).toBe('骤雷哨卫 被施加 [虚空印记×3]');
  });

  it('自疗不写成"我为我"，他疗才写双方', () => {
    expect(text({ t: 1, kind: 'heal', actorId: 'player', targetId: 'player', amount: 168, self: true, skillId: 'void.mark' }, r))
      .toBe('[虚空印记] 序列编织者 回复 168 点生命');
    expect(text({ t: 1, kind: 'heal', actorId: 'e1', targetId: 'player', amount: 40 }, r)).toContain('骤雷哨卫 为 序列编织者');
  });

  it('叙事行（game.js 与第三方包 ctx.log）原样显示，不套战斗模板', () => {
    expect(text({ t: 1, text: '购买了虚空核（-58 碎片）' }, r)).toBe('购买了虚空核（-58 碎片）');
    expect(text({ t: 1 }, r)).toBe('');
  });

  it('查不到的 id 退回显示 id 本身，绝不显示 undefined', () => {
    const line = text({ t: 1, kind: 'damage', actorId: 'player', targetId: 'ghost', skillId: 'nope.skill', amount: 5 }, r);
    expect(line).toContain('ghost');
    expect(line).not.toContain('undefined');
  });

  it('没有 skillId 时不硬凑"咏唱【】"这种空壳', () => {
    const line = text({ t: 1, kind: 'damage', actorId: 'player', targetId: 'e1', amount: 5 }, r);
    expect(line).not.toContain('【】');
    expect(line).toContain('造成');
  });
});

describe('数值缩写', () => {
  it('本作量级不缩写，≥1e4 才用万/亿', () => {
    expect(formatAmount(204)).toBe('204');
    expect(formatAmount(9999)).toBe('9,999');
    expect(formatAmount(12345)).toBe('1.23万');
    expect(formatAmount(24_600_000)).toBe('2460.00万');
    expect(formatAmount(310_000_000)).toBe('3.10亿');
  });
});

describe('logEntryDigest', () => {
  it('措辞不进指纹：改文案不影响结构化条目的摘要', () => {
    const entry = { t: 100, kind: 'damage', actorId: 'player', targetId: 'e1', skillId: 'blade.jab', amount: 204 };
    const digest = logEntryDigest(entry);
    // 摘要里既没有"造成"也没有"伤害"这些字 —— 它们属于显示层
    expect(digest).not.toContain('造成');
    expect(digest).not.toContain('伤害');
    expect(digest).toContain('blade.jab');
    expect(digest).toContain('204');
  });

  it('数值或暴击不同 ⇒ 摘要必须不同（否则对拍是假的）', () => {
    const base = { t: 1, kind: 'damage', actorId: 'p', targetId: 'e', amount: 10 };
    expect(logEntryDigest(base)).not.toBe(logEntryDigest({ ...base, amount: 11 }));
    expect(logEntryDigest(base)).not.toBe(logEntryDigest({ ...base, crit: true }));
    expect(logEntryDigest(base)).not.toBe(logEntryDigest({ ...base, kind: 'crit', crit: true }));
  });

  it('叙事行按原文进摘要（它本身就是文本契约的一部分）', () => {
    expect(logEntryDigest({ t: 5, text: '进入第 2 层' })).toContain('进入第 2 层');
  });
});
