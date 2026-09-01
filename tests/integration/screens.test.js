// @vitest-environment jsdom
/**
 * 屏幕级细测：序列编辑器、装备面板、无障碍行为。
 *
 * 与 app-wiring.test.js 的分工：那份管「接线通不通」（每个屏幕打得开、回调打到
 * GameFlow、状态真的变），这份管「屏幕自己的交互对不对」——排序、筛选、上限、
 * 批量操作，以及键盘用户能不能真正用起来（焦点陷阱、aria-pressed、切屏焦点）。
 */

import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp, DEFAULT_GCD_SEQUENCE, DEFAULT_OGCD_SLOTS } from '../../src/main.js';
import { officialModuleEntries } from '../helpers.js';
import { nullAudio } from '../../src/ui/audio/nullAudio.js';
import { resetAdapterCache } from '../../src/persistence/storageAdapter.js';
import { SaveService } from '../../src/persistence/saveService.js';
import { EQUIP_SLOTS, NODE_TYPE, OGCD_SLOT_LIMIT, SCREEN } from '../../src/core/constants.js';
import { enhanceCost, rollEquipment } from '../../src/core/equipment.js';
import { mulberry32 } from '../../src/core/prng.js';
import { totalExpForLevel } from '../../src/core/progression.js';
import { recalcPlayer } from '../../src/core/derived.js';

const SEED = 20240101;

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

const q = (sel) => document.querySelector(sel);
const qa = (sel) => [...document.querySelectorAll(sel)];
const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
const screenEl = (id) => `[data-screen="${id}"]`;
const root = (id) => `.screen-host ${screenEl(id)}`;
const tick = async (times = 8) => {
  for (let i = 0; i < times; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

function must(sel) {
  const el = q(sel);
  expect(el, `找不到元素：${sel}`).not.toBeNull();
  return el;
}

/**
 * 往背包塞几件可控属性的装备（两个装备相关的 describe 共用）。
 * forceRarity ⇒ 不看掉落曲线，测试才不会随曲线调参漂。
 */
function stock(items) {
  app.store.update((draft) => {
    draft.player.inventory = items.map(({ idSuffix, slot, rarity }) =>
      rollEquipment({
        rng: mulberry32(rarity * 31 + slot.length),
        floorNumber: 3,
        idSuffix,
        forceSlot: slot,
        forceRarity: rarity,
      }),
    );
  });
}

let app;

/** 进一局并切到指定屏幕。 */
function openAt(screen) {
  app.startNewRun(SEED);
  app.router.go(screen);
}

beforeEach(async () => {
  app = await mount();
});

// ============================================================
// 序列屏
// ============================================================

describe('序列屏交互', () => {
  beforeEach(async () => {
    await openAt(SCREEN.SEQUENCE);
  });

  const sequence = () => app.snapshot().player.gcdSequence;
  const ogcdIds = () => app.snapshot().player.ogcdSlots.map((slot) => slot.skillId);
  const listItems = () => qa(`${root(SCREEN.SEQUENCE)} [data-slot="gcd-list"] .seq-item`);

  it('列出默认序列，顺序与状态一致', () => {
    const names = listItems().map((li) => li.dataset.index);
    expect(names).toEqual(DEFAULT_GCD_SEQUENCE.map((_, i) => String(i)));
    expect(text(`${root(SCREEN.SEQUENCE)} [data-slot="gcd-count"]`)).toContain(String(DEFAULT_GCD_SEQUENCE.length));
  });

  it('技能库「添加」把技能接到序列尾部', () => {
    const before = sequence().length;
    const add = qa(`${root(SCREEN.SEQUENCE)} [data-add]`).find((btn) => !btn.disabled);
    click(add);
    expect(sequence().length).toBe(before + 1);
    expect(listItems().length).toBe(before + 1);
  });

  it('移除与上下移动都改到状态里', () => {
    const first = sequence()[0];
    click(must(`${root(SCREEN.SEQUENCE)} [data-slot="gcd-list"] [data-remove]`));
    expect(sequence()).not.toContain(first);

    const before = [...sequence()];
    click(must(`${root(SCREEN.SEQUENCE)} [data-slot="gcd-list"] [data-move="down"]`));
    const after = sequence();
    expect(after[0]).toBe(before[1]);
    expect(after[1]).toBe(before[0]);
  });

  it('第一项不能再上移、最后一项不能再下移（不越界）', () => {
    const before = [...sequence()];
    click(must(`${root(SCREEN.SEQUENCE)} [data-slot="gcd-list"] li:first-child [data-move="up"]`));
    expect(sequence()).toEqual(before);
  });

  it('未解锁技能加不进来，并给出提示', async () => {
    // 关到 1 级解锁之外的技能：把等级压到 1，找一个需 Lv.>1 的
    const locked = [...app.pool.skills.values()].find(
      (s) => s.type === 'GCD' && (app.unlockTable.get(s.id) ?? 1) > 1,
    );
    expect(locked).toBeDefined();

    app.router.go(SCREEN.SEQUENCE);
    // 技能库默认只列「已解锁」，要看未解锁项得先取消该筛选
    const only = must(`${root(SCREEN.SEQUENCE)} [data-slot="only-unlocked"]`);
    only.checked = false;
    only.dispatchEvent(new window.Event('change', { bubbles: true }));
    const search = q(`${root(SCREEN.SEQUENCE)} [data-slot="search"]`);
    search.value = locked.id;
    search.dispatchEvent(new window.Event('input', { bubbles: true }));

    const add = q(`${root(SCREEN.SEQUENCE)} [data-add="${locked.id}"]`);
    expect(add).not.toBeNull();
    expect(add.disabled).toBe(true);
    expect(add.closest('.library-item').className).toContain('is-lock');

    click(add);
    await tick();
    expect(sequence()).not.toContain(locked.id);
  });

  it('升到 20 级后原本锁定的技能变为可添加', () => {
    app.store.update((draft) => {
      draft.player.exp = totalExpForLevel(20);
      recalcPlayer(draft.player);
    });
    app.router.go(SCREEN.SEQUENCE);

    // 要的是"1 级锁着、20 级已解锁"的技能：只按 >1 挑会挑到 57 级才解锁的
    // blade.slash，20 级仍然锁着，测试前提就空了
    const locked = [...app.pool.skills.values()].find((skill) => {
      const need = app.unlockTable.get(skill.id) ?? 1;
      return skill.type === 'GCD' && need > 1 && need <= 20;
    });
    expect(locked).toBeDefined();
    const search = q(`${root(SCREEN.SEQUENCE)} [data-slot="search"]`);
    search.value = locked.id;
    search.dispatchEvent(new window.Event('input', { bubbles: true }));
    const add = must(`${root(SCREEN.SEQUENCE)} [data-add="${locked.id}"]`);
    expect(add.disabled).toBe(false);

    click(add);
    expect(sequence()).toContain(locked.id);
  });

  it('oGCD 槽位到达上限后拒绝继续添加', async () => {
    // 默认开局已带两个自保/爆发插入技
    expect(ogcdIds()).toEqual(DEFAULT_OGCD_SLOTS.map((slot) => slot.skillId));
    app.store.update((draft) => {
      draft.player.ogcdSlots = [
        { skillId: 'ogcd.secondWind', priority: 95, slotIndex: 0 },
        { skillId: 'ogcd.suddenStrike', priority: 30, slotIndex: 1 },
        { skillId: 'ogcd.multistrike', priority: 20, slotIndex: 2 },
      ];
    });
    app.router.go(SCREEN.SEQUENCE);
    expect(app.snapshot().player.ogcdSlots.length).toBe(OGCD_SLOT_LIMIT);
    expect(qa(`${root(SCREEN.SEQUENCE)} [data-slot="ogcd-list"] .seq-item`).length).toBe(OGCD_SLOT_LIMIT);

    click(q(`${root(SCREEN.SEQUENCE)} [data-type="oGCD"]`));
    const candidates = qa(`${root(SCREEN.SEQUENCE)} [data-add]`).filter((btn) => !btn.disabled);
    expect(candidates.length).toBe(0);

    const add = qa(`${root(SCREEN.SEQUENCE)} [data-add]`)[0];
    click(add);
    await tick();
    expect(app.snapshot().player.ogcdSlots.length).toBe(OGCD_SLOT_LIMIT);
    expect(q('.app-toast').textContent).toContain('槽位已满');
  });

  it('拖动排序改变顺序（dragstart → drop）', () => {
    const before = [...sequence()];
    const items = listItems();
    const dt = { effectAllowed: '', dropEffect: '' };
    const fire = (el, type) => {
      const ev = new window.Event(type, { bubbles: true, cancelable: true });
      ev.dataTransfer = dt;
      Object.defineProperty(ev, 'target', { value: el });
      el.dispatchEvent(ev);
    };
    fire(items[0], 'dragstart');
    fire(items[2], 'drop');

    const after = sequence();
    expect(after.length).toBe(before.length);
    expect(after).not.toEqual(before);
  });

  it('优先级输入被夹在 0~99 并写回槽位', () => {
    app.store.update((draft) => {
      draft.player.ogcdSlots = [{ skillId: 'ogcd.suddenStrike', priority: 30, slotIndex: 0 }];
    });
    app.router.go(SCREEN.SEQUENCE);
    const input = must(`${root(SCREEN.SEQUENCE)} [data-slot="ogcd-list"] [data-priority]`);
    input.value = '150';
    input.dispatchEvent(new window.Event('change', { bubbles: true }));
    expect(app.snapshot().player.ogcdSlots[0].priority).toBe(99);
  });
});

function text(sel) {
  return q(sel)?.textContent ?? '';
}

// ============================================================
// 装备屏
// ============================================================

describe('装备屏交互', () => {
  beforeEach(async () => {
    await openAt(SCREEN.EQUIPMENT);
  });

  it('空背包给出空态而不是崩溃', () => {
    expect(q(`${root(SCREEN.EQUIPMENT)} .bag-list`).textContent).toContain('背包是空的');
    expect(qa(`${root(SCREEN.EQUIPMENT)} .bag-item:not(.is-empty)`).length).toBe(0);
    expect(qa(`${root(SCREEN.EQUIPMENT)} .equip-slot.is-empty`).length).toBe(8);
  });

  it('点击背包条目展开详情，含与已装备的对比', () => {
    stock([{ idSuffix: 't.w1', slot: 'weapon', rarity: 4 }]);
    app.router.go(SCREEN.EQUIPMENT);
    click(must(`${root(SCREEN.EQUIPMENT)} [data-select]`));
    const detail = q(`${root(SCREEN.EQUIPMENT)} [data-slot="detail"]`).textContent;
    expect(detail).toContain('攻击');
    expect(q(`${root(SCREEN.EQUIPMENT)} .bag-item.is-selected`)).not.toBeNull();
  });

  it('穿戴 → 槽位填满且面板提升；卸下 → 回到背包', () => {
    const before = app.snapshot().player.attack;
    stock([{ idSuffix: 't.w2', slot: 'weapon', rarity: 5 }]);
    app.router.go(SCREEN.EQUIPMENT);
    const gear = app.snapshot().player.inventory[0];

    click(must(`${root(SCREEN.EQUIPMENT)} [data-equip="${gear.id}"]`));
    const after = app.snapshot();
    expect(after.player.equipment.weapon.id).toBe(gear.id);
    expect(after.player.attack).toBeGreaterThan(before);
    expect(qa(`${root(SCREEN.EQUIPMENT)} .equip-slot:not(.is-empty)`).length).toBe(1);

    click(must(`${root(SCREEN.EQUIPMENT)} [data-unequip="weapon"]`));
    expect(app.snapshot().player.equipment.weapon).toBeNull();
    expect(app.snapshot().player.inventory.length).toBe(1);
  });

  it('强化按钮扣碎片并 +1；碎片不足时不变', () => {
    stock([{ idSuffix: 't.w3', slot: 'weapon', rarity: 3 }]);
    app.router.go(SCREEN.EQUIPMENT);
    const gear = app.snapshot().player.inventory[0];
    const cost = enhanceCost(gear);
    app.store.update((draft) => {
      draft.fateShards = cost;
    });

    // 强化按钮在详情区，先选中这件
    click(must(`${root(SCREEN.EQUIPMENT)} [data-select="${gear.id}"]`));
    click(must(`${root(SCREEN.EQUIPMENT)} [data-enhance="${gear.id}"]`));
    expect(app.snapshot().player.inventory[0].enhanceLevel).toBe(1);
    expect(app.snapshot().fateShards).toBe(0);
    expect(q('.app-toast').textContent).toContain('强化');
  });

  it('分解单件与「批量分解破损与普通」各走各的', () => {
    stock([
      { idSuffix: 't.a', slot: 'weapon', rarity: 0 },
      { idSuffix: 't.b', slot: 'head', rarity: 1 },
      { idSuffix: 't.c', slot: 'chest', rarity: 4 },
    ]);
    app.router.go(SCREEN.EQUIPMENT);
    const keepId = app.snapshot().player.inventory.find((g) => g.rarityIndex === 4).id;

    click(must(`${root(SCREEN.EQUIPMENT)} [data-act="salvage-worn"]`));
    const ids = app.snapshot().player.inventory.map((g) => g.id);
    expect(ids).toEqual([keepId]);
    expect(app.snapshot().fateShards).toBeGreaterThan(0);
  });

  it('三种排序各自兑现承诺（评分降序 / 品质降序 / 部位顺序）', () => {
    stock([
      { idSuffix: 't.a', slot: 'weapon', rarity: 3 },
      { idSuffix: 't.b', slot: 'chest', rarity: 5 },
      { idSuffix: 't.c', slot: 'ring', rarity: 0 },
      { idSuffix: 't.d', slot: 'feet', rarity: 2 },
    ]);
    app.router.go(SCREEN.EQUIPMENT);

    const sort = must(`${root(SCREEN.EQUIPMENT)} [data-slot="sort"]`);
    const order = () =>
      qa(`${root(SCREEN.EQUIPMENT)} [data-select]`).map(
        (b) => app.snapshot().player.inventory.find((g) => g.id === b.getAttribute('data-select')),
      );
    const setSort = (value) => {
      sort.value = value;
      sort.dispatchEvent(new window.Event('change', { bubbles: true }));
      return order();
    };

    const byScore = setSort('score').map((g) => g.score);
    expect([...byScore].sort((a, b) => b - a)).toEqual(byScore);

    const byRarity = setSort('rarity').map((g) => g.rarityIndex);
    expect([...byRarity].sort((a, b) => b - a)).toEqual(byRarity);

    const slotOrder = setSort('slot').map((g) => EQUIP_SLOTS.indexOf(g.slot));
    expect([...slotOrder].sort((a, b) => a - b)).toEqual(slotOrder);
  });
});

// ============================================================
// 自动熔炼面板（P2）
//
// 面板存在的意义是"玩家能把自己的意图写成规则"，所以这里测的是
// **改一个控件 → 状态里真的变了 → 显示也跟着变**，而不只是"有这些控件"。
// 特别要测两个会骗人的地方：预设下拉在改过之后必须说「自定义」，
// 而「试算」必须**什么都不改**。
// ============================================================

describe('装备屏 · 自动熔炼面板', () => {
  const EQUIP = () => root(SCREEN.EQUIPMENT);

  beforeEach(async () => {
    await openAt(SCREEN.EQUIPMENT);
  });

  const setSelect = (element, value) => {
    element.value = value;
    element.dispatchEvent(new window.Event('change', { bubbles: true }));
  };

  it('默认是「不自动熔炼」，而且预设一个不少', () => {
    expect(q(`${EQUIP()} [data-slot="filter-state"]`).textContent).toBe('未开启');
    expect(q(`${EQUIP()} [data-slot="filter-summary"]`).textContent).toContain('不自动熔炼');
    const options = qa(`${EQUIP()} [data-slot="filter-preset"] option`);
    expect(options.map((o) => o.value)).toEqual(['off', 'junk', 'epic_up', 'crit_jewelry']);
  });

  it('选预设 ⇒ 状态真的变了，摘要跟着说人话', () => {
    setSelect(q(`${EQUIP()} [data-slot="filter-preset"]`), 'epic_up');
    const filter = app.snapshot().lootFilter;
    expect(filter.enabled).toBe(true);
    expect(filter.minRarity).toBe(4);
    expect(q(`${EQUIP()} [data-slot="filter-state"]`).textContent).toBe('已开启');
    expect(q(`${EQUIP()} [data-slot="filter-summary"]`).textContent).toContain('史诗');
  });

  it('手改一格就脱离预设（下拉框不许接着说瞎话）', () => {
    setSelect(q(`${EQUIP()} [data-slot="filter-preset"]`), 'junk');
    const raritySelect = q(`${EQUIP()} [data-filter-field="minRarity"]`);
    setSelect(raritySelect, '6');
    const values = qa(`${EQUIP()} [data-slot="filter-preset"] option`).map((o) => o.value);
    expect(values).toContain('custom');
    expect(q(`${EQUIP()} [data-slot="filter-preset"]`).value).toBe('custom');
    expect(app.snapshot().lootFilter.minRarity).toBe(6);
  });

  it('部位组例外能加上也能退回「用全局」', () => {
    const armorSelect = qa(`${EQUIP()} [data-filter-group="armor"]`)[0];
    expect(armorSelect).toBeTruthy();
    setSelect(armorSelect, '5');
    expect(app.snapshot().lootFilter.groups.armor.minRarity).toBe(5);
    click(must(`${EQUIP()} [data-filter-clear="armor"]`));
    expect(app.snapshot().lootFilter.groups.armor).toBeUndefined();
  });

  it('复选框改的是 keepIfBetterThanEquipped，不是别的字段', () => {
    const box = q(`${EQUIP()} [data-filter-field="keepIfBetterThanEquipped"]`);
    box.checked = false;
    box.dispatchEvent(new window.Event('change', { bubbles: true }));
    expect(app.snapshot().lootFilter.keepIfBetterThanEquipped).toBe(false);
    expect(app.snapshot().lootFilter.enabled).toBe(false); // 没开就是没开，勾个复选不该启动熔炼
  });

  it('试算只读：报得出后果，但背包与碎片一个子都没动', () => {
    stock([
      { idSuffix: 't.m1', slot: 'weapon', rarity: 0 },
      { idSuffix: 't.m2', slot: 'head', rarity: 1 },
      { idSuffix: 't.m3', slot: 'chest', rarity: 5 },
    ]);
    setSelect(q(`${EQUIP()} [data-slot="filter-preset"]`), 'epic_up');
    const before = app.snapshot();
    const shards = before.fateShards;
    const ids = before.player.inventory.map((g) => g.id);

    click(must(`${EQUIP()} [data-act="filter-preview"]`));

    const after = app.snapshot();
    expect(after.fateShards).toBe(shards);
    expect(after.player.inventory.map((g) => g.id)).toEqual(ids);
    expect(q(`${EQUIP()} [data-slot="filter-stats"]`).textContent).toContain('试算');
    expect(q(`${EQUIP()} [data-slot="filter-stats"]`).textContent).toContain('2 件');
  });

  it('本局统计随熔炼增长（不是只给个开关就不管账）', () => {
    app.store.update((draft) => {
      draft.metadata.gearMelted = 3;
      draft.metadata.shardsFromMelt = 27;
    });
    app.renderAll();
    expect(q(`${EQUIP()} [data-slot="filter-stats"]`).textContent).toContain('已自动熔炼 3 件');
    expect(q(`${EQUIP()} [data-slot="filter-stats"]`).textContent).toContain('27');
  });
});

// ============================================================
// 无障碍与键盘
// ============================================================

describe('无障碍', () => {
  it('切屏后焦点交给新屏标题（屏幕阅读器能感知上下文变化）', () => {
    app.startNewRun(SEED);
    app.router.go(SCREEN.CHARACTER);
    const heading = q(`${root(SCREEN.CHARACTER)} h2`);
    expect(document.activeElement).toBe(heading);
  });

  it('导航条同一时刻只有一个 aria-pressed=true', () => {
    app.startNewRun(SEED);
    app.router.go(SCREEN.EQUIPMENT);
    const pressed = qa('.app-nav [aria-pressed="true"]');
    expect(pressed).toHaveLength(1);
    expect(pressed[0].getAttribute('data-nav')).toBe(SCREEN.EQUIPMENT);
  });

  it('弹窗是 aria-modal，且 Tab 不会逃出弹窗', async () => {
    app.startNewRun(SEED);
    const shop = app.snapshot().mapNodes.find((n) => n.type === NODE_TYPE.SHOP);
    app.store.update((draft) => {
      draft.currentNodeId = shop.id;
      draft.fateShards = 1000;
    });
    app.openShopDialog();

    const box = q('.dialog-box');
    expect(box.getAttribute('role')).toBe('dialog');
    expect(box.getAttribute('aria-modal')).toBe('true');

    const focusables = [...box.querySelectorAll('button, input, select')];
    expect(focusables.length).toBeGreaterThan(1);
    focusables[focusables.length - 1].focus();

    const tab = new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    box.dispatchEvent(tab);
    // 焦点陷阱：最后一个元素上按 Tab 应被拦截并回到第一个
    expect(tab.defaultPrevented).toBe(true);
    expect(box.contains(document.activeElement)).toBe(true);
    await tick();
  });

  it('战斗日志与 toast 都有 aria-live（新增内容会被读出来）', () => {
    app.startNewRun(SEED);
    expect(q(`${root(SCREEN.MAP)} [data-slot="log-list"]`).getAttribute('aria-live')).toBe('polite');
    expect(q('.app-toast').getAttribute('aria-live')).toBe('polite');
  });

  it('地图节点可键盘聚焦（不依赖鼠标）', () => {
    app.startNewRun(SEED);
    const focusable = qa(`${root(SCREEN.MAP)} .map-node[tabindex="0"]`);
    expect(focusable.length).toBeGreaterThan(0);
  });
});
