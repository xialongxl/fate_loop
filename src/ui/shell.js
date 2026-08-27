/**
 * 应用外壳与屏幕宿主（阶段 9）。
 *
 * 从单页两栏改为多屏架构。设计取舍：
 *   - 所有屏幕的 DOM 常驻，用 hidden 切换而非销毁重建。理由是地图 SVG 的
 *     视图状态（缩放/平移）与滚动位置都挂在 DOM 上，销毁重建会丢失。
 *   - 只有「当前屏」会收到 render()，其余屏跳过 —— 90 个技能 + 60 格背包
 *     全量重绘不便宜，切屏时才重绘。
 *   - 顶部导航只在「局内」屏幕显示；主菜单/存档/设置属于局外，无导航条。
 */

import { SCREEN } from '../core/constants.js';

/** 局内导航条的按钮定义。顺序即 Tab 顺序。 */
const IN_RUN_NAV = Object.freeze([
  { screen: SCREEN.MAP, icon: '⌗', label: '地图' },
  { screen: SCREEN.SEQUENCE, icon: '⌘', label: '技能轴' },
  { screen: SCREEN.EQUIPMENT, icon: '◈', label: '装备' },
  { screen: SCREEN.CHARACTER, icon: '☰', label: '角色' },
  { screen: SCREEN.CODEX, icon: '❖', label: '图鉴' },
  { screen: SCREEN.HISTORY, icon: '⏱', label: '战绩' },
]);

/** 需要显示局内导航条的屏幕。 */
export const IN_RUN_SCREENS = new Set(IN_RUN_NAV.map((n) => n.screen));

export function buildShell(root) {
  root.innerHTML = '';
  root.className = 'app-shell';

  const header = document.createElement('header');
  header.className = 'app-header';
  header.innerHTML = `
    <div class="brand">
      <span class="brand-mark" aria-hidden="true">◍</span>
      <div class="brand-text">
        <span class="brand-kicker">FATE LOOP</span>
        <strong class="brand-title">命运轮回</strong>
      </div>
    </div>
    <div class="header-stats" role="status" aria-live="polite">
      <span class="stat-chip" data-field="level">Lv.1</span>
      <span class="stat-chip" data-field="hp">— / —</span>
      <span class="stat-chip" data-field="floor">第 1 层</span>
      <span class="stat-chip" data-field="shards">碎片 0</span>
      <span class="stat-chip" data-field="status">待开始</span>
    </div>
    <div class="header-actions">
      <span class="storage-note" data-field="storage"></span>
      <button type="button" class="header-btn" data-action="settings" title="设置">⚙</button>
      <button type="button" class="header-btn" data-action="menu" title="返回主菜单">⌂</button>
    </div>
  `;

  const nav = document.createElement('nav');
  nav.className = 'app-nav';
  nav.setAttribute('aria-label', '局内界面导航');
  nav.innerHTML = IN_RUN_NAV.map(
    (item) => `
    <button type="button" class="nav-btn" data-nav="${item.screen}" aria-pressed="false">
      <span class="nav-icon" aria-hidden="true">${item.icon}</span>
      <span class="nav-label">${item.label}</span>
    </button>`,
  ).join('');

  const host = document.createElement('div');
  host.className = 'screen-host';

  const dialog = document.createElement('div');
  dialog.className = 'app-dialog';
  dialog.setAttribute('data-slot', 'dialog');
  dialog.hidden = true;

  const toast = document.createElement('div');
  toast.className = 'app-toast';
  toast.setAttribute('role', 'status');
  toast.setAttribute('aria-live', 'polite');
  toast.hidden = true;

  root.append(header, nav, host, dialog, toast);

  return {
    root,
    header,
    nav,
    host,
    dialog,
    toast,
    fields: {
      level: header.querySelector('[data-field="level"]'),
      hp: header.querySelector('[data-field="hp"]'),
      floor: header.querySelector('[data-field="floor"]'),
      shards: header.querySelector('[data-field="shards"]'),
      status: header.querySelector('[data-field="status"]'),
      storage: header.querySelector('[data-field="storage"]'),
    },
    buttons: {
      settings: header.querySelector('[data-action="settings"]'),
      menu: header.querySelector('[data-action="menu"]'),
    },
  };
}

export { IN_RUN_NAV };
