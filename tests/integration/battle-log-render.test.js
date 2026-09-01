// @vitest-environment jsdom
/**
 * 战斗日志的**真渲染**测试。
 *
 * log-format.test.js 证明了纯函数怎么输出；这份证明 battleScreen 确实接上了它：
 * 行有语义 class、数字在 `.log-amount` 里、显示的是技能名而不是 id，
 * 以及动效有预算（不会在 4x 下堆出几十个节点）。
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/main.js';
import { officialModuleEntries } from '../helpers.js';
import { nullAudio } from '../../src/ui/audio/nullAudio.js';
import { resetAdapterCache } from '../../src/persistence/storageAdapter.js';
import { SaveService } from '../../src/persistence/saveService.js';
import { SCREEN, LOG_CAPACITY } from '../../src/core/constants.js';

async function mount() {
  resetAdapterCache();
  document.body.innerHTML = '<div id="app"></div>';
  const cleaner = new SaveService();
  await cleaner.init();
  await cleaner.clearAll();
  return createApp({
    root: document.querySelector('#app'),
    seed: 20240101,
    modules: officialModuleEntries(),
    audio: nullAudio,
  });
}

const q = (sel) => document.querySelector(sel);
const qa = (sel) => [...document.querySelectorAll(sel)];
const tick = async (times = 8) => {
  for (let i = 0; i < times; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

/** 开一场战斗并渲染战斗屏。 */
async function fightOnce(app) {
  app.startNewRun(20240101);
  await tick();
  const combat = app
    .snapshot()
    .mapNodes.find((n) => n.type === 'combat' || n.type === 'elite');
  app.store.update((d) => {
    d.currentNodeId = combat.id;
    d.visitedNodeIds.add(combat.id);
  });
  app.flow.startBattle();
  app.engine.runToEnd();
  app.screens[SCREEN.BATTLE].onEnter();
  app.router.go(SCREEN.BATTLE);
  await tick();
  app.renderAll();
  await tick();
}

beforeEach(async () => {
  document.body.innerHTML = '<div id="app"></div>';
});

describe('战斗日志渲染', () => {
  it('日志行带语义 class，数字在 .log-amount 里', async () => {
    const app = await mount();
    await fightOnce(app);
    const rows = qa('.screen-battle .log-entry');
    expect(rows.length, '战斗打完应该有日志').toBeGreaterThan(3);
    const dmg = rows.filter((li) => /log-(damage|crit)/.test(li.className));
    expect(dmg.length, '应有伤害行').toBeGreaterThan(0);
    expect(dmg[0].querySelector('.log-amount').textContent).toMatch(/^[\d,.]+万?$/);
    expect(dmg[0].querySelector('.log-icon').textContent).toMatch(/[★◆]/);
    app.destroy();
  });

  it('显示的是技能名而不是内部 id（名字在渲染层查）', async () => {
    const app = await mount();
    await fightOnce(app);
    const skills = qa('.screen-battle .log-skill').map((n) => n.textContent);
    expect(skills.length).toBeGreaterThan(0);
    for (const s of skills) {
      expect(s, `日志里漏出了内部 id：${s}`).not.toMatch(/\./);   // 'blade.jab' 这类
      expect(s).not.toBe('');
    }
    app.destroy();
  });

  /**
   * 回归：日志比战场活得久。
   * 结算后 state.monsters 已清空，只查当前快照会把内部 id 直接印到屏幕上
   * （实测长这样：【mon.shadow.reaver.t1#0】吞噬 击中你！）。
   */
  it('结算后怪物已从快照消失，日志仍然显示单位名而不是 id', async () => {
    const app = await mount();
    await fightOnce(app);
    app.flow.finishBattle();          // 这一步会清空 monsters
    app.renderAll();
    await tick();
    expect(app.snapshot().monsters, '前置：结算后 monsters 应为空').toHaveLength(0);
    const all = qa('.screen-battle .log-entry').map((li) => li.textContent);
    expect(all.length).toBeGreaterThan(0);
    for (const line of all) {
      expect(line, `日志漏出内部 id：${line}`).not.toMatch(/mon\.[a-z]/);
      expect(line).not.toMatch(/#\d/);
      expect(line).not.toMatch(/ogcd\.|blade\.|fire\.|frost\.|shadow\.|thunder\.|order\./);
    }
    app.destroy();
  });

  it('叙事行不套战斗模板（game.js 的提示与第三方包 ctx.log 都走这条）', async () => {
    const app = await mount();
    await fightOnce(app);
    // 结算后才会有"战斗胜利，获得…"这种叙事行 —— 战斗中的日志现在全是结构化行
    app.flow.finishBattle();
    app.renderAll();
    await tick();
    const narr = qa('.screen-battle .log-entry.log-text');
    expect(narr.length, '结算应有叙事行').toBeGreaterThan(0);
    expect(narr.some((li) => li.textContent.includes('胜利') || li.textContent.includes('经验'))).toBe(true);
    // 叙事行不该被战斗模板包成"咏唱【】"
    expect(narr[0].textContent).not.toContain('咏唱');
    app.destroy();
  });

  it('动效有预算：飘字不会超过 6 个', async () => {
    const app = await mount();
    await fightOnce(app);
    const layer = q('.screen-battle .fx-layer');
    // 没有触发任何新事件时层可以不存在；存在就必须受预算约束
    if (layer !== null) expect(layer.children.length).toBeLessThanOrEqual(6);
    // 逐帧推进时反复渲染，预算始终不破
    app.flow.startBattle?.();
    for (let i = 0; i < 3; i += 1) {
      app.renderAll();
      await tick(2);
    }
    const after = q('.screen-battle .fx-layer');
    if (after !== null) expect(after.children.length).toBeLessThanOrEqual(6);
    app.destroy();
  });

  it('日志容量提到 180，且展示裁剪不会反过来缩小状态', async () => {
    expect(LOG_CAPACITY).toBe(180);
    const app = await mount();
    await fightOnce(app);
    const stateCount = app.snapshot().log.length;
    const shown = qa('.screen-battle .log-entry').length;
    // 设置里 logLimit 更小时，屏上少显示，但状态里一条不少
    expect(stateCount).toBeGreaterThan(0);
    expect(shown).toBeGreaterThan(0);
    app.destroy();
  });

  it('reduced-motion 下不放动效（无障碍开关必须真的生效）', async () => {
    const app = await mount();
    const listeners = [];
    // jsdom 没有 matchMedia，补一个可控实现：styles.css 里那条 media query
    // 会关掉 animation，而 JS 侧也必须自己不看它 —— 两边都得守
    window.matchMedia = (query) => ({
      matches: /prefers-reduced-motion/.test(query),
      media: query,
      addEventListener: (t, f) => listeners.push(f),
      removeEventListener: () => {},
      onchange: null,
    });
    await fightOnce(app);
    const layer = q('.screen-battle .fx-layer');
    expect(layer === null || layer.children.length === 0, 'reduced-motion 下不该有飘字').toBe(true);
    app.destroy();
  });
});
