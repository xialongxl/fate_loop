// @vitest-environment jsdom
/**
 * 自动熔炼规则编辑器（独立对话框，P2b）。
 *
 * 这个文件守的是"补全到参考项目那种全面度"之后的四件事：
 *   1. **多条必需词条 + 每条独立下限**能写进状态（P2 只有单条，是缺的那一半）
 *   2. **逐槽**规则能加上、能退回继承
 *   3. **折叠段是懒渲染**：没展开过的段不许往状态里写值（否则收起的段落会带
 *      stale 值漂进规则里 —— 那是"看着有其实没有"的老毛病）
 *   4. 「带则熔」「评分下限」两个新条件真的落到 `gearVerdict` 能读到的形状上
 */

import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/main.js';
import { officialModuleEntries } from '../helpers.js';
import { nullAudio } from '../../src/ui/audio/nullAudio.js';
import { resetAdapterCache } from '../../src/persistence/storageAdapter.js';
import { SaveService } from '../../src/persistence/saveService.js';
import { FilterDefaultsService } from '../../src/persistence/lootFilterDefaults.js';
import { SCREEN } from '../../src/core/constants.js';
import { gearVerdict } from '../../src/core/lootFilter.js';

const SEED = 4242;

const q = (sel) => document.querySelector(sel);
const qa = (sel) => [...document.querySelectorAll(sel)];
const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
const change = (el) => el.dispatchEvent(new window.Event('change', { bubbles: true }));
const tick = async (times = 6) => {
  for (let i = 0; i < times; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};
function must(sel) {
  const el = q(sel);
  expect(el, `找不到元素：${sel}`).not.toBeNull();
  return el;
}

let app;

async function openEditor() {
  app.router.go(SCREEN.EQUIPMENT);
  await tick(2);
  click(must(`[data-screen="equipment"] [data-act="filter-edit"]`));
  await tick(2);
  return q('.dialog-box');
}

beforeEach(async () => {
  resetAdapterCache();
  document.body.innerHTML = '<div id="app"></div>';
  const cleaner = new SaveService();
  await cleaner.init();
  await cleaner.clearAll();
  await (await new FilterDefaultsService().init()).clear();
  app = await createApp({
    root: q('#app'),
    seed: SEED,
    modules: officialModuleEntries(),
    audio: nullAudio,
  });
  app.startNewRun(SEED);
  await tick(2);
});

describe('规则编辑器', () => {
  it('九段齐全，且只有全局是展开的（其余懒渲染）', async () => {
    await openEditor();
    expect(qa('.lf-block')).toHaveLength(9);
    const bodies = qa('.lf-body');
    expect(bodies[0].hidden).toBe(false);
    expect(bodies[0].querySelectorAll('select, input').length).toBeGreaterThan(8);
    for (const body of bodies.slice(1)) {
      expect(body.hidden).toBe(true);
      expect(body.innerHTML).toBe(''); // 没展开过就不该有 DOM
    }
  });

  it('展开某个槽 ⇒ 控件才出现，收起再展开不会重复生成', async () => {
    await openEditor();
    click(must('.lf-toggle[data-toggle="slot:ring"]'));
    const body = q('.lf-body[data-body="slot:ring"]');
    expect(body.querySelectorAll('select').length).toBe(1);
    expect(body.querySelectorAll('[data-required]').length).toBe(4);
    expect(body.querySelectorAll('[data-melt]').length).toBe(4);
    expect(body.querySelectorAll('[data-affix-value]').length).toBe(4);
    expect(body.querySelector('[data-min-score]')).not.toBeNull();
    click(must('.lf-toggle[data-toggle="slot:ring"]'));
    click(must('.lf-toggle[data-toggle="slot:ring"]'));
    expect(body.querySelectorAll('[data-required]').length).toBe(4); // 不是 8
  });

  it('多条必需词条 + 每条独立下限：状态里是真的两条', async () => {
    await openEditor();
    const body = q('.lf-body[data-body="global"]');
    body.querySelector('[data-min-rarity]').value = '4';
    change(body.querySelector('[data-min-rarity]'));
    click(body.querySelector('[data-required="crit"]'));
    change(body.querySelector('[data-required="crit"]'));
    click(body.querySelector('[data-required="attack"]'));
    change(body.querySelector('[data-required="attack"]'));
    const critValue = body.querySelector('[data-affix-value="crit"]');
    critValue.value = '5';
    change(critValue);

    const filter = app.snapshot().lootFilter;
    expect(filter.minRarity).toBe(4);
    // 顺序按 DOM 里的词条表（maxHp/attack/defense/crit），不是点击顺序 —— 点两下
    // 顺序就变的规则会让 filterHash 无谓地漂。
    expect([...filter.requiredAffixes].sort()).toEqual(['attack', 'crit']);
    expect(filter.minAffixValues).toEqual({ crit: 5 });
  });

  it('评分下限与「带则熔」写进状态，且判定读得到', async () => {
    await openEditor();
    // 先开总开关：编辑器里"启用"是一个明确的勾选，不是"填了条件就自动开"
    const enable = must('[data-toggle-enabled]');
    enable.checked = true;
    change(enable);
    const body = q('.lf-body[data-body="global"]');
    const score = body.querySelector('[data-min-score]');
    score.value = '1234';
    change(score);
    click(body.querySelector('[data-melt="maxHp"]'));
    change(body.querySelector('[data-melt="maxHp"]'));

    const filter = app.snapshot().lootFilter;
    expect(filter.minScore).toBe(1234);
    expect(filter.meltAffixes).toEqual(['maxHp']);
    // 判定层真吃到：带生命的装备被硬否决，哪怕品质过线、分数够
    expect(
      gearVerdict(
        { slot: 'weapon', rarityIndex: 8, score: 99_999, stats: { maxHp: 10, attack: 1, defense: 0, crit: 0 } },
        { filter, equipment: {} },
      ).reason,
    ).toBe('meltAffix');
    expect(
      gearVerdict(
        { slot: 'weapon', rarityIndex: 8, score: 10, stats: { maxHp: 0, attack: 1, defense: 0, crit: 0 } },
        { filter, equipment: {} },
      ).reason,
    ).toBe('belowMinScore');
  });

  it('槽段填了才写进 slots；「清除本段」退回继承（而不是写一条空规则占位）', async () => {
    await openEditor();
    click(must('.lf-toggle[data-toggle="slot:pendant"]'));
    const body = q('.lf-body[data-body="slot:pendant"]');
    body.querySelector('[data-min-rarity]').value = '6';
    change(body.querySelector('[data-min-rarity]'));
    expect(app.snapshot().lootFilter.slots.pendant.minRarity).toBe(6);

    click(must('[data-clear-section="slot:pendant"]'));
    expect(app.snapshot().lootFilter.slots.pendant).toBeUndefined();
  });

  it('没展开过的段不会被"顺手写空"（懒渲染的另一个理由）', async () => {
    await openEditor();
    const body = q('.lf-body[data-body="global"]');
    body.querySelector('[data-min-rarity]').value = '2';
    change(body.querySelector('[data-min-rarity]'));
    const filter = app.snapshot().lootFilter;
    // 8 个槽一个都没展开 ⇒ slots 必须是空的
    expect(Object.keys(filter.slots)).toEqual([]);
  });

  it('「启用自动熔炼」的勾选只管 enabled，不偷改别的条件', async () => {
    await openEditor();
    const enable = must('[data-toggle-enabled]');
    enable.checked = true;
    change(enable);
    const filter = app.snapshot().lootFilter;
    expect(filter.enabled).toBe(true);
    expect(filter.minRarity).toBe(-1);
    expect(filter.minScore).toBe(0);
  });

  it('「清空全部规则」回到不自动熔炼，摘要与预设下拉一起改口', async () => {
    await openEditor();
    const enable = must('[data-toggle-enabled]');
    enable.checked = true;
    change(enable);
    const body = q('.lf-body[data-body="global"]');
    body.querySelector('[data-min-rarity]').value = '5';
    change(body.querySelector('[data-min-rarity]'));
    expect(app.snapshot().lootFilter.enabled).toBe(true);

    click(must('[data-lf-reset]'));
    await tick(2);
    expect(app.snapshot().lootFilter.enabled).toBe(false);
    expect(q(`[data-screen="equipment"] [data-slot="filter-state"]`).textContent).toBe('未开启');
    expect(q(`[data-screen="equipment"] [data-slot="filter-preset"]`).value).toBe('off');
  });

  it('改一格就脱离预设（下拉框不许接着说瞎话）', async () => {
    app.flow.applyLootFilterPreset('junk');
    await openEditor();
    const body = q('.lf-body[data-body="global"]');
    body.querySelector('[data-min-rarity]').value = '6';
    change(body.querySelector('[data-min-rarity]'));
    const select = q(`[data-screen="equipment"] [data-slot="filter-preset"]`);
    expect([...select.options].map((o) => o.value)).toContain('custom');
    expect(select.value).toBe('custom');
  });

  it('默认规则只影响"下一局"，读档仍用存档里当时的那套', async () => {
    app.flow.setLootFilter({ enabled: true, minRarity: 3 });
    await app.filterDefaults.set(app.flow.lootFilter());
    app.flow.setLootFilter({ enabled: true, minRarity: 7 }); // 本局继续改，不该污染默认
    expect(app.filterDefaults.value.minRarity).toBe(3);

    app.startNewRun(999);
    await tick(2);
    expect(app.snapshot().lootFilter.minRarity).toBe(3); // 新局按默认播种
  });
});
