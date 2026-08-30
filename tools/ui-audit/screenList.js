/**
 * 体检要覆盖的界面清单——**单一来源**。
 *
 * 为什么要单独一个文件：Node 侧的 run.mjs 与浏览器侧的 harness.js 原先各写一份，
 * 加屏幕时只改一边就会"体检悄悄少量一屏"，而那正是这个工具存在的全部意义。
 * 本文件不含任何 DOM 调用，两边都能直接 import。
 */
export const AUDIT_SCREENS = Object.freeze([
  'menu',
  'map',
  'battle',
  'sequence',
  'equipment',
  'character',
  'saves',
  'settings',
  'codex',
  'history',
  'mods',
  'shop',
  'event',
  'victory',
]);
