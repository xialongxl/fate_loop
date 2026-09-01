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
import { describe, it, expect, beforeEach, vi } from 'vitest';
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

/** 官方四组 + 示例包：真实 app 走 import.meta.glob 会带上示例包，测试要自己注入 */
function modulesWithExample() {
  const dir = '/src/mods/dev/example-pack';
  return [
    ...officialModuleEntries(),
    {
      path: `${dir}/manifest.js`,
      dir,
      loadManifest: async () => await import(`../../src/mods/dev/example-pack/manifest.js`),
      loadSetup: async () => await import(`../../src/mods/dev/example-pack/setup.js`),
    },
  ];
}

async function boot(packs, seed = 4242, modules = modulesWithExample(), installPacks = null) {
  document.body.innerHTML = '<div id="app"></div>';
  return createApp({
    root: document.querySelector('#app'),
    seed,
    modules,
    audio: nullAudio,
    packs,
    installPacks,
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

  /**
   * 沙箱**本体**起不来时游戏必须能开 —— 这条是真实事故补的回归。
   *
   * 事故现场：dev 下 Vite 不把 .wasm 搬进预打包目录，QuickJS 实例化抛
   * "expected magic word"，而 main.js 里这段没有 try —— 异常一路冒到
   * createApp，玩家看到的是白屏加一行“启动失败”，连进模组屏卸包的机会都没有。
   * 上面那条“包坏掉”只测了**单包隔离**（installSandboxPacks 自接接住），
   * 根本测不到“整个沙箱没起来”这一档，所以这里拿注入口子直接报假它。
   */
  it('沙箱本体起不来时：游戏照样开、原因说得出、卸包入口仍在', async () => {
    const packs = await new PackService().init();
    await packs.install({ ...PACK, title: '跑不起来的包' });

    const app = await boot(
      packs,
      31337,
      modulesWithExample(),
      async () => {
        throw new Error(
          'Aborted(CompileError: WebAssembly.instantiate(): expected magic word 00 61 73 6d, found 3c 21 64 6f)',
        );
      },
    );

    // 1) 开起来了，而且停在主菜单
    expect(app.router.current).toBe(SCREEN.MAIN_MENU);
    // 2) 不是“静默没效果”：原因与影响面都记在报告里
    expect(app.packReport.sandboxError).toContain('expected magic word');
    expect(app.packReport.blockedPacks).toBe(1);
    expect(app.packReport.loaded).toHaveLength(0);
    expect(app.pool.skills.has('poc.app.nova')).toBe(false);
    // 3) 关键：存档命名空间仍按“装了包”走。跟着加载成败切库的话，
    //    装包玩家下次看到的是“进度不见了”—— 那比白屏更难解释。
    expect(app.saveService.modded).toBe(true);

    // 4) 模组屏把原因写上脸，并且仍有卸包按钮（否则玩家出不去这个循环）
    app.router.go(SCREEN.MODS);
    app.screens[SCREEN.MODS].onEnter();
    for (let i = 0; i < 3; i += 1) await new Promise((r) => setTimeout(r, 0));
    const alerts = [...app.screens[SCREEN.MODS].element.querySelectorAll('.mod-alert')];
    expect(alerts.some((n) => n.textContent.includes('沙箱本体没能启动'))).toBe(true);
    expect(alerts.some((n) => n.textContent.includes('expected magic word'))).toBe(true);
    expect(
      app.screens[SCREEN.MODS].element.querySelector('[data-act="remove"]'),
      '卸包入口必须可达，不然玩家永远退不出这个循环',
    ).not.toBeNull();
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

describe('模组屏（S3）', () => {
  /** 进到模组屏并渲染一次。 */
  async function openMods(app) {
    app.router.go(SCREEN.MODS);
    app.screens[SCREEN.MODS].onEnter();
    await flush();
    return app.screens[SCREEN.MODS].element;
  }
  const flush = async (times = 3) => {
    for (let i = 0; i < times; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  };
  /**
   * 等确认弹层出现。**别用固定 tick 数**：安装路径上还有动态 import
   * （zip 要现拉 fflate），固定次数就是撞运气。
   */
  const waitForDialog = async (label, rounds = 40) => {
    for (let i = 0; i < rounds; i += 1) {
      await flush(2);
      const box = document.querySelector('.dialog-box');
      if (box !== null) return box;
    }
    throw new Error(`${label}：等不到确认弹层`);
  };

  /** 点掉确认弹层（安装/卸载都会问一句，不点是改不了的） */
  const confirmDialog = (label) => {
    const box = document.querySelector('.dialog-box');
    expect(box, `${label}：应该弹确认`).not.toBeNull();
    const button = box.querySelector('[data-confirm]');
    expect(button, `${label}：确认按钮应在`).not.toBeNull();
    button.click();
  };

  it('主菜单进得去；没装包时是明确的空态而不是半张表', async () => {
    const packs = await new PackService().init();
    const app = await boot(packs);
    const el = await openMods(app);
    const third = el.querySelector('[data-slot="section-third"]');
    expect(third.querySelector('.mod-card.is-empty').textContent).toContain('还没有安装任何第三方包');
    // 空态只属于第三方那一段 —— 官方内容是实打实存在的，不能跟着一起"空"
    expect(third.querySelectorAll('.mod-card').length).toBe(1);
    app.destroy();
  });

  it('官方内容分核心包与示例包两段显示，且不给启停/卸载按钮', async () => {
    const packs = await new PackService().init();
    const app = await boot(packs);
    const el = await openMods(app);

    const core = [...el.querySelectorAll('[data-slot="core-list"] .mod-card')];
    // 按集合比，不按顺序：官方包的先后由模组拓扑排序决定，那是实现细节，
    // 拿顺序做断言等于把测试绑在一个随时会变的排写上
    expect(core.map((n) => n.getAttribute('data-id')).sort()).toEqual([
      'official.core-encounters',
      'official.core-map',
      'official.core-monsters',
      'official.core-skills',
    ]);
    // 内容数量要看得见（这是"官方到底装了什么"的唯一入口）
    const skills = core.find((n) => n.getAttribute('data-id') === 'official.core-skills');
    expect(skills.querySelector('.mod-contents').textContent).toContain('90 技能');
    expect(skills.querySelector('.mod-contents').textContent).toContain('6 流派');
    // 地图生成器以前没有 source，统计会显示成"（无内容）"
    const mapPack = core.find((n) => n.getAttribute('data-id') === 'official.core-map');
    expect(mapPack.querySelector('.mod-contents').textContent).toContain('1 地图生成器');

    const dev = [...el.querySelectorAll('[data-slot="dev-list"] .mod-card')];
    expect(dev.map((n) => n.getAttribute('data-id'))).toEqual(['dev.example-pack']);
    expect(dev[0].querySelector('.mod-title').textContent).toContain('示例包');
    expect(dev[0].querySelector('.mod-contents').textContent).toContain('6 技能');

    // 官方卡片上不该有任何操作按钮：启停/卸载对构建期内容没有意义
    expect(el.querySelectorAll('[data-slot="core-list"] button, [data-slot="dev-list"] button').length).toBe(0);
    expect(core[0].querySelector('.mod-state').textContent.trim()).toBe('构建期');
    app.destroy();
  });

  it('装了但没重载：状态写「未生效」并给出重载入口（不假装热生效）', async () => {
    const packs = await new PackService().init();
    const app = await boot(packs);
    await packs.install({ ...PACK, title: '星爆包' });
    const el = await openMods(app);

    const card = el.querySelector('[data-slot="section-third"] .mod-card');
    expect(card.querySelector('.mod-title').textContent).toBe('星爆包');
    expect(card.querySelector('.mod-state').textContent.trim()).toBe('未生效');
    expect(card.querySelector('.mod-hash code').textContent).toMatch(/^[0-9a-f]{8,}$/);
    expect(el.querySelector('[data-slot="reload"]').hidden).toBe(true);

    card.querySelector('[data-act="toggle"]').click();
    await flush();
    expect((await packs.list())[0].enabled).toBe(false);
    // 改完必须让玩家知道"要重载才生效"
    expect(el.querySelector('[data-slot="reload"]').hidden).toBe(false);
    app.destroy();
  });

  it('启动时装好的包标「已生效」；卸载入口真的从库里删掉', async () => {
    const packs = await new PackService().init();
    await packs.install({ ...PACK });
    const app = await boot(packs);
    const el = await openMods(app);
    const third = el.querySelector('[data-slot="section-third"]');
    expect(third.querySelector('.mod-state.is-live')).not.toBeNull();
    expect(third.querySelector('.mod-state').textContent.trim()).toBe('已生效');

    third.querySelector('[data-act="remove"]').click();
    await flush();
    confirmDialog('卸载');
    await flush();
    expect(await packs.list()).toHaveLength(0);
    app.destroy();
  });

  it('包加载失败与覆盖官方内容都会出现在告警区（不能只写进 console）', async () => {
    const packs = await new PackService().init();
    const app = await boot(packs);
    app.packReport.failed.push({ id: 'poc.broken', reason: '疑似死循环' });
    app.packReport.overrides.push({ id: 'blade.jab', kind: 'skills', was: 'official.core-skills', by: 'poc.x' });
    const el = await openMods(app);
    // 断言 render 的 promise 真的 resolve：DOM 更新之后才抛的错，
    // 只看 innerHTML 是查不出来的（el.toggle() 那个坑就是这么漏过 jsdom 的）
    await expect(app.screens[SCREEN.MODS].render()).resolves.toBeUndefined();
    await flush();
    const alerts = [...el.querySelectorAll('.mod-alert')].map((n) => n.textContent);
    expect(alerts.some((t) => t.includes('poc.broken') && t.includes('疑似死循环'))).toBe(true);
    expect(alerts.some((t) => t.includes('blade.jab') && t.includes('official.core-skills'))).toBe(true);
    app.destroy();
  });

  it('看源码：装的是别人写的代码，必须能打开看', async () => {
    const packs = await new PackService().init();
    await packs.install({ ...PACK });
    const app = await boot(packs);
    const el = await openMods(app);
    el.querySelector('[data-slot="section-third"] [data-act="source"]').click();
    await flush(6);
    const pre = document.querySelector('.mod-src');
    expect(pre).not.toBeNull();
    expect(pre.textContent).toContain("import { begin, skill");
    app.destroy();
  });

  it('安装入口走文件选择器；身份从文件名推且展示给玩家', async () => {
    const packs = await new PackService().init();
    const app = await boot(packs);
    const el = await openMods(app);
    const input = el.querySelector('[data-slot="file"]');
    const spy = vi.spyOn(input, 'click');
    el.querySelector('[data-act="install"]').click();
    expect(spy).toHaveBeenCalled();

    // 直接喂一个 File 进 change：走完整安装路径（含真实确认弹层，不打桩）
    const file = new File([PACK.files['main.js']], 'poc.app@2.0.0.js', { type: 'text/javascript' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new Event('change'));
    await waitForDialog('安装');
    confirmDialog('安装');
    await flush(6);
    const rows = await packs.list();
    expect(rows[0]).toMatchObject({ id: 'poc.app', version: '2.0.0' });
    app.destroy();
  });
});

describe('zip 包安装（S2b-4）', () => {
  const flush = async (n = 6) => {
    for (let i = 0; i < n; i += 1) await new Promise((r) => setTimeout(r, 0));
  };

  it('拖一个 .zip 进来：多文件包解开后正常安装', async () => {
    const { zipSync, strToU8 } = await import('fflate');
    const packs = await new PackService().init();
    const app = await boot(packs);
    app.router.go(SCREEN.MODS);
    await flush(3);

    const input = app.screens[SCREEN.MODS].element.querySelector('[data-slot="file"]');
    const bytes = zipSync({
      'main.js': strToU8(PACK.files['main.js']),
      'lib/extra.js': strToU8('export const EXTRA = 1;'),
    });
    // jsdom 的 File 没有 arrayBuffer/text，所以给一个最小替身：
    // 生产代码两条路径都有（file.arrayBuffer?.()），这里测的是 zip 分支
    const stub = { name: 'poc.zip@1.2.3.zip', arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
    Object.defineProperty(input, 'files', { value: [stub], configurable: true });
    input.dispatchEvent(new Event('change'));

    // zip 分支要先动态 import fflate 再解压 ⇒ 必须轮询等弹层。
    // 固定 tick 数在这里会通过得**毫无意义**：它测的是"这 6 个宏任务够不够"
    let box = null;
    for (let i = 0; i < 40 && box === null; i += 1) {
      await flush(2);
      box = document.querySelector('.dialog-box');
    }
    expect(box, 'zip 安装也要过确认弹层').not.toBeNull();
    expect(box.textContent).toContain('poc.zip');
    expect(box.textContent).toContain('2 个文件');
    box.querySelector('[data-confirm]').click();
    await flush(6);

    const rows = await packs.list();
    expect(rows[0]).toMatchObject({ id: 'poc.zip', version: '1.2.3', files: 2 });
    app.destroy();
  });

  it('炸弹包给出可读原因，不静默失败也不崩', async () => {
    const { zipSync, strToU8 } = await import('fflate');
    const packs = await new PackService().init();
    const app = await boot(packs);
    app.router.go(SCREEN.MODS);
    await flush(3);
    const input = app.screens[SCREEN.MODS].element.querySelector('[data-slot="file"]');
    const huge = strToU8('A'.repeat(600 * 1024));
    const bytes = zipSync({ 'main.js': strToU8(PACK.files['main.js']), 'big.js': huge });
    const stub = { name: 'poc.bomb.zip', arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
    Object.defineProperty(input, 'files', { value: [stub], configurable: true });
    input.dispatchEvent(new Event('change'));

    let toast = null;
    for (let i = 0; i < 40 && toast === null; i += 1) {
      await flush(2);
      const node = document.querySelector('.app-toast');
      if (node !== null && !node.hidden && node.textContent !== '') toast = node;
    }
    expect(toast, '炸弹包必须给出可读原因，不能静默').not.toBeNull();
    expect(toast.textContent).toMatch(/解包失败|解压后超过/);
    expect(await packs.list()).toHaveLength(0);
    app.destroy();
  });
});
