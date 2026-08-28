/**
 * SVG 地图渲染（规格 6.5、10.2）。
 *
 * 纯文字游戏的地图用 SVG 而非 Canvas：矢量缩放无损、节点天然可点击可聚焦，
 * 且能直接挂 ARIA 属性满足无障碍要求。
 */

import { NODE_TYPE, ZOOM_MAX } from '../../core/constants.js';

const CELL = 64;
const RADIUS = 20;
const PADDING = 40;

/** 节点类型 → 图标与可读标签。 */
export const NODE_VISUALS = Object.freeze({
  [NODE_TYPE.START]: { icon: '⌂', label: '起点', cls: 'n-start' },
  [NODE_TYPE.COMBAT]: { icon: '⚔', label: '战斗', cls: 'n-combat' },
  [NODE_TYPE.ELITE]: { icon: '☠', label: '精英', cls: 'n-elite' },
  [NODE_TYPE.REST]: { icon: '✚', label: '休息', cls: 'n-rest' },
  [NODE_TYPE.SHOP]: { icon: '$', label: '商店', cls: 'n-shop' },
  [NODE_TYPE.EVENT]: { icon: '?', label: '事件', cls: 'n-event' },
  [NODE_TYPE.EMPTY]: { icon: '·', label: '空地', cls: 'n-empty' },
  [NODE_TYPE.EXIT]: { icon: '▼', label: '出口', cls: 'n-exit' },
  [NODE_TYPE.DEAD_END]: { icon: '×', label: '死路', cls: 'n-dead' },
});

const SVG_NS = 'http://www.w3.org/2000/svg';

function el(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    node.setAttribute(key, String(value));
  }
  return node;
}

export class MapRenderer {
  #svg;
  #viewport;
  #edgeLayer;
  #nodeLayer;

  constructor(container) {
    this.#svg = el('svg', {
      class: 'map-svg',
      role: 'application',
      'aria-label': '节点地图，使用 Tab 聚焦节点，回车移动',
    });
    this.#viewport = el('g', { class: 'map-viewport' });
    this.#edgeLayer = el('g', { class: 'map-edges' });
    this.#nodeLayer = el('g', { class: 'map-nodes' });

    this.#viewport.append(this.#edgeLayer, this.#nodeLayer);
    this.#svg.append(this.#viewport);
    container.append(this.#svg);
  }

  get svg() {
    return this.#svg;
  }

  /** 应用视图变换（缩放平移）。 */
  applyView(view) {
    this.#viewport.setAttribute(
      'transform',
      `translate(${view.offsetX} ${view.offsetY}) scale(${view.zoom})`,
    );
  }

  /**
   * 算出把视野对准「已揭示区域」的变换参数。
   *
   * 为什么需要：viewBox 是整层世界（例如 8×11 → 592×784，纵向），而画布通常是
   * 横向的。开局只揭示三五个节点时，meet 缩放会把整个世界塞进画布，那几个点就
   * 变成漂在虚空里的芝麻。对准已揭示区放大后，开局画面是"我在这儿，周围未知"。
   *
   * 只动视图状态（裁决 5：不入存档、不进快照），因此不影响确定性。
   * @returns {{zoom:number, offsetX:number, offsetY:number}|null}
   */
  fitToRevealed(snapshot) {
    const revealed = (snapshot.mapNodes ?? []).filter((n) => n.isRevealed);
    if (revealed.length === 0) return null;

    const vbWidth = snapshot.gridWidth * CELL + PADDING * 2;
    const vbHeight = snapshot.gridHeight * CELL + PADDING * 2;
    const minX = PADDING + Math.min(...revealed.map((n) => n.gridX)) * CELL;
    const maxX = PADDING + (Math.max(...revealed.map((n) => n.gridX)) + 1) * CELL;
    const minY = PADDING + Math.min(...revealed.map((n) => n.gridY)) * CELL;
    const maxY = PADDING + (Math.max(...revealed.map((n) => n.gridY)) + 1) * CELL;

    // 留 25% 边距，别让节点贴着画布边缘；上限收一档避免单点时放大到糊
    const zoom = Math.min(
      ZOOM_MAX,
      Math.max(0.5, Math.min(vbWidth / (maxX - minX), vbHeight / (maxY - minY)) * 0.75),
    );
    return {
      zoom,
      offsetX: vbWidth / 2 - zoom * ((minX + maxX) / 2),
      offsetY: vbHeight / 2 - zoom * ((minY + maxY) / 2),
    };
  }

  /**
   * 全量重绘。节点数量在数十级别，全量重绘比 diff 更简单且足够快。
   * @param {object} snapshot 状态快照
   * @param {object} options
   */
  render(snapshot, { adjacentIds = new Set(), battling = false } = {}) {
    this.#edgeLayer.replaceChildren();
    this.#nodeLayer.replaceChildren();

    const { mapNodes, mapAdjacency, currentNodeId, gridWidth, gridHeight } = snapshot;
    if (mapNodes.length === 0) return;

    const width = gridWidth * CELL + PADDING * 2;
    const height = gridHeight * CELL + PADDING * 2;
    this.#svg.setAttribute('viewBox', `0 0 ${width} ${height}`);

    const cx = (node) => PADDING + node.gridX * CELL + CELL / 2;
    const cy = (node) => PADDING + node.gridY * CELL + CELL / 2;
    const byId = new Map(mapNodes.map((n) => [n.id, n]));

    // 未揭示的节点画成雾点。不画的话开局整块画布是空的，
    // 玩家会以为地图没加载出来 —— 空白和"还没探索"是两种完全不同的观感。
    for (const node of mapNodes) {
      if (node.isRevealed) continue;
      this.#nodeLayer.append(
        el('circle', { class: 'map-fog', cx: cx(node), cy: cy(node), r: 4, 'aria-hidden': 'true' }),
      );
    }

    // 连线：只画一次（id 小的一端负责）
    for (const node of mapNodes) {
      if (!node.isRevealed) continue;
      for (const neighborId of mapAdjacency[node.id] ?? []) {
        if (node.id > neighborId) continue;
        const neighbor = byId.get(neighborId);
        if (neighbor === undefined || !neighbor.isRevealed) continue;
        this.#edgeLayer.append(
          el('line', {
            x1: cx(node),
            y1: cy(node),
            x2: cx(neighbor),
            y2: cy(neighbor),
            class: 'map-edge',
          }),
        );
      }
    }

    // 节点
    for (const node of mapNodes) {
      if (!node.isRevealed) continue;

      const visual = NODE_VISUALS[node.type] ?? { icon: '?', label: '未知', cls: '' };
      const isCurrent = node.id === currentNodeId;
      const isAdjacent = adjacentIds.has(node.id);
      const reachable = isAdjacent && !battling && node.type !== NODE_TYPE.DEAD_END;

      const group = el('g', {
        class: [
          'map-node',
          visual.cls,
          isCurrent ? 'is-current' : '',
          node.isCleared ? 'is-cleared' : '',
          reachable ? 'is-reachable' : '',
          battling ? 'is-locked' : '',
        ]
          .filter(Boolean)
          .join(' '),
        transform: `translate(${cx(node)} ${cy(node)})`,
        'data-node-id': node.id,
        role: 'button',
        tabindex: reachable ? '0' : '-1',
        'aria-label': `${node.displayName}，${visual.label}${node.isCleared ? '，已清理' : ''}${
          isCurrent ? '，当前位置' : ''
        }${reachable ? '，可移动' : ''}`,
        'aria-current': isCurrent ? 'true' : 'false',
        'aria-disabled': reachable ? 'false' : 'true',
      });

      group.append(el('circle', { r: RADIUS, class: 'node-body' }));

      const icon = el('text', {
        class: 'node-icon',
        'text-anchor': 'middle',
        'dominant-baseline': 'central',
        y: 1,
      });
      icon.textContent = visual.icon;
      group.append(icon);

      if (node.isCleared) {
        const check = el('text', {
          class: 'node-check',
          'text-anchor': 'middle',
          x: RADIUS - 2,
          y: -RADIUS + 6,
        });
        check.textContent = '✓';
        group.append(check);
      }

      const title = el('title');
      title.textContent = `${node.displayName}（${visual.label}）`;
      group.append(title);

      this.#nodeLayer.append(group);
    }
  }
}

export { CELL, PADDING, RADIUS };
