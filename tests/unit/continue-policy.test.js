/**
 * 「继续游戏该读哪一份」的选择策略。
 *
 * 规则：时间优先；但最新那份"没真进度"时，降级为进度最高的那份。
 * 这条策略存在的理由是一段真实丢档经历：自动槽被误点的新局刷成空档，
 * 而 Lv.14 那局躺在手动槽里 —— 点"继续游戏"却回到空档，看起来像存档全没了。
 */
import { describe, it, expect } from 'vitest';
import { pickResumableSlot } from '../../src/persistence/continuePolicy.js';

/** 造一条 listSlots() 形状的摘要。 */
const slot = (slotId, { empty = false, incompatible = false, savedAt = 1000, exp = 0, floorNumber = 1, battlesWon = 0, nodesCleared = 0, fateShards = 0, auto = false } = {}) => ({
  slotId,
  empty,
  auto,
  incompatible,
  savedAt,
  exp,
  floorNumber,
  battlesWon,
  nodesCleared,
  fateShards,
});

describe('pickResumableSlot', () => {
  it('全空 → null（按钮该禁用，而不是打开个空局）', () => {
    expect(pickResumableSlot([])).toBeNull();
    expect(pickResumableSlot([slot('slot1', { empty: true }), slot('auto', { empty: true, auto: true })])).toBeNull();
  });

  it('正常情形按时间选：谁写得最晚读谁', () => {
    const slots = [
      slot('slot1', { savedAt: 100, exp: 9000 }),
      slot('auto', { savedAt: 300, exp: 200, auto: true }),
    ];
    const picked = pickResumableSlot(slots);
    expect(picked.slot.slotId).toBe('auto');
    expect(picked.downgraded).toBe(false);
  });

  /** 这就是玩家真实踩到的现场：自动槽是刚误点的新局，老局在手动槽。 */
  it('最新那份是空局时降级到进度最高的那份，并标记 downgraded', () => {
    const slots = [
      slot('slot2', { savedAt: 100, exp: 5000, floorNumber: 8, battlesWon: 37, nodesCleared: 8 }),
      slot('slot1', { savedAt: 90, exp: 3000, floorNumber: 4, battlesWon: 10 }),
      slot('auto', { savedAt: 200, exp: 0, floorNumber: 2, auto: true }), // 空局但最新
    ];
    const picked = pickResumableSlot(slots);
    expect(picked.slot.slotId).toBe('slot2');
    expect(picked.downgraded).toBe(true);
  });

  it('只有一份可用存档时直接选它，不算降级', () => {
    const picked = pickResumableSlot([
      slot('slot1', { empty: true }),
      slot('auto', { savedAt: 500, exp: 10, auto: true }),
    ]);
    expect(picked.slot.slotId).toBe('auto');
    expect(picked.downgraded).toBe(false);
  });

  it('版本不兼容的存档一律跳过（读它只会抛错）', () => {
    const picked = pickResumableSlot([
      slot('slot1', { incompatible: true, savedAt: 900, exp: 9999 }),
      slot('slot2', { savedAt: 100, exp: 50 }),
    ]);
    expect(picked.slot.slotId).toBe('slot2');
  });

  it('全是空存档但有不兼容档 → 仍然 null（不该假装能继续）', () => {
    expect(pickResumableSlot([slot('slot1', { incompatible: true })])).toBeNull();
  });

  it('降级时进度并列按层数破平；都是 0 进度就回到最新那份', () => {
    const tied = pickResumableSlot([
      slot('slot1', { savedAt: 10, exp: 500, floorNumber: 9 }),
      slot('slot2', { savedAt: 20, exp: 500, floorNumber: 3 }),
      slot('auto', { savedAt: 30, exp: 0, auto: true }),
    ]);
    expect(tied.slot.slotId).toBe('slot1'); // exp 相同 ⇒ 层数高的赢

    const allEmpty = pickResumableSlot([
      slot('slot1', { savedAt: 10, exp: 0 }),
      slot('auto', { savedAt: 30, exp: 0, auto: true }),
    ]);
    expect(allEmpty.slot.slotId).toBe('auto'); // 都没进度 ⇒ 回到玩家最后碰的那份
    expect(allEmpty.downgraded).toBe(false);
  });

  it('拿碎片当唯一进度的存档算"有进度"（商店买过东西不是空局）', () => {
    const picked = pickResumableSlot([
      slot('slot1', { savedAt: 10, exp: 5000 }),
      slot('auto', { savedAt: 30, exp: 0, fateShards: 12, auto: true }),
    ]);
    expect(picked.slot.slotId).toBe('auto');
    expect(picked.downgraded).toBe(false);
  });
});
