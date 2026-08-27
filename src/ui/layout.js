/**
 * 两栏布局骨架（规格 10.1）。
 * 左侧地图 55%，右侧面板 45%。
 */

export function buildLayout(root) {
  root.innerHTML = '';
  root.classList.add('app-root');

  const header = document.createElement('header');
  header.className = 'app-header';
  header.innerHTML = `
    <h1 class="app-title">命运轮回 <span class="app-subtitle">FATE LOOP</span></h1>
    <div class="header-stats" role="status" aria-live="polite">
      <span data-field="floor">第 1 层</span>
      <span data-field="shards">碎片 0</span>
      <span data-field="status">待开始</span>
      <span data-field="storage" class="storage-note"></span>
    </div>
  `;

  const main = document.createElement('main');
  main.className = 'app-main';

  const mapPane = document.createElement('section');
  mapPane.className = 'pane pane-map';
  mapPane.setAttribute('aria-label', '节点地图');
  mapPane.innerHTML = `
    <div class="map-toolbar">
      <button type="button" data-action="reset-view">复位视图</button>
      <span class="map-hint">滚轮缩放 · 拖拽平移 · 双击复位 · 点击相邻节点移动</span>
    </div>
    <div class="map-canvas" data-slot="map"></div>
    <div class="map-mask" data-slot="mask" hidden aria-hidden="true">战斗进行中</div>
  `;

  const sidePane = document.createElement('section');
  sidePane.className = 'pane pane-side';
  sidePane.innerHTML = `
    <div data-slot="seed"></div>
    <div data-slot="node"></div>
    <div data-slot="sequence"></div>
    <div data-slot="battle"></div>
    <div data-slot="log"></div>
  `;

  main.append(mapPane, sidePane);

  const dialog = document.createElement('div');
  dialog.className = 'app-dialog';
  dialog.setAttribute('data-slot', 'dialog');
  dialog.hidden = true;

  root.append(header, main, dialog);

  return {
    header,
    slots: {
      map: mapPane.querySelector('[data-slot="map"]'),
      mask: mapPane.querySelector('[data-slot="mask"]'),
      resetView: mapPane.querySelector('[data-action="reset-view"]'),
      seed: sidePane.querySelector('[data-slot="seed"]'),
      node: sidePane.querySelector('[data-slot="node"]'),
      sequence: sidePane.querySelector('[data-slot="sequence"]'),
      battle: sidePane.querySelector('[data-slot="battle"]'),
      log: sidePane.querySelector('[data-slot="log"]'),
      dialog,
    },
    fields: {
      floor: header.querySelector('[data-field="floor"]'),
      shards: header.querySelector('[data-field="shards"]'),
      status: header.querySelector('[data-field="status"]'),
      storage: header.querySelector('[data-field="storage"]'),
    },
  };
}
