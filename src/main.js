/**
 * 应用装配入口。
 *
 * 装配顺序有依赖：Store → Registry（契约需要 store 与 rng 提供者）→ 模组加载
 * → BattleEngine → GameFlow → UI。rng 提供者用惰性引用打破 Registry 与 Engine
 * 的循环依赖。
 */

import './ui/styles.css';

import { BUILD_TAG, GAME_STATUS, NODE_TYPE, SPEED_MODES, WINNER } from './core/constants.js';
import { Store } from './core/store.js';
import { createInitialState } from './core/initialState.js';
import { randomSeed } from './core/prng.js';
import { registerDefaultContracts } from './contracts/index.js';
import { Registry } from './contracts/registry.js';
import { loadMods } from './core/mods/loader.js';
import { BattleEngine } from './core/battle/engine.js';
import { GameFlow } from './core/game.js';
import { SaveService } from './persistence/saveService.js';
import { HowlerAudio } from './ui/audio/howlerAudio.js';
import { nullAudio } from './ui/audio/nullAudio.js';
import { buildLayout } from './ui/layout.js';
import { MapRenderer } from './ui/map/renderer.js';
import { attachMapInteraction } from './ui/map/interaction.js';
import { createViewState, resetView } from './ui/map/viewState.js';
import { createSeedPanel } from './ui/panel/seedInput.js';
import { createNodePanel } from './ui/panel/nodePanel.js';
import { createSequenceEditor } from './ui/panel/sequenceEditor.js';
import { createBattlePanel } from './ui/panel/hpBars.js';
import { createLogView } from './ui/panel/logView.js';
import { createDialog } from './ui/panel/summary.js';

/** 默认起始序列：兼顾输出与自保，让新玩家不必先配序列就能开局。 */
const DEFAULT_GCD_SEQUENCE = [
  'blade.jab',
  'blade.slash',
  'blade.riposte',
  'blade.momentumStrike',
  'blade.cleave',
];
const DEFAULT_OGCD_SLOTS = [
  { skillId: 'ogcd.emergencyHeal', priority: 95 },
  { skillId: 'ogcd.suddenStrike', priority: 30 },
];

async function boot() {
  console.info(BUILD_TAG);

  const root = document.querySelector('#app');
  const layout = buildLayout(root);

  // ---- 内核装配 ----
  const seed = randomSeed();
  const store = new Store(
    createInitialState(seed, { gcdSequence: DEFAULT_GCD_SEQUENCE, ogcdSlots: DEFAULT_OGCD_SLOTS }),
  );

  const registry = new Registry();
  let engine = null;
  let contentPool = null;
  const audio = new HowlerAudio();

  registerDefaultContracts({
    store,
    // 惰性引用：契约注册早于引擎构造与模组加载，此处不能直接捕获
    getRng: () => engine.getRng(),
    getBuffTable: () => contentPool?.buffs,
    getAudioSink: () => engine?.getAudioSink() ?? audio,
    registry,
  });

  const { pool, loaded } = await loadMods({ registry });
  contentPool = pool;
  console.info(
    `[mods] 已加载 ${loaded.length} 个模组：技能 ${pool.skills.size} / Buff ${pool.buffs.size} / 怪物 ${pool.monsters.size} / 遭遇 ${pool.encounters.size} / 商品 ${pool.shopItems.size} / 事件 ${pool.events.size}`,
  );

  engine = new BattleEngine({ store, registry, pool });
  await audio.init();
  engine.setAudioSinks({ live: audio, silent: nullAudio });

  const saveService = new SaveService();
  const storageInfo = await saveService.init();
  layout.fields.storage.textContent = storageInfo.degraded
    ? `存档：${storageInfo.kind}（降级，可能被浏览器清理）`
    : '';

  const flow = new GameFlow({ store, engine, pool, saveService, audio });

  // ---- UI 装配 ----
  const view = createViewState();
  const mapRenderer = new MapRenderer(layout.slots.map);
  const dialog = createDialog(layout.slots.dialog);
  const logView = createLogView(layout.slots.log);

  let speed = SPEED_MODES.X1;
  let rafHandle = null;

  const seedPanel = createSeedPanel(layout.slots.seed, {
    getSeed: () => store.unsafeGetState().seed,
    onSeedChange: (nextSeed) => {
      stopLoop();
      store.replace(
        createInitialState(nextSeed, {
          gcdSequence: DEFAULT_GCD_SEQUENCE,
          ogcdSlots: DEFAULT_OGCD_SLOTS,
        }),
      );
      resetView(view);
      flow.enterFloor(1);
      sequenceEditor.render();
    },
  });

  const nodePanel = createNodePanel(layout.slots.node, {
    getFlow: () => flow,
    onAction: (action) => handleNodeAction(action),
  });

  const sequenceEditor = createSequenceEditor(layout.slots.sequence, {
    getState: () => store.unsafeGetState(),
    getSkills: () => pool.skills,
    onPlayFeedback: (id) => audio.play(id, {}),
    onChange: (mutate) => {
      store.update((draft) => mutate(draft.player));
      sequenceEditor.render();
    },
  });

  const battlePanel = createBattlePanel(layout.slots.battle, {
    getSpeed: () => speed,
    onSpeedChange: (next) => {
      speed = next;
      if (next === SPEED_MODES.MAX) {
        stopLoop();
        engine.runToEnd();
        settleBattle();
      } else if (next === SPEED_MODES.PAUSED) {
        stopLoop();
      } else {
        startLoop();
      }
      render();
    },
    onStartBattle: () => {
      flow.startBattle();
      speed = SPEED_MODES.X1;
      startLoop();
      render();
    },
  });

  // ---- 地图交互 ----
  attachMapInteraction({
    svg: mapRenderer.svg,
    view,
    onViewChange: () => mapRenderer.applyView(view),
    onNodeActivate: (nodeId) => {
      const result = flow.moveTo(nodeId);
      if (!result.ok) {
        audio.play('ui.deny', {});
        return;
      }
      render();
      if (result.triggeredBattle) {
        flow.startBattle();
        speed = SPEED_MODES.X1;
        startLoop();
        render();
      }
    },
  });

  layout.slots.resetView.addEventListener('click', () => {
    resetView(view);
    mapRenderer.applyView(view);
  });

  // ---- 战斗循环 ----
  function startLoop() {
    if (rafHandle !== null) return;
    const tick = () => {
      const state = store.unsafeGetState();
      if (state.status !== GAME_STATUS.BATTLING) {
        rafHandle = null;
        settleBattle();
        return;
      }
      const running = engine.runFrame(speed);
      render();
      if (!running) {
        rafHandle = null;
        settleBattle();
        return;
      }
      rafHandle = requestAnimationFrame(tick);
    };
    rafHandle = requestAnimationFrame(tick);
  }

  function stopLoop() {
    if (rafHandle === null) return;
    cancelAnimationFrame(rafHandle);
    rafHandle = null;
  }

  function settleBattle() {
    const state = store.unsafeGetState();
    if (state.status !== GAME_STATUS.FINISHED) return;

    const lost = state.winner === WINNER.MONSTERS;
    const result = flow.finishBattle();
    render();

    if (lost && result.won === false) {
      dialog.openSummary(store.getSnapshot(), { outcome: 'death' });
      const box = layout.slots.dialog.querySelector('.dialog-box');
      box.querySelector('[data-action="close"]').addEventListener('click', () => {
        const nextSeed = randomSeed();
        store.replace(
          createInitialState(nextSeed, {
            gcdSequence: DEFAULT_GCD_SEQUENCE,
            ogcdSlots: DEFAULT_OGCD_SLOTS,
          }),
        );
        resetView(view);
        flow.enterFloor(1);
        seedPanel.sync();
        sequenceEditor.render();
        render();
      });
    }
  }

  // ---- 节点操作 ----
  function handleNodeAction(action) {
    if (action === 'rest') {
      flow.useRest();
      render();
      return;
    }
    if (action === 'descend') {
      flow.descend();
      resetView(view);
      mapRenderer.applyView(view);
      render();
      return;
    }
    if (action === 'shop') {
      openShop();
      return;
    }
    if (action === 'event') {
      openEvent();
    }
  }

  function openShop() {
    const shopState = flow.getShopOffers();
    if (shopState === null) return;
    const shards = store.unsafeGetState().fateShards;

    const html = `
      <h2>流浪货摊</h2>
      <p class="event-text">持有碎片：${shards}</p>
      <ul class="shop-list">
        ${shopState.offers
          .map((offer) => {
            const bought = shopState.purchasedIds.has(offer.id);
            const affordable = shards >= offer.cost;
            return `
            <li class="shop-item">
              <span class="shop-item-info">
                <span class="shop-item-name">${offer.name}</span>
                <span class="shop-item-desc">${offer.description}</span>
              </span>
              <span class="shop-cost">${offer.cost}</span>
              <button type="button" data-buy="${offer.id}" ${bought || !affordable ? 'disabled' : ''}>
                ${bought ? '已购买' : '购买'}
              </button>
            </li>`;
          })
          .join('')}
      </ul>
      <div class="dialog-actions">
        <button type="button" data-action="close" class="btn-primary">离开</button>
      </div>
    `;

    const box = dialog.open(html);
    box.addEventListener('click', (event) => {
      const itemId = event.target.getAttribute?.('data-buy');
      if (itemId === null || itemId === undefined) return;
      const result = flow.purchase(itemId);
      if (!result.ok) {
        audio.play('ui.deny', {});
        return;
      }
      render();
      openShop();
    });
  }

  function openEvent() {
    const event = flow.getEvent();
    if (event === null) return;

    const html = `
      <h2>${event.name}</h2>
      <p class="event-text">${event.text}</p>
      <ul class="event-choices">
        ${event.choices
          .map(
            (choice, index) => `
          <li class="event-choice">
            <span class="event-choice-info">
              <span class="event-choice-label">${choice.label}</span>
              <span class="event-choice-desc">${choice.description}</span>
            </span>
            <button type="button" data-choice="${index}">选择</button>
          </li>`,
          )
          .join('')}
      </ul>
    `;

    const box = dialog.open(html);
    box.addEventListener('click', (e) => {
      const raw = e.target.getAttribute?.('data-choice');
      if (raw === null || raw === undefined) return;
      flow.resolveEvent(event.id, Number(raw));
      dialog.close();
      render();
    });
  }

  // ---- 渲染 ----
  function render() {
    const snapshot = store.getSnapshot();
    const battling = snapshot.status === GAME_STATUS.BATTLING;
    const adjacentIds = new Set(snapshot.mapAdjacency[snapshot.currentNodeId] ?? []);

    mapRenderer.render(snapshot, { adjacentIds, battling });
    mapRenderer.applyView(view);
    layout.slots.mask.hidden = !battling;

    layout.fields.floor.textContent = `第 ${snapshot.floorNumber} 层`;
    layout.fields.shards.textContent = `碎片 ${snapshot.fateShards}`;
    layout.fields.status.textContent = STATUS_LABELS[snapshot.status] ?? snapshot.status;

    const node = snapshot.mapNodes.find((n) => n.id === snapshot.currentNodeId);
    const canStartBattle =
      !battling &&
      node !== undefined &&
      (node.type === NODE_TYPE.COMBAT || node.type === NODE_TYPE.ELITE) &&
      !node.isCleared;

    nodePanel.render(snapshot);
    battlePanel.render(snapshot, { canStartBattle });
    logView.render(snapshot);
  }

  const STATUS_LABELS = {
    [GAME_STATUS.IDLE]: '待开始',
    [GAME_STATUS.EXPLORING]: '探索中',
    [GAME_STATUS.BATTLING]: '战斗中',
    [GAME_STATUS.PAUSED]: '已暂停',
    [GAME_STATUS.FINISHED]: '已结束',
    [GAME_STATUS.ERROR]: '错误',
  };

  // 窗口失焦自动暂停：避免后台标签页节流影响观赏体验
  window.addEventListener('blur', () => {
    if (store.unsafeGetState().status === GAME_STATUS.BATTLING) {
      stopLoop();
      speed = SPEED_MODES.PAUSED;
      render();
    }
  });

  flow.enterFloor(1);
  render();
}

boot().catch((error) => {
  console.error('[fate-loop] 启动失败', error);
  const root = document.querySelector('#app');
  if (root !== null) {
    root.innerHTML = `<pre style="color:#f85149;padding:20px;white-space:pre-wrap">启动失败：${String(
      error?.message ?? error,
    )}\n\n${String(error?.stack ?? '')}</pre>`;
  }
});
