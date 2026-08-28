/**
 * 历史战绩（阶段 9 补齐：与 codex 一样，导航条与主菜单早已引用 SCREEN.HISTORY，
 * 但文件此前不存在 —— 交接文档 P0-1）。
 *
 * 数据源是 SaveService 的 history 存储（GameFlow 在永久死亡时写入，保留 50 条）。
 *
 * 通关（P1-6）：第 50 层使用出口即写入 outcome:'victory' 记录；通关后选
 * 「继续挑战无尽」再死的，outcome 是 'death' 但带 victoryAchieved 标记，
 * 卡片上标成「通关后 · 无尽」，不冒充第二次通关。
 */

import { escapeHtml, formatNumber, formatTimestamp } from '../format.js';

const OUTCOME_LABELS = Object.freeze({
  victory: { text: '通关', cls: 'is-win' },
  death: { text: '阵亡', cls: 'is-death' },
});

const FILTERS = [
  { id: 'all', label: '全部' },
  { id: 'death', label: '阵亡' },
  { id: 'victory', label: '通关' },
];

export function createHistoryScreen({ listHistory, getSnapshot, onOpenCodex, onBack }) {
  const element = document.createElement('section');
  element.className = 'screen-history';
  element.innerHTML = `
    <header class="screen-head">
      <h2 tabindex="-1">历史战绩</h2>
      <div class="screen-head-actions">
        <button type="button" class="btn-ghost" data-act="codex">图鉴</button>
        <button type="button" class="btn-ghost" data-act="back">← 返回</button>
      </div>
    </header>
    <p class="screen-hint">
      每局从 1 级重开，死亡即清零。这里记录的是历次轮回的终点 —— 想复现某局，
      抄下它的种子即可。
    </p>
    <dl class="history-summary" data-slot="summary"></dl>
    <div class="filter-row" data-slot="filters"></div>
    <ul class="history-list" data-slot="list"></ul>
  `;

  const slots = {
    summary: element.querySelector('[data-slot="summary"]'),
    filters: element.querySelector('[data-slot="filters"]'),
    list: element.querySelector('[data-slot="list"]'),
  };

  let entries = [];
  let filter = 'all';
  let loading = true;
  let loadError = null;

  function stats(rows) {
    if (rows.length === 0) return null;
    const deepest = rows.reduce((max, r) => Math.max(max, r.floorReached ?? 0), 0);
    const sum = (key) => rows.reduce((total, r) => total + (r[key] ?? 0), 0);
    return {
      runs: rows.length,
      deepest,
      avgFloor: sum('floorReached') / rows.length,
      battlesWon: sum('battlesWon'),
      victories: rows.filter((r) => r.outcome === 'victory').length,
    };
  }

  function renderSummary() {
    const stat = stats(entries);
    const current = getSnapshot?.();
    const liveNote =
      current !== undefined && current !== null && current.status !== 'idle'
        ? `<div><dt>当前轮回</dt><dd>第 ${current.floorNumber} 层 · Lv.${current.player.level}</dd></div>`
        : '';
    if (stat === null) {
      slots.summary.innerHTML = liveNote || '<div><dt>战绩</dt><dd>尚无记录</dd></div>';
      return;
    }
    slots.summary.innerHTML = `
      ${liveNote}
      <div><dt>记录局数</dt><dd>${stat.runs}</dd></div>
      <div><dt>最深</dt><dd>第 ${stat.deepest} 层</dd></div>
      <div><dt>平均深度</dt><dd>${stat.avgFloor.toFixed(1)} 层</dd></div>
      <div><dt>累计胜场</dt><dd>${formatNumber(stat.battlesWon)}</dd></div>
      <div><dt>通关</dt><dd>${stat.victories === 0 ? '尚无' : stat.victories}</dd></div>
    `;
  }

  function renderFilters() {
    slots.filters.innerHTML = FILTERS.map(
      (f) =>
        `<button type="button" class="filter-btn ${f.id === filter ? 'is-active' : ''}"
                 data-filter="${f.id}">${f.label}</button>`,
    ).join('');
  }

  function entryCard(entry) {
    const outcome = OUTCOME_LABELS[entry.outcome] ?? { text: entry.outcome ?? '未知', cls: '' };
    const endlessTag =
      entry.outcome !== 'victory' && entry.victoryAchieved === true
        ? '<span class="tag is-added">通关后 · 无尽</span>'
        : '';
    const sequence = (entry.gcdSequence ?? []).length;
    const ogcd = (entry.ogcdSlots ?? []).length;
    return `
      <li class="history-card ${outcome.cls}">
        <div class="history-head">
          <span class="history-outcome ${outcome.cls}">${escapeHtml(outcome.text)}</span>
          ${endlessTag}
          <strong>第 ${entry.floorReached ?? 0} 层</strong>
          <span class="history-when">${escapeHtml(formatTimestamp(entry.recordedAt))}</span>
        </div>
        <dl class="history-stats">
          <div><dt>等级</dt><dd>Lv.${entry.level ?? 1}</dd></div>
          <div><dt>胜场</dt><dd>${entry.battlesWon ?? 0}</dd></div>
          <div><dt>清理节点</dt><dd>${entry.nodesCleared ?? 0}</dd></div>
          <div><dt>总伤害</dt><dd>${formatNumber(entry.totalDamage)}</dd></div>
          <div><dt>总治疗</dt><dd>${formatNumber(entry.totalHeal)}</dd></div>
          <div><dt>碎片</dt><dd>${formatNumber(entry.shardsEarned)}</dd></div>
          <div><dt>装备</dt><dd>${entry.gearFound ?? 0} 件</dd></div>
          <div><dt>战斗耗时</dt><dd>${((entry.virtualTimeMs ?? 0) / 1000).toFixed(2)}s</dd></div>
        </dl>
        <p class="history-seq">${sequence} 个 GCD · ${ogcd} 个 oGCD</p>
        <p class="history-seed">
          种子 <code>${escapeHtml(String(entry.seed ?? '—'))}</code>
          ${
            entry.contentHash === undefined || entry.contentHash === null
              ? ''
              : ` · 内容 <code>${escapeHtml(String(entry.contentHash))}</code>`
          }
        </p>
      </li>`;
  }

  function renderList() {
    if (loading) {
      slots.list.innerHTML = '<li class="history-card is-loading">读取战绩…</li>';
      return;
    }
    if (loadError !== null) {
      slots.list.innerHTML = `<li class="history-card is-broken">读取失败：${escapeHtml(loadError)}</li>`;
      return;
    }
    const rows = entries.filter((entry) => filter === 'all' || entry.outcome === filter);
    slots.list.innerHTML =
      rows.length === 0
        ? '<li class="history-card is-empty">没有符合条件的记录</li>'
        : rows.map(entryCard).join('');
  }

  function render() {
    renderSummary();
    renderFilters();
    renderList();
  }

  async function refresh() {
    loading = true;
    loadError = null;
    render();
    try {
      entries = await listHistory();
    } catch (error) {
      loadError = String(error?.message ?? error);
      entries = [];
    } finally {
      loading = false;
    }
    render();
  }

  element.addEventListener('click', (event) => {
    if (event.target.closest?.('[data-act="back"]')) {
      onBack();
      return;
    }
    if (event.target.closest?.('[data-act="codex"]')) {
      onOpenCodex?.();
      return;
    }
    const btn = event.target.closest?.('[data-filter]');
    if (btn !== null && btn !== undefined) {
      filter = btn.getAttribute('data-filter');
      render();
    }
  });

  return {
    element,
    render,
    refresh,
    onEnter() {
      void refresh();
    },
  };
}
