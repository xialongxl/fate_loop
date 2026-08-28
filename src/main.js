/**
 * 应用装配（阶段 9：多屏外壳）。
 *
 * 本文件只做三件事：装配内核、把用户意图翻译成 GameFlow / BattleEngine 调用、
 * 把状态快照分发给屏幕。任何规则都不许写在这里 —— 那是 core 的职责。
 *
 * 导出 createApp 工厂而不是自动启动，为的是能在 jsdom 冒烟测试里整局驱动；
 * 浏览器入口是 boot.js（index.html 指向它）。
 *
 * 渲染管线：Store.subscribe 每次通知产出一份深冻结快照，本模块缓存为 latest，
 * 屏幕一律通过 getSnapshot() 取它 —— 于是「每帧一次克隆」而非「每屏一次克隆」。
 * 战斗每帧都渲染，这条差别是 1x 下掉帧与否的分界。
 */

import './ui/styles.css';

import {
  AUTO_SAVE_SLOT,
  GAME_STATUS,
  INVENTORY_CAPACITY,
  SCREEN,
  SPEED_MODES,
  WINNER,
} from './core/constants.js';
import { Store } from './core/store.js';
import { createInitialState } from './core/initialState.js';
import { normalizeSeed, randomSeed } from './core/prng.js';
import { registerDefaultContracts } from './contracts/index.js';
import { Registry } from './contracts/registry.js';
import { loadMods } from './core/mods/loader.js';
import { BattleEngine } from './core/battle/engine.js';
import { GameFlow } from './core/game.js';
import { describeGear, rarityOf } from './core/equipment.js';
import { SaveService } from './persistence/saveService.js';
import { defaultSettings } from './persistence/schema.js';
import { HowlerAudio } from './ui/audio/howlerAudio.js';
import { nullAudio } from './ui/audio/nullAudio.js';
import { buildShell, IN_RUN_SCREENS } from './ui/shell.js';
import { ScreenRouter } from './ui/router.js';
import { createDialog } from './ui/dialog.js';
import { createConfirm, createToast, escapeHtml, formatNumber } from './ui/format.js';
import { createMainMenuScreen } from './ui/screens/mainMenu.js';
import { createMapScreen } from './ui/screens/mapScreen.js';
import { createBattleScreen } from './ui/screens/battleScreen.js';
import { createCharacterScreen } from './ui/screens/characterScreen.js';
import { createEquipmentScreen } from './ui/screens/equipmentScreen.js';
import { createSequenceScreen } from './ui/screens/sequenceScreen.js';
import { createSavesScreen } from './ui/screens/saves.js';
import { createSettingsScreen } from './ui/screens/settings.js';
import { createCodexScreen } from './ui/screens/codex.js';
import { createHistoryScreen } from './ui/screens/history.js';

const STATUS_LABELS = Object.freeze({
  [GAME_STATUS.IDLE]: '待开始',
  [GAME_STATUS.EXPLORING]: '探索中',
  [GAME_STATUS.BATTLING]: '战斗中',
  [GAME_STATUS.PAUSED]: '已暂停',
  [GAME_STATUS.FINISHED]: '已结束',
  [GAME_STATUS.ERROR]: '错误',
});

/** 移动被拒时的玩家可读理由（GameFlow 返回的是机器码，不能直接上屏）。 */
const MOVE_DENY = Object.freeze({
  notExploring: '当前状态下不能移动',
  notAdjacent: '只能走到相邻节点',
  noSuchNode: '那个节点不在地图上',
  deadEnd: '此路不通',
});

/**
 * 默认开局序列。
 *
 * 必须是 1 级就合法的组合。解锁表按类型分名额（前 6 个 GCD + 前 4 个 oGCD
 * 在 1 级），因此 5 个低代价起手 GCD 加一个自保插入技是合法且可用的开局。
 * 旧默认里的 blade.slash(7) / riposte(6) / cleave(41) 与 ogcd.emergencyHeal(94)
 * 在 1 级都是非法的 —— 交接文档 P1-2 提醒的正是这件事。
 *
 * 改这里之前先看一眼胜率守卫：tests/integration/balance.test.js。
 */
export const DEFAULT_GCD_SEQUENCE = Object.freeze([
  'blade.jab',
  'blade.disarm',
  'fire.spark',
  'frost.shard',
  'shadow.touch',
]);
export const DEFAULT_OGCD_SLOTS = Object.freeze([
  // 自保优先：残血时振奋（短冷却自我治疗）抢到最前
  { skillId: 'ogcd.secondWind', priority: 95 },
  { skillId: 'ogcd.suddenStrike', priority: 30 },
]);

/**
 * 装配整个应用。
 *
 * @param {object} [options]
 * @param {Element} [options.root] 挂载点，默认 #app
 * @param {number} [options.seed] 初始种子（测试固定用）
 * @param {Array} [options.modules] 注入模组条目（绕过 import.meta.glob，测试用）
 * @param {SaveService} [options.saveService]
 * @param {object} [options.audio] 音频 sink（测试传静默实现）
 */
export async function createApp({
  root = document.querySelector('#app'),
  seed = randomSeed(),
  modules,
  saveService = new SaveService(),
  audio = new HowlerAudio(),
} = {}) {
  if (root === null || root === undefined) {
    throw new Error('createApp 需要挂载点（#app）');
  }

  // ============================================================
  // 内核装配。顺序有依赖：Store → Registry（契约要 store 与 rng 提供者）
  // → 模组 → Engine → Flow。rng 提供者用惰性引用打破 Registry 与 Engine 的循环。
  // ============================================================
  const store = new Store(
    createInitialState(seed, {
      gcdSequence: [...DEFAULT_GCD_SEQUENCE],
      ogcdSlots: [...DEFAULT_OGCD_SLOTS],
    }),
  );

  const registry = new Registry();
  let engine = null;
  let pool = null;

  registerDefaultContracts({
    store,
    getRng: () => engine.getRng(),
    getBuffTable: () => pool?.buffs,
    getAudioSink: () => engine?.getAudioSink() ?? audio,
    registry,
  });

  const loaded = await loadMods({ registry, modules });
  pool = loaded.pool;
  engine = new BattleEngine({ store, registry, pool });

  await audio.init?.();
  engine.setAudioSinks({ live: audio, silent: nullAudio });

  const storageInfo = await saveService.init();
  const flow = new GameFlow({ store, engine, pool, saveService, audio });
  /** 解锁表由 GameFlow 持有（它要在开战前用它洗序列），屏幕共用同一张。 */
  const unlockTable = flow.unlockTable;

  // ============================================================
  // 设置（P1-1：此前 settings 有写无读，这里补上消费方）
  // ============================================================
  let settings = await saveService.loadSettings();

  function applyAudioSettings() {
    audio.setMuted?.(settings.muted === true);
    audio.setVolume?.(settings.volume ?? 0.6);
  }
  applyAudioSettings();

  function updateSettings(patch) {
    settings = { ...settings, ...patch };
    applyAudioSettings();
    saveService.saveSettings(settings);
  }

  // ============================================================
  // 外壳、屏幕与路由
  // ============================================================
  const shell = buildShell(root);
  const dialog = createDialog(shell.dialog);
  const confirm = createConfirm(dialog);
  const toast = createToast(shell.toast);
  const notify = (message, kind = 'info') => toast.show(message, { kind });

  /** 快照缓存：订阅回调是唯一写入点，屏幕不许自行取活状态。 */
  let latest = store.getSnapshot();
  let renderDepth = 0;

  store.subscribe((snapshot) => {
    latest = snapshot;
    // 渲染抛错必须被兜住：否则会连锁触发后面每一次 update 都抛
    try {
      renderAll();
    } catch (error) {
      reportError(error, 'render');
    }
  });

  const getSnapshot = () => latest;
  const getState = () => latest;
  const isRunActive = () =>
    latest.status === GAME_STATUS.EXPLORING ||
    latest.status === GAME_STATUS.BATTLING ||
    latest.status === GAME_STATUS.PAUSED;
  /**
   * 能不能写存档。暂停中也算有效局内状态 —— 但状态字段一旦在暂停里被写成
   * EXPLORING（例如读档恢复半路失败），就必须以引擎的真实状态为准，
   * 否则存档界面会给一个恢复不出来的槽位提供「保存」按钮。
   */
  const canWriteSave = () => isRunActive() && engine.isPaused() === false;

  // ---- 战斗循环 ----
  let speed = SPEED_MODES.PAUSED;
  /** 暂停前用的速度，P 键与「继续」按钮都靠它回到玩家上次的手感。 */
  let lastRunningSpeed = SPEED_MODES.X1;
  let rafHandle = null;

  function beginBattle() {
    // 核心在 startBattle 里也会洗一次（纵深防御）；这里先洗是为了能提示玩家
    const { removed } = flow.sanitizeSequence();
    if (removed.length > 0) notify(`${removed.length} 个技能当前等级未解锁，已移出序列`, 'warn');
    flow.startBattle();
    router.go(SCREEN.BATTLE);
    const want = settings.autoStartBattle === false ? SPEED_MODES.PAUSED : settings.defaultSpeed;
    setSpeed(want === SPEED_MODES.PAUSED ? SPEED_MODES.X1 : want);
  }

  function setSpeed(next) {
    if (![SPEED_MODES.PAUSED, SPEED_MODES.X1, SPEED_MODES.X4, SPEED_MODES.MAX].includes(next)) {
      return;
    }
    if (next === SPEED_MODES.PAUSED) {
      stopLoop();
      engine.pause(); // 写 GAME_STATUS.PAUSED：虚拟时间停止推进，不是「推进但不结算」
      speed = next;
      renderAll();
      return;
    }

    engine.resume(); // 从暂停态捞回来；不在暂停态时是空操作
    speed = next;
    lastRunningSpeed = next;
    if (next === SPEED_MODES.MAX) {
      stopLoop();
      engine.runToEnd();
      onBattleStopped();
    } else if (getSnapshot().status === GAME_STATUS.BATTLING) {
      startLoop();
    }
    renderAll();
  }

  /** P 键：战斗中/暂停中切换。输入控件里打字不算。 */
  function togglePause() {
    const status = getSnapshot().status;
    if (status !== GAME_STATUS.BATTLING && status !== GAME_STATUS.PAUSED) return;
    if (engine.isPaused()) {
      setSpeed(speed === SPEED_MODES.PAUSED ? lastRunningSpeed : speed);
    } else {
      setSpeed(SPEED_MODES.PAUSED);
    }
    audio.play(status === GAME_STATUS.PAUSED ? 'ui.confirm' : 'ui.click', {});
  }

  function startLoop() {
    if (rafHandle !== null) return;
    const tick = () => {
      rafHandle = null;
      if (getSnapshot().status !== GAME_STATUS.BATTLING || speed === SPEED_MODES.PAUSED) {
        onBattleStopped();
        renderAll();
        return;
      }
      const running = engine.runFrame(speed);
      if (!running) {
        onBattleStopped();
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

  /** 战斗停止（胜或败）：结算并按需弹死亡面板。 */
  function onBattleStopped() {
    stopLoop();
    if (getSnapshot().status !== GAME_STATUS.FINISHED) return;

    const lost = getSnapshot().winner === WINNER.MONSTERS;
    const result = flow.finishBattle(); // 内部会 notify，快照随之更新
    if (result.settled !== true) return;

    if (!lost) {
      // 胜利：留在战斗屏，footer 显示奖励与「返回地图」
      renderAll();
      return;
    }
    // 阵亡：GameFlow 已写历史并清自动槽
    dialog.openSummary(getSnapshot(), {
      outcome: 'death',
      primaryLabel: '回到主菜单',
      onPrimary: () => gotoMenu(),
    });
  }

  // ============================================================
  // 屏幕装配
  // ============================================================
  const screens = {
    [SCREEN.MAIN_MENU]: createMainMenuScreen({
      onContinue: () => void continueRun(),
      onNewGame: () => openNewGameDialog(),
      onOpen: (id) => router.go(id, { push: true }),
      getAutoSlot: async () => {
        const slots = await saveService.listSlots();
        return slots.find((s) => s.slotId === AUTO_SAVE_SLOT) ?? null;
      },
    }),

    [SCREEN.MAP]: createMapScreen({
      getSnapshot,
      getLogLimit: () => settings.logLimit ?? 100,
      onNodeActivate: safe((nodeId) => void handleNodeActivate(nodeId)),
      onNodeAction: safe((action) => void handleNodeAction(action)),
      onSeedChange: safe((text) => void handleSeedChange(text)),
    }),

    [SCREEN.BATTLE]: createBattleScreen({
      getSnapshot,
      getSkills: () => pool.skills,
      getBuffs: () => pool.buffs,
      getSpeed: () => speed,
      onSpeedChange: safe((next) => setSpeed(next)),
      onLeave: safe(() => router.go(SCREEN.MAP)),
      getLogLimit: () => settings.logLimit ?? 100,
    }),

    [SCREEN.CHARACTER]: createCharacterScreen({ getState }),

    [SCREEN.EQUIPMENT]: createEquipmentScreen({
      getState,
      onEquip: safe((id) => flow.equip(id)),
      onUnequip: safe((slot) => flow.unequip(slot)),
      onSalvage: safe((id) => flow.salvage(id)),
      onEnhance: safe((id) => flow.enhance(id)),
      onToast: notify,
    }),

    [SCREEN.SEQUENCE]: createSequenceScreen({
      getState,
      getSkills: () => pool.skills,
      getUnlockTable: () => unlockTable,
      onChange: safe((mutate) => {
        store.update((draft) => mutate(draft.player));
        // 屏幕自己会拦未解锁项，这里再洗一次是给手改进来的状态兜底
        const { removed } = flow.sanitizeSequence();
        if (removed.length > 0) notify('有技能当前等级未解锁，已移出序列', 'warn');
      }),
      onPlayFeedback: (id) => audio.play(id, {}),
      onToast: notify,
    }),

    [SCREEN.SAVES]: createSavesScreen({
      listSlots: () => saveService.listSlots(),
      canSave: canWriteSave,
      onLoad: async (slotId) => {
        const loadedSlot = await saveService.loadSlot(slotId);
        if (loadedSlot === null) {
          notify('该槽位是空的', 'warn');
          return;
        }
        restoreRun(loadedSlot.run);
        notify(`已读取${slotId === AUTO_SAVE_SLOT ? '自动' : '手动'}存档`, 'info');
      },
      onSave: async (slotId) => {
        if (!isRunActive()) {
          notify('没有进行中的轮回', 'warn');
          return;
        }
        saveService.saveToSlot(slotId, store.unsafeGetState());
        await saveService.flush();
        notify('已保存', 'info');
      },
      onDelete: async (slotId) => {
        const ok = await confirm(`删除该存档？此操作不可撤销。`, { confirmLabel: '删除' });
        if (!ok) return;
        await saveService.deleteSlot(slotId);
        notify('已删除', 'info');
      },
      onBack: () => router.back(SCREEN.MAIN_MENU),
    }),

    [SCREEN.SETTINGS]: createSettingsScreen({
      getSettings: () => settings,
      onChange: (patch) => updateSettings(patch),
      onBack: () => router.back(getSnapshot().status === GAME_STATUS.IDLE ? SCREEN.MAIN_MENU : SCREEN.MAP),
      onResetData: () => void resetAllData(),
    }),

    [SCREEN.CODEX]: createCodexScreen({
      getPool: () => pool,
      getUnlockTable: () => unlockTable,
      getSnapshot,
      onBack: () => router.back(SCREEN.MAIN_MENU),
    }),

    [SCREEN.HISTORY]: createHistoryScreen({
      listHistory: () => saveService.loadHistory(),
      getSnapshot,
      onOpenCodex: () => router.go(SCREEN.CODEX, { push: true }),
      onBack: () => router.back(SCREEN.MAIN_MENU),
    }),
  };

  const router = new ScreenRouter(shell.host);
  for (const [id, screen] of Object.entries(screens)) router.register(id, screen);

  // ---- 导航条 ----
  shell.nav.addEventListener('click', (event) => {
    const target = event.target.closest?.('[data-nav]');
    if (target === null || target === undefined) return;
    router.go(target.getAttribute('data-nav'));
  });

  shell.buttons.settings.addEventListener('click', () => {
    router.go(SCREEN.SETTINGS, { push: true });
  });

  shell.buttons.menu.addEventListener('click', () => void gotoMenuConfirmed());

  router.subscribe((id) => {
    for (const btn of shell.nav.querySelectorAll('[data-nav]')) {
      const active = btn.getAttribute('data-nav') === id;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-pressed', String(active));
    }
    shell.nav.hidden = !IN_RUN_SCREENS.has(id);
    shell.root.classList.toggle('is-in-run', IN_RUN_SCREENS.has(id));
    renderShell();
  });

  // ============================================================
  // 意图处理：地图节点
  // ============================================================

  async function handleNodeActivate(nodeId) {
    const result = flow.moveTo(nodeId);
    if (!result.ok) {
      audio.play('ui.deny', {});
      notify(MOVE_DENY[result.reason] ?? '无法移动', 'warn');
      return;
    }
    if (result.triggeredBattle) {
      if (settings.autoStartBattle === false) {
        notify('已抵达战斗节点，可在右侧「进入战斗」开始', 'info');
      } else {
        beginBattle();
      }
    }
  }

  async function handleNodeAction(action) {
    const node = flow.currentNode();
    if (node === null) return;

    if (action === 'rest') {
      const result = flow.useRest();
      if (!result.ok) notify(result.reason === 'alreadyUsed' ? '这里已经休息过了' : '这里不能休息', 'warn');
      return;
    }
    if (action === 'descend') {
      const result = flow.descend();
      if (result.victory === true) {
        showVictorySummary();
        return;
      }
      if (!result.ok) notify('这里没有通往下一层的路', 'warn');
      screens[SCREEN.MAP].resetView();
      return;
    }

  
    if (action === 'battle') {
      beginBattle();
      return;
    }
    if (action === 'shop') {
      openShopDialog();
      return;
    }
    if (action === 'event') {
      openEventDialog();
    }
  }

  /** 种子输入框：换种子等于重开一局，必须二次确认。 */
  async function handleSeedChange(text) {
    const next = normalizeSeed(text, randomSeed());
    const ok = await confirm(
      `用种子 ${next} 重开一局？当前轮回的进度会被丢弃（自动存档会被覆盖）。`,
      { confirmLabel: '重开' },
    );
    if (!ok) return;
    startNewRun(next);
  }

  function openNewGameDialog() {
    const suggested = randomSeed();
    const box = dialog.open(
      `
      <h2 tabindex="-1">新的轮回</h2>
      <p class="dialog-text">种子决定地图、遭遇与一切随机。同一种子必然重现同一局。</p>
      <label class="dialog-field">
        <span>种子（数字或任意词语）</span>
        <input type="text" data-slot="seed" value="${suggested}" data-autofocus />
      </label>
      <p class="setting-note">留空则用随机种子。</p>
      <div class="dialog-actions">
        <button type="button" data-act="start" class="btn-primary">开始探索</button>
        <button type="button" data-act="random" class="btn-ghost">换一个随机种子</button>
        <button type="button" data-action="close" class="btn-ghost">取消</button>
      </div>
    `,
      { wide: false },
    );

    const input = box.querySelector('[data-slot="seed"]');
    box.addEventListener('click', (event) => {
      const act = event.target.getAttribute?.('data-act');
      if (act === 'random') {
        input.value = String(randomSeed());
        input.focus();
        return;
      }
      if (act !== 'start') return;
      const next = input.value.trim() === '' ? randomSeed() : normalizeSeed(input.value, randomSeed());
      dialog.close();
      startNewRun(next);
    });
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      const next = input.value.trim() === '' ? randomSeed() : normalizeSeed(input.value, randomSeed());
      dialog.close();
      startNewRun(next);
    });
  }

  /** 商店：消耗品/属性商品 + 装备货架（后者此前实现了却没有入口）。 */
  function openShopDialog() {
    const shopState = flow.getShopOffers();
    if (shopState === null) {
      notify('这里没有商人', 'warn');
      return;
    }

    const box = dialog.open('', { wide: true });
    renderShop();

    function renderShop() {
      const state = getSnapshot();
      const gearShelf = flow.getShopGear();
      box.innerHTML = `
        <h2 tabindex="-1">流浪货摊</h2>
        <p class="dialog-text">持有命运碎片：<strong>${formatNumber(state.fateShards)}</strong>
          · 背包 ${state.player.inventory.length} / ${INVENTORY_CAPACITY}</p>
        <ul class="shop-list">
          ${shopState.offers
            .map((offer) => {
              const bought = shopState.purchasedIds.has(offer.id);
              const affordable = state.fateShards >= offer.cost;
              return `
              <li class="shop-item">
                <span class="shop-item-info">
                  <span class="shop-item-name">${escapeHtml(offer.name)}</span>
                  <span class="shop-item-desc">${escapeHtml(offer.description)}</span>
                </span>
                <span class="shop-cost">${offer.cost}</span>
                <button type="button" data-buy="${escapeHtml(offer.id)}"
                        ${bought || !affordable ? 'disabled' : ''}>${bought ? '已购买' : '购买'}</button>
              </li>`;
            })
            .join('')}
        </ul>
        <h3>装备货架</h3>
        <ul class="shop-list is-gear">
          ${gearShelf
            .map(({ gear, price }) => {
              const bought = shopState.purchasedIds.has(gear.id);
              const affordable =
                state.fateShards >= price && state.player.inventory.length < INVENTORY_CAPACITY;
              return `
              <li class="shop-item">
                <span class="shop-item-info">
                  <span class="shop-item-name ${rarityOf(gear).cls}">${escapeHtml(gear.name)}</span>
                  <span class="shop-item-desc">${escapeHtml(describeGear(gear))}</span>
                </span>
                <span class="shop-cost">${price}</span>
                <button type="button" data-buy-gear="${escapeHtml(gear.id)}"
                        ${bought || !affordable ? 'disabled' : ''}>${bought ? '已购买' : '购入'}</button>
              </li>`;
            })
            .join('')}
        </ul>
        <div class="dialog-actions">
          <button type="button" data-action="close" class="btn-primary">离开</button>
        </div>
      `;
    }

    box.addEventListener('click', (event) => {
      const itemId = event.target.getAttribute?.('data-buy');
      if (itemId !== null && itemId !== undefined) {
        const result = flow.purchase(itemId);
        if (!result.ok) {
          audio.play('ui.deny', {});
          notify(PURCHASE_DENY[result.reason] ?? '无法购买', 'warn');
          return;
        }
        renderShop();
        return;
      }

      const gearId = event.target.getAttribute?.('data-buy-gear');
      if (gearId === null || gearId === undefined) return;
      const picked = flow.getShopGear().find((entry) => entry.gear.id === gearId);
      if (picked === undefined) return;
      const result = flow.purchaseGear(picked.gear);
      if (!result.ok) {
        audio.play('ui.deny', {});
        notify(PURCHASE_DENY[result.reason] ?? '无法购买', 'warn');
        return;
      }
      notify(`已购入，-${result.price} 碎片`, 'info');
      renderShop();
    });
  }

  /** 通关面板：一条路继续无尽，一条路收手。两条都不伪造第二次结算。 */
  function showVictorySummary() {
    dialog.openSummary(getSnapshot(), {
      outcome: 'victory',
      primaryLabel: '继续挑战无尽',
      onPrimary: () => {
        const continued = flow.continueEndless();
        if (!continued.ok) return;
        screens[SCREEN.MAP].resetView();
        notify('从这里开始没有尽头', 'info');
      },
      secondaryLabel: '结束这局',
      onSecondary: () => gotoMenu(),
    });
  }

  const PURCHASE_DENY = Object.freeze({
    alreadyPurchased: '这件已经买过了',
    insufficientShards: '命运碎片不足',
    inventoryFull: '背包已满，先分解一些装备',
    noSuchItem: '没有这件商品',
    notShopNode: '这里没有商人',
    shopNotOpened: '还没有看到货架',
  });

  function openEventDialog() {
    const event = flow.getEvent();
    if (event === null) {
      notify('这里已经没什么可看了', 'info');
      return;
    }

    const box = dialog.open(`
      <h2 tabindex="-1">${escapeHtml(event.name)}</h2>
      <p class="dialog-text">${escapeHtml(event.text)}</p>
      <ul class="event-choices">
        ${event.choices
          .map(
            (choice, index) => `
          <li class="event-choice">
            <span class="event-choice-info">
              <span class="event-choice-label">${escapeHtml(choice.label)}</span>
              <span class="event-choice-desc">${escapeHtml(choice.description)}</span>
            </span>
            <button type="button" data-choice="${index}" class="btn-primary">选择</button>
          </li>`,
          )
          .join('')}
      </ul>
      <div class="dialog-actions">
        <button type="button" data-action="close" class="btn-ghost">走开</button>
      </div>
    `);

    box.addEventListener('click', (clickEvent) => {
      const raw = clickEvent.target.getAttribute?.('data-choice');
      if (raw === null || raw === undefined) return;
      const result = flow.resolveEvent(event.id, Number(raw));
      dialog.close();
      if (!result.ok) notify('什么也没有发生', 'warn');
    });
  }

  // ============================================================
  // 运行期错误边界（P1-7）
  //
  // 屏幕回调抛错、渲染抛错、异步 rejection 都不该把整局卡在半路：
  // 停止推进、把 code 与消息摊在屏幕上、给出「回主菜单」这条退路。
  // state.error 只存 code + 消息，不存 stack 与时间戳 —— 状态里的东西都要
  // 考虑确定性，堆栈留在控制台就够了。
  // ============================================================
  let errorDialogOpen = false;

  function reportError(error, where = '') {
    console.error('[fate-loop] 运行期错误', where, error);
    stopLoop();
    const code = typeof error?.code === 'string' ? error.code : String(error?.name ?? 'Unknown');
    const message = String(error?.message ?? error ?? '未知错误').slice(0, 400);
    store.update((draft) => {
      draft.error = { code, message, where: String(where) };
    });

    if (errorDialogOpen) return;
    errorDialogOpen = true;
    const box = dialog.open(
      `
      <h2 tabindex="-1">出了点问题</h2>
      <p class="dialog-text">战斗已停止推进。存档没有被破坏，可以先回主菜单。</p>
      <p class="library-desc"><span class="tag">${escapeHtml(code)}</span>${
        where ? ` <span class="tag">${escapeHtml(where)}</span>` : ''
      }</p>
      <p class="summary-seq">${escapeHtml(message)}</p>
      <div class="dialog-actions">
        <button type="button" data-act="err-menu" class="btn-primary" data-autofocus>返回主菜单</button>
        <button type="button" data-act="err-dismiss" class="btn-ghost">关掉并继续</button>
      </div>
    `,
      { closeOnBackdrop: false, escapable: false },
    );

    const finish = (toMenu) => {
      errorDialogOpen = false;
      store.update((draft) => {
        draft.error = null;
      });
      dialog.close();
      if (toMenu) gotoMenu();
      else renderAll();
    };
    box.addEventListener('click', (event) => {
      const act = event.target.getAttribute?.('data-act');
      if (act === 'err-menu') finish(true);
      else if (act === 'err-dismiss') finish(false);
    });
  }

  /** 把同步回调包一层：屏幕内部的 DOM 事件由这里兜住。 */
  function safe(fn) {
    return (...args) => {
      try {
        return fn(...args);
      } catch (error) {
        reportError(error, fn.name || 'intent');
        return undefined;
      }
    };
  }

  function onWindowError(event) {
    reportError(event.error ?? new Error(String(event.message)), 'window');
  }

  function onUnhandledRejection(event) {
    reportError(event.reason ?? new Error('未处理的 Promise 拒绝'), 'promise');
  }
  window.addEventListener('error', onWindowError);
  window.addEventListener('unhandledrejection', onUnhandledRejection);

  // ============================================================
  // 轮回生命周期
  // ============================================================

  function freshState(nextSeed) {
    return createInitialState(nextSeed, {
      gcdSequence: [...DEFAULT_GCD_SEQUENCE],
      ogcdSlots: [...DEFAULT_OGCD_SLOTS],
    });
  }

  function startNewRun(nextSeed = randomSeed()) {
    stopLoop();
    dialog.close();
    speed = SPEED_MODES.PAUSED;
    store.replace(freshState(nextSeed));
    latest = store.getSnapshot();
    flow.enterFloor(1);
    screens[SCREEN.MAP].resetView();
    router.clearStack();
    router.go(SCREEN.MAP);
  }

  function restoreRun(run) {
    stopLoop();
    dialog.close();
    speed = SPEED_MODES.PAUSED;
    flow.restoreRun(run);
    screens[SCREEN.MAP].resetView();
    router.clearStack();
    router.go(SCREEN.MAP);
  }

  async function continueRun() {
    const loadedSlot = await saveService.loadSlot(AUTO_SAVE_SLOT);
    if (loadedSlot === null) {
      notify('没有可继续的自动存档', 'warn');
      return;
    }
    restoreRun(loadedSlot.run);
  }

  async function gotoMenuConfirmed() {
    if (!isRunActive()) {
      gotoMenu();
      return;
    }
    const ok = await confirm('返回主菜单？进度保存在自动槽里，不会丢失。', {
      confirmLabel: '返回主菜单',
    });
    if (ok) gotoMenu();
  }

  function gotoMenu() {
    stopLoop();
    speed = SPEED_MODES.PAUSED;
    dialog.close();
    router.go(SCREEN.MAIN_MENU);
  }

  async function resetAllData() {
    const ok = await confirm('清空全部本地数据（4 个槽位、历史战绩、设置）？不可撤销。', {
      confirmLabel: '全部清空',
    });
    if (!ok) return;
    stopLoop();
    await saveService.clearAll();
    settings = defaultSettings();
    applyAudioSettings();
    store.replace(freshState(randomSeed()));
    latest = store.getSnapshot();
    router.clearStack();
    router.go(SCREEN.MAIN_MENU);
    notify('已清空全部数据', 'info');
  }

  // ============================================================
  // 渲染
  // ============================================================

  function renderShell(passed) {
    const state = passed ?? getSnapshot();
    const inRun = isRunActive() || state.status === GAME_STATUS.FINISHED;
    const { level, hp, maxHp } = state.player;
    shell.fields.level.textContent = `Lv.${level}`;
    shell.fields.hp.textContent = `${formatNumber(hp)} / ${formatNumber(maxHp)}`;
    shell.fields.floor.textContent = `第 ${state.floorNumber} 层`;
    shell.fields.shards.textContent = `碎片 ${formatNumber(state.fateShards)}`;
    shell.fields.status.textContent = STATUS_LABELS[state.status] ?? state.status;
    for (const field of ['level', 'hp', 'floor', 'shards']) {
      shell.fields[field].hidden = !inRun;
    }
    shell.fields.status.hidden = state.status === GAME_STATUS.IDLE;
  }



  function renderAll() {
    // 屏幕渲染中若再触发 store.update，订阅会重入；限深避免无限递归。
    if (renderDepth > 3 || errorDialogOpen) return;
    renderDepth += 1;
    try {
      const state = getSnapshot();
      renderShell(state);
      router.renderCurrent();
    } finally {
      renderDepth -= 1;
    }
  }

  // ---- 切后台自动暂停：避免标签页节流后战斗"跳时间" ----
  function onVisibilityChange() {
    if (document.hidden && getSnapshot().status === GAME_STATUS.BATTLING) {
      setSpeed(SPEED_MODES.PAUSED);
      notify('切到后台，已暂停', 'info');
    }
  }
  document.addEventListener('visibilitychange', onVisibilityChange);

  function onKeyDown(event) {
    if (event.key !== 'p' && event.key !== 'P') return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target;
    if (typeof target?.closest === 'function' && target.closest('input, textarea, select, [contenteditable="true"]')) return;
    if (router.current !== SCREEN.BATTLE && router.current !== SCREEN.MAP) return;
    event.preventDefault();
    togglePause();
  }
  document.addEventListener('keydown', onKeyDown);

  function destroy() {
    stopLoop();
    document.removeEventListener('visibilitychange', onVisibilityChange);
    document.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('error', onWindowError);
    window.removeEventListener('unhandledrejection', onUnhandledRejection);
    dialog.close();
    shell.root.innerHTML = '';
  }

  // ---- 启动：主菜单 ----
  const storageLabel = storageInfo.degraded
    ? `存档后端：${storageInfo.kind}（降级，可能被浏览器清理）`
    : `存档后端：${storageInfo.kind}`;
  shell.fields.storage.textContent = storageLabel;
  // 设置屏自己也要知道降级情况：它在页尾显示一行数据去向
  screens[SCREEN.SETTINGS].setStorageInfo?.(
    `${storageLabel} · 历史战绩保留最近 50 条`,
  );
  if (!Object.values(SPEED_MODES).includes(settings.defaultSpeed)) {
    settings = { ...settings, defaultSpeed: SPEED_MODES.X1 };
  }
  router.go(SCREEN.MAIN_MENU);
  renderAll();

  return {
    store,
    engine,
    flow,
    pool,
    router,
    screens,
    dialog,
    shell,
    unlockTable,
    get speed() {
      return speed;
    },
    get settings() {
      return { ...settings };
    },
    setSpeed,
    togglePause,
    reportError,
    startNewRun,
    restoreRun,
    continueRun,
    gotoMenu,
    openShopDialog,
    openEventDialog,
    beginBattle,
    notify,
    renderAll,
    destroy,
    /** 当前缓存快照（测试与调试用）。 */
    snapshot: getSnapshot,
  };
}
