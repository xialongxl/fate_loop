/**
 * 地图鼠标与键盘交互（规格 6.5、10.2）。
 *
 * 交互集合：点击节点移动、滚轮缩放、拖拽平移、双击复位。
 * 键盘可达性：节点是 role=button + tabindex，回车/空格等价于点击。
 */

import {
  centerAnchor,
  clientToUser,
  resetView,
  userScalePerPx,
  zoomAt,
} from './viewState.js';

/**
 * 滚轮缩放以光标为锚、拖拽换算坐标空间 —— 两条都是修“不对焦”的。
 * 拿不到 getScreenCTM（jsdom / 老浏览器）时退回视口中心锚点与像素直加，
 * 不假装换算成功。
 */
export function attachMapInteraction({ svg, view, onNodeActivate, onViewChange }) {
  const cleanups = [];

  function applyViewChange() {
    /**
     * 这里**故意不做钳制**。上一轮我加了 clampView，本意是“别把地图拖进虚空”，
     * 实测它反而把“对焦”打回了原形：世界（viewBox 592×784）比可见区
     * （916×543px → 1323×784 user）窄时，它每次都把 X 重新居中，
     * 算好的锚点补偿当场被抹平（探针量到漂移 4~28px）。
     * 而“不许拖出边界”不是用户报的问题，也不该以“对焦失效”为代价。
     * clampView 仍然导出（单测覆盖），将来要做“回弹”时再用，不在这条路上。
     */
    onViewChange();
  }

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

  // 滚轮缩放：锁住光标底下那个点（以前只改 zoom，缩放原点是 viewBox 左上角，
  // 于是一放大整张图就朝左上挤，光标底下的节点跑掉）
  on(
    svg,
    'wheel',
    (event) => {
      event.preventDefault();
      const factor = event.deltaY < 0 ? 1.1 : 1 / 1.1;
      const anchor = clientToUser(svg, event.clientX, event.clientY) ?? centerAnchor(svg);
      zoomAt(view, factor, anchor.x, anchor.y);
      applyViewChange();
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
    // 指针走的是 CSS 像素，offset 活在 user 单位：不换算的话 1 user ≈ 1.5px 时
    // 图会比手快 1.5 倍（窗口越窄差越多）。拿不到 CTM 才退回直加。
    const scale = userScalePerPx(svg) ?? { sx: 1, sy: 1 };
    view.offsetX = view.dragOriginX + (event.clientX - view.dragStartX) * scale.sx;
    view.offsetY = view.dragOriginY + (event.clientY - view.dragStartY) * scale.sy;
    applyViewChange();
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
    applyViewChange();
  });

  return () => {
    for (const cleanup of cleanups) cleanup();
  };
}
