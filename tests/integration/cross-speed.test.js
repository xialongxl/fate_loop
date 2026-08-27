/**
 * 阶段 5 最关键验收：跨速度对拍。
 *
 * 1x / 4x / MAX 三种模式的终态必须逐字段相等。这一项同时检验四项裁决：
 *   裁决 1（绝对到期时间戳）—— 若用递减计数器，4x 的 64ms 步长会跳过判定
 *   裁决 2（PRNG 按用途分流）—— 若共用一条流，不同推进节奏会错位
 *   裁决 3（oGCD 每实体每步至多一个）—— 若作用域是全局，帧内顺序会漂移
 *   裁决 4（normalize 对齐 16ms）—— 若有非对齐时长，步长不同则结果不同
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { SPEED_MODES } from '../../src/core/constants.js';
import { battleFingerprint, createHarness, loadOfficialPool } from '../helpers.js';

/** 用指定速度模式跑完一场战斗，返回终态指纹。 */
async function runBattle(seed, mode, { nodeId = 'node_4_6', tier = 'normal' } = {}) {
  const { store, engine, flow } = await createHarness({ seed });
  flow.enterFloor(1);

  // 固定战斗参数，绕开地图随机走位带来的差异
  engine.begin({ nodeId, tier });

  if (mode === SPEED_MODES.MAX) {
    engine.runToEnd();
  } else {
    let guard = 0;
    while (engine.runFrame(mode)) {
      guard += 1;
      if (guard > 200000) throw new Error('战斗未在合理帧数内结束');
    }
  }

  return battleFingerprint(store.getSnapshot());
}

describe('跨速度对拍（阶段 5 验收门）', () => {
  beforeAll(async () => {
    await loadOfficialPool();
  });

  it('1x 与 4x 终态逐字段相等', async () => {
    const a = await runBattle(20240101, SPEED_MODES.X1);
    const b = await runBattle(20240101, SPEED_MODES.X4);
    expect(b).toEqual(a);
  });

  it('1x 与 MAX 终态逐字段相等', async () => {
    const a = await runBattle(20240101, SPEED_MODES.X1);
    const c = await runBattle(20240101, SPEED_MODES.MAX);
    expect(c).toEqual(a);
  });

  it('4x 与 MAX 终态逐字段相等', async () => {
    const b = await runBattle(20240101, SPEED_MODES.X4);
    const c = await runBattle(20240101, SPEED_MODES.MAX);
    expect(c).toEqual(b);
  });

  it('多个种子下三模式全部一致', async () => {
    for (const seed of [1, 999, 123456, 0x7fffffff]) {
      const [a, b, c] = await Promise.all([
        runBattle(seed, SPEED_MODES.X1),
        runBattle(seed, SPEED_MODES.X4),
        runBattle(seed, SPEED_MODES.MAX),
      ]);
      expect(b, `种子 ${seed} 的 4x 与 1x 不一致`).toEqual(a);
      expect(c, `种子 ${seed} 的 MAX 与 1x 不一致`).toEqual(a);
    }
  });

  it('精英战斗同样满足三模式一致', async () => {
    const opts = { nodeId: 'node_2_3', tier: 'elite' };
    const a = await runBattle(555, SPEED_MODES.X1, opts);
    const b = await runBattle(555, SPEED_MODES.X4, opts);
    const c = await runBattle(555, SPEED_MODES.MAX, opts);
    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });

  it('不同节点产生不同战斗（遭遇流按节点隔离）', async () => {
    const a = await runBattle(777, SPEED_MODES.MAX, { nodeId: 'node_1_1' });
    const b = await runBattle(777, SPEED_MODES.MAX, { nodeId: 'node_9_9' });
    // 至少某一维度不同；若完全相同则说明 nodeId 未参与派生
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });

  it('同一战斗重复运行结果稳定（无隐藏全局状态）', async () => {
    const runs = [];
    for (let i = 0; i < 5; i += 1) {
      runs.push(await runBattle(31337, SPEED_MODES.MAX));
    }
    for (const run of runs.slice(1)) {
      expect(run).toEqual(runs[0]);
    }
  });
});

describe('战斗终止条件', () => {
  it('战斗必定在超时前结束，且给出明确原因', async () => {
    const { store, engine, flow } = await createHarness({ seed: 42 });
    flow.enterFloor(1);
    engine.begin({ nodeId: 'node_3_3', tier: 'normal' });
    engine.runToEnd();

    const snap = store.getSnapshot();
    expect(snap.status).toBe('finished');
    expect(['player', 'monsters']).toContain(snap.winner);
    expect(['playerDown', 'monstersCleared', 'timeout']).toContain(snap.battleEndReason);
    expect(snap.virtualTime).toBeLessThanOrEqual(engine.timeoutMs + 16);
  });

  it('空 GCD 序列会走到超时而非死循环', async () => {
    const { store, engine, flow } = await createHarness({
      seed: 7,
      gcdSequence: [],
      ogcdSlots: [],
    });
    flow.enterFloor(1);
    engine.begin({ nodeId: 'node_5_5', tier: 'normal' });
    engine.runToEnd();

    const snap = store.getSnapshot();
    expect(snap.status).toBe('finished');
    // 玩家不出手，必定被打死或超时
    expect(['playerDown', 'timeout']).toContain(snap.battleEndReason);
  });

  it('战斗外消费随机数会抛错', async () => {
    const { engine } = await createHarness({ seed: 1 });
    expect(() => engine.getRng()).toThrow(/战斗流未初始化/);
  });
});
