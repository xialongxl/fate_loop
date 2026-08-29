/**
 * 存档导出 / 导入（单个 JSON 文件）的校验与往返测试。
 *
 * 导入的虽然是数据，但它会直接进状态 —— 所以校验器的职责是"挡住会让游戏
 * 进入非法状态的东西"（NaN、禁用键、超长数组、版本不符），而不是"判断数值合不合理"
 * （1 血通关 999 层是玩家自己的事）。
 */

import { describe, expect, it } from 'vitest';
import {
  EXPORT_FORMAT,
  EXPORT_VERSION,
  MAX_RECORDS_PER_FILE,
  buildExport,
  buildMultiExport,
  parseImport,
  summarizeImportedSlot,
} from '../../src/persistence/saveTransfer.js';
import { SaveService } from '../../src/persistence/saveService.js';
import { SCHEMA_VERSION } from '../../src/core/constants.js';
import { createHarness } from '../helpers.js';
import { resetAdapterCache } from '../../src/persistence/storageAdapter.js';

function makeRun(overrides = {}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    seed: 4242,
    floorNumber: 3,
    currentNodeId: 'node_1_1',
    startNodeId: 'node_1_1',
    exitNodeId: 'node_5_5',
    visitedNodeIds: ['node_1_1'],
    clearedNodeIds: ['node_1_1'],
    exp: 300,
    playerHp: 200,
    seedBonus: { maxHp: 10, attack: 2, defense: 1 },
    gcdSequence: ['blade.jab', 'fire.spark'],
    ogcdSlots: [{ skillId: 'ogcd.secondWind', priority: 95 }],
    equipment: { weapon: null, chest: null },
    inventory: [],
    fateShards: 88,
    shopPurchases: [],
    metadata: { battlesWon: 4 },
    ...overrides,
  };
}

function wrap(slots) {
  return JSON.stringify({ format: EXPORT_FORMAT, exportVersion: EXPORT_VERSION, slots });
}

describe('往返', () => {
  it('导出 → 解析 → 摘要，字段一一对应', () => {
    const text = JSON.stringify(
      buildExport({ slotId: 'slot1', label: '存档位 1', record: { savedAt: 111, contentHash: 'ab12cd34', run: makeRun() } }),
      null,
      2,
    );
    const parsed = parseImport(text);
    expect(parsed.ok).toBe(true);
    expect(summarizeImportedSlot(parsed.slots[0])).toMatchObject({
      slotId: 'slot1',
      seed: 4242,
      floorNumber: 3,
      fateShards: 88,
      contentHash: 'ab12cd34',
    });
    expect(summarizeImportedSlot(parsed.slots[0]).level).toBeGreaterThan(1);
  });

  it('多槽位导出保留各自槽位，且数量有上限', () => {
    const entries = ['slot1', 'slot2', 'auto'].map((slotId) => ({
      slotId,
      label: slotId,
      record: { savedAt: 1, contentHash: null, run: makeRun() },
    }));
    const parsed = parseImport(JSON.stringify(buildMultiExport(entries)));
    expect(parsed.ok).toBe(true);
    expect(parsed.slots.map((s) => s.slotId)).toEqual(['slot1', 'slot2', 'auto']);

    const tooMany = Array.from({ length: MAX_RECORDS_PER_FILE + 3 }, (_, i) => ({
      slotId: `slot${i}`,
      record: { run: makeRun() },
    }));
    const big = buildMultiExport(tooMany);
    expect(big.slots.length).toBe(MAX_RECORDS_PER_FILE);
  });

  it('导入的记录能真的写进槽位并读回来（内容一致）', async () => {
    resetAdapterCache();
    const service = new SaveService();
    await service.init();
    const parsed = parseImport(
      JSON.stringify(buildExport({ slotId: 'slot2', record: { savedAt: 555, contentHash: 'ff00', run: makeRun() } })),
    );
    const slot = parsed.slots[0];
    service.saveRecord(slot.slotId, {
      savedAt: slot.savedAt,
      contentHash: slot.contentHash,
      run: slot.run,
    });
    await service.flush();

    const loaded = await service.loadSlot('slot2');
    expect(loaded.contentHash).toBe('ff00');
    expect(loaded.run.seed).toBe(4242);
    expect(loaded.run.exp).toBe(300);

    const records = await service.readRecords(['slot1', 'slot2', 'slot3', 'auto']);
    expect(records.map((r) => r.slotId)).toEqual(['slot2']); // 空槽被跳过
  });

  it('导出的就是当前进度：saveRun 后 readRecords → buildExport → parseImport 全等', async () => {
    resetAdapterCache();
    const service = new SaveService();
    await service.init();
    service.provideFingerprint(() => ({ hash: '1234abcd', mods: [], packs: [] }));
    const { flow } = await createHarness({ seed: 777, saveService: service });
    flow.enterFloor(2);
    await service.flush();

    const [record] = await service.readRecords(['auto']);
    const text = JSON.stringify(buildExport({ slotId: 'auto', record }));
    const parsed = parseImport(text);
    expect(parsed.ok).toBe(true);
    expect(parsed.slots[0].run.seed).toBe(777);
    expect(parsed.slots[0].run.floorNumber).toBe(2);
    expect(parsed.slots[0].contentHash).toBe('1234abcd');
  });
});

describe('校验器挡住非法输入', () => {
  it('空文本 / 非 JSON / 非本游戏文件 / 版本不符', () => {
    expect(parseImport('').ok).toBe(false);
    expect(parseImport('   ').reason).toContain('空');
    expect(parseImport('{不是 json').ok).toBe(false);
    expect(parseImport(JSON.stringify({ format: 'other-game', slots: [] })).reason).toContain('不是本游戏');
    expect(parseImport(JSON.stringify({ format: EXPORT_FORMAT, exportVersion: 99, slots: [] })).reason).toContain('导出格式版本');
    expect(parseImport(JSON.stringify({ format: EXPORT_FORMAT, exportVersion: EXPORT_VERSION, slots: [] })).reason).toContain('没有槽位');
  });

  it('拒绝非有限数（NaN / Infinity 会一路传染到血条与伤害）', () => {
    expect(parseImport(wrap([{ slotId: 'slot1', run: makeRun({ exp: 1e999 }) }])).reason).toMatch(/exp|非有限/);
    expect(parseImport(wrap([{ slotId: 'slot1', run: makeRun({ playerHp: Number.NaN }) }])).ok).toBe(false);
  });

  it('拒绝 __proto__ / constructor 等禁用键', () => {
    const evil = '{"format":"fate-loop-save","exportVersion":1,"slots":[{"slotId":"s","run":{"__proto__":{"polluted":true}}}]}';
    expect(parseImport(evil).reason).toContain('禁用键');
    const ctor = '{"format":"fate-loop-save","exportVersion":1,"slots":[{"slotId":"s","run":{"constructor":{"x":1}}}]}';
    expect(parseImport(ctor).reason).toContain('禁用键');
  });

  it('拒绝类型错误的字段（seed 是字符串、gcdSequence 含数字…）', () => {
    expect(parseImport(wrap([{ slotId: 'slot1', run: makeRun({ seed: '42' }) }])).reason).toContain('seed');
    expect(parseImport(wrap([{ slotId: 'slot1', run: makeRun({ gcdSequence: [1, 2] }) }])).reason).toContain('gcdSequence');
    expect(parseImport(wrap([{ slotId: 'slot1', run: makeRun({ inventory: 'not-array' }) }])).reason).toContain('inventory');
    expect(parseImport(wrap([{ slotId: 'slot1', run: makeRun({ floorNumber: 0 }) }])).reason).toContain('floorNumber');
  });

  it('拒绝过长的数组与字符串（DoS 面）', () => {
    expect(
      parseImport(wrap([{ slotId: 'slot1', run: makeRun({ inventory: Array.from({ length: 500 }, () => null) }) }])).reason,
    ).toContain('inventory');
    expect(
      parseImport(wrap([{ slotId: 'slot1', run: makeRun({ gcdSequence: Array.from({ length: 500 }, (_, i) => `s${i}`) }) }])).reason,
    ).toMatch(/数组过长|gcdSequence/);
    expect(parseImport(wrap([{ slotId: 'slot1', run: makeRun({ currentNodeId: 'x'.repeat(900) }) }])).reason).toContain('字符串过长');
  });

  it('装备里的非法数值也挡', () => {
    const bad = makeRun({ inventory: [{ id: 'eq.1', name: '坏', slot: 'weapon', stats: { maxHp: -5, attack: 0, defense: 0, crit: 0 } }] });
    expect(parseImport(wrap([{ slotId: 'slot1', run: bad }])).reason).toContain('装备');
  });

  it('引擎版本不匹配的 run 走既有拒读逻辑', () => {
    expect(parseImport(wrap([{ slotId: 'slot1', run: makeRun({ schemaVersion: 1 }) }])).reason).toContain('版本不兼容');
  });
});
