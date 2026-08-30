/**
 * 示例包**过沙箱**的对拍测试。
 *
 * 为什么值得单独立一个文件：示例包是"模组作者的活文档"，而文档最容易烂在
 * "它其实只在一条加载路径上成立"。这个包设计上支持两条路：
 *   构建期  src/mods/dev/ 原生 ESM + 3 行 setup.js 适配器
 *   沙箱期  把同样的文件塞进 QuickJS，由宿主收集注册
 * 两条路共用同一份源码，靠的是 `'fate'` 的双解析。这里把源码**真的**送进
 * 沙箱跑一遍，再和原生加载的结果逐项对拍 —— 哪条路悄悄漂了，这条测试会红。
 *
 * S2b 之后这条尤其重要：示例包用了 onBattleStart 与 mapGenerator，
 * 这两个能力只有沙箱侧支持，构建期侧此前从没验证过它们能被收上来。
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPack } from '../../src/core/mods/sandbox/pack.js';
import { createSandboxHost } from '../../src/core/mods/sandbox/host.js';
import { loadOfficialPool } from '../helpers.js';

const PACK_DIR = 'src/mods/dev/example-pack';
const clock = () => performance.now();

/** 读包目录里的 .js（跳过构建期专用的 manifest/setup —— 第三方包没有这两个文件）。 */
function readPackFiles() {
  const files = new Map();
  for (const name of readdirSync(PACK_DIR).sort()) {
    if (!name.endsWith('.js')) continue;
    if (name === 'setup.js' || name === 'manifest.js') continue;
    files.set(name, readFileSync(join(PACK_DIR, name), 'utf8'));
  }
  return files;
}

describe('示例包在沙箱里也能跑', () => {
  it('注册出来的内容与原生加载路径一致', async () => {
    const files = readPackFiles();
    // 三条 import 路径都在：入口 + 两个子模块。少一条说明包目录结构变了
    expect([...files.keys()].sort()).toEqual(['content.js', 'index.js', 'map.js', 'skills.js']);

    const pack = createPack({
      id: 'dev.example-pack',
      version: '1.1.0',
      entry: 'index.js',
      files,
    });
    const host = await createSandboxHost({ clock });
    const record = await host.installPack(pack);
    expect(record.failed, record.failureReason ?? 'no failure').toBe(false);

    const specs = host.drainRegistrations(record);
    const hooks = host.drainHooks(record);

    // toMatchObject：drain 出来的每条都带 __sourcePack 标记（宿主用来标来源）
    expect(specs.families).toMatchObject([{ id: 'void', label: '虚空' }]);
    expect(specs.buffs.map((b) => b.id)).toEqual(['void.mark']);
    expect(specs.skills.map((s) => s.id)).toEqual([
      'void.rift',
      'void.collapse',
      'void.eclipse',
      'void.siphon',
      'void.ruin',
      'void.debt',
    ]);
    expect(typeof specs.skills[5].execute).toBe('function');
    expect(specs.monsters.map((m) => m.id)).toEqual(['mon.void.riftling', 'mon.void.herald']);
    expect(specs.encounters).toHaveLength(3);
    expect(specs.shopItems.map((i) => i.id)).toEqual(['shop.void.core', 'shop.void.mend']);
    expect(typeof specs.shopItems[0].apply).toBe('function');
    expect(specs.events[0].choices).toHaveLength(3);
    // 事件的 apply 是嵌在数组里的：能收上来才说明路径式函数提取真的通了
    for (const choice of specs.events[0].choices) expect(typeof choice.apply).toBe('function');
    expect(typeof specs.mapGenerators[0].generate).toBe('function');
    expect(hooks.battleStart).toHaveLength(1);

    // 与**原生加载路径**逐项对拍数量 —— 这条测试的全部意义就在这：
    // 同一份源码，两条解析路径，收上来的东西必须一样多
    const native = (await import('../../src/mods/dev/example-pack/setup.js')).setup();
    for (const kind of Object.keys(specs)) {
      expect(specs[kind].length, `${kind} 两条路径收上来的数量不一致`).toBe(native[kind]?.length ?? 0);
    }
    // 官方池本身不该被示例包污染（loadOfficialPool 只装官方内容）
    const pool = await loadOfficialPool();
    expect(pool.skills.has('void.debt')).toBe(false);

    // 生成器过沙箱之后仍然满足准入校验（确定性 + 结构）
    const { validateMapGenerator } = await import('../../src/core/mods/sandbox/generatorCheck.js');
    expect(validateMapGenerator(specs.mapGenerators[0], { source: 'dev.example-pack' })).toBe(true);

    host.dispose();
  });

  it('沙箱版技能真的能打：execute 跨界调用 ctx 生效', async () => {
    const host = await createSandboxHost({ clock });
    const pack = createPack({ id: 'dev.example-pack', version: '1.1.0', entry: 'index.js', files: readPackFiles() });
    const record = await host.installPack(pack);
    const specs = host.drainRegistrations(record);
    const debt = specs.skills.find((s) => s.id === 'void.debt');

    const calls = [];
    const ctx = {
      entity: (id) => ({ id, hp: 40, maxHp: 100 }),
      damage: (a) => calls.push(['damage', a]),
      heal: (a) => calls.push(['heal', a]),
      applyBuff: (a) => calls.push(['applyBuff', a]),
      buffStacks: () => 2,
      log: (m) => calls.push(['log', m]),
      sound: () => {},
      query: () => null,
      removeBuff: () => {},
      hasBuff: () => true,
      rng: () => 0.5,
      virtualTime: 1000,
      floorNumber: 1,
    };
    debt.execute(ctx, { id: 'player', attack: 100, hp: 100, maxHp: 200 }, [{ id: 'e1', hp: 90 }]);
    const damage = calls.find((c) => c[0] === 'damage');
    expect(damage[1].sourceId).toBe('player');
    expect(damage[1].targetId).toBe('e1');
    // 第一次见到 e1 ⇒ 只有基础伤害 80（没有"追讨"）
    expect(damage[1].amount).toBeCloseTo(80, 0);

    // 第二次施放：目标从 40（上次记下的）"回到" 40 以上才会追讨 —— 这里 ctx 固定返回 40
    calls.length = 0;
    debt.execute(ctx, { id: 'player', attack: 100, hp: 100, maxHp: 200 }, [{ id: 'e1', hp: 90 }]);
    expect(calls.find((c) => c[0] === 'damage')[1].amount).toBeCloseTo(80, 0);

    // onBattleStart 能把记忆清空 —— 这正是它存在的理由
    const hooks = host.drainHooks(record);
    expect(() => hooks.battleStart[0](ctx, { virtualTime: 0 })).not.toThrow();
    expect(host.getRecord('dev.example-pack').failed).toBe(false);
    host.dispose();
  });
});
