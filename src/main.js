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
import { SKILL_FAMILY_LABELS } from './core/constants.js';
import { describeGear, rarityOf } from './core/equipment.js';
import { SaveService, AUTO_BACKUP_LIMIT } from './persistence/saveService.js';
import { levelFromTotalExp } from './core/progression.js';
import { pickResumableSlot } from './persistence/continuePolicy.js';
import { SAVE_SLOT_IDS, slotLabel } from './persistence/schema.js';
import {
  buildExport,
  buildMultiExport,
  parseImport,
  summarizeImportedSlot,
} from './persistence/saveTransfer.js';
import { computeContentFingerprint, fingerprintMatches } from './persistence/contentFingerprint.js';
import { PackService } from './persistence/packs.js';
import { defaultSettings } from './persistence/schema.js';
import { HowlerAudio } from './ui/audio/howlerAudio.js';
import { nullAudio } from './ui/audio/nullAudio.js';
import { buildShell, IN_RUN_SCREENS } from './ui/shell.js';
import { ScreenRouter } from './ui/router.js';
import { createDialog } from './ui/dialog.js';
import { createConfirm, createToast, escapeHtml, formatNumber, formatTimestamp } from './ui/format.js';
import { createMainMenuScreen } from './ui/screens/mainMenu.js';
import { createMapScreen } from './ui/screens/mapScreen.js';
import { createBattleScreen } from './ui/screens/battleScreen.js';
import { createCharacterScreen } from './ui/screens/characterScreen.js';
import { createEquipmentScreen } from './ui/screens/equipmentScreen.js';
import { createSequenceScreen } from './ui/screens/sequenceScreen.js';
import { createSavesScreen } from './ui/screens/saves.js';
import { createSettingsScreen } from './ui/screens/settings.js';
import { createModsScreen } from './ui/screens/mods.js';
import { derivePackIdentity } from './core/mods/sandbox/pack.js';
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
 * 默认开局序列 = 开局解锁的全部 6 个 GCD，**每个流派各一个**。
 *
 * 为什么正好六个：解锁表按流派轮转分配 starter 名额（SKILL_FAMILIES 六个流派 ×
 * 家族内最便宜的一个），所以 1 级就能摸到每个流派的手感，而不是"物理系打到底、
 * 其他系全锁着"。
 *
 * 实测（6 种子 × 第 1~3 层全部战斗节点）：带上 order.emergencyCare 这套是 97%，
 * 换成不含治疗的组合掉到 86% —— 治疗 GCD 就是开局存活的关键，别随便删。
 * 改这里之前先看 tests/integration/balance.test.js 的胜率下限与流派覆盖断言。
 */
export const DEFAULT_GCD_SEQUENCE = Object.freeze([
  'blade.jab',
  'fire.spark',
  'frost.shard',
  'shadow.touch',
  'thunder.spark',
  'order.emergencyCare',
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
 * @param {Function} [options.installPacks] 覆盖 `installSandboxPacks`（**只给测试用**：
 *   真实装配走惰性 import，不把 227KB wasm 拖进主包；而"沙箱整个起不来"
 *   这条路径在正常环境里根本触发不了，没这个口子就测不到）
 */
export async function createApp({
  root = document.querySelector('#app'),
  seed = randomSeed(),
  modules,
  saveService = new SaveService(),
  audio = new HowlerAudio(),
  packs,
  installPacks = null,
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
  /** 沙箱宿主（只有真装了包才存在）；卸载包时要靠它把 VM 收掉。 */
  let sandboxHost = null;

  registerDefaultContracts({
    store,
    getRng: () => engine.getRng(),
    getBuffTable: () => pool?.buffs,
    getAudioSink: () => engine?.getAudioSink() ?? audio,
    registry,
  });

  const modLoad = await loadMods({ registry, modules });
  pool = modLoad.pool;
  // engine 必须在装包**之前**建好：包的 fate.onBattleStart 要往它身上挂钩子。
  // 契约里用的是惰性引用（getRng: () => engine.getRng()），所以提前建不影响装配。
  engine = new BattleEngine({ store, registry, pool });

  /**
   * 第三方包（S2）。几件事决定了它必须卡在这里：
   *  1. **在 saveService.init() 之前** —— 装了包要切到隔离存档命名空间，
   *     而“装没装”得先知道；
   *  2. **在算指纹之前** —— 包会往池里塞内容，指纹必须反映它；
   *  3. **在 engine 之后** —— 钩子要有地方挂；
   *  4. **沙箱代码本身是惰性 import 的** —— 没装包的玩家连 227KB 的
   *     QuickJS wasm 都不该下（主包现在才 28KB）。
   */
  const packService = packs === undefined ? new PackService() : packs;
  const packReport = {
    ok: [],
    failed: [],
    overrides: [],
    loaded: [],
    broken: [],
    /** 沙箱本体没起来（wasm 加载失败等）时的原因；null = 没出这事 */
    sandboxError: null,
    /** 因沙箱没起来而**本次未生效**的已启用包数 */
    blockedPacks: 0,
  };
  /**
   * 整段包在 try 里 —— 这一条是真实事故写下来的，不是臆想的防御：
   * dev 下 Vite 预打包不把 `.wasm` 搬进 `node_modules/.vite/deps/`，而 QuickJS
   * 胶水按 `new URL('emscripten-module.wasm', import.meta.url)` 定位它 ⇒ 要不到 ⇒ 404，
   * 而 SPA fallback 递回来的是 index.html ⇒ `WebAssembly.instantiate` 报
   * "expected magic word 00 61 73 6d, found 3c 21 64 6f"（`<!do`）⇒ 异常冒到
   * createApp ⇒ **白屏**。后果比"包没生效"严重一个量级：
   * 玩家连进模组屏卸掉它的入口都没有。
   *
   * 「第三方包不该有让游戏开不了机的权力」是沙箱设计文档自己写的原则，
   * 那它就得由代码保证，而不是由"包恰好写得规范"保证。惰性 import 也同上：
   * 惰性只保证不拖体积，不保证不炸。
   */
  if (packService !== null) {
    let enabledCount = 0;
    try {
      const enabled = await packService.loadEnabled();
      packReport.broken = enabled.broken;
      enabledCount = (enabled.entries ?? []).length;
      if (enabledCount > 0) {
        const installer =
          installPacks ??
          (await import('./core/mods/sandbox/index.js')).installSandboxPacks;
        const result = await installer({
          entries: enabled.entries,
          pool,
          engine,
          clock: () => performance.now(),
        });
        packReport.ok = result.ok;
        packReport.failed = result.failed;
        packReport.overrides = result.overrides;
        packReport.loaded = result.loaded;
        sandboxHost = result.host;
      }
    } catch (error) {
      packReport.sandboxError = String(error?.message ?? error);
      packReport.blockedPacks = enabledCount;
      // 沙箱起不来 ⇒ 内容池退回纯官方。但**存档命名空间仍按"装了包"走**：
      // 装包玩家的档存在隔离库里，跟着"加载成败"切库就会表现为"档不见了"。
      // 读那份档会撞内容指纹校验并弹确认 —— 那是响的，不是静默的。
    }
  }

  await audio.init?.();
  engine.setAudioSinks({ live: audio, silent: nullAudio });

  const storageInfo = await saveService.init({
    // 包真生效 → 隔离库；包想生效但沙箱挂了 → 仍走隔离库（否则装包玩家会觉得档丢了）。
    // blockedPacks 为 0 时不能切：那是「根本没装包」，切库反而会把 vanilla 存档藏起来。
    modded:
      packReport.loaded.length > 0 ||
      (packReport.sandboxError !== null && packReport.blockedPacks > 0),
  });
  const flow = new GameFlow({ store, engine, pool, saveService, audio });

  /**
   * 内容指纹（S1）。结果 = f(种子, 序列, 内容池)，所以分享种子必须连带分享指纹，
   * 读档也必须能看出“这份存档来自另一个内容集”。
   */
  const fingerprint = computeContentFingerprint(pool, {
    mods: modLoad.loaded,
    packs: packReport.loaded,
  });
  saveService.provideFingerprint(() => fingerprint);
  /** 解锁表由 GameFlow 持有（它要在开战前用它洗序列），屏幕共用同一张。 */
  const unlockTable = flow.unlockTable;
  /** 流派中文名：core 官方标签 + 各模组（含 dev 示例包）注册的流派。 */
  const familyLabels = Object.freeze({
    ...SKILL_FAMILY_LABELS,
    ...Object.fromEntries([...pool.families.values()].map((family) => [family.id, family.label])),
  });

  // ============================================================
  // 存储后端的可读说明
  //
  // 光说「降级」没用 —— 得说清是被什么挡住的。真实场景：以 file:// 打开
  // （浏览器对不透明源禁用 IndexedDB）、隐私模式 / 站点数据被拦、另一个标签页
  // 占着旧版本连接导致升级被 block。三种的处理方式完全不同。
  // ============================================================
  function describeStorage(info) {
    const blocked = (info.attempts ?? []).map((a) => `${a.kind}：${a.reason}`);
    const protocol =
      typeof location !== 'undefined' && location.protocol === 'file:'
        ? '当前以 file:// 打开，浏览器会禁用 IndexedDB —— 请用 npm run dev 或任意静态服务器访问'
        : null;
    const head = info.degraded
      ? `存档后端：${info.kind}（降级，可能被浏览器清理）`
      : `存档后端：${info.kind}`;
    const details = [protocol, ...blocked].filter((x) => x !== null && x !== undefined);
    const migrated =
      info.migrated && info.migrated.moved > 0
        ? `已自动找回 ${(info.migrated).moved} 条降级期间写在 localStorage 的数据`
        : null;
    return {
      kind: info.kind,
      degraded: info.degraded,
      migrated: info.migrated ?? null,
      notice: migrated,
      short:
        migrated !== null
          ? `${head} · ${migrated}`
          : details.length === 0
            ? head
            : `${head} · 原因见设置页`,
      long: details.length === 0 ? (migrated ?? head) : `${head}。${details.join('；')}`,
    };
  }

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
      contentHash: fingerprint.hash,
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
      onContinuePrev: () => void continuePrevRun(),
      getPrevSlot: async () => {
        const list = await saveService.listPrevAutos();
        const prev = list[0];
        if (prev === undefined) return null;
        return {
          empty: false,
          floorNumber: prev.run?.floorNumber,
          exp: prev.run?.exp,
          savedAt: prev.savedAt,
          /** 多于一份时菜单上要说清“下面还有旧的”，不然玩家以为只能回一步 */
          backupCount: list.length,
        };
      },
      onNewGame: () => openNewGameDialog(),
      onOpen: (id) => router.go(id, { push: true }),
      /**
       * 「继续游戏」该开哪一份 —— 跨四个槽位判断，不是只看自动槽。
       * 规则与理由见 persistence/continuePolicy.js（写死自动槽曾经会把玩家
       * 从 Lv.14 的手动档领进误点新局刷出来的 Lv.1 空档，看起来像丢档）。
       */
      getContinueSlot: async () => {
        const slots = await saveService.listSlots();
        const picked = pickResumableSlot(slots);
        if (picked === null) return { empty: true };
        const allIncompatible = slots.every((slot) => slot.empty === true || slot.incompatible === true);
        if (allIncompatible) {
          const broken = slots.find((slot) => slot.incompatible === true);
          return { incompatible: true, schemaVersion: broken?.schemaVersion ?? null };
        }
        return { ...picked.slot, downgraded: picked.downgraded, label: slotLabel(picked.slot.slotId) };
      },
    }),

    [SCREEN.MAP]: createMapScreen({
      getSnapshot,
      getLogLimit: () => settings.logLimit ?? 100,
      onNodeActivate: safe((nodeId) => void handleNodeActivate(nodeId)),
      onNodeAction: safe((action) => void handleNodeAction(action)),
      onSeedChange: safe((text) => void handleSeedChange(text)),
      getContentFingerprint: () => fingerprint,
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
      // 熔炼规则（P2）：屏幕不碰 store，一律走 GameFlow 的三个入口
      onFilterPatch: safe((patch) => flow.setLootFilter(patch)),
      onFilterPreset: safe((id) => flow.applyLootFilterPreset(id)),
      onFilterPreview: () => flow.previewLootFilter(),
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
      familyLabels,
    }),

    [SCREEN.SAVES]: createSavesScreen({
      listSlots: () => saveService.listSlots(),
      canSave: canWriteSave,
      getCurrentHash: () => fingerprint.hash,
      onExport: safe((slotId) => void exportSlot(slotId)),
      onExportAll: safe(() => void exportAll()),
      onImportFile: safe((file) => void importFile(file)),
      onLoad: async (slotId) => {
        const loadedSlot = await saveService.loadSlot(slotId);
        if (loadedSlot === null) {
          notify('该槽位是空的', 'warn');
          return;
        }
        if (!(await confirmContentMismatch(loadedSlot))) return;
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

    [SCREEN.MODS]: createModsScreen({
      listPacks: () => packService.list(),
      /**
       * 官方包（核心 / 示例）来自构建期加载结果，内容数量按 pool 里的 source 归组。
       * 它们**没有**启停与卸载入口 —— 不是 UI 偷懒，是这三类操作对构建期内容
       * 根本没有意义：内容已经打进产物了。
       */
      listOfficialPacks: () => {
        const bySource = new Map();
        for (const kind of Object.keys(pool)) {
          for (const spec of pool[kind].values()) {
            const source = spec?.source ?? '(未知来源)';
            const row = bySource.get(source) ?? {};
            row[kind] = (row[kind] ?? 0) + 1;
            bySource.set(source, row);
          }
        }
        const titles = {
          'official.core-skills': '核心 · 技能与流派',
          'official.core-monsters': '核心 · 怪物',
          'official.core-encounters': '核心 · 遭遇 / 商品 / 事件',
          'official.core-map': '核心 · 地图生成',
          'dev.example-pack': '示例包 · 虚空（教学用）',
        };
        return modLoad.loaded.map((mod) => ({
          id: mod.id,
          version: mod.version,
          title: titles[mod.id] ?? mod.id,
          group: mod.id.startsWith('official.') ? 'core' : 'dev',
          counts: bySource.get(mod.id) ?? {},
        }));
      },
      getReport: () => packReport,
      onInstallFile: safe((file) => void installPackFile(file)),
      onToggle: safe(async (id, enabled) => {
        await packService.setEnabled(id, enabled);
        notify(enabled ? '已启用，重载后生效' : '已停用，重载后生效', 'info');
      }),
      onRemove: safe(async (id) => {
        const sure = await confirm(`卸载包 ${id}？它注册的内容会随之消失，`
          + '相关存档仍在隔离命名空间里，装了包还能读回。', { confirmLabel: '卸载' });
        if (!sure) return;
        await packService.remove(id);
        notify('已卸载，重载后生效', 'info');
      }),
      onViewSource: safe(async (id) => void viewPackSource(id)),
      onReload: () => void reloadForPacks(),
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
      familyLabels,
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
      contentHash: fingerprint.hash,
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
    // 后悔药：新局一旦产生进度就会顶掉自动档，所以此刻先备份一份
    // 同步：备份只是改内存列表 + 入写队列（真正的落盘由 flush 统一做）
    saveService.backupAutoSave();
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
    const slots = await saveService.listSlots();
    const picked = pickResumableSlot(slots);
    if (picked === null) {
      notify('没有可继续的存档', 'warn');
      return;
    }
    const loadedSlot = await saveService.loadSlot(picked.slot.slotId);
    if (loadedSlot === null) {
      notify('那一份存档读不回来，请到存档屏重新选择', 'warn');
      return;
    }
    if (!(await confirmContentMismatch(loadedSlot))) return;
    restoreRun(loadedSlot.run);
    // 降级读取必须说出来：玩家有权知道"继续"打开的不是最新那份
    if (picked.downgraded) {
      notify(
        `已继续「${slotLabel(picked.slot.slotId)}」（第 ${String(picked.slot.floorNumber ?? '?')} 层）` +
          '—— 最新那份是还没打过的新局，所以按进度选了这份',
        'info',
      );
      return;
    }
    notify(`已继续「${slotLabel(picked.slot.slotId)}」`, 'info');
  }

  /** 从"上一局自动档"备份读回（读成功后删掉备份，避免一个档被反复回退）。 */
  // ---- 存档导出 / 导入（单个 JSON 文件） ----

  function downloadJson(filename, text) {
    if (typeof URL?.createObjectURL !== 'function') return false; // 无 DOM 环境（测试）
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    return true;
  }

  async function exportSlot(slotId) {
    const record = await saveService.loadSlot(slotId);
    if (record === null) {
      notify('这个槽位是空的', 'warn');
      return;
    }
    const text = JSON.stringify(
      buildExport({ slotId, label: slotLabel(slotId), record }),
      null,
      2,
    );
    const name = `fate-loop-${slotId}-${fingerprint.hash}.json`;
    if (downloadJson(name, text)) notify(`已导出 ${name}`, 'info');
    else notify('当前环境不支持下载，请改用截图/记录种子', 'warn');
  }

  async function exportAll() {
    const records = await saveService.readRecords(SAVE_SLOT_IDS);
    if (records.length === 0) {
      notify('没有任何存档可以导出', 'warn');
      return;
    }
    const text = JSON.stringify(
      buildMultiExport(
        records.map((record) => ({
          slotId: record.slotId,
          label: slotLabel(record.slotId),
          record,
        })),
      ),
      null,
      2,
    );
    const name = `fate-loop-all-${fingerprint.hash}.json`;
    if (downloadJson(name, text)) notify(`已导出 ${records.length} 个槽位`, 'info');
  }

  /** 导入：解析 → 校验 → 列明要写进哪些槽位 → 一次确认 → 落盘并读回第一个。 */
  /**
   * 读文本文件。`file.text()` 是标准 API，但**不是所有环境都有**
   * （jsdom 的 File 就没有；老 Safari 也要到 14 才有）—— 没有回退的话
   * 表现为"点了没反应"，比报错更难查。
   */
  function readTextFile(file) {
    if (typeof file?.text === 'function') return file.text();
    return new Promise((resolve, reject) => {
      const Reader = typeof FileReader === 'function' ? FileReader : null;
      if (Reader === null) {
        reject(new Error('这个环境既没有 File.text() 也没有 FileReader，无法读取文件'));
        return;
      }
      const reader = new Reader();
      reader.onload = () => resolve(String(reader.result ?? ''));
      reader.onerror = () => reject(reader.error ?? new Error('读取失败'));
      reader.readAsText(file);
    });
  }

  /**
   * 安装一个本地包。三件不可省的事：
   *  1. **身份从文件名推，但推出来什么就展示什么** —— 静默改 id 会让玩家
   *     下次完全认不出自己装过哪个；
   *  2. 确认弹里说清"这会改变指纹与存档命名空间"；这句话不提前讲，
   *     玩家会在"我的存档去哪了"里绕半天；
   *  3. 装完不热重载，只标脏（理由见 screens/mods.js 顶部）。
   */
  async function installPackFile(file) {
    const fileName = String(file?.name ?? 'pack.js');
    const identity = derivePackIdentity(fileName);
    /** 一个文件 = 一个单文件包；zip = 多文件包。两条路都归到同一个 files Map */
    let files = null;
    let entry = undefined;
    let meta = {};

    if (/\.zip$/i.test(fileName)) {
      let bytes;
      try {
        bytes = new Uint8Array(await (file.arrayBuffer?.() ?? Promise.reject(new Error('没有 arrayBuffer'))));
      } catch (error) {
        notify(`读取压缩包失败：${String(error?.message ?? error)}`, 'warn');
        return;
      }
      // 只有真拿 zip 来才拉 fflate：单文件路径不该背解压库
      const { unpackArchive } = await import('./core/mods/sandbox/archive.js');
      const unpacked = await unpackArchive(bytes);
      if (!unpacked.ok) {
        notify(`解包失败：${unpacked.reason}`, 'warn');
        return;
      }
      files = unpacked.files;
      entry = unpacked.entry;
      meta = unpacked.meta ?? {};
    } else {
      let text = '';
      try {
        text = await readTextFile(file);
      } catch (error) {
        notify(`读取文件失败：${String(error?.message ?? error)}`, 'warn');
        return;
      }
      files = { 'main.js': text };
    }

    // pack.json 里写了 id/version 就用它，否则从文件名推 —— 两种都要展示给玩家
    const id = typeof meta.id === 'string' && meta.id !== '' ? meta.id : identity.id;
    const version = typeof meta.version === 'string' && meta.version !== '' ? meta.version : identity.version;
    const title = String(meta.title ?? file?.name ?? id);

    const sure = await confirm(
      `安装为 ${id}（版本 ${version}），来源"${fileName}"，含 ${files.size ?? Object.keys(files).length} 个文件。
` +
        '第三方包会改变内容指纹，并把存档切到独立命名空间。',
      { confirmLabel: '安装' },
    );
    if (!sure) return;
    const result = await packService.install({ id, version, title, author: meta.author, files, entry });
    if (!result.ok) {
      notify(`安装失败：${result.reason}`, 'warn');
      return;
    }
    screens[SCREEN.MODS].markDirty();
    notify(`已安装 ${result.pack.id}，重载页面后生效`, 'info');
  }

  /** 看源码：装的是别人写的代码，打不开看就等于让人信一个黑箱。 */
  async function viewPackSource(id) {
    const loaded = await packService.load(id);
    if (loaded === null) {
      notify('这个包的源文件读不回来，建议卸载后重装', 'warn');
      return;
    }
    const box = dialog.open('', { wide: true });
    const sections = [...loaded.pack.files.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(
        ([path, src]) =>
          `<h3 class="mod-src-file">${escapeHtml(path)}</h3>\n        <pre class="mod-src">${escapeHtml(src)}</pre>`,
      )
      .join('');
    box.innerHTML = `
      <h2 tabindex="-1">包源码 · ${escapeHtml(loaded.pack.id)}</h2>
      <p class="dialog-text">版本 ${escapeHtml(loaded.pack.version)} · ${loaded.pack.files.size} 个文件</p>
      ${sections}`;
  }

  /**
   * 重载。不做热重载是**故意**的：内容池冻结、解锁表开局算完、
   * 各屏都持着 pool 引用 —— 热重载会留下一堆半新半旧的状态，
   * 那比不重载更容易出"看不出原因"的 bug。
   */
  async function reloadForPacks() {
    await saveService.flush();
    if (typeof window !== 'undefined' && typeof window.location?.reload === 'function') {
      window.location.reload();
      return;
    }
    notify('这个环境里没有 location.reload，请手动刷新页面', 'warn');
  }

  async function importFile(file) {
    let text = '';
    try {
      text = await readTextFile(file);
    } catch (error) {
      notify(`读取文件失败：${String(error?.message ?? error)}`, 'warn');
      return;
    }
    const parsed = parseImport(text);
    if (!parsed.ok) {
      notify(`导入失败：${parsed.reason}`, 'warn');
      audio.play('ui.deny', {});
      return;
    }
    const rows = parsed.slots.map((slot) => {
      const info = summarizeImportedSlot(slot);
      const foreign =
        info.contentHash !== null && info.contentHash !== undefined && info.contentHash !== fingerprint.hash;
      return `
        <li class="shop-item">
          <span class="shop-item-info">
            <span class="shop-item-name">${escapeHtml(slotLabel(info.slotId))}</span>
            <span class="shop-item-desc">
              种子 ${escapeHtml(String(info.seed))} · 第 ${info.floorNumber} 层 · Lv.${info.level} ·
              碎片 ${formatNumber(info.fateShards)}
              ${foreign ? ` · <span class="tag is-lock">内容指纹 ${escapeHtml(String(info.contentHash))} 与当前不符</span>` : ''}
            </span>
          </span>
        </li>`;
    });
    // 用自定义面板而不是 confirm：导入前必须让玩家看清"要写哪些槽位、
    // 每个槽位是什么内容、内容指纹对不对得上"—— 覆盖是不可撤销的
    const chosen = await new Promise((resolve) => {
      const box = dialog.open(
        `
        <h2 tabindex="-1">导入存档</h2>
        <p class="dialog-text">准备导入 ${parsed.slots.length} 个槽位。<strong>同名槽位会被覆盖</strong>，此操作不可撤销。</p>
        <ul class="shop-list">${rows.join('')}</ul>
        <div class="dialog-actions">
          <button type="button" data-act="import-cancel" class="btn-ghost">取消</button>
          <button type="button" data-act="import-ok" class="btn-primary" data-autofocus>导入</button>
        </div>
      `,
        { closeOnBackdrop: false },
      );
      box.addEventListener('click', (event) => {
        const act = event.target.getAttribute?.('data-act');
        if (act === 'import-ok') {
          dialog.close();
          resolve(true);
        } else if (act === 'import-cancel') {
          dialog.close();
          resolve(false);
        }
      });
    });
    if (!chosen) return;
    for (const slot of parsed.slots) {
      saveService.saveRecord(slot.slotId, {
        savedAt: slot.savedAt ?? Date.now(),
        contentHash: slot.contentHash ?? null,
        contentMods: slot.contentMods ?? [],
        run: slot.run,
      });
    }
    await saveService.flush();
    notify(`已导入 ${parsed.slots.length} 个槽位`, 'info');
    screens[SCREEN.SAVES].refresh?.();
  }

  async function continuePrevRun() {
    const list = await saveService.listPrevAutos();
    if (list.length === 0) {
      notify('没有可回退的上一局存档', 'warn');
      return;
    }
    // 多于一份时必须让人选：默认拿最新的，而玩家想救的往往是“上一个之前的那一局”
    const chosen = list.length === 1 ? list[0] : await pickPrevAuto(list);
    if (chosen === null) return;
    if (!(await confirmContentMismatch(chosen))) return;
    restoreRun(chosen.run);
    await saveService.consumeAutoBackup(chosen.backupKey ?? chosen.savedAt);
    notify('已回退到所选的那一局自动存档', 'info');
  }

  /** 备份选择面板：时间 + 当时进度，让玩家认得出哪份是我要救的。 */
  async function pickPrevAuto(list) {
    return new Promise((resolve) => {
      const rows = list.map((item) => {
        const run = item.run ?? {};
        return `
          <li class="shop-item">
            <button type="button" class="shop-item-pick" data-prev="${escapeHtml(String(item.backupKey ?? item.savedAt ?? ''))}">
              <span class="shop-item-info">
                <span class="shop-item-name">${escapeHtml(formatTimestamp(item.savedAt))}</span>
                <span class="shop-item-desc">
                  第 ${run.floorNumber ?? '?'} 层 · Lv.${levelFromTotalExp(run.exp ?? 0)} ·
                  碎片 ${formatNumber(run.fateShards ?? 0)} · 胜场 ${run.metadata?.battlesWon ?? 0}
                </span>
              </span>
            </button>
          </li>`;
      });
      const box = dialog.open(`
        <h2 tabindex="-1">回到哪一局？</h2>
        <p class="dialog-text">系统里留着 <strong>${list.length}</strong> 份自动存档备份（最多留 ${AUTO_BACKUP_LIMIT} 份）。</p>
        <ul class="shop-list">${rows.join('')}</ul>
        <div class="dialog-actions">
          <button type="button" data-act="prev-cancel" class="btn-ghost">取消</button>
        </div>
      `);
      box.addEventListener('click', (event) => {
        if (event.target.closest?.('[data-act="prev-cancel"]') !== null) {
          dialog.close();
          resolve(null);
          return;
        }
        const key = event.target.closest?.('[data-prev]')?.getAttribute('data-prev');
        if (key === undefined || key === null) return;
        dialog.close();
        resolve(list.find((item) => String(item.backupKey ?? item.savedAt ?? '') === key) ?? null);
      });
    });
  }

  /**
   * 存档来自另一个内容集时要问一句 —— 否则玩家会遇到"技能凭空消失"，
   * 而那是 sanitizeSequence 在正常工作，不是 bug。
   */
  async function confirmContentMismatch(record) {
    const { status, saved, current } = fingerprintMatches(record, fingerprint.hash);
    if (status === 'match') return true;
    // 没有指纹字段 = S1 之前存的档。拦它一次就等于拦每个老玩家一次，
    // 所以只提示不拦；真正要拦的是"指纹存在且不同"。
    if (status === 'unknown') {
      notify('这份存档没有内容指纹记录（早于该功能），读档后若技能对不上属正常', 'info');
      return true;
    }
    return confirm(
      `这份存档来自另一个内容集（存档 ${saved}，当前 ${current}）。` +
        '读档后未解锁或不存在的技能会被自动剔除。仍要读取吗？',
      { confirmLabel: '仍然读取', cancelLabel: '取消' },
    );
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
    // 沙箱里的 wasm runtime 不收回就是一堆泄漏的 wasm 堆
    sandboxHost?.dispose();
    sandboxHost = null;
    shell.root.innerHTML = '';
  }

  // ---- 启动：主菜单 ----
  const storage = describeStorage(storageInfo);
  shell.fields.storage.textContent = storage.short;
  shell.fields.storage.title = storage.long;

  /**
   * 包的状态必须开口说话。静默失败的包会让玩家以为“装了但没效果”，
   * 而静默成功的包会让他找不到存档去哪了（切了命名空间）。
   */
  if (packReport.loaded.length > 0) {
    notify(
      `已加载 ${packReport.loaded.length} 个第三方包，存档已切到隔离命名空间`,
      'info',
    );
  }
  if (packReport.overrides.length > 0) {
    notify(`第三方包覆盖了 ${packReport.overrides.length} 项官方内容`, 'warn');
  }
  for (const failure of packReport.failed.slice(0, 3)) {
    notify(`包 ${failure.id} 未加载：${failure.reason}`, 'warn');
  }
  if (packReport.broken.length > 0) {
    notify(`有 ${packReport.broken.length} 个包的源文件读不回来，可卸载后重装`, 'warn');
  }
  if (packReport.sandboxError !== null) {
    // 响，不静默："安静地没效果"是本项目最难查的一类 bug。
    notify(
      `沙箱没能启动，${packReport.blockedPacks} 个包本次未生效（原因见模组屏）。` +
        '官方内容不受影响，游戏可以照常玩',
      'danger',
    );
  }
  // 设置屏页尾显示完整原因：头部那一行放不下"为什么降级"
  screens[SCREEN.SETTINGS].setStorageInfo?.(
    `${storage.long} · 历史战绩保留最近 50 条`,
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
    fingerprint,
    saveService,
    /** 第三方包（S2）：清单、本次装配结果、沙箱宿主与注册表。 */
    packs: packService,
    packReport,
    get sandboxHost() {
      return sandboxHost;
    },
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
    storageSummary: () => describeStorage(storageInfo),
    destroy,
    /** 当前缓存快照（测试与调试用）。 */
    snapshot: getSnapshot,
  };
}
