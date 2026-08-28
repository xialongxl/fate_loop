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
import { migrateLocalToIndexedDb, pickAdapter } from './storageAdapter.js';

export class SaveService {
  #adapter = null;
  #degraded = false;
  #pending = new Map();
  #flushScheduled = false;
  #flushing = null;
  #errorListeners = new Set();

  async init() {
    const { adapter, degraded, attempts = [] } = await pickAdapter();
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

    return { kind: adapter.kind, degraded, attempts, migrated };
  }

  get degraded() {
    return this.#degraded;
  }

  get adapterKind() {
    return this.#adapter?.kind ?? 'none';
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

  /** 写入自动槽（每层开始、每次结算时由 GameFlow 调用）。 */
  saveRun(state) {
    return this.saveToSlot(AUTO_SAVE_SLOT, state);
  }

  /**
   * 写入指定槽位。同步入队，不返回 Promise —— core 层可安全调用。
   * savedAt 用物理时钟：它只用于存档列表排序，不进入任何确定性判定。
   */
  saveToSlot(slotId, state) {
    const record = {
      slotId,
      savedAt: Date.now(),
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
    return { savedAt: record.savedAt ?? null, run: deserializeRun(record.data ?? record) };
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
   * 清空全部本地数据：4 个槽位 + 历史战绩 + 设置。
   * 设置界面「清空全部数据」的后端。同时清空待写队列 —— 否则 flush 会把
   * 刚删掉的快照又写回去，玩家看到的是“删不干净”的存档。
   */
  async clearAll() {
    if (this.#adapter === null) await this.init();
    this.#pending.clear();
    this.#flushScheduled = false;
    for (const slotId of SAVE_SLOT_IDS) {
      await this.#adapter.delete(slotKey(slotId));
    }
    await this.#adapter.delete(HISTORY_KEY);
    await this.#adapter.delete(SETTINGS_KEY);
    await this.#adapter.delete(LEGACY_SAVE_KEY);
    return { ok: true };
  }

  /** 追加历史记录，保留最近 50 条。 */
  async appendHistory(state, { outcome }) {
    if (this.#adapter === null) await this.init();
    const existing = (await this.#adapter.get(HISTORY_KEY)) ?? [];
    const entry = { ...createHistoryEntry(state, { outcome }), recordedAt: Date.now() };
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
