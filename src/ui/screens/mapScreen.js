/**
 * 地图界面（阶段 9：从旧的两栏布局中抽出，成为独立屏幕）。
 *
 * 布局仍是左地图右侧栏，但侧栏只放「当前节点信息 + 操作 + 简短日志」——
 * 技能序列、装备、战斗都搬到了各自的独立屏幕。
 */

import { NODE_TYPE, VICTORY_FLOOR } from '../../core/constants.js';
import { MapRenderer, NODE_VISUALS } from '../map/renderer.js';
import { attachMapInteraction } from '../map/interaction.js';
import { createViewState, resetView } from '../map/viewState.js';
import { escapeHtml, formatNumber } from '../format.js';

export function createMapScreen({
  getSnapshot,
  onNodeActivate,
  onNodeAction,
  onSeedChange,
  getLogLimit = null,
}) {
  const element = document.createElement('section');
  element.className = 'screen-map';
  element.innerHTML = `
    <div class="map-pane">
      <div class="map-toolbar">
        <h2 class="pane-title" tabindex="-1">节点地图</h2>
        <div class="map-tools">
          <button type="button" data-act="reset-view" class="tool-btn">复位视图</button>
        </div>
      </div>
      <p class="map-legend" aria-label="图例">
        ${Object.values(NODE_VISUALS)
          .map((v) => `<span class="legend-item"><i class="${v.cls}">${v.icon}</i>${v.label}</span>`)
          .join('')}
      </p>
      <div class="map-canvas" data-slot="map"></div>
      <p class="map-hint">滚轮缩放 · 拖拽平移 · 双击复位 · 点击高亮节点移动 · Tab + 回车键盘操作</p>
    </div>

    <aside class="map-side">
      <div class="panel panel-node" data-slot="node"></div>
      <div class="panel panel-seed" data-slot="seed"></div>
      <div class="panel panel-log" data-slot="log"></div>
    </aside>
  `;

  const view = createViewState();
  const renderer = new MapRenderer(element.querySelector('[data-slot="map"]'));
  const nodeSlot = element.querySelector('[data-slot="node"]');
  const seedSlot = element.querySelector('[data-slot="seed"]');
  const logSlot = element.querySelector('[data-slot="log"]');

  seedSlot.innerHTML = `
    <h3 class="panel-title">种子</h3>
    <div class="seed-row">
      <label class="visually-hidden" for="seed-input">当前种子</label>
      <input id="seed-input" type="text" data-slot="seed-input" inputmode="numeric" />
      <button type="button" data-act="apply-seed" class="btn-ghost">重开此种子</button>
    </div>
    <p class="panel-note">同种子必得同地图、同遭遇、同战斗结果。可填数字或任意词语。</p>
  `;
  const seedInput = seedSlot.querySelector('[data-slot="seed-input"]');

  logSlot.innerHTML = `
    <h3 class="panel-title">近期动态</h3>
    <ol class="log-list" data-slot="log-list" aria-live="polite"></ol>
  `;
  const logList = logSlot.querySelector('[data-slot="log-list"]');

  attachMapInteraction({
    svg: renderer.svg,
    view,
    onViewChange: () => renderer.applyView(view),
    onNodeActivate,
  });

  element.addEventListener('click', (event) => {
    const act = event.target.getAttribute?.('data-act');
    if (act === 'reset-view') {
      resetView(view);
      renderer.applyView(view);
      return;
    }
    if (act === 'apply-seed') {
      onSeedChange(seedInput.value);
      return;
    }
    const action = event.target.getAttribute?.('data-action');
    if (action !== null && action !== undefined) onNodeAction(action);
  });

  seedInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') onSeedChange(seedInput.value);
  });

  function renderNodePanel(snapshot) {
    const node = snapshot.mapNodes.find((n) => n.id === snapshot.currentNodeId);
    if (node === undefined) {
      nodeSlot.innerHTML = '<h3 class="panel-title">当前位置</h3><p class="panel-note">尚未进入地图。</p>';
      return;
    }

    const visual = NODE_VISUALS[node.type] ?? { icon: '?', label: '未知' };
    const atExit = node.id === snapshot.exitNodeId;
    const buttons = [];

    if (node.type === NODE_TYPE.REST && !node.isCleared) {
      buttons.push('<button type="button" data-action="rest" class="btn-primary">休息（恢复 30% 生命）</button>');
    }
    if (node.type === NODE_TYPE.SHOP) {
      buttons.push('<button type="button" data-action="shop" class="btn-primary">进入商店</button>');
    }
    if (node.type === NODE_TYPE.EVENT && !node.isCleared) {
      buttons.push('<button type="button" data-action="event" class="btn-primary">查看事件</button>');
    }
    if ((node.type === NODE_TYPE.COMBAT || node.type === NODE_TYPE.ELITE) && !node.isCleared) {
      buttons.push('<button type="button" data-action="battle" class="btn-primary">进入战斗</button>');
    }
    if (atExit) {
      // 终点层的出口要说清楚这是通关，而不是"又一层"
      buttons.push(
        snapshot.floorNumber >= VICTORY_FLOOR && !snapshot.victoryAchieved
          ? `<button type="button" data-action="descend" class="btn-primary is-primary">踏入轮回尽头（第 ${VICTORY_FLOOR} 层通关）</button>`
          : '<button type="button" data-action="descend" class="btn-primary">前往下一层</button>',
      );
    }

    nodeSlot.innerHTML = `
      <h3 class="panel-title">当前位置</h3>
      <p class="node-headline">
        <span class="node-badge ${visual.cls}">${visual.icon}</span>
        <strong>${escapeHtml(node.displayName)}</strong>
        <span class="node-type">${visual.label}</span>
        ${node.isCleared ? '<span class="node-cleared">已清理</span>' : ''}
      </p>
      <dl class="mini-stats">
        <div><dt>攻击</dt><dd>${formatNumber(snapshot.player.attack)}</dd></div>
        <div><dt>防御</dt><dd>${formatNumber(snapshot.player.defense)}</dd></div>
        <div><dt>生命</dt><dd>${formatNumber(snapshot.player.hp)} / ${formatNumber(snapshot.player.maxHp)}</dd></div>
        <div><dt>已清理</dt><dd>${snapshot.clearedNodeIds.size} 节点</dd></div>
      </dl>
      <div class="node-actions">${buttons.join('') || '<p class="panel-note">此处无事可做，继续前进。</p>'}</div>
    `;
  }

  let lastLogKey = -1;

  function renderLog(snapshot) {
    // 地图界面的日志是概览，最多 12 条；玩家的 logLimit 更小时以它为准
    const limit = Math.min(12, Math.max(1, getLogLimit?.() ?? 12));
    const rows = snapshot.log.slice(-limit);
    // 键里带上 limit：只比长度的话，改设置后条数没变就永远不重绘
    const key = rows.length * 1000 + limit;
    if (key === lastLogKey) return;
    lastLogKey = key;
    logList.replaceChildren();
    for (const entry of rows) {
      const li = document.createElement('li');
      li.className = 'log-entry';
      const time = document.createElement('span');
      time.className = 'log-time';
      time.textContent = `${(entry.t / 1000).toFixed(2)}s`;
      const msg = document.createElement('span');
      msg.className = 'log-msg';
      msg.textContent = entry.message;
      li.append(time, msg);
      logList.append(li);
    }
    logList.scrollTop = logList.scrollHeight;
  }

  function render() {
    const snapshot = getSnapshot();
    const adjacentIds = new Set(snapshot.mapAdjacency[snapshot.currentNodeId] ?? []);
    renderer.render(snapshot, { adjacentIds, battling: false });
    renderer.applyView(view);
    if (document.activeElement !== seedInput) seedInput.value = String(snapshot.seed);
    renderNodePanel(snapshot);
    renderLog(snapshot);
  }

  return {
    element,
    render,
    /** 换层/换种子时复位视图。 */
    resetView() {
      resetView(view);
      renderer.applyView(view);
    },
    onEnter() {
      lastLogKey = -1;
    },
  };
}
