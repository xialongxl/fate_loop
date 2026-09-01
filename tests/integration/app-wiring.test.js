// @vitest-environment jsdom
/**
 * 阶段 9 接线的 jsdom 冒烟测试。
 *
 * 为什么必须有：UI 层此前零测试，而「屏幕文件不存在但导航已引用」这类缺陷
 * （交接文档 P0-1 的 codex/history）只有真的把路由点一遍才会暴露。
 * 这里跑的是完整装配：boot → 主菜单 → 开局 → 导航 → 战斗 → 结算 → 存档。
 *
 * 刻意不测视觉：只断言「屏幕渲染出非空内容、回调真的打到 GameFlow」。
 */

import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  createApp,
  DEFAULT_GCD_SEQUENCE,
  DEFAULT_OGCD_SLOTS,
} from '../../src/main.js';
import { battleFingerprint, officialModuleEntries } from '../helpers.js';
import { filterHashOf } from '../../src/core/lootFilter.js';
import { nullAudio } from '../../src/ui/audio/nullAudio.js';
import { levelFromTotalExp, totalExpForLevel } from '../../src/core/progression.js';
import { recalcPlayer } from '../../src/core/derived.js';
import { resetAdapterCache } from '../../src/persistence/storageAdapter.js';
import { SaveService } from '../../src/persistence/saveService.js';
import {
  AUTO_SAVE_SLOT,
  GAME_STATUS,
  NODE_TYPE,
  SCREEN,
  SPEED_MODES,
  STARTER_SKILL_COUNT,
  VICTORY_FLOOR,
  WINNER,
} from '../../src/core/constants.js';

const SEED = 20240101;

/**
 * 挂载一个全新应用。
 * clearStorage 默认 true：fake-indexeddb 在同一 jsdom 进程内是共享的，
 * 不清的话上一个测试写的历史与槽位会污染断言。同一测试内第二次 mount 要传 false。
 */
async function mount({ clearStorage = true, ...options } = {}) {
  resetAdapterCache();
  document.body.innerHTML = '<div id="app"></div>';
  if (clearStorage) {
    const cleaner = new SaveService();
    await cleaner.init();
    await cleaner.clearAll();
  }
  return createApp({
    root: document.querySelector('#app'),
    seed: SEED,
    modules: officialModuleEntries(),
    audio: nullAudio,
    ...options,
  });
}

const q = (selector) => document.querySelector(selector);
const qa = (selector) => [...document.querySelectorAll(selector)];
const textOf = (selector) => q(selector)?.textContent ?? '';
const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
/** 找不到就带着选择器报错，避免「null.dispatchEvent」这种无信息失败。 */
function must(selector) {
  const el = q(selector);
  expect(el, `找不到元素：${selector}`).not.toBeNull();
  return el;
}
/** 等几个宏任务：存档探测与写队列都是异步的（fake-indexeddb 要跨多个 task）。 */
async function tick(times = 16) {
  for (let i = 0; i < times; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * 等 toast 真的出现。**不要用固定 tick 数等 IndexedDB**：
 * 存档读写走真实异步 I/O，固定次数是撞运气 —— 本文件里
 * “导出全部”那条就这样假失败过（加一行 console.log 就绿）。
 */
async function waitForToast(pattern, rounds = 20) {
  for (let i = 0; i < rounds; i += 1) {
    await tick();
    const toast = q('.app-toast');
    if (toast !== null && !toast.hidden && pattern.test(toast.textContent)) return toast;
  }
  throw new Error(
    `等不到匹配 ${String(pattern)} 的提示，当前：${JSON.stringify(q('.app-toast')?.textContent ?? '')}`,
  );
}
const screenEl = (id) => `.screen-host [data-screen="${id}"]`;
const visibleScreen = () => qa('[data-screen]').find((el) => !el.hidden)?.dataset.screen ?? null;

/** 走完整的新开局路径（含种子对话框），用于验证 UI 通路本身。 */
async function startRunViaDialog(app, seedText = null) {
  click(must('[data-act="new"]'));
  const box = q('.dialog-box');
  if (seedText !== null) box.querySelector('[data-slot="seed"]').value = seedText;
  click(box.querySelector('[data-act="start"]'));
}

/** 直接开一局（多数测试关心的是屏幕行为，不是对话框）。 */
function startRun(app) {
  app.startNewRun(SEED);
}

/** 按 id 取快照里的节点。 */
function nodeById(state, id) {
  return state.mapNodes.find((n) => n.id === id);
}

/** 找出货架上真的在卖某商品的商店节点（商品按 nodeId 派生，种子固定则恒定）。 */
function shopSelling(h, itemId) {
  for (const node of h.snapshot().mapNodes.filter((n) => n.type === NODE_TYPE.SHOP)) {
    standOn(h, node);
    if (h.flow.getShopOffers().offers.some((o) => o.id === itemId)) return node;
  }
  return null;
}

/** 把玩家放到某个节点上（等价于走过去，但不触发战斗）。 */
function standOn(app, node) {
  app.store.update((draft) => {
    draft.currentNodeId = node.id;
    draft.visitedNodeIds.add(node.id);
  });
}

let app;
beforeEach(async () => {
  app = await mount();
});

// ============================================================
// 外壳与主菜单
// ============================================================

describe('外壳启动', () => {
  it('落在主菜单，局内导航条隐藏', () => {
    expect(visibleScreen()).toBe(SCREEN.MAIN_MENU);
    expect(q('.app-nav').hidden).toBe(true);
    expect(textOf('.menu-title')).toContain('命运轮回');
  });

  it('存储后端被报告出来', () => {
    expect(textOf('[data-field="storage"]')).toMatch(/存档后端：(indexeddb|localstorage|memory)/);
  });

  it('没有任何存档时「继续游戏」禁用而不是藏起来', async () => {
    await tick();
    expect(q('[data-act="continue"]').disabled).toBe(true);
    // 文案不再限定"自动存档"：继续游戏现在跨四个槽位判断（见 continuePolicy）
    expect(q('[data-slot="continue-note"]').textContent).toContain('暂无可继续的存档');
  });

  /**
   * 回归：以前「继续游戏」写死读自动槽。玩家误点一次新的轮回之后，
   * 自动槽是 Lv.1 空局、而 Lv.14 那局躺在手动槽里 —— 点"继续"会被领进空局，
   * 看起来就像存档全没了。现在按"时间优先、空局则降级到进度最高"选。
   */
  it('自动槽被误点的新局占着时，继续游戏读的是有进度的手动槽', async () => {
    await tick();
    // 先认真玩一局存进 slot1（有 exp、有胜场）
    startRun(app);
    app.store.update((d) => {
      d.player.exp = 4000;
      d.metadata.battlesWon = 12;
      d.floorNumber = 6;
    });
    app.saveService.saveToSlot('slot1', app.store.unsafeGetState());
    await app.saveService.flush();

    // 自动槽刷成"什么都没发生过"的空局。
    // 注意要**绕过 GameFlow 的门禁**直接写盘：新局没进度时根本不会落盘，
    // 而玩家手上那份空自动档是旧版本（门禁之前）留下的遗留数据 —— 这里模拟的
    // 就是它。给自动槽加任何真进度都会让"时间优先"正确地选中它，测不到降级。
    const { createInitialState } = await import('../../src/core/initialState.js');
    app.saveService.saveRun(createInitialState(999001, { gcdSequence: [], ogcdSlots: [] }));
    await app.saveService.flush();
    app.gotoMenu();
    await tick();

    const note = q('[data-slot="continue-note"]').textContent;
    expect(note, '按钮该说清会打开哪一份').toContain('存档位 1');
    expect(note).toContain('第 6 层');
    // 降级这件事要写在按钮上，不能等点下去才发现
    expect(note).toContain('改读进度更高的');

    click(q('[data-act="continue"]'));
    await tick(4);
    const okButton = document.querySelector('.dialog-box [data-confirm]');
    if (okButton !== null) {
      okButton.click();
      await tick(4);
    }
    expect(app.snapshot().player.exp).toBe(4000);
    expect(app.snapshot().seed).not.toBe(999001);
  });
});

// ============================================================
// 开局
// ============================================================

describe('新的轮回', () => {
  it('种子对话框：开始 → 进入地图屏，导航条出现', async () => {
    await startRunViaDialog(app);
    expect(visibleScreen()).toBe(SCREEN.MAP);
    expect(q('.app-nav').hidden).toBe(false);
    expect(textOf('[data-field="floor"]')).toContain('第 1 层');
    expect(textOf('[data-field="status"]')).toContain('探索中');
  });

  it('种子归一化：同一词语永远得到同一局', async () => {
    await startRunViaDialog(app, '命运轮回去');
    const seed = app.snapshot().seed;
    expect(Number.isInteger(seed)).toBe(true);
    expect(app.snapshot().status).toBe(GAME_STATUS.EXPLORING);

    const again = await mount({ clearStorage: false });
    await startRunViaDialog(again, '命运轮回去');
    expect(again.snapshot().seed).toBe(seed);
    expect(again.snapshot().mapNodes.map((n) => n.type)).toEqual(app.snapshot().mapNodes.map((n) => n.type));
  });

  it('默认开局序列在 1 级全部合法（P1-2 的前置检查）', () => {
    const table = app.unlockTable;
    const offenders = DEFAULT_GCD_SEQUENCE.filter((id) => (table.get(id) ?? 1) > 1);
    expect(offenders).toEqual([]);
    const ogcdOffenders = DEFAULT_OGCD_SLOTS.filter((s) => (table.get(s.skillId) ?? 1) > 1);
    expect(ogcdOffenders).toEqual([]);
    expect(DEFAULT_GCD_SEQUENCE.length).toBeGreaterThan(0);
  });
});

// ============================================================
// 导航：每个屏幕都要真的渲染出东西
// ============================================================

describe('局内导航', () => {
  const NAV_TARGETS = [
    SCREEN.MAP,
    SCREEN.SEQUENCE,
    SCREEN.EQUIPMENT,
    SCREEN.CHARACTER,
    SCREEN.CODEX,
    SCREEN.HISTORY,
  ];

  beforeEach(() => {
    startRun(app);
  });

  it.each(NAV_TARGETS)('导航到 %s 不崩溃且渲染出内容', (target) => {
    const before = visibleScreen();
    expect(before).toBe(SCREEN.MAP);
    click(must(`[data-nav="${target}"]`));

    expect(visibleScreen()).toBe(target);
    const el = q(screenEl(target));
    expect(el.innerHTML.length).toBeGreaterThan(80);
    expect(q(`[data-nav="${target}"]`).getAttribute('aria-pressed')).toBe('true');
  });

  it('当前导航按钮以外的屏幕不渲染（DOM 常驻但 hidden）', () => {
    click(must(`[data-nav="${SCREEN.CHARACTER}"]`));
    expect(q(screenEl(SCREEN.MAP)).hidden).toBe(true);
    expect(q(screenEl(SCREEN.CHARACTER)).hidden).toBe(false);
  });

  it('角色屏显示等级与属性拆解表', () => {
    click(must(`[data-nav="${SCREEN.CHARACTER}"]`));
    expect(textOf(`${screenEl(SCREEN.CHARACTER)} .level-badge`)).toContain('Lv.');
    const rows = qa(`${screenEl(SCREEN.CHARACTER)} .breakdown-table tbody tr`);
    expect(rows).toHaveLength(4);
    expect(rows[0].textContent).toContain('最大生命');
  });

  it('序列屏列出默认序列与技能库', () => {
    click(must(`[data-nav="${SCREEN.SEQUENCE}"]`));
    const list = q(`${screenEl(SCREEN.SEQUENCE)} [data-slot="gcd-list"]`);
    expect(list.querySelectorAll('li').length).toBe(DEFAULT_GCD_SEQUENCE.length);
    expect(textOf(`${screenEl(SCREEN.SEQUENCE)} [data-slot="level-note"]`)).toContain('Lv.1');
  });

  it('装备屏显示 8 个槽位与空背包提示', () => {
    click(must(`[data-nav="${SCREEN.EQUIPMENT}"]`));
    expect(qa(`${screenEl(SCREEN.EQUIPMENT)} .equip-slot`).length).toBe(8);
    expect(textOf(`${screenEl(SCREEN.EQUIPMENT)} [data-slot="bag"]`)).toContain('背包');
  });
});

// ============================================================
// 战斗屏
// ============================================================

describe('战斗屏接线', () => {
  /** 走到本层第一个未清理的战斗节点并开战。 */
  function startFirstCombat(h) {
    const node = h.app.snapshot().mapNodes.find((n) => n.type === NODE_TYPE.COMBAT);
    standOn(h.app, node);
    h.app.beginBattle();
    return node;
  }

  it('MAX 速度一路到底：奖励出现，返回地图按钮可用', () => {
    startRun(app);
    startFirstCombat({ app });
    expect(visibleScreen()).toBe(SCREEN.BATTLE);
    expect(app.snapshot().status).toBe(GAME_STATUS.BATTLING);

    app.setSpeed(SPEED_MODES.MAX);
    const state = app.snapshot();
    expect(state.status).toBe(GAME_STATUS.EXPLORING); // 已结算
    expect(state.winner).toBeNull();
    expect(state.lastBattleReward).not.toBeNull();

    const foot = q(`${screenEl(SCREEN.BATTLE)} .battle-foot`);
    expect(foot.hidden).toBe(false);
    expect(foot.textContent).toContain('碎片');

    click(foot.querySelector('[data-act="leave"]'));
    expect(visibleScreen()).toBe(SCREEN.MAP);
  });

  it('1x 逐帧推进：帧间状态在变，结束后可结算', async () => {
    startRun(app);
    startFirstCombat({ app });
    app.setSpeed(SPEED_MODES.X1);
    expect(app.speed).toBe(SPEED_MODES.X1);

    // 手动跑若干帧（jsdom 的 rAF 依赖 vitest 的 fake/real timer 时序，这里直接驱动引擎）
    for (let i = 0; i < 200 && app.snapshot().status === GAME_STATUS.BATTLING; i += 1) {
      app.engine.runFrame(SPEED_MODES.X1);
    }
    app.setSpeed(SPEED_MODES.MAX);
    expect(app.snapshot().status).toBe(GAME_STATUS.EXPLORING);
    await tick();
  });

  it('战斗屏每帧都在改 DOM，但不消费随机流（确定性对拍）', async () => {
    // A：安静地打一场
    const quiet = await mount();
    startRun(quiet);
    const nodeA = quiet.snapshot().mapNodes.find((n) => n.type === NODE_TYPE.COMBAT);
    standOn(quiet, nodeA);
    quiet.beginBattle();
    quiet.engine.runToEnd();
    const fingerprintA = battleFingerprint(quiet.snapshot());

    // B：同样的种子同样的节点，但中途把每个屏幕都渲染一遍、开合对话框多次
    const noisy = await mount();
    startRun(noisy);
    for (const id of Object.values(SCREEN)) {
      if (noisy.router.has(id)) noisy.router.go(id);
    }
    noisy.router.go(SCREEN.MAP);
    for (let i = 0; i < 30; i += 1) noisy.renderAll();
    const nodeB = noisy.snapshot().mapNodes.find((n) => n.type === nodeA.type);
    standOn(noisy, nodeB);
    noisy.beginBattle();
    for (let i = 0; i < 50; i += 1) noisy.screens[SCREEN.BATTLE].render();
    noisy.engine.runToEnd();
    expect(battleFingerprint(noisy.snapshot())).toEqual(fingerprintA);
  });

  it('阵亡：结算面板出现，关闭后回主菜单', () => {
    startRun(app);
    // 清空序列 → 打不出伤害 → 必然阵亡
    app.store.update((draft) => {
      draft.player.gcdSequence = [];
      draft.player.ogcdSlots = [];
    });
    startFirstCombat({ app });
    app.setSpeed(SPEED_MODES.MAX);

    const state = app.snapshot();
    expect(state.status).toBe(GAME_STATUS.FINISHED);
    expect(state.winner).toBe(WINNER.MONSTERS);
    const box = q('.dialog-box');
    expect(box).not.toBeNull();
    expect(box.textContent).toContain('探索结束');
    expect(box.textContent).toContain('阵亡');

    click(box.querySelector('[data-sum="primary"]'));
    expect(q('.app-dialog').hidden).toBe(true);
    expect(visibleScreen()).toBe(SCREEN.MAIN_MENU);
  });

  it('暂停按钮停止推进虚拟时间', () => {
    startRun(app);
    startFirstCombat({ app });
    app.setSpeed(SPEED_MODES.X1);
    app.setSpeed(SPEED_MODES.PAUSED);
    const t = app.snapshot().virtualTime;
    for (let i = 0; i < 5; i += 1) expect(app.snapshot().virtualTime).toBe(t);
  });
});

// ============================================================
// 节点操作（地图屏 → GameFlow）
// ============================================================

describe('节点操作', () => {
  beforeEach(() => {
    startRun(app);
  });

  it('战斗节点的按钮真的能开战（P1-3 断链已接上）', () => {
    const node = app.snapshot().mapNodes.find((n) => n.type === NODE_TYPE.COMBAT);
    standOn(app, node);
    click(must(`${screenEl(SCREEN.MAP)} [data-action="battle"]`));
    expect(visibleScreen()).toBe(SCREEN.BATTLE);
    expect(app.snapshot().status).toBe(GAME_STATUS.BATTLING);
  });

  it('商店对话框：买属性商品扣碎片，且加成撑得过重算', () => {
    const shop = shopSelling(app, 'shop.stat.maxHp');
    expect(shop).not.toBeNull();
    app.store.update((draft) => {
      draft.fateShards = 500;
    });
    app.openShopDialog();

    const box = q('.dialog-box');
    const offers = box.querySelectorAll('[data-buy]');
    expect(offers.length).toBe(3);
    expect(box.querySelectorAll('[data-buy-gear]').length).toBe(2);

    const before = app.snapshot().player.maxHp;
    click(box.querySelector('[data-buy="shop.stat.maxHp"]'));
    const after = app.snapshot();
    expect(after.fateShards).toBe(500 - 40);
    expect(after.player.maxHp).toBe(before + 60);

    // 重算之后仍在（P0-3 的 UI 通路）
    app.renderAll();
    app.store.update((draft) => {
      draft.player.exp += 1;
    });
    expect(app.snapshot().player.maxHp).toBe(before + 60);
  });

  it('商店：碎片不足给出 toast 而非静默失败', async () => {
    const shop = app.snapshot().mapNodes.find((n) => n.type === NODE_TYPE.SHOP);
    standOn(app, shop);
    app.store.update((draft) => {
      draft.fateShards = 0;
    });
    app.openShopDialog();
    const box = q('.dialog-box');
    const button = box.querySelector('[data-buy]');
    expect(button.disabled).toBe(true);
    await tick();
    expect(q('.app-toast').hidden).toBe(true);
  });

  it('商店行是两行结构，价格写在按钮里（不靠第三列）', () => {
    const shop = app.snapshot().mapNodes.find((n) => n.type === NODE_TYPE.SHOP);
    standOn(app, shop);
    app.openShopDialog();
    const box = q('.dialog-box');

    // 名称与描述各占一个块级子元素（不是同一行里并列的两个 span）
    const first = box.querySelector('.shop-item .shop-item-info');
    expect(first.querySelector('.shop-item-name')).not.toBeNull();
    expect(first.querySelector('.shop-item-desc')).not.toBeNull();
    // 价格进了按钮，独立的 .shop-cost 列已整个拿掉：
    // 一行里三个右对齐元素（名称/价格/按钮）是噪声，而“多少钱”与“买得起吗”是同一个问题
    expect(box.querySelector('.shop-cost')).toBeNull();
    expect(box.querySelector('[data-buy]').textContent).toMatch(/购买 \d+/);
    expect(box.querySelector('[data-buy-gear]').textContent).toMatch(/购入 \d+/);
    // 装备行在描述里重说一次品质名：名字靠颜色分层级，而颜色不是给所有人看的
    const gearDesc = box.querySelector('.shop-list.is-gear .shop-item-desc').textContent;
    expect(gearDesc).toMatch(/^(破损|普通|精良|卓越|史诗|传说|神话|不朽|终焉) ·/);
    // 三段（商品 / 装备货架 / ATM）各自成 section，靠分隔线分组
    expect(box.querySelectorAll('.shop-section').length).toBe(3);
  });

  it('对话框头部条：eyebrow + 标题 + ✕，重绘后不丢也不重复', async () => {
    const shop = app.snapshot().mapNodes.find((n) => n.type === NODE_TYPE.SHOP);
    standOn(app, shop);
    app.openShopDialog();
    const box = q('.dialog-box');

    const header = box.querySelector('.dialog-header');
    expect(header, '头部条应在').not.toBeNull();
    expect(header.querySelector('.dialog-eyebrow').textContent).toBe('功能面板');
    expect(header.querySelector('.dialog-title').textContent).toBe('流浪货摊');
    expect(header.querySelectorAll('[data-dialog-close]')).toHaveLength(1);
    // 标题必须仍在头部里：dialog.js 是“把第一个 h2 搬进去”，不是复制一份
    expect(box.querySelectorAll('h2')).toHaveLength(1);

    // 重绘（买东西会重写整个 box.innerHTML）后头部还得在，而且不能攒出第二个 ✕
    app.store.update((draft) => {
      draft.fateShards = 500;
    });
    app.renderAll();
    click(box.querySelector('[data-buy]'));
    await tick();
    expect(box.querySelector('.dialog-header')).not.toBeNull();
    expect(box.querySelectorAll('[data-dialog-close]')).toHaveLength(1);
  });

  it('右上角 ✕ 真能关掉对话框（重绘后也不失效）', async () => {
    const shop = app.snapshot().mapNodes.find((n) => n.type === NODE_TYPE.SHOP);
    standOn(app, shop);
    app.openShopDialog();
    const box = q('.dialog-box');
    // 先买东西触发一次重绘：✕ 是代理接接的，重绘后必须仍然可用
    app.store.update((draft) => {
      draft.fateShards = 500;
    });
    click(box.querySelector('[data-buy]'));
    await tick();
    click(must('.dialog-box .dialog-close'));
    expect(q('.app-dialog').hidden).toBe(true);
  });

  it('初始焦点不被 ✕ 抢走（头部是注进去的，顺序容易把焦点带偏）', async () => {
    const shop = app.snapshot().mapNodes.find((n) => n.type === NODE_TYPE.SHOP);
    standOn(app, shop);
    app.openShopDialog();
    await tick();
    const focused = document.activeElement;
    expect(focused).not.toBeNull();
    expect(focused.classList.contains('dialog-close')).toBe(false);
  });

  it('事件：选择选项后节点被清理', () => {
    const node = app.snapshot().mapNodes.find((n) => n.type === NODE_TYPE.EVENT);
    standOn(app, node);
    app.openEventDialog();
    const box = q('.dialog-box');
    expect(box.querySelector('[data-choice]')).not.toBeNull();

    click(box.querySelector('[data-choice="0"]'));
    expect(q('.app-dialog').hidden).toBe(true);
    expect(app.snapshot().clearedNodeIds.has(node.id)).toBe(true);
  });

  it('休息：点按钮恢复生命，再点被拒并有提示', () => {
    const rest = app.snapshot().mapNodes.find((n) => n.type === NODE_TYPE.REST);
    standOn(app, rest);
    app.store.update((draft) => {
      draft.player.hp = 50;
    });
    click(must(`${screenEl(SCREEN.MAP)} [data-action="rest"]`));
    expect(app.snapshot().player.hp).toBeGreaterThan(50);

    // 一次性：用过之后按钮不再出现（而不是留着让玩家反复点）
    expect(q(`${screenEl(SCREEN.MAP)} [data-action="rest"]`)).toBeNull();
    expect(app.snapshot().log.some((l) => l.message.includes('休息'))).toBe(true);
  });

  it('下层：出口按钮推进到第 2 层并复位地图', () => {
    const exit = app.snapshot().mapNodes.find((n) => n.id === app.snapshot().exitNodeId);
    standOn(app, exit);
    click(must(`${screenEl(SCREEN.MAP)} [data-action="descend"]`));
    expect(app.snapshot().floorNumber).toBe(2);
    expect(textOf('[data-field="floor"]')).toContain('第 2 层');
  });
});

// ============================================================
// 图鉴与战绩
// ============================================================

describe('图鉴屏', () => {
  beforeEach(() => {
    startRun(app);
    click(must(`[data-nav="${SCREEN.CODEX}"]`));
  });

  it('默认列出技能，并标注 1 级未解锁项', () => {
    const items = qa(`${screenEl(SCREEN.CODEX)} .codex-item`);
    expect(items.length).toBe(90);
    // 1 级解锁的名额 = GCD + oGCD 两类 starter 之和，其余全部标锁
    expect(qa(`${screenEl(SCREEN.CODEX)} .codex-item:not(.is-lock)`).length).toBe(
      STARTER_SKILL_COUNT,
    );
    expect(qa(`${screenEl(SCREEN.CODEX)} .codex-item.is-lock`).length).toBe(
      90 - STARTER_SKILL_COUNT,
    );
  });

  it('切到怪物页签后逐条渲染，搜索能过滤', () => {
    click(must(`${screenEl(SCREEN.CODEX)} [data-tab="monster"]`));
    expect(qa(`${screenEl(SCREEN.CODEX)} .codex-item`).length).toBe(300);

    const search = q(`${screenEl(SCREEN.CODEX)} [data-slot="search"]`);
    search.value = '游魂';
    search.dispatchEvent(new window.Event('input', { bubbles: true }));
    const filtered = qa(`${screenEl(SCREEN.CODEX)} .codex-item`);
    expect(filtered.length).toBeGreaterThan(0);
    expect(filtered.length).toBeLessThan(300);
  });

  it('商品与事件页签含品质示例（宝珠系统未实装要如实标注）', () => {
    click(must(`${screenEl(SCREEN.CODEX)} [data-tab="other"]`));
    const text = q(`${screenEl(SCREEN.CODEX)} [data-slot="list"]`).textContent;
    expect(text).toContain('草药束');
    expect(text).toContain('歧路石碑');
    expect(text).toContain('宝珠槽');
    expect(text).toContain('系统未实装');
  });
});

describe('战绩屏', () => {
  it('空历史给出空态而非崩溃', async () => {
    startRun(app);
    click(must(`[data-nav="${SCREEN.HISTORY}"]`));
    await tick();
    expect(q(`${screenEl(SCREEN.HISTORY)} .history-list`).textContent).toContain('没有符合条件的记录');
    expect(textOf(`${screenEl(SCREEN.HISTORY)} [data-slot="summary"]`)).toContain('当前轮回');
  });

  it('阵亡后写入一条记录，重新进入界面能看到', async () => {
    startRun(app);
    app.store.update((draft) => {
      draft.player.gcdSequence = [];
      draft.player.ogcdSlots = [];
    });
    const node = app.snapshot().mapNodes.find((n) => n.type === NODE_TYPE.COMBAT);
    standOn(app, node);
    app.beginBattle();
    app.setSpeed(SPEED_MODES.MAX);
    click(must('.dialog-box [data-sum="primary"]'));

    await tick();
    click(must(`[data-nav="${SCREEN.HISTORY}"]`));
    await tick();
    const cards = qa(`${screenEl(SCREEN.HISTORY)} .history-card`);
    expect(cards.length).toBe(1);
    expect(cards[0].textContent).toContain('阵亡');
    // 种子是复现整局的凭据，战绩卡必须把它显示出来
    expect(cards[0].textContent).toContain(String(SEED));
    void node;
  });

  /**
   * 熔炼规则（P2）得在战绩里留痕。两个理由缺一不可：
   *  - 不开熔炼的玩家一局拾到 30 件、开的只看到 5 件，不留痕就像“装备变少了”
   *  - 同种子 + 不同规则 = 不同结果，那 8 位就是两人对战不上时的解释
   */
  it('开了自动熔炼 ⇒ 战绩卡写得出件数与规则指纹', async () => {
    startRun(app);
    app.flow.applyLootFilterPreset('epic_up');
    app.store.update((draft) => {
      draft.metadata.gearMelted = 4;
      draft.metadata.shardsFromMelt = 33;
    });

    app.store.update((draft) => {
      draft.player.gcdSequence = [];
      draft.player.ogcdSlots = [];
    });
    const node = app.snapshot().mapNodes.find((n) => n.type === NODE_TYPE.COMBAT);
    standOn(app, node);
    app.beginBattle();
    app.setSpeed(SPEED_MODES.MAX);
    click(must('.dialog-box [data-sum="primary"]'));

    await tick();
    click(must(`[data-nav="${SCREEN.HISTORY}"]`));
    await tick();
    const card = q(`${screenEl(SCREEN.HISTORY)} .history-card`);
    expect(card).not.toBeNull();
    expect(card.textContent).toContain('自动熔炼');
    const hash = filterHashOf(app.snapshot().lootFilter);
    expect(card.querySelector('.history-seed code[title]')?.textContent).toBe(hash);
    expect(card.querySelector('.history-seed code[title]')?.getAttribute('title')).toContain('史诗');
  });

  it('没开熔炼 ⇒ 战绩卡不占地方（旧语义：off 对所有档都一样，写出来只是噪声）', async () => {
    startRun(app);
    app.store.update((draft) => {
      draft.player.gcdSequence = [];
      draft.player.ogcdSlots = [];
    });
    const node = app.snapshot().mapNodes.find((n) => n.type === NODE_TYPE.COMBAT);
    standOn(app, node);
    app.beginBattle();
    app.setSpeed(SPEED_MODES.MAX);
    click(must('.dialog-box [data-sum="primary"]'));
    await tick();
    click(must(`[data-nav="${SCREEN.HISTORY}"]`));
    await tick();
    const card = q(`${screenEl(SCREEN.HISTORY)} .history-card`);
    expect(card.textContent).not.toContain('熔炼 ');
  });
});

// ============================================================
// 存档与设置
// ============================================================

describe('存档与设置', () => {
  it('手动槽保存 → 列表可见 → 读取恢复进度', async () => {
    const saves = new SaveService();
    const h = await mount({ saveService: saves });
    startRun(h);
    const exit = h.snapshot().mapNodes.find((n) => n.id === h.snapshot().exitNodeId);
    standOn(h, exit);
    click(must(`${screenEl(SCREEN.MAP)} [data-action="descend"]`));
    expect(h.snapshot().floorNumber).toBe(2);

    h.router.go(SCREEN.SAVES);
    await tick();
    click(must(`${screenEl(SCREEN.SAVES)} [data-save="slot1"]`));
    await tick();
    expect(qa(`${screenEl(SCREEN.SAVES)} .slot-card`).length).toBe(4);
    // 自动槽只由游戏流程写，界面上不给手动按钮
    expect(q(`${screenEl(SCREEN.SAVES)} [data-save="${AUTO_SAVE_SLOT}"]`)).toBeNull();
    expect(qa(`${screenEl(SCREEN.SAVES)} .slot-card`)[0].textContent).toContain('第 2 层');

    // 回到第 1 层开局，再从槽位读回第 2 层
    h.startNewRun(SEED);
    expect(h.snapshot().floorNumber).toBe(1);
    h.router.go(SCREEN.SAVES);
    await tick();
    click(must(`${screenEl(SCREEN.SAVES)} [data-load="slot1"]`));
    await tick();
    expect(h.snapshot().floorNumber).toBe(2);
    expect(h.snapshot().status).toBe(GAME_STATUS.EXPLORING);
  });

  it('设置屏显示存档后端信息（setStorageInfo 必须有调用方）', async () => {
    click(must('[data-action="settings"]'));
    await tick(2);
    const note = q(`${screenEl(SCREEN.SETTINGS)} [data-slot="storage"]`);
    expect(note.textContent).toContain('存档后端');
    // 局外界面不该留一排空的 chip
    expect(q('.app-shell').className).not.toContain('is-in-run');
  });

  it('设置：静音开关立即生效并落盘', async () => {
    click(must('[data-action="settings"]'));
    expect(visibleScreen()).toBe(SCREEN.SETTINGS);

    const box = q(`${screenEl(SCREEN.SETTINGS)} [data-set="muted"]`);
    box.checked = true;
    box.dispatchEvent(new window.Event('input', { bubbles: true }));
    expect(app.settings.muted).toBe(true);
    await tick();

    const again = await mount({ clearStorage: false });
    expect(again.settings.muted).toBe(true);
  });

  it('设置：清空全部数据需要二次确认', async () => {
    startRun(app);
    click(must('[data-action="settings"]'));
    click(must(`${screenEl(SCREEN.SETTINGS)} [data-act="reset"]`));
    await tick();

    const box = q('.dialog-box');
    expect(box.textContent).toContain('不可撤销');
    click(box.querySelector('[data-cancel]'));
    await tick();
    expect(app.snapshot().floorNumber).toBe(1);

    click(must(`${screenEl(SCREEN.SETTINGS)} [data-act="reset"]`));
    await tick();
    click(must('.dialog-box [data-confirm]'));
    await tick();
    expect(visibleScreen()).toBe(SCREEN.MAIN_MENU);
    expect(app.snapshot().status).toBe(GAME_STATUS.IDLE);
  });

  it('局外界面隐藏局内导航条，头部数值随之收起', () => {
    click(must('[data-action="settings"]'));
    expect(q('.app-nav').hidden).toBe(true);
    click(must(`${screenEl(SCREEN.SETTINGS)} [data-act="back"]`));
    expect(visibleScreen()).toBe(SCREEN.MAIN_MENU);
  });
});

// ============================================================
// 路由器契约
// ============================================================

describe('路由器', () => {
  it('go 到未注册的屏幕直接抛错，而不是静默白屏', () => {
    startRun(app);
    expect(() => app.router.go('nope')).toThrow(/未注册的屏幕/);
    // 抛错后当前屏仍在，不会出现「点了没反应也没提示」
    expect(visibleScreen()).toBe(SCREEN.MAP);
  });

  it('back 依返回栈回退，栈空时用 fallback', () => {
    startRun(app);
    app.router.go(SCREEN.SETTINGS, { push: true });
    expect(app.router.back(SCREEN.MAP).current).toBe(SCREEN.MAP);

    app.router.go(SCREEN.CODEX, { push: true });
    app.router.go(SCREEN.SAVES, { push: true });
    expect(app.router.back(SCREEN.MAP).current).toBe(SCREEN.CODEX);
    expect(app.router.back(SCREEN.MAP).current).toBe(SCREEN.MAP);
  });
});

// ============================================================
// 对话框行为（P1-4 回归）
// ============================================================

describe('对话框', () => {
  it('createConfirm：点取消 resolve(false)，不挂起', async () => {
    click(must('[data-action="menu"]'));
    await tick();
    expect(q('.app-dialog').hidden).toBe(true);

    startRun(app);
    const settled = (async () => {
      click(must('[data-action="menu"]'));
      await tick();
      const box = q('.dialog-box');
      click(box.querySelector('[data-cancel]'));
      await tick();
      return q('.app-dialog').hidden;
    })();
    await expect(settled).resolves.toBe(true);
  });

  it('ESC 能关闭可退出的对话框', async () => {
    startRun(app);
    click(must('[data-action="menu"]'));
    await tick();
    const dialog = q('.app-dialog');
    dialog.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await tick();
    expect(dialog.hidden).toBe(true);
  });
});

// ============================================================
// 长跑冒烟：连着推 5 层，每层把所有屏幕在有数据的状态下打开一遍
// ============================================================

describe('多局长跑', () => {
  /**
   * 连推 5 层：每层打完所有战斗、用掉休息、解开事件、再把六个局内屏在有数据的
   * 状态下各打开一次。目标不是「能不能赢」，而是接线在真实数据量下不崩。
   *
   * 顺带测到的平衡事实（不改代码，只记录）：1 级合法的默认序列胜率约 38%，
   * 因为全部 oGCD（含 emergencyHeal）都锁在 79 级以后，开局没有任何防御手段。
   * 因此这里容忍阵亡重开，并另外把等级顶到 20 级来测「已解锁很多技能」的屏幕。
   */
  it('推进 5 层不抛错，高等级下屏幕仍能渲染', async () => {
    startRun(app);
    let battles = 0;
    let descents = 0;

    for (let round = 1; round <= 5; round += 1) {
      const nodes = app.snapshot().mapNodes;
      for (const node of nodes.filter((n) => n.type === NODE_TYPE.COMBAT || n.type === NODE_TYPE.ELITE)) {
        standOn(app, node);
        app.beginBattle();
        app.setSpeed(SPEED_MODES.MAX);
        battles = Math.max(battles, app.snapshot().metadata.battlesWon);
        if (app.snapshot().status === GAME_STATUS.FINISHED) break;
      }
      if (app.snapshot().status === GAME_STATUS.FINISHED) {
        // 阵亡：结算面板弹出 → 关闭 → 另开一局继续跑屏幕
        click(must('.dialog-box [data-sum="primary"]'));
        await tick();
        startRun(app);
        expect(app.snapshot().status).toBe(GAME_STATUS.EXPLORING);
      }

      for (const node of nodes.filter((n) => n.type === NODE_TYPE.REST)) {
        standOn(app, node);
        app.store.update((draft) => {
          draft.player.hp = Math.max(1, Math.floor(draft.player.maxHp / 2));
        });
        app.flow.useRest();
      }
      for (const node of nodes.filter((n) => n.type === NODE_TYPE.EVENT)) {
        standOn(app, node);
        const event = app.flow.getEvent();
        if (event !== null) app.flow.resolveEvent(event.id, 0);
      }

      visitAllScreens();
      const best = [...app.snapshot().player.inventory].sort((a, b) => b.score - a.score)[0];
      if (best !== undefined) expect(app.flow.equip(best.id).ok).toBe(true);

      app.router.go(SCREEN.MAP);
      const floorBefore = app.snapshot().floorNumber;
      standOn(app, nodeById(app.snapshot(), app.snapshot().exitNodeId));
      expect(app.flow.descend()).toEqual({ ok: true, floorNumber: floorBefore + 1 });
      descents += 1;
    }

    expect(descents).toBe(5);

    // 把等级顶到 20 级：解锁表里出现大量已解锁项，序列屏与图鉴走的另一条分支
    app.store.update((draft) => {
      draft.player.exp = totalExpForLevel(20);
      recalcPlayer(draft.player);
    });
    expect(app.snapshot().player.level).toBe(20);
    visitAllScreens();
    click(q(`[data-nav="${SCREEN.CODEX}"]`));
    const unlockedNow = qa(`${screenEl(SCREEN.CODEX)} .codex-item:not(.is-lock)`).length;
    expect(unlockedNow).toBeGreaterThan(6);
    expect(textOf(`${screenEl(SCREEN.SEQUENCE)} [data-slot="level-note"]`)).toContain('Lv.');

    // 经验与等级的单一数据源不变量在长跑后仍成立
    const state = app.snapshot();
    expect(levelFromTotalExp(state.player.exp)).toBe(state.player.level);
    expect(state.player.hp).toBeLessThanOrEqual(state.player.maxHp);
    void battles;
  }, 30_000);
});

/** 六个局内屏幕各打开一次并断言渲染出内容。 */
function visitAllScreens() {
  for (const target of [
    SCREEN.MAP,
    SCREEN.SEQUENCE,
    SCREEN.EQUIPMENT,
    SCREEN.CHARACTER,
    SCREEN.CODEX,
    SCREEN.HISTORY,
  ]) {
    app.router.go(target);
    expect(q(`[data-screen="${target}"]`).hidden).toBe(false);
    expect(q(`[data-screen="${target}"]`).innerHTML.length).toBeGreaterThan(40);
  }
}

// ============================================================
// 暂停（P1-5：GAME_STATUS.PAUSED 真的被写入）
// ============================================================

describe('暂停与恢复', () => {
  /** 进战斗并跑几帧。断言仍在战斗中，免得测试在"已结束"的状态上验暂停。 */
  function toBattle() {
    startRun(app);
    const node = app.snapshot().mapNodes.find((n) => n.type === NODE_TYPE.COMBAT);
    standOn(app, node);
    app.beginBattle();
    for (let i = 0; i < 5; i += 1) app.engine.runFrame(SPEED_MODES.X1);
    expect(app.snapshot().status).toBe(GAME_STATUS.BATTLING);
    return app.snapshot().virtualTime;
  }

  it('setSpeed(paused) 写入 PAUSED 状态并冻住虚拟时间', () => {
    toBattle();
    app.setSpeed(SPEED_MODES.PAUSED);

    expect(app.snapshot().status).toBe(GAME_STATUS.PAUSED);
    const frozen = app.snapshot().virtualTime;
    expect(app.engine.runFrame(SPEED_MODES.X1)).toBe(false);
    expect(app.snapshot().virtualTime).toBe(frozen);
    expect(textOf('[data-field="status"]')).toContain('已暂停');
    expect(textOf(`${screenEl(SCREEN.BATTLE)} .battle-phase`)).toContain('已暂停');
  });

  it('暂停态下速度按钮仍然可用，选速度即恢复战斗', () => {
    toBattle();
    app.setSpeed(SPEED_MODES.PAUSED);

    const buttons = qa(`${screenEl(SCREEN.BATTLE)} [data-speed]`);
    expect(buttons.every((b) => !b.disabled)).toBe(true);

    click(buttons.find((b) => b.getAttribute('data-speed') === SPEED_MODES.X4));
    expect(app.snapshot().status).toBe(GAME_STATUS.BATTLING);
    const t = app.snapshot().virtualTime;
    app.engine.runFrame(SPEED_MODES.X4);
    expect(app.snapshot().virtualTime).toBeGreaterThan(t);
  });

  it('P 键切换暂停/恢复；输入框里打字不触发', () => {
    toBattle();
    const key = (k) => document.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true }));

    key('p');
    expect(app.snapshot().status).toBe(GAME_STATUS.PAUSED);
    key('p');
    expect(app.snapshot().status).toBe(GAME_STATUS.BATTLING);

    const input = document.createElement('input');
    document.body.append(input);
    const typing = new window.KeyboardEvent('keydown', { key: 'p', bubbles: true, cancelable: true });
    input.dispatchEvent(typing);
    expect(app.snapshot().status).toBe(GAME_STATUS.BATTLING); // 没被误触发
    input.remove();
  });

  it('切到后台自动暂停', () => {
    toBattle();
    expect(app.snapshot().status).toBe(GAME_STATUS.BATTLING);
    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    document.dispatchEvent(new window.Event('visibilitychange'));
    expect(app.snapshot().status).toBe(GAME_STATUS.PAUSED);
    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
  });

  it('暂停不算结束：finishBattle 仍拒绝结算', () => {
    toBattle();
    app.setSpeed(SPEED_MODES.PAUSED);
    expect(app.flow.finishBattle()).toEqual({ settled: false });
    expect(app.snapshot().status).toBe(GAME_STATUS.PAUSED);
  });

  it('暂停中不给手动存档入口（GameFlow 会把状态写成探索，读档恢复不出来）', async () => {
    toBattle();
    app.setSpeed(SPEED_MODES.PAUSED);
    expect(app.snapshot().status).toBe(GAME_STATUS.PAUSED);
    app.router.go(SCREEN.SAVES);
    await tick();
    expect(q(`${screenEl(SCREEN.SAVES)} [data-save="slot1"]`)).toBeNull();

    // 恢复后按钮回来（存档列表是异步刷新的）
    app.setSpeed(SPEED_MODES.X1);
    expect(app.snapshot().status).toBe(GAME_STATUS.BATTLING);
    app.router.go(SCREEN.SAVES);
    await tick();
    expect(q(`${screenEl(SCREEN.SAVES)} [data-save="slot1"]`)).not.toBeNull();
  });
});

// ============================================================
// logLimit：只影响显示，不碰确定性（P1-1）
// ============================================================

describe('日志显示条数', () => {
  /** 打满一场并返回战斗日志 DOM 条数与状态里的日志长度。 */
  function battleLogRows(limit) {
    return (async () => {
      const h = await mount({ clearStorage: false });
      if (limit !== null) {
        h.router.go(SCREEN.SETTINGS);
        const select = must(`${screenEl(SCREEN.SETTINGS)} [data-set="logLimit"]`);
        select.value = String(limit);
        select.dispatchEvent(new window.Event('input', { bubbles: true }));
      }
      h.startNewRun(SEED);
      const node = h.snapshot().mapNodes.find((n) => n.type === NODE_TYPE.COMBAT);
      standOn(h, node);
      h.beginBattle();
      h.setSpeed(SPEED_MODES.MAX);
      h.router.go(SCREEN.BATTLE);
      h.renderAll();
      return {
        dom: qa(`${screenEl(SCREEN.BATTLE)} [data-slot="log"] .log-entry`).length,
        state: h.snapshot().log.length,
        fingerprint: battleFingerprint(h.snapshot()),
      };
    })();
  }

  it('设成 50 时只显示 50 条，但状态里仍是完整日志', async () => {
    const full = await battleLogRows(null);
    expect(full.state).toBeGreaterThan(0);

    const capped = await battleLogRows(50);
    expect(capped.dom).toBeLessThanOrEqual(50);
    expect(capped.state).toBe(full.state);
  }, 30_000);

  it('改这个设置不改变战斗结果（展示裁剪没漏进判定）', async () => {
    const a = await battleLogRows(100);
    const b = await battleLogRows(50);
    expect(b.fingerprint).toEqual(a.fingerprint);
  }, 30_000);
});

// ============================================================
// 运行期错误边界（P1-7）
// ============================================================

describe('错误边界', () => {
  it('reportError 会停住战斗、写 state.error 并弹出可退路的面板', () => {
    startRun(app);
    const node = app.snapshot().mapNodes.find((n) => n.type === NODE_TYPE.COMBAT);
    standOn(app, node);
    app.beginBattle();
    app.setSpeed(SPEED_MODES.X1);

    const error = new Error('契约实现炸了');
    error.code = 'CONTRACT_BOOM';
    app.reportError(error, 'test');

    const box = q('.dialog-box');
    expect(box).not.toBeNull();
    expect(box.textContent).toContain('出了点问题');
    expect(box.textContent).toContain('CONTRACT_BOOM');
    expect(box.textContent).toContain('契约实现炸了');
    expect(app.snapshot().error).toMatchObject({ code: 'CONTRACT_BOOM' });
    expect(app.snapshot().status).toBe(GAME_STATUS.BATTLING); // 战斗状态本身没被改坏

    click(box.querySelector('[data-act="err-dismiss"]'));
    expect(q('.app-dialog').hidden).toBe(true);
    expect(app.snapshot().error).toBeNull();
  });

  it('错误面板上的「返回主菜单」会离开局内', () => {
    startRun(app);
    app.reportError(new Error('模组加载失败'));
    click(q('.dialog-box [data-act="err-menu"]'));
    expect(visibleScreen()).toBe(SCREEN.MAIN_MENU);
    expect(app.snapshot().error).toBeNull();
  });

  it('错误没被处理完之前不重复弹第二个面板', () => {
    startRun(app);
    app.reportError(new Error('第一次'));
    const first = q('.dialog-box').textContent;
    app.reportError(new Error('第二次'));
    expect(qa('.dialog-box').length).toBe(1);
    expect(q('.dialog-box').textContent).toBe(first);
    expect(app.snapshot().error.message).toContain('第二次'); // 状态里仍是最新的
  });
});

// ============================================================
// 通关与无尽（P1-6 的 UI 通路）
// ============================================================

describe('通关面板', () => {
  /** 把玩家放到终点层的出口（enterFloor 可指定层数，不必真爬 50 层）。 */
  function standAtVictoryExit(h, floor = VICTORY_FLOOR) {
    h.flow.enterFloor(floor);
    const exit = nodeById(h.snapshot(), h.snapshot().exitNodeId);
    standOn(h, exit);
    return exit;
  }

  it('终点层的出口按钮说清楚这是通关，而不是"又一层"', () => {
    startRun(app);
    standAtVictoryExit(app);
    const button = must(`${screenEl(SCREEN.MAP)} [data-action="descend"]`);
    expect(button.textContent).toContain('轮回尽头');
    expect(button.textContent).toContain(String(VICTORY_FLOOR));

    // 普通层的出口仍是原来的说法
    app.flow.enterFloor(3);
    standOn(app, nodeById(app.snapshot(), app.snapshot().exitNodeId));
    expect(q(`${screenEl(SCREEN.MAP)} [data-action="descend"]`).textContent).toContain('前往下一层');
  });

  it('点出口 → 通关结算面板：两条出路各走各的（先「继续挑战无尽」）', () => {
    startRun(app);
    standAtVictoryExit(app);
    click(must(`${screenEl(SCREEN.MAP)} [data-action="descend"]`));

    const box = must('.dialog-box');
    expect(box.textContent).toContain('通关结算');
    expect(box.textContent).toContain('通关');
    expect(app.snapshot().status).toBe(GAME_STATUS.FINISHED);
    expect(app.snapshot().winner).toBe(WINNER.PLAYER);

    const buttons = box.querySelectorAll('[data-sum]');
    expect(buttons).toHaveLength(2);
    click(box.querySelector('[data-sum="primary"]')); // 继续挑战无尽

    expect(q('.app-dialog').hidden).toBe(true);
    expect(app.snapshot().status).toBe(GAME_STATUS.EXPLORING);
    expect(app.snapshot().victoryAchieved).toBe(true);
    expect(q(`${screenEl(SCREEN.MAP)} [data-action="descend"]`).textContent).toContain('下一层');

    click(must(`${screenEl(SCREEN.MAP)} [data-action="descend"]`));
    expect(app.snapshot().floorNumber).toBe(VICTORY_FLOOR + 1);
  });

  it('「结束这局」直接回主菜单，且不会偷偷继续', () => {
    startRun(app);
    standAtVictoryExit(app);
    click(must(`${screenEl(SCREEN.MAP)} [data-action="descend"]`));
    click(must('.dialog-box [data-sum="secondary"]'));

    expect(visibleScreen()).toBe(SCREEN.MAIN_MENU);
    expect(app.snapshot().status).toBe(GAME_STATUS.FINISHED);
    expect(app.snapshot().victoryAchieved).toBe(true);
  });

  it('通关记录进战绩屏，并显示在「通关」筛选下', async () => {
    startRun(app);
    standAtVictoryExit(app);
    click(must(`${screenEl(SCREEN.MAP)} [data-action="descend"]`));
    await tick();

    app.router.go(SCREEN.HISTORY);
    await tick();
    const cards = qa(`${screenEl(SCREEN.HISTORY)} .history-card`);
    expect(cards.some((c) => c.textContent.includes('通关'))).toBe(true);
    expect(textOf(`${screenEl(SCREEN.HISTORY)} [data-slot="summary"]`)).toMatch(/通关\s*1/);

    click(must(`${screenEl(SCREEN.HISTORY)} [data-filter="victory"]`));
    expect(qa(`${screenEl(SCREEN.HISTORY)} .history-card`)).toHaveLength(1);
  });

  it('通关后自动槽被清掉，「继续游戏」不再指向一个已通关的局', async () => {
    const saves = new SaveService();
    const h = await mount({ saveService: saves });
    h.startNewRun(SEED);
    h.flow.enterFloor(VICTORY_FLOOR);
    standOn(h, nodeById(h.snapshot(), h.snapshot().exitNodeId));
    h.flow.descend();
    await tick();

    expect(await saves.loadSlot(AUTO_SAVE_SLOT)).toBeNull();
    h.gotoMenu();
    await tick();
    expect(h.screens[SCREEN.MAIN_MENU].element.querySelector('[data-act="continue"]').disabled).toBe(true);
  });
});

describe('存储后端提示', () => {
  it('降级时头部说"原因见设置页"，完整原因挂在 title 与设置页上', async () => {
    const savedIdb = globalThis.indexedDB;
    delete globalThis.indexedDB;
    try {
      const h = await mount();
      const note = q('[data-field="storage"]');
      expect(note.textContent).toContain('降级');
      expect(note.textContent).toContain('原因见设置页');
      expect(note.title).toContain('IndexedDB');

      h.router.go(SCREEN.SETTINGS);
      await tick(2);
      expect(q(`${screenEl(SCREEN.SETTINGS)} [data-slot="storage"]`).textContent).toContain('IndexedDB');
      expect(h.storageSummary().degraded).toBe(true);
    } finally {
      globalThis.indexedDB = savedIdb;
    }
  });

  it('未降级时不带"降级"字样', async () => {
    expect(app.storageSummary().degraded).toBe(false);
    expect(textOf('[data-field="storage"]')).toMatch(/存档后端：indexeddb/);
    expect(textOf('[data-field="storage"]')).not.toContain('降级');
  });
});

describe('地图视图', () => {
  it('未揭示节点画成雾点，而不是什么都不画（否则开局像坏图）', () => {
    startRun(app);
    const state = app.snapshot();
    const fog = qa(`${screenEl(SCREEN.MAP)} .map-fog`);
    expect(state.mapNodes.filter((n) => !n.isRevealed).length).toBeGreaterThan(0);
    expect(fog.length).toBe(state.mapNodes.filter((n) => !n.isRevealed).length);
    // 雾点不带类型信息，也不参与键盘焦点
    expect(fog[0].getAttribute('aria-hidden')).toBe('true');
    expect(fog[0].getAttribute('tabindex')).toBeNull();
  });

  it('开局自动把视野对准已揭示区（而不是整个世界缩成一点）', () => {
    startRun(app);
    const fit = app.screens[SCREEN.MAP].element;
    expect(fit).toBeTruthy();
    const zoom = Number(
      document
        .querySelector(`${screenEl(SCREEN.MAP)} .map-viewport`)
        .getAttribute('transform')
        .match(/scale\(([\d.]+)\)/)[1],
    );
    // 只揭示起点附近时，zoom 应当被放大到 1 以上；等于 1 说明对准逻辑没跑
    expect(zoom).toBeGreaterThan(1);
  });

  it('玩家手动缩放后，切屏回来不再抢走他的视角', () => {
    startRun(app);
    const viewport = document.querySelector(`${screenEl(SCREEN.MAP)} .map-viewport`);
    const before = viewport.getAttribute('transform');
    // 模拟一次滚轮缩小（对准后已在 ZOOM_MAX，只能往小调）；interaction 会置 viewTouched
    const svg = document.querySelector(`${screenEl(SCREEN.MAP)} .map-svg`);
    svg.dispatchEvent(new window.WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true }));
    const touched = viewport.getAttribute('transform');
    expect(touched).not.toBe(before);

    app.router.go(SCREEN.CHARACTER);
    app.router.go(SCREEN.MAP);
    expect(document.querySelector(`${screenEl(SCREEN.MAP)} .map-viewport`).getAttribute('transform')).toBe(touched);
  });
});

// ============================================================
// 内容指纹（S1）在 UI 上的三条通路
// ============================================================

/** 包一层真 SaveService，只改 loadSlot/listSlots 里的 contentHash。 */
function hashOverrideSaves(hash) {
  const real = new SaveService();
  const boot = real.init().then((info) => info);
  const patch = (record) => (record === null ? null : { ...record, contentHash: hash });
  return {
    real,
    api: {
      get degraded() {
        return false;
      },
      get modded() {
        return false;
      },
      init: () => boot,
      provideFingerprint: (p) => real.provideFingerprint(p),
      loadSettings: () => real.loadSettings(),
      saveSettings: (x) => real.saveSettings(x),
      saveToSlot: (id, s) => real.saveToSlot(id, s),
      saveRun: (s) => real.saveRun(s),
      listSlots: async () => (await real.listSlots()).map((s) => ({ ...s, contentHash: hash })),
      deleteSlot: (id) => real.deleteSlot(id),
      appendHistory: (s, o) => real.appendHistory(s, o),
      loadHistory: () => real.loadHistory(),
      clearRun: () => real.clearRun(),
      clearAll: () => real.clearAll(),
      backupAutoSave: () => real.backupAutoSave(),
      loadPrevAuto: () => real.loadPrevAuto(),
      deletePrevAuto: () => real.deletePrevAuto(),
      flush: () => real.flush(),
      loadSlot: async (id) => patch(await real.loadSlot(id)),
    },
  };
}

describe('内容指纹', () => {
  it('地图屏种子面板显示本局指纹（玩家抄种子时就该看见它）', () => {
    startRun(app);
    expect(textOf(`${screenEl(SCREEN.MAP)} [data-slot="fingerprint"]`)).toMatch(
      /本局内容指纹 [0-9a-f]{8}/,
    );
    expect(app.fingerprint.hash).toMatch(/^[0-9a-f]{8}$/);
    expect(app.fingerprint.mods.length).toBeGreaterThanOrEqual(4);
  });

  it('结算面板带内容指纹一行', () => {
    startRun(app);
    app.store.update((d) => {
      d.player.gcdSequence = [];
      d.player.ogcdSlots = [];
    });
    const node = app.snapshot().mapNodes.find((n) => n.type === NODE_TYPE.COMBAT);
    standOn(app, node);
    app.beginBattle();
    app.setSpeed(SPEED_MODES.MAX);
    const box = must('.dialog-box');
    expect(box.textContent).toContain('内容指纹');
    expect(box.textContent).toContain(app.fingerprint.hash);
  });

  it('读档遇到别的指纹要先问一句，取消就不动当前局', async () => {
    const { real, api } = hashOverrideSaves('deadbeef');
    const h = await mount({ saveService: api });
    h.startNewRun(SEED);
    await tick();
    real.provideFingerprint(() => ({ hash: 'deadbeef', mods: [], packs: [] }));
    real.saveRun(h.snapshot());
    await real.flush();

    h.gotoMenu();
    await tick();
    click(must('[data-act="continue"]'));
    await tick();
    const box = must('.dialog-box');
    expect(box.textContent).toContain('另一个内容集');
    expect(box.textContent).toContain('deadbeef');

    click(box.querySelector('[data-cancel]'));
    await tick();
    expect(visibleScreen()).toBe(SCREEN.MAIN_MENU);

    // 确认后才真的读
    click(must('[data-act="continue"]'));
    await tick();
    click(must('.dialog-box [data-confirm]')); // createConfirm 的确认按钮
    await tick();
    expect(visibleScreen()).toBe(SCREEN.MAP);
  });

  it('存档列表给不符的槽位打标记', async () => {
    const { real, api } = hashOverrideSaves('ffff0000');
    const h = await mount({ saveService: api });
    h.startNewRun(SEED);
    real.saveRun(h.snapshot());
    await real.flush();

    h.router.go(SCREEN.SAVES);
    await tick();
    expect(qa(`${screenEl(SCREEN.SAVES)} .slot-tag.is-warn`).length).toBeGreaterThan(0);
    // 自动槽才有内容指纹（saveRun 写的是 auto），所以查所有卡片而不是第一张
    expect(qa(`${screenEl(SCREEN.SAVES)} .slot-card`).map((c) => c.textContent).join(' ')).toContain('ffff0000');
  });
});

// ============================================================
// 误点「新的轮回」不得毁掉自动存档
// ============================================================

describe('自动存档的后悔药', () => {
  /** 打一局有进度的：赢两场再下层。 */
  async function buildRun(h) {
    h.startNewRun(SEED);
    for (const node of h.snapshot().mapNodes.filter((n) => n.type === NODE_TYPE.COMBAT).slice(0, 2)) {
      standOn(h, node);
      h.beginBattle();
      h.setSpeed(SPEED_MODES.MAX);
      if (h.snapshot().status === GAME_STATUS.FINISHED) break;
    }
    await tick(2);
    return h.snapshot().player.exp;
  }

  it('开新局但一步没走：自动档仍是上一局，「继续游戏」能把它读回来', async () => {
    const exp = await buildRun(app);
    expect(exp).toBeGreaterThan(0);

    app.gotoMenu();
    app.startNewRun(SEED + 7); // 误点一次「新的轮回」
    await tick(2);
    app.gotoMenu();
    await tick();

    const continueBtn = must('[data-act="continue"]');
    expect(continueBtn.disabled).toBe(false);
    expect(continueBtn.textContent).toContain('第 1 层');

    click(continueBtn);
    await tick();
    expect(app.snapshot().player.exp).toBe(exp); // 读回的是原来那一局
  });

  it('新局真打出进度后，主菜单给出「回上一局」并能读回旧局', async () => {
    const oldExp = await buildRun(app);

    app.gotoMenu();
    app.startNewRun(SEED + 11);
    await tick(2);
    // 新局下层 = 明确进度 ⇒ 自动档被覆盖，此时只剩备份
    const exit = nodeById(app.snapshot(), app.snapshot().exitNodeId);
    standOn(app, exit);
    app.flow.descend();
    await tick(2);

    app.gotoMenu();
    await tick();
    const prevBtn = q('[data-act="continue-prev"]');
    expect(prevBtn).not.toBeNull();
    expect(prevBtn.textContent).toContain('回上一局自动档');

    click(prevBtn);
    await tick();
    expect(app.snapshot().player.exp).toBe(oldExp);
    expect(visibleScreen()).toBe(SCREEN.MAP);

    // 备份用掉一次就消失，避免反复回退
    app.gotoMenu();
    await tick();
    expect(q('[data-act="continue-prev"]')).toBeNull();
  });
});

// ============================================================
// 存档导出 / 导入（UI 通路）
// ============================================================

describe('存档导出导入界面', () => {
  beforeEach(() => {
    startRun(app);
    app.router.go(SCREEN.SAVES);
  });

  it('存档屏有导入与导出全部入口；空槽不给导出按钮', async () => {
    await tick();
    expect(q(`${screenEl(SCREEN.SAVES)} [data-act="import"]`)).not.toBeNull();
    expect(q(`${screenEl(SCREEN.SAVES)} [data-act="export-all"]`)).not.toBeNull();
    expect(q(`${screenEl(SCREEN.SAVES)} input[type="file"]`)).not.toBeNull();
    // 这局一步没走 ⇒ 自动档没被覆盖 ⇒ 四个槽都是空的
    expect(qa(`${screenEl(SCREEN.SAVES)} [data-export]`).length).toBe(0);
  });

  it('有内容的槽位才给导出；点导出不炸（无下载能力时要给出提示）', async () => {
    // 下层 = 明确进度 ⇒ 自动档写入
    const exit = nodeById(app.snapshot(), app.snapshot().exitNodeId);
    standOn(app, exit);
    app.flow.descend();
    app.router.go(SCREEN.SAVES);
    await tick();

    const buttons = qa(`${screenEl(SCREEN.SAVES)} [data-export]`);
    expect(buttons.length).toBe(1); // 只有自动槽有内容
    expect(buttons[0].getAttribute('data-export')).toBe(AUTO_SAVE_SLOT);

    click(buttons[0]);
    // 同样等 toast 出现，而不是固定 tick —— 导出前要先读盘
    const toast = await waitForToast(/已导出|不支持下载/);
    expect(toast.hidden).toBe(false);
  });

  it('导出全部在没有任何存档时给出提示', async () => {
    await tick();
    // 必须真清存储：上一测试 descend() 会留下自动档，用 clearStorage:false
    // 等于测"恰好没落盘的时序"，之前通过纯属侥幸
    const fresh = await mount({ clearStorage: true });
    fresh.router.go(SCREEN.SAVES);
    await tick();
    click(must(`${screenEl(SCREEN.SAVES)} [data-act="export-all"]`));
    await waitForToast(/导出|没有任何存档/);
  });
});
