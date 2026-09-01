/**
 * 地图视图状态（裁决 5）。
 * 独立于 #state：不入存档、不进快照哈希，因此缩放平移不影响确定性断言。
 *
 * 坐标空间必须说清楚，否则一定会算错（这两个 bug 都真踩过）：
 *   - `offsetX/offsetY/zoom` 全在 **SVG user 单位**（viewBox 空间，例如 592×784）
 *   - 鼠标事件里的 `clientX/clientY` 与 `movementX` 在 **CSS 像素**
 *   两者相差一个 `getScreenCTM()` 的缩放比（窗口越窄差得越多）。
 *   变换是 `p → o + z·p`，所以缩放原点默认是 user 空间的 (0,0) ——
 *   **不补 offset 就等于"朝左上角缩放"**，光标底下那个节点会跑掉。
 */

import { ZOOM_MAX, ZOOM_MIN } from '../../core/constants.js';

export function createViewState() {
  return {
    offsetX: 0,
    offsetY: 0,
    zoom: 1.0,
    isDragging: false,
    dragStartX: 0,
    dragStartY: 0,
    dragOriginX: 0,
    dragOriginY: 0,
  };
}

export function clampZoom(zoom) {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom));
}

export function resetView(view) {
  view.offsetX = 0;
  view.offsetY = 0;
  view.zoom = 1.0;
  return view;
}

/**
 * 以某个 user 坐标点为锚做缩放 —— 缩放前后，锚点在屏幕上的位置**不变**。
 *
 * 推导：`screen = o + z·p`，要让锚点 a 不动 ⇒ `o' + z'·a = o + z·a`
 *      ⇒ `o' = a − (a − o)·(z'/z)`。
 * 锚点取视口中心时，它就是参考项目 area_map.js 里那两行 `tx = w/2 - (w/2 - tx)*ratio`
 * —— 我们把它推广成任意锚点，滚轮才能"对焦在光标下"。
 *
 * @param {object} view 会被就地修改（视图状态是可变的小对象，不进快照）
 * @param {number} factor 期望的缩放倍率（内部会先夹到 ZOOM_MIN..ZOOM_MAX）
 * @param {number} anchorX 锚点 user 坐标
 * @param {number} anchorY
 * @returns {object} view
 */
export function zoomAt(view, factor, anchorX, anchorY) {
  const old = view.zoom;
  const next = clampZoom(old * factor);
  const ratio = next / old;
  const ax = Number.isFinite(anchorX) ? anchorX : null;
  const ay = Number.isFinite(anchorY) ? anchorY : null;
  if (ax !== null) view.offsetX = ax - (ax - view.offsetX) * ratio;
  if (ay !== null) view.offsetY = ay - (ay - view.offsetY) * ratio;
  view.zoom = next;
  return view;
}

/**
 * 把视图夹回"不许拖进虚空"。
 *
 * 内容比视口小时**居中**（而不是允许留在角落）—— 一张比窗口还小的图被拖到
 * 边角上，看起来就像"地图丢了"。内容比视口大时，最多拖到边缘对齐。
 * @param {object} view
 * @param {number} contentWidth  viewBox 宽（user 单位）
 * @param {number} contentHeight viewBox 高
 */
export function clampView(view, contentWidth, contentHeight) {
  if (!Number.isFinite(contentWidth) || !Number.isFinite(contentHeight)) return view;
  const scaledW = contentWidth * view.zoom;
  const scaledH = contentHeight * view.zoom;
  view.offsetX =
    scaledW <= contentWidth
      ? (contentWidth - scaledW) / 2
      : Math.min(0, Math.max(contentWidth - scaledW, view.offsetX));
  view.offsetY =
    scaledH <= contentHeight
      ? (contentHeight - scaledH) / 2
      : Math.min(0, Math.max(contentHeight - scaledH, view.offsetY));
  return view;
}

/**
 * CSS 像素 → SVG user 坐标。
 *
 * 为什么不能直接拿 clientX 减个 rect.left：viewBox 会缩放/居中内容，
 * 像素与 user 单位之间是一个矩阵，只有 `getScreenCTM()` 知道它。
 * jsdom 与老浏览器上没有这个 API —— 返回 null 让调用方退回"视口中心"，
 * 而不是假装换算成功（那会算出一个看不见的锚点）。
 *
 * @param {SVGGraphicsElement} svg
 * @returns {{x:number,y:number}|null}
 */
export function clientToUser(svg, clientX, clientY) {
  const ctm = typeof svg?.getScreenCTM === 'function' ? svg.getScreenCTM() : null;
  if (ctm === null || ctm === undefined) return null;
  const inverse = typeof ctm.inverse === 'function' ? ctm.inverse() : null;
  if (inverse === null) return null;

  // 首选经典 SVG 点 API（浏览器都有）；再退到 window 上的 DOMPoint。
  // 两个都拿不到（jsdom 就是这种环境）→ null，让调用方退回视口中心。
  // 注意不能写 `new DOMPoint(...)` 裸名字：那是未声明全局，eslint 会报 no-undef。
  if (typeof svg.createSVGPoint === 'function') {
    const point = svg.createSVGPoint();
    if (point !== null && point !== undefined) {
      point.x = clientX;
      point.y = clientY;
      const mapped = point.matrixTransform(inverse);
      return { x: mapped.x, y: mapped.y };
    }
  }
  const DOMPointCtor = svg.ownerDocument?.defaultView?.DOMPoint;
  if (typeof DOMPointCtor === 'function') {
    const mapped = new DOMPointCtor(clientX, clientY).matrixTransform(inverse);
    return { x: mapped.x, y: mapped.y };
  }
  return null;
}

/**
 * 像素位移 → user 位移的比例。拖拽要把指针走的像素换算成同一空间，
 * 否则 1 user 单位 ≈ 1.5 CSS px 的时候，图会比手快 1.5 倍。
 * @returns {{sx:number, sy:number}|null} null = 拿不到 CTM，调用方退回像素值
 */
export function userScalePerPx(svg) {
  const ctm = typeof svg?.getScreenCTM === 'function' ? svg.getScreenCTM() : null;
  if (ctm === null || ctm === undefined) return null;
  if (!Number.isFinite(ctm.a) || ctm.a === 0 || !Number.isFinite(ctm.d) || ctm.d === 0) return null;
  return { sx: 1 / ctm.a, sy: 1 / ctm.d };
}

/** viewBox 的内容尺寸（拿不到时返回 null，clamp 会自动跳过）。 */
export function contentSize(svg) {
  const box = svg?.viewBox;
  const base = box && box.baseVal ? box.baseVal : null;
  if (base === null || base === undefined) return null;
  if (!Number.isFinite(base.width) || !Number.isFinite(base.height)) return null;
  if (base.width <= 0 || base.height <= 0) return null;
  return { width: base.width, height: base.height };
}

/** 视口中心（user 单位）—— 光标锚点不可用时的兜底锚点。 */
export function centerAnchor(svg) {
  const size = contentSize(svg);
  if (size === null) return { x: null, y: null };
  return { x: size.width / 2, y: size.height / 2 };
}
