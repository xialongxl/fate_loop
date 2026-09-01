// @vitest-environment jsdom
/**
 * 前瞻性投资系统 · ATM（跨局存款机）。
 *
 * 这个文件要钉的是"跨局"两个字 —— 那正是本作第一次有**不在某一局里**的数值：
 *   · 换一局、换个存档槽、甚至装了运行时包（存档切库），余额都必须在
 *   · 清档要连着它一起清，而且要**事先说清楚**（悄悄抹掉一笔看不见的钱最脏）
 *   · 它不吃随机数：存不存钱不该改变这场战斗本身
 * 奖励阶梯目前**故意是空的**（数值要和 P4 精炼一起算），所以这里也要断言
 * UI 老实说"待定"，不许显示"全部已解锁"。
 */

import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/main.js';
import { createHarness, battleFingerprint, officialModuleEntries } from '../helpers.js';
import { nullAudio } from '../../src/ui/audio/nullAudio.js';
import { AtmService } from '../../src/persistence/atm.js';
import { SaveService } from '../../src/persistence/saveService.js';
import { pickAdapter, resetAdapterCache } from '../../src/persistence/storageAdapter.js';
import { NODE_TYPE, SCREEN } from '../../src/core/constants.js';

const SEED = 4242;

async function boot(options = {}) {
  resetAdapterCache();
  document.body.innerHTML = '<div id="app"></div>';
  const cleaner = new SaveService();
  await cleaner.init();
  await cleaner.clearAll();
  // ATM 是跳局的 ⇒ 它故意不随开局重置。测试之间不洗它，就会看到
  // 上一个用例存进去的钱（那既不报 bug 也不说明问题，只会让人误判）。
  await (await new AtmService().init()).clear();
  return createApp({
    root: document.querySelector('#app'),
    seed: SEED,
    modules: officialModuleEntries(),
    audio: nullAudio,
    ...options,
  });
}

const q = (sel) => document.querySelector(sel);
const qa = (sel) => [...document.querySelectorAll(sel)];
const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
const tick = async (times = 8) => {
  for (let i = 0; i < times; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

/** 走到当前层的商店节点并打开对话框。 */
async function openShop(app) {
  app.startNewRun(SEED);
  await tick(2);
  const node = app
    .snapshot()
    .mapNodes.find((n) => n.type === NODE_TYPE.SHOP);
  expect(node, '这一层没有商店节点，换 seed').toBeTruthy();
  app.store.update((draft) => {
    draft.currentNodeId = node.id;
  });
  app.openShopDialog();
  await tick();
  return node;
}

/** 直接给玩家一笔钱，免得为了测试去打十几场。 */
const give = (app, shards) =>
  app.store.update((draft) => {
    draft.fateShards = shards;
  });

describe('ATM 存取（装配层）', () => {
  beforeEach(async () => {
    resetAdapterCache();
  });

  it('商店里有 ATM 面板：余额、累计、存/取按钮都在', async () => {
    const app = await boot();
    await openShop(app);
    give(app, 1_234);
    app.renderAll();
    const box = q('.dialog-box');
    expect(box.textContent).toContain('前瞻性投资系统');
    expect(box.textContent).toContain('投资奖励待定');
    const deposit = qa('.dialog-box [data-atm-deposit]').map((b) => b.getAttribute('data-atm-deposit'));
    expect(deposit).toEqual(['50', '200', '1000', 'all']);
    expect(qa('.dialog-box [data-atm-withdraw]').length).toBe(4);
    app.destroy();
  });

  it('存 1000 ⇒ 碎片扣掉、余额与累计同增，并当场写盘', async () => {
    const app = await boot();
    await openShop(app);
    give(app, 1_234);
    app.renderAll();
    click(mustButton('.dialog-box [data-atm-deposit="1000"]'));

    expect(app.snapshot().fateShards).toBe(234);
    expect(app.atmAccount).toMatchObject({ balance: 1000, total: 1000 });
    await tick(4);
    const { adapter } = await pickAdapter({ modded: false });
    expect(await adapter.get('atm')).toMatchObject({ balance: 1000, total: 1000 });
    app.destroy();
  });

  it('取回是 1:1 无损：余额减、碎片加、**历史累计不动**', async () => {
    const app = await boot();
    await openShop(app);
    give(app, 1_234);
    app.renderAll();
    click(mustButton('.dialog-box [data-atm-deposit="1000"]'));
    click(mustButton('.dialog-box [data-atm-withdraw="200"]'));

    expect(app.snapshot().fateShards).toBe(434);
    expect(app.atmAccount).toMatchObject({ balance: 800, total: 1000 });
    app.destroy();
  });

  it('钱不够时不成交，也不留下半成的账', async () => {
    const app = await boot();
    const before = app.atmAccount;
    expect(app.flow.depositToAtm(500)).toEqual({ ok: false, reason: 'insufficientShards', atm: before });
    expect(app.snapshot().fateShards).toBe(0);
    expect(app.atmAccount.balance).toBe(0);
    app.destroy();
  });

  it('跨局：换一局、重开应用，余额都还在（这就是"跨局"的定义）', async () => {
    const atm = await new AtmService().init();
    await atm.clear(); // 用**同一个实例**，所以必须当场清，不能只清盘
    const app = await boot({ atm });
    await openShop(app);
    give(app, 1_234);
    app.renderAll();
    click(mustButton('.dialog-box [data-atm-deposit="all"]'));
    const deposited = app.atmAccount.balance;
    expect(deposited).toBe(1_234);
    app.destroy();

    // 重开一局（新的 store 与 flow）
    const app2 = await boot({ atm: await new AtmService().init() });
    expect(app2.atmAccount.balance).toBe(deposited);
    // 新开一局不会动它：钱是玩家这个人的，不是某一局的
    app2.startNewRun(999);
    await tick(2);
    expect(app2.atmAccount.balance).toBe(deposited);
    app2.destroy();
  });

  it('装了运行时包（存档切到隔离库）时，余额仍读得到 —— 它永远在 vanilla 库里', async () => {
    const app = await boot();
    await openShop(app);
    give(app, 700);
    app.renderAll();
    click(mustButton('.dialog-box [data-atm-deposit="200"]'));
    await tick(4);
    app.destroy();

    const modded = await pickAdapter({ modded: true });
    // 隔离库里不应出现这笔账（adapter 缺键时可能给 undefined，所以归一成 null 再断）
    expect((await modded.adapter.get('atm')) ?? null).toBeNull();
    const revived = await new AtmService().init();
    expect(revived.state.balance).toBe(200); // 而服务照样读得到
  });

  it('清空全部数据会连 ATM 一起清 —— 而且事先点名了金额', async () => {
    const app = await boot();
    await openShop(app);
    give(app, 600);
    app.renderAll();
    click(mustButton('.dialog-box [data-atm-deposit="200"]'));
    await tick(4);

    app.router.go(SCREEN.SETTINGS);
    await tick();
    // 设置屏要看得见这笔钱（看不见就要被清掉的东西最可怕）
    expect(q('[data-screen="settings"] [data-slot="atm"]').textContent).toContain('200');

    click(mustButton('[data-screen="settings"] [data-act="reset"]'));
    await tick();
    const box = q('.dialog-box');
    expect(box.textContent).toContain('ATM');
    expect(box.textContent).toContain('200');
    click(mustButton('.dialog-box [data-confirm]'));
    await tick(6);

    const revived = await new AtmService().init();
    expect(revived.state).toMatchObject({ balance: 0, total: 0 });
    app.destroy();
  });

  it('没有 ATM 服务时（如禁用环境），商店不摆一台按不动的机器', async () => {
    const app = await boot({ atm: null });
    await openShop(app);
    expect(app.flow.hasAtm).toBe(false);
    expect(q('.dialog-box').textContent).not.toContain('前瞻性投资系统');
    app.destroy();
  });

  it('战绩留下当时的余额与累计（"同种子"现在还得加一句"同一台 ATM"）', async () => {
    const app = await boot();
    await openShop(app);
    give(app, 600);
    app.renderAll();
    click(mustButton('.dialog-box [data-atm-deposit="200"]'));
    await tick(4);

    // 强制战败结算，看历史条目
    app.store.update((draft) => {
      draft.player.gcdSequence = [];
      draft.player.ogcdSlots = [];
    });
    const combat = app.snapshot().mapNodes.find((n) => n.type === NODE_TYPE.COMBAT);
    app.store.update((draft) => {
      draft.currentNodeId = combat.id;
    });
    app.beginBattle();
    app.setSpeed('MAX');
    click(mustButton('.dialog-box [data-sum="primary"]'));
    await tick(6);

    const history = await app.saveService.loadHistory();
    expect(history[0]).toMatchObject({ atmBalance: 200, atmTotal: 200 });
    app.destroy();
  });
});

function mustButton(sel) {
  const el = q(sel);
  expect(el, `找不到元素：${sel}`).not.toBeNull();
  return el;
}

describe('ATM 不碰随机流（核心层）', () => {
  it('同一场战斗：存过钱的与否的指纹逐项相等', async () => {
    const run = async (depositAmount) => {
      const h = await createHarness({ seed: SEED });
      h.flow.enterFloor(2);
      if (depositAmount > 0) {
        h.store.update((draft) => {
          draft.fateShards = 10_000;
        });
        h.flow.depositToAtm(depositAmount);
      }
      const node = h.store.unsafeGetState().mapNodes.find((n) => n.type === NODE_TYPE.COMBAT);
      h.store.update((draft) => {
        draft.currentNodeId = node.id;
      });
      h.flow.startBattle();
      h.engine.runToEnd();
      return battleFingerprint(h.store.getSnapshot());
    };

    const plain = await run(0);
    const deposited = await run(3_000);
    expect(deposited).toEqual(plain);
  });

  it('没注入 ATM 时 flow 的方法老实拒绝，而不是造一笔不存在的账', async () => {
    const h = await createHarness({ seed: 7 });
    expect(h.flow.hasAtm).toBe(false);
    expect(h.flow.depositToAtm(10)).toEqual({ ok: false, reason: 'noAtm' });
    expect(h.flow.withdrawFromAtm(10)).toEqual({ ok: false, reason: 'noAtm' });
    expect(h.store.getSnapshot().fateShards).toBe(0);
  });
});
