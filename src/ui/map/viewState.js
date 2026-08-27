/**
 * 地图视图状态（裁决 5）。
 * 独立于 #state：不入存档、不进快照哈希，因此缩放平移不影响确定性断言。
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
