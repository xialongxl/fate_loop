/** 当前节点信息与节点操作（休息、商店、事件、下层）。 */

import { NODE_TYPE } from '../../core/constants.js';
import { NODE_VISUALS } from '../map/renderer.js';

export function createNodePanel(container, { getFlow, onAction }) {
  container.className = 'panel panel-node';

  function render(snapshot) {
    const node = snapshot.mapNodes.find((n) => n.id === snapshot.currentNodeId);
    if (node === undefined) {
      container.innerHTML = '<h2 class="panel-title">当前位置</h2><p>尚未进入地图。</p>';
      return;
    }

    const visual = NODE_VISUALS[node.type] ?? { icon: '?', label: '未知' };
    const atExit = node.id === snapshot.exitNodeId;
    let actions = '';

    if (node.type === NODE_TYPE.REST && !node.isCleared) {
      actions = '<button type="button" data-action="rest" class="btn-primary">休息（恢复 30% 生命）</button>';
    } else if (node.type === NODE_TYPE.SHOP) {
      actions = '<button type="button" data-action="shop" class="btn-primary">查看商店</button>';
    } else if (node.type === NODE_TYPE.EVENT && !node.isCleared) {
      actions = '<button type="button" data-action="event" class="btn-primary">查看事件</button>';
    }

    if (atExit) {
      actions += '<button type="button" data-action="descend" class="btn-primary">进入下一层</button>';
    }

    container.innerHTML = `
      <h2 class="panel-title">当前位置</h2>
      <p class="node-headline">
        <span class="node-badge">${visual.icon}</span>
        <strong>${node.displayName}</strong>
        <span class="node-type">${visual.label}</span>
        ${node.isCleared ? '<span class="node-cleared">已清理</span>' : ''}
      </p>
      <dl class="node-stats">
        <div><dt>攻击</dt><dd>${snapshot.player.attack}</dd></div>
        <div><dt>防御</dt><dd>${snapshot.player.defense}</dd></div>
        <div><dt>生命</dt><dd>${snapshot.player.hp} / ${snapshot.player.maxHp}</dd></div>
        <div><dt>已清理</dt><dd>${snapshot.clearedNodeIds.size} 个节点</dd></div>
      </dl>
      <div class="node-actions">${actions}</div>
    `;
  }

  container.addEventListener('click', (event) => {
    const action = event.target.getAttribute?.('data-action');
    if (action !== null && action !== undefined) onAction(action);
  });

  return { render, getFlow };
}
