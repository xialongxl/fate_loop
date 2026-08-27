/**
 * 地图鼠标与键盘交互（规格 6.5、10.2）。
 *
 * 交互集合：点击节点移动、滚轮缩放、拖拽平移、双击复位。
 * 键盘可达性：节点是 role=button + tabindex，回车/空格等价于点击。
 */

import { clampZoom, resetView } from './viewState.js';

/**
 * @param {object} deps
 * @param {SVGElement} deps.svg
 * @param {object} deps.view viewState
 * @param {(nodeId:string)=>void} deps.onNodeActivate
 * @param {()=>void} deps.onViewChange
 */
export function attachMapInteraction({ svg, view, onNodeActivate, onViewChange }) {
  const cleanups = [];

  function on(target, type, handler, options) {
    target.addEventListener(type, handler, options);
    cleanups.push(() => target.removeEventListener(type, handler, options));
  }

  function nodeIdFromEvent(event) {
    const group = event.target.closest?.('[data-node-id]');
    return group?.getAttribute('data-node-id') ?? null;
  }

  // 点击节点
  on(svg, 'click', (event) => {
    const nodeId = nodeIdFromEvent(event);
    if (nodeId !== null) onNodeActivate(nodeId);
  });

  // 键盘激活
  on(svg, 'keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const nodeId = nodeIdFromEvent(event);
    if (nodeId === null) return;
    event.preventDefault();
    onNodeActivate(nodeId);
  });

  // 滚轮缩放
  on(
    svg,
    'wheel',
    (event) => {
      event.preventDefault();
      const factor = event.deltaY < 0 ? 1.1 : 1 / 1.1;
      view.zoom = clampZoom(view.zoom * factor);
      onViewChange();
    },
    { passive: false },
  );

  // 拖拽平移（仅在空白区域按下时开始，避免与节点点击冲突）
  on(svg, 'pointerdown', (event) => {
    if (nodeIdFromEvent(event) !== null) return;
    view.isDragging = true;
    view.dragStartX = event.clientX;
    view.dragStartY = event.clientY;
    view.dragOriginX = view.offsetX;
    view.dragOriginY = view.offsetY;
    svg.setPointerCapture?.(event.pointerId);
  });

  on(svg, 'pointermove', (event) => {
    if (!view.isDragging) return;
    view.offsetX = view.dragOriginX + (event.clientX - view.dragStartX);
    view.offsetY = view.dragOriginY + (event.clientY - view.dragStartY);
    onViewChange();
  });

  const endDrag = (event) => {
    if (!view.isDragging) return;
    view.isDragging = false;
    svg.releasePointerCapture?.(event.pointerId);
  };
  on(svg, 'pointerup', endDrag);
  on(svg, 'pointercancel', endDrag);

  // 双击空白复位
  on(svg, 'dblclick', (event) => {
    if (nodeIdFromEvent(event) !== null) return;
    resetView(view);
    onViewChange();
  });

  return () => {
    for (const cleanup of cleanups) cleanup();
  };
}
