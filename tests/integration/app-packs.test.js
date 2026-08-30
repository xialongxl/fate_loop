// @vitest-environment jsdom
/**
 * 装了第三方包的**应用**能不能起来 —— S2 的收尾验证。
 *
 * 前面两份测试分别证明了"包能在沙箱里跑"与"包能改战斗结果"，
 * 但都没碰装配序里最要命的一条：**存档命名空间要在读到包清单之后才决定**。
 * 顺序错了，装包玩家就会把进度写进 vanilla 库，之后切回官方内容又读不到 ——
 * 那是"存档没了"，不是小 bug。
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { createApp } from '../../src/main.js';
import { officialModuleEntries } from '../helpers.js';
import { nullAudio } from '../../src/ui/audio/nullAudio.js';
import { PackService } from '../../src/persistence/packs.js';
import { resetAdapterCache, pickAdapter } from '../../src/persistence/storageAdapter.js';
import { SCREEN } from '../../src/core/constants.js';

const PACK = {
  id: 'poc.app',
  version: '1.0.0',
  files: {
    'main.js': `
import { begin, skill, family, SKILL_TYPE } from 'fate';
begin({ id: 'poc.app', version: '1.0.0', title: '装配测试包' });
family({ id: 'astral', label: '星界' });
skill({ id: 'poc.app.nova', name: '星爆', type: SKILL_TYPE.GCD, gcdCost: 2.4,
  execute: (ctx, self, targets) => { for (const t of targets) ctx.damage({ sourceId: self.id, targetId: t.id, amount: 400 }); } });
`,
  },
};

async function freshAdapters() {
  resetAdapterCache();
  for (const modded of [false, true]) {
    const { adapter } = await pickAdapter({ modded });
    await adapter.clear();
  }
}

async function boot(packs, seed = 4242) {
  document.body.innerHTML = '<div id="app"></div>';
  return createApp({
    root: document.querySelector('#app'),
    seed,
    modules: officialModuleEntries(),
    audio: nullAudio,
    packs,
  });
}

beforeEach(async () => {
  await freshAdapters();
  document.body.innerHTML = '<div id="app"></div>';
});

describe('应用 × 第三方包', () => {
  it('没装包：不创建沙箱、存档留在 vanilla 命名空间', async () => {
    const packs = await new PackService().init();
    const app = await boot(packs);
    expect(app.packReport.loaded).toHaveLength(0);
    expect(app.sandboxHost).toBeNull();
    expect(app.packs).toBe(packs);
    expect(app.saveService.modded).toBe(false);
    app.destroy();
  });

  it('装了包：包内容进池、指纹记下它、存档切到隔离命名空间', async () => {
    const packs = await new PackService().init();
    const installed = await packs.install({ ...PACK, title: '装配测试包' });
    expect(installed.ok, installed.reason).toBe(true);

    const app = await boot(packs, 777);
    expect(app.packReport.ok).toHaveLength(1);
    expect(app.packReport.ok[0].provided).toMatchObject({ skills: 1, families: 1 });
    expect(app.pool.skills.get('poc.app.nova').source).toBe('poc.app');
    expect(app.fingerprint.packs).toEqual([
      { id: 'poc.app', version: '1.0.0', sha256: installed.pack.hash.hex },
    ]);
    expect(app.sandboxHost).not.toBeNull();
    // 关键断言：装了包就必须切到隔离库，否则玩家会在 vanilla 库里找不到进度
    expect(app.saveService.modded).toBe(true);
    app.destroy();
  });

  it('包在加载期就坏掉时应用照常起来，只是该包不上场', async () => {
    const packs = await new PackService().init();
    await packs.install({
      id: 'poc.broken',
      version: '1.0.0',
      files: {
        'main.js': `
import { begin, skill } from 'fate';
begin({ id: 'poc.broken', version: '1.0.0' });
throw new Error('这个包不想上场');
skill({ id: 'poc.broken.a', type: 'GCD', gcdCost: 2.4, execute: () => {} });
`,
      },
    });
    const app = await boot(packs, 99);
    // 界面照样能开：第三方包没有让游戏开不了机的权力
    expect(app.packReport.failed).toHaveLength(1);
    expect(app.packReport.failed[0].id).toBe('poc.broken');
    expect(app.pool.skills.has('poc.broken.a')).toBe(false);
    expect(app.router.current).toBe(SCREEN.MAIN_MENU);
    app.destroy();
  });

  it('指纹只由内容决定：装→卸→再装，hash 回到同一个', async () => {
    const packs = await new PackService().init();
    await packs.install(PACK);
    const withPack = await boot(packs, 5);
    const hashWith = withPack.fingerprint.hash;
    expect(withPack.pool.skills.has('poc.app.nova')).toBe(true);
    withPack.destroy();

    await packs.remove(PACK.id);
    const without = await boot(packs, 5);
    expect(without.pool.skills.has('poc.app.nova')).toBe(false);
    expect(without.fingerprint.hash).not.toBe(hashWith);

    await packs.install(PACK);
    const again = await boot(packs, 5);
    expect(again.fingerprint.hash).toBe(hashWith);
    again.destroy();
  });
});
