/**
 * 存档界面（阶段 9）。
 *
 * 槽位模型参考 Fate_echo：3 个手动槽 + 1 个自动槽，自动槽只读不可手写。
 * 已通关的存档（victoryAchieved）会打「已通关」标签：那是一局走完 50 层后
 * 继续无尽时存下来的，与普通中途档值得区分。
 *
 * 与 Fate_echo 的差异：本作显示种子，因为种子是复现整局的完整凭据 ——
 * 玩家可以抄下种子在别处重现同一局，这是确定性内核的直接卖点。
 */

import { escapeHtml, formatNumber, formatTimestamp } from '../format.js';
import { slotLabel } from '../../persistence/schema.js';
import { levelFromTotalExp } from '../../core/progression.js';

export function createSavesScreen({
  onLoad,
  onSave,
  onDelete,
  onBack,
  listSlots,
  canSave,
  getCurrentHash = null,
  onExport = null,
  onExportAll = null,
  onImportFile = null,
}) {
  const element = document.createElement('section');
  element.className = 'screen-saves';
  element.innerHTML = `
    <header class="screen-head">
      <h2 tabindex="-1">存档管理</h2>
      <button type="button" class="btn-ghost" data-act="back">← 返回</button>
    </header>
    <div class="transfer-bar">
      <label class="visually-hidden" for="save-import-file">选择存档文件</label>
      <input id="save-import-file" type="file" accept="application/json,.json" data-slot="import-file" hidden />
      <button type="button" class="btn-ghost" data-act="import">导入存档文件…</button>
      <button type="button" class="btn-ghost" data-act="export-all">导出全部</button>
    </div>
    <p class="screen-hint">
      自动存档在每层开始与每场战斗结算后写入，不可手动覆盖。
      手动槽需要局内才能保存。复现一整局需要 <strong>种子 + 内容指纹</strong>
      两者：种子决定随机数流，指纹决定当时的官方内容版本。
    </p>
    <ul class="slot-list" data-slot="list"></ul>
  `;

  const list = element.querySelector('[data-slot="list"]');

  function slotCard(slot) {
    const label = slotLabel(slot.slotId);
    const saveable = !slot.auto && canSave();

    if (slot.empty === true) {
      return `
        <li class="slot-card is-empty">
          <div class="slot-main">
            <h3 class="slot-title">${escapeHtml(label)}${slot.auto ? '<span class="slot-tag">自动</span>' : ''}</h3>
            <p class="slot-meta">空槽位</p>
          </div>
          <div class="slot-actions">
            ${saveable ? `<button type="button" data-save="${slot.slotId}" class="btn-primary">保存到此</button>` : ''}
          </div>
        </li>`;
    }

    if (slot.incompatible === true) {
      return `
        <li class="slot-card is-broken">
          <div class="slot-main">
            <h3 class="slot-title">${escapeHtml(label)}</h3>
            <p class="slot-meta">存档版本 v${escapeHtml(slot.schemaVersion)} 与当前引擎不兼容，无法读取</p>
          </div>
          <div class="slot-actions">
            <button type="button" data-delete="${slot.slotId}" class="btn-danger">删除</button>
          </div>
        </li>`;
    }

    const level = levelFromTotalExp(slot.exp ?? 0);
    // 内容指纹不符：读档会被 sanitizeSequence 洗技能，先在这里说清楚
    const currentHash = getCurrentHash?.() ?? null;
    const foreign =
      currentHash !== null &&
      typeof slot.contentHash === 'string' &&
      slot.contentHash !== currentHash;
    return `
      <li class="slot-card">
        <div class="slot-main">
          <h3 class="slot-title">
            ${escapeHtml(label)}${slot.auto ? '<span class="slot-tag">自动</span>' : ''}
            ${slot.victoryAchieved === true ? '<span class="slot-tag is-win">已通关</span>' : ''}
          </h3>
          <p class="slot-meta">${escapeHtml(formatTimestamp(slot.savedAt))}</p>
          <dl class="slot-stats">
            <div><dt>层数</dt><dd>第 ${slot.floorNumber} 层</dd></div>
            <div><dt>等级</dt><dd>Lv.${level}</dd></div>
            <div><dt>碎片</dt><dd>${formatNumber(slot.fateShards)}</dd></div>
            <div><dt>已清理</dt><dd>${slot.nodesCleared} 节点</dd></div>
            <div><dt>胜场</dt><dd>${slot.battlesWon}</dd></div>
            <div><dt>装备</dt><dd>${slot.equippedCount} / 8</dd></div>
          </dl>
          <p class="slot-seed">
            种子 <code>${escapeHtml(slot.seed)}</code>
            ${
              slot.contentHash
                ? ` · 内容 <code>${escapeHtml(String(slot.contentHash))}</code>`
                : ''
            }
            ${foreign ? '<span class="slot-tag is-warn">与当前内容集不符</span>' : ''}
          </p>
        </div>
        <div class="slot-actions">
          <button type="button" data-load="${slot.slotId}" class="btn-primary">读取</button>
          ${onExport === null ? '' : `<button type="button" data-export="${slot.slotId}" class="btn-ghost">导出</button>`}
          ${saveable ? `<button type="button" data-save="${slot.slotId}" class="btn-ghost">覆盖</button>` : ''}
          <button type="button" data-delete="${slot.slotId}" class="btn-danger">删除</button>
        </div>
      </li>`;
  }

  async function refresh() {
    list.innerHTML = '<li class="slot-card is-loading">读取存档列表…</li>';
    let slots = [];
    try {
      slots = await listSlots();
    } catch (error) {
      list.innerHTML = `<li class="slot-card is-broken">存档列表读取失败：${escapeHtml(
        error?.message ?? error,
      )}</li>`;
      return;
    }
    list.innerHTML = slots.map(slotCard).join('');
  }

  const importInput = element.querySelector('[data-slot="import-file"]');
  importInput?.addEventListener('change', () => {
    const file = importInput.files?.[0];
    if (file !== undefined && file !== null) void onImportFile?.(file);
    importInput.value = '';
  });

  element.addEventListener('click', (event) => {
    const target = event.target;
    if (target.getAttribute?.('data-act') === 'back') {
      onBack();
      return;
    }
    if (target.getAttribute?.('data-act') === 'import') {
      importInput?.click();
      return;
    }
    if (target.getAttribute?.('data-act') === 'export-all') {
      void onExportAll?.();
      return;
    }
    const exportId = target.getAttribute?.('data-export');
    if (exportId !== null && exportId !== undefined) {
      void onExport?.(exportId);
      return;
    }
    const loadId = target.getAttribute?.('data-load');
    if (loadId !== null && loadId !== undefined) {
      void onLoad(loadId).then(refresh);
      return;
    }
    const saveId = target.getAttribute?.('data-save');
    if (saveId !== null && saveId !== undefined) {
      void Promise.resolve(onSave(saveId)).then(refresh);
      return;
    }
    const deleteId = target.getAttribute?.('data-delete');
    if (deleteId !== null && deleteId !== undefined) {
      void Promise.resolve(onDelete(deleteId)).then(refresh);
    }
  });

  return {
    element,
    onEnter() {
      void refresh();
    },
    refresh,
  };
}
