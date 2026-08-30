// @vitest-environment node
/**
 * 自动存档不能被"更旧的档"悄悄顶掉 —— 这一份是照着玩家实际丢档的路径写的。
 *
 * 现场：主菜单误点「新的轮回」，在新局里走到第 2 层，回来发现自动存档槽
 * 变成 Lv.1 / 0 碎片 / 0 胜场，那一局 Lv.14 没了。
 *
 * 之前的修法（"没进度的新局不写自动档"）**挡不住这个**：descend() 会加
 * metadata.floorsCleared，于是"第 2 层的空局"也算有进度，照样覆盖。
 * 真正的安全网只能是：**顶掉之前先把被顶掉的那份存进备份历史**。
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { SaveService, AUTO_BACKUP_LIMIT } from '../../src/persistence/saveService.js';
import { hasMeaningfulProgress, isSaveRegression } from '../../src/core/runProgress.js';
import { resetAdapterCache, pickAdapter } from '../../src/persistence/storageAdapter.js';
import { AUTO_SAVE_SLOT } from '../../src/core/constants.js';
import { createInitialState } from '../../src/core/initialState.js';
import { serializeRun } from '../../src/persistence/schema.js';

async function wipe() {
  resetAdapterCache();
  for (const modded of [false, true]) {
    const { adapter } = await pickAdapter({ modded });
    await adapter.clear();
  }
}

beforeEach(wipe);

/** 造一个"有进度"的局：exp/碎片/胜场/装备都能给。 */
function run({ exp = 0, shards = 0, wins = 0, floors = 0, seed = 2462498413 } = {}) {
  const state = createInitialState(seed, { gcdSequence: [], ogcdSlots: [] });
  state.player.exp = exp;
  state.fateShards = shards;
  state.metadata.battlesWon = wins;
  state.metadata.floorsCleared = floors;
  state.floorNumber = floors + 1;
  return state;
}

async function service() {
  const svc = new SaveService();
  await svc.init();
  svc.provideFingerprint(() => ({ hash: 'abcd1234', mods: [], packs: [], counts: {} }));
  return svc;
}

describe('自动档覆盖安全网', () => {
  it('好档被新局顶掉时，旧的那份自动进备份历史（截图那条路径）', async () => {
    const svc = await service();
    svc.saveRun(run({ exp: 5000, shards: 461, wins: 37, floors: 8 }));
    await svc.flush();

    // 误点新的轮回之后，新局第一次写自动档
    svc.saveRun(run({ exp: 0, shards: 0, wins: 0, floors: 1 }));
    await svc.flush();

    const backups = await svc.listPrevAutos();
    expect(backups).toHaveLength(1);
    expect(backups[0].run.fateShards).toBe(461);
    expect(backups[0].run.metadata.battlesWon).toBe(37);
    // 当前自动槽确实是新局（自动槽该跟着当前局走，不该被门控卡住）
    const current = await svc.loadSlot(AUTO_SAVE_SLOT);
    expect(current.run.fateShards).toBe(0);
  });

  it('连点两次「新的轮回」也不会毁掉第一份好档（旧版单槽备份的死法）', async () => {
    const svc = await service();
    svc.saveRun(run({ exp: 5000, shards: 461, wins: 37, floors: 8 }));
    await svc.flush();
    await svc.backupAutoSave(); // 旧版就在这里存单槽

    // 新局 A 打出一点进度 → 顶掉好档，再点一次新的轮回
    svc.saveRun(run({ exp: 30, shards: 5, wins: 1, floors: 2 }));
    await svc.flush();
    await svc.backupAutoSave();

    // 新局 B 又顶掉 A
    svc.saveRun(run({ exp: 0, shards: 0, wins: 0, floors: 1 }));
    await svc.flush();

    const backups = await svc.listPrevAutos();
    const exps = backups.map((b) => b.run.exp);
    expect(exps).toContain(5000); // 最初那份 Lv.14 的档还在
    expect(exps).toContain(30);
    expect(backups[0].run.exp).toBe(30); // 新的在前
  });

  it('正常前进（exp 只涨不跌）不会堆备份 —— 备份只在"回退"时产生', async () => {
    const svc = await service();
    for (const exp of [100, 200, 400, 900]) {
      svc.saveRun(run({ exp, shards: exp, wins: exp / 10, floors: exp / 100 }));
      await svc.flush();
    }
    expect(await svc.listPrevAutos()).toHaveLength(0);
  });

  // 注意：备份里存的是 **serializeRun 的扁平形状**（顶层 exp / equipment，
  // clearedNodeIds 是数组），不是运行时状态。断言要按这个形状写。
  it('取走一份备份不影响其余（按内容身份 backupKey 认）', async () => {
    const svc = await service();
    svc.saveRun(run({ exp: 5000, floors: 8 }));
    await svc.flush();
    await svc.backupAutoSave();
    svc.saveRun(run({ exp: 3000, floors: 5 }));
    await svc.flush();
    await svc.backupAutoSave();

    const list = await svc.listPrevAutos();
    expect(list).toHaveLength(2);
    expect(await svc.consumeAutoBackup(list[0].backupKey)).toBe(true);
    const after = await svc.listPrevAutos();
    expect(after).toHaveLength(1);
    // 取走的是最新那份（3000），留下的应当是更早的 5000
    expect(after[0].run.exp).toBe(5000);
  });

  it('备份数量有上限，且丢的是最旧的一份而不是最值钱的', async () => {
    const svc = await service();
    for (const exp of [9000, 8000, 7000, 6000, 5000, 4000, 3000]) {
      svc.saveRun(run({ exp }));
      await svc.flush();
      await svc.backupAutoSave();
    }
    const list = await svc.listPrevAutos();
    expect(list).toHaveLength(AUTO_BACKUP_LIMIT);
    const exps = list.map((b) => b.run.exp);
    // 7 次备份留 5 份 ⇒ 被挤掉的必须是最旧的两份（9000、8000），最新的五份留着。
    // 不断言 exps 的顺序：同一毫秒内 savedAt 分不出先后，顺序由插入决定，
    // 断言顺序会得到一条"其实没在测东西"的脆测试。
    expect(exps).not.toContain(9000);
    expect(exps).not.toContain(8000);
    expect(new Set(exps)).toEqual(new Set([7000, 6000, 5000, 4000, 3000]));
  });

  it('旧版单槽备份 run:autoPrev 会被吸收，不降级已经救过档的人', async () => {
    const { adapter } = await pickAdapter({ modded: false });
    await adapter.set('run:autoPrev', {
      slotId: 'autoPrev',
      savedAt: 12345,
      data: serializeRun(run({ exp: 4321, shards: 100 })),
    });
    const svc = await service();
    const list = await svc.listPrevAutos();
    expect(list).toHaveLength(1);
    expect(list[0].run.exp).toBe(4321);
    // 吸收完要清掉旧键，否则下次读还会重复（fake-indexeddb 缺键返回 undefined）
    expect(await adapter.get('run:autoPrev')).toBeFalsy();
  });
});

describe('进度判定', () => {
  it('走到第 2 层但什么都没发生：不算有进度（旧逻辑的 floorNumber>1 就是这里错的）', () => {
    const state = createInitialState(1, { gcdSequence: [], ogcdSlots: [] });
    state.floorNumber = 2;
    expect(hasMeaningfulProgress(state)).toBe(false);
  });

  it('清过一个节点 / 拿过一片碎片 / 打过一仗：算有进度', () => {
    const base = () => createInitialState(1, { gcdSequence: [], ogcdSlots: [] });
    const a = base();
    a.clearedNodeIds.add('n1');
    expect(hasMeaningfulProgress(a)).toBe(true);
    const b = base();
    b.fateShards = 1;
    expect(hasMeaningfulProgress(b)).toBe(true);
    const c = base();
    c.metadata.battlesWon = 1;
    expect(hasMeaningfulProgress(c)).toBe(true);
  });

  it('回退判定看 exp 不看碎片：商店花掉碎片是合法变小，不该误报', () => {
    const rich = { player: { exp: 1000 }, metadata: { floorsCleared: 3 }, fateShards: 400 };
    const spent = { player: { exp: 1000 }, metadata: { floorsCleared: 3 }, fateShards: 40 };
    expect(isSaveRegression(rich, spent)).toBe(false);
    expect(isSaveRegression(rich, { player: { exp: 999 }, metadata: {} })).toBe(true);
    expect(isSaveRegression(rich, { player: { exp: 1001 }, metadata: {} })).toBe(false);
    // exp 相等时比层数
    expect(isSaveRegression(rich, { player: { exp: 1000 }, metadata: { floorsCleared: 1 } })).toBe(true);
  });

  it('判定能吃存档里的序列化形态（Set 变数组），因为备份比较的是盘上的东西', () => {
    const serialized = serializeRun(run({ exp: 100, shards: 3 }));
    expect(hasMeaningfulProgress(serialized)).toBe(true);
    expect(hasMeaningfulProgress(serializeRun(createInitialState(1, {})))).toBe(false);
  });
});
