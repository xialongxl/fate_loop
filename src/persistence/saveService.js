/**
 * 存档服务（裁决 7，阶段 9 扩展多槽位）。
 *
 * 核心问题：IndexedDB 异步，而战斗/生成逻辑被 ESLint 硬禁 async。
 * 解法：core/** 永不直接调存储。SaveService 提供同步的 enqueue()，把快照推入
 * 写队列，队列在宏任务中串行 flush。同一 key 的待写项只保留最新一份（合写），
 * 因此高频调用也不会堆积。
 *
 * 写入失败不影响游戏进行 —— 只记日志并通知监听者，让 UI 提示。
 *
 * 槽位模型（参考 Fate_echo 的 3 手动槽 + 1 自动槽）：
 *   - 自动槽 `auto` 由游戏流程写（每层、每次结算），玩家不能手动覆盖
 *   - 手动槽 `slot1..slot3` 只在玩家点「保存」时写
 *   - 每条记录带 savedAt 时间戳（存档列表要按时间排序，这是 UI 元数据，
 *     不参与任何确定性逻辑，因此允许触碰物理时钟）
 */

import {
  HISTORY_KEY,
  LEGACY_SAVE_KEY,
  SAVE_SLOT_IDS,
  SETTINGS_KEY,
  createHistoryEntry,
  defaultSettings,
  deserializeRun,
  isAutoSlot,
  serializeRun,
  slotKey,
  summarizeSave,
} from './schema.js';
import { AUTO_SAVE_SLOT } from '../core/constants.js';
import { expOf, hasMeaningfulProgress, isSaveRegression } from '../core/runProgress.js';
import { migrateLocalToIndexedDb, pickAdapter } from './storageAdapter.js';

/** 自动档备份历史（不占存档界面的格子）。 */
const PREV_SLOT = 'autoPrev';
const PREV_KEY = slotKey(PREV_SLOT); // 旧版单槽，只用于**迁移**
const BACKUP_KEY = 'run:autoBackups';
export const AUTO_BACKUP_LIMIT = 5;

export class SaveService {
  #adapter = null;
  #degraded = false;
  /**
   * 最后一次写入的自动档（内存副本）。
   * 安全网靠它做同步比较；init 时从盘上读一次，所以刷新页面也拦得住。
   */
  #lastAuto = null;
  /** 自动档备份历史（内存常驻，落盘走 enqueue；新的在前，上限 AUTO_BACKUP_LIMIT） */
  #backups = [];
  #pending = new Map();
  #flushScheduled = false;
  #flushing = null;
  #errorListeners = new Set();
  #modded = false;
  /** 内容指纹提供者：由装配层注入（它才知道池子长什么样），存档要带这份凭据。 */
  #fingerprint = null;

  /**
   * @param {object} [options]
   * @param {boolean} [options.modded] 启用了运行时包 ⇒ 存档写进独立命名空间。
   *   今天恒为 false（还没有运行时加载），但**命名空间的切分要早于工坊**：
   *   等真有包时再改库名，等于把玩家已有存档留在另一个库里。
   */
  async init({ modded = false } = {}) {
    this.#modded = modded;
    const { adapter, degraded, attempts = [] } = await pickAdapter({ modded });
    this.#adapter = adapter;
    this.#degraded = degraded;
    // 清理 v1 遗留的单键存档，避免存档界面出现读不出来的幽灵条目
    try {
      await adapter.delete(LEGACY_SAVE_KEY);
    } catch {
      // 清理失败无害
    }
    // 降级期间写进 localStorage 的数据搬回来，否则修好版本锁那一刻玩家会以为存档没了
    let migrated = { moved: 0, skipped: 0 };
    if (adapter.kind === 'indexeddb') {
      try {
        migrated = await migrateLocalToIndexedDb(adapter);
      } catch {
        // 搬家失败不影响游戏：数据仍在 localStorage，下次启动再试
      }
    }

    // 备份历史读进内存（并吸收旧版单槽 run:autoPrev，别让已经救过档的人被降级）
    try {
      const storedBackups = await adapter.get(BACKUP_KEY);
      const legacy = await adapter.get(PREV_KEY);
      const merged = Array.isArray(storedBackups) ? [...storedBackups] : [];
      if (legacy !== null && legacy !== undefined && legacy.data !== undefined) {
        if (!merged.some((item) => (item?.savedAt ?? null) === (legacy.savedAt ?? null))) {
          merged.push({ ...legacy, slotId: PREV_SLOT });
        }
        await adapter.delete(PREV_KEY);
      }
      this.#backups = merged
        .filter((item) => item !== null && item !== undefined && item.data !== undefined)
        .sort((a, b) => Number(b.savedAt ?? 0) - Number(a.savedAt ?? 0))
        .slice(0, AUTO_BACKUP_LIMIT);
    } catch {
      this.#backups = [];
    }

    // 把现有自动档读进内存：安全网必须跨页面刷新仍然有效，
    // 否则“刷新页面 → 读个旧档 → 自动保存”这条路径上就没人拦得住了。
    try {
      this.#lastAuto = (await adapter.get(slotKey(AUTO_SAVE_SLOT))) ?? null;
    } catch {
      this.#lastAuto = null;
    }

    return { kind: adapter.kind, degraded, attempts, migrated };
  }

  get degraded() {
    return this.#degraded;
  }

  get adapterKind() {
    return this.#adapter?.kind ?? 'none';
  }

  /** 当前是否运行在 modded 命名空间。 */
  get modded() {
    return this.#modded;
  }

  /**
   * 注入内容指纹提供者。SaveService 不认识内容池，所以由装配层给一个函数
   * （每次写档时调用），避免持久层反向依赖 core。
   * @param {() => {hash:string, mods:Array, packs:Array}} provider
   */
  provideFingerprint(provider) {
    this.#fingerprint = typeof provider === 'function' ? provider : null;
    return this;
  }

  /** 写档时附带的凭据。没有 provider 时返回空对象（测试与早期启动阶段）。 */
  #credentials() {
    if (this.#fingerprint === null) return {};
    const fp = this.#fingerprint();
    if (fp === null || fp === undefined) return {};
    return { contentHash: fp.hash, contentMods: fp.mods ?? [], contentPacks: fp.packs ?? [] };
  }

  onError(listener) {
    this.#errorListeners.add(listener);
    return () => this.#errorListeners.delete(listener);
  }

  /**
   * 同步入队。这是唯一允许被同步逻辑调用的写入入口。
   * 同 key 合写：后来的覆盖先前的待写项。
   */
  enqueue(key, value) {
    this.#pending.set(key, value);
    this.#scheduleFlush();
    return this;
  }

  /**
   * 写入自动槽（每层开始、每次结算时由 GameFlow 调用）。
   *
   * ⚠️ 这里有一道**丢档安全网**：如果新状态比当前自动档更"旧"（exp 变小），
   * 说明这次写入会把一局进度更大的存档顶掉 —— 先把被顶掉的那份存进备份历史。
   * 典型现场：误点「新的轮回」后在新局里打了第一仗。
   *
   * 为什么不用 hasMeaningfulProgress 拦：新局只要往下走一层就已经"有进度"了，
   * **任何**门控都挡不住"新局顶掉老局"。自动槽就该跟着当前局走，
   * 安全性得由"顶掉前先存一份"来保证。
   *
   * 为什么用内存里的 #lastAuto 而不是再读一次盘：saveRun 是同步入队、
   * 宏任务落盘，比较一旦走异步就会和 flush 抢时序 —— 读到新值就等于没读到。
   */
  saveRun(state) {
    const serialized = serializeRun(state);
    const previous = this.#pending.get(slotKey(AUTO_SAVE_SLOT)) ?? this.#lastAuto;
    if (
      previous !== null &&
      previous !== undefined &&
      isSaveRegression(previous.data ?? previous, serialized)
    ) {
      this.#backupRecord(previous);
    }
    this.#lastAuto = { slotId: AUTO_SAVE_SLOT, savedAt: Date.now(), ...this.#credentials(), data: serialized };
    return this.enqueue(slotKey(AUTO_SAVE_SLOT), this.#lastAuto);
  }

  /**
   * 写入指定槽位。同步入队，不返回 Promise —— core 层可安全调用。
   * savedAt 用物理时钟：它只用于存档列表排序，不进入任何确定性判定。
   */
  saveToSlot(slotId, state) {
    const record = {
      slotId,
      savedAt: Date.now(),
      ...this.#credentials(),
      data: serializeRun(state),
    };
    return this.enqueue(slotKey(slotId), record);
  }

  /** 读取指定槽位。版本不匹配会抛错（schema.js 中判定）。 */
  async loadSlot(slotId) {
    if (this.#adapter === null) await this.init();
    // 待写项可能还没落盘，优先读它，避免「刚存就读却读到旧值」
    const pendingRecord = this.#pending.get(slotKey(slotId));
    const record = pendingRecord ?? (await this.#adapter.get(slotKey(slotId)));
    if (record === null || record === undefined) return null;
    // 记录级凭据要一起带出去：调用方要靠 contentHash 判断"这存档是不是别的内容集写的"
    return {
      savedAt: record.savedAt ?? null,
      contentHash: record.contentHash ?? null,
      contentMods: record.contentMods ?? [],
      contentPacks: record.contentPacks ?? [],
      run: deserializeRun(record.data ?? record),
    };
  }

  /** 列出全部槽位的摘要。缺失槽返回 { slotId, empty: true }。 */
  async listSlots() {
    if (this.#adapter === null) await this.init();
    const out = [];
    for (const slotId of SAVE_SLOT_IDS) {
      let record = this.#pending.get(slotKey(slotId));
      if (record === undefined) {
        try {
          record = await this.#adapter.get(slotKey(slotId));
        } catch {
          record = null;
        }
      }
      if (record === null || record === undefined) {
        out.push({ slotId, empty: true, auto: isAutoSlot(slotId) });
        continue;
      }
      out.push({
        slotId,
        empty: false,
        auto: isAutoSlot(slotId),
        ...summarizeSave(record),
      });
    }
    return out;
  }

  /**
   * 直接写入一条现成的记录（导入用 —— 导入没有"当前状态"可序列化）。
   * 走同一条写队列，因此与 saveToSlot 一样是同步入队、宏任务落盘。
   */
  saveRecord(slotId, record) {
    // 落盘形状必须与 saveToSlot 一致：run 放在 `data` 键下，
    // 否则 loadSlot 的 `record.data ?? record` 会拿到外层记录、读不到 schemaVersion
    const { run, data, ...rest } = record;
    return this.enqueue(slotKey(slotId), { ...rest, slotId, data: run ?? data });
  }

  /** 读出若干槽位的完整记录（导出用）。空槽与不兼容槽会被跳过。 */
  async readRecords(slotIds) {
    const out = [];
    for (const slotId of slotIds) {
      const loaded = await this.loadSlot(slotId);
      if (loaded !== null) out.push({ slotId, ...loaded });
    }
    return out;
  }

  async deleteSlot(slotId) {
    if (this.#adapter === null) await this.init();
    this.#pending.delete(slotKey(slotId));
    await this.#adapter.delete(slotKey(slotId));
  }

  /** 清除自动槽（永久死亡时调用）。 */
  async clearRun() {
    await this.deleteSlot(AUTO_SAVE_SLOT);
  }

  /**
   * 备份的**内容身份**。
   *
   * ⚠️ 不能用 savedAt 去重：两次写入落在同一毫秒是完全正常的（连点、批量结算、
   * 测试里更是必然），那会把两份**不同**的档误判成重复而丢掉一份 —— 而"丢掉的那份"
   * 恰恰是玩家要救的。savedAt 同样也不能当删除键（一次删掉两条）。
   */
  static #backupKeyOf(record) {
    const d = record?.data ?? record ?? {};
    return [
      d.seed ?? '?',
      expOf(d),
      d.metadata?.floorsCleared ?? 0,
      d.fateShards ?? 0,
      d.metadata?.battlesWon ?? 0,
    ].join('|');
  }

  /**
   * 把一份现成的自动档记录收进备份历史。
   *
   * **全程同步**（除了走既有写队列落盘）：以前这里是"异步读盘 + 调用方 void 掉
   * promise"，于是 flush() 不等它，测试与真实退出时序下备份会丢。
   * 列表常驻 #backups，落盘统一走 enqueue ⇒ 与存档槽同一套 flush 语义。
   */
  #backupRecord(record) {
    const data = record?.data ?? record;
    let run;
    try {
      run = deserializeRun(data);
    } catch {
      return false;
    }
    if (!hasMeaningfulProgress(run)) return false;
    const backupKey = SaveService.#backupKeyOf(record);
    if (this.#backups.some((item) => item.backupKey === backupKey)) return false;
    this.#backups = [
      { ...record, slotId: PREV_SLOT, backupKey },
      ...this.#backups,
    ]
      .filter((item) => item !== null && item !== undefined && item.data !== undefined)
      .sort((a, b) => Number(b.savedAt ?? 0) - Number(a.savedAt ?? 0))
      .slice(0, AUTO_BACKUP_LIMIT);
    this.enqueue(BACKUP_KEY, this.#backups);
    return true;
  }

  /**
   * 把当前自动槽显式收进备份历史。GameFlow 开新局前会调一次；
   * 平时由 saveRun 里的回退安全网自动触发，不依赖这里。
   */
  backupAutoSave() {
    const record =
      this.#pending.get(slotKey(AUTO_SAVE_SLOT)) ?? this.#lastAuto ?? null;
    if (record === null) return { ok: false, reason: 'noAutoSave' };
    return this.#backupRecord(record) ? { ok: true } : { ok: false, reason: 'notWorthBackingUp' };
  }

  /** 备份列表（新的在前）。纯内存读，所以调用方拿到的永远与已入队写入一致。 */
  async listAutoBackups() {
    if (this.#adapter === null) await this.init();
    return this.#backups.map((item) => ({ ...item }));
  }

  /**
   * 可读的备份列表（主菜单/选择面板用）。
   * 反序列化失败的条目**静默剔除**而不是抛：存储被清一半时把菜单带崩是最坏的结果。
   */
  async listPrevAutos() {
    const list = await this.listAutoBackups();
    const out = [];
    for (const item of list) {
      const view = this.#toPrevView(item);
      if (view !== null) out.push(view);
    }
    return out;
  }

  /** 最近一份备份（旧 API，主菜单默认入口用）。没有则 null。 */
  async loadPrevAuto() {
    const [newest] = await this.listPrevAutos();
    return newest ?? null;
  }

  #toPrevView(record) {
    try {
      return {
        savedAt: record.savedAt ?? null,
        backupKey: record.backupKey ?? record.savedAt ?? null,
        contentHash: record.contentHash ?? null,
        contentMods: record.contentMods ?? [],
        run: deserializeRun(record.data ?? record),
      };
    } catch {
      return null;
    }
  }

  /**
   * 取走并删除某一份备份。优先按 backupKey 认（内容身份，唯一）；
   * 只有老数据没有 backupKey 时才退回 savedAt。
   */
  consumeAutoBackup(id) {
    const before = this.#backups.length;
    this.#backups = this.#backups.filter((item) =>
      item.backupKey !== undefined ? item.backupKey !== id : (item.savedAt ?? null) !== id,
    );
    this.enqueue(BACKUP_KEY, this.#backups);
    return this.#backups.length !== before;
  }

  /** 丢掉最新一份（旧 API，保留给"用掉即弃"的调用点）。 */
  deletePrevAuto() {
    this.#backups = this.#backups.slice(1);
    this.enqueue(BACKUP_KEY, this.#backups);
  }

  /**
   * 清空全部本地数据：4 个槽位 + 历史战绩 + 设置。
   * 设置界面「清空全部数据」的后端。同时清空待写队列 —— 否则 flush 会把
   * 刚删掉的快照又写回去，玩家看到的是“删不干净”的存档。
   */
  async clearAll() {
    if (this.#adapter === null) await this.init();
    this.#pending.clear();
    this.#flushScheduled = false;
    // 内存里也清：否则 clearAll 之后 listPrevAutos 还能读到"刚被清空"的备份
    this.#backups = [];
    this.#lastAuto = null;
    for (const slotId of SAVE_SLOT_IDS) {
      await this.#adapter.delete(slotKey(slotId));
    }
    await this.#adapter.delete(HISTORY_KEY);
    await this.#adapter.delete(PREV_KEY);
    await this.#adapter.delete(BACKUP_KEY);
    await this.#adapter.delete(SETTINGS_KEY);
    await this.#adapter.delete(LEGACY_SAVE_KEY);
    return { ok: true };
  }

  /** 追加历史记录，保留最近 50 条。 */
  async appendHistory(state, { outcome }) {
    if (this.#adapter === null) await this.init();
    const existing = (await this.#adapter.get(HISTORY_KEY)) ?? [];
    const entry = {
      ...createHistoryEntry(state, { outcome }),
      ...this.#credentials(),
      recordedAt: Date.now(),
    };
    const next = [entry, ...existing].slice(0, 50);
    await this.#adapter.set(HISTORY_KEY, next);
    return next;
  }

  async loadHistory() {
    if (this.#adapter === null) await this.init();
    return (await this.#adapter.get(HISTORY_KEY)) ?? [];
  }

  async clearHistory() {
    if (this.#adapter === null) await this.init();
    await this.#adapter.delete(HISTORY_KEY);
  }

  /** 读取设置，缺失字段用默认值补齐（增加新设置项时老存档不会缺键）。 */
  async loadSettings() {
    if (this.#adapter === null) await this.init();
    const stored = await this.#adapter.get(SETTINGS_KEY);
    return { ...defaultSettings(), ...(stored ?? {}) };
  }

  /** 保存设置（同步入队）。 */
  saveSettings(settings) {
    return this.enqueue(SETTINGS_KEY, { ...defaultSettings(), ...settings });
  }

  #scheduleFlush() {
    if (this.#flushScheduled) return;
    this.#flushScheduled = true;
    // 宏任务而非微任务：让当前同步逻辑（可能是整场 MAX 战斗）先跑完
    setTimeout(() => {
      this.#flushScheduled = false;
      void this.flush();
    }, 0);
  }

  /** 串行 flush，避免并发事务互相阻塞。 */
  async flush() {
    if (this.#flushing !== null) return this.#flushing;

    this.#flushing = (async () => {
      if (this.#adapter === null) await this.init();
      while (this.#pending.size > 0) {
        const [key, value] = this.#pending.entries().next().value;
        this.#pending.delete(key);
        try {
          await this.#adapter.set(key, value);
        } catch (error) {
          for (const listener of this.#errorListeners) {
            listener({ key, error });
          }
          console.warn(`[save] 写入 ${key} 失败：${String(error)}`);
        }
      }
    })();

    try {
      await this.#flushing;
    } finally {
      this.#flushing = null;
    }
  }
}
