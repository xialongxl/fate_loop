/**
 * 浏览器入口。
 *
 * 只做两件事：装配应用、装配失败时把错误摊在屏幕上。
 * 装配逻辑全部在 main.js（导出 createApp 工厂，以便在 jsdom 冒烟测试里整局驱动）。
 *
 * 为什么不做静默降级：本作的所有崩溃都源于内容或状态不一致，留一块空白页面
 * 只会让玩家以为「游戏没做」。错误屏带上 code 与 stack，抄回来就能定位。
 */

import { createApp } from './main.js';

createApp().catch((error) => {
  console.error('[fate-loop] 启动失败', error);
  const root = document.querySelector('#app');
  if (root === null) return;
  root.innerHTML = '';

  const box = document.createElement('pre');
  box.className = 'boot-error';
  box.textContent = [
    '命运轮回启动失败',
    '',
    `${String(error?.message ?? error)}`,
    error?.code ? `错误码：${String(error.code)}` : '',
    '',
    String(error?.stack ?? ''),
  ]
    .filter(Boolean)
    .join('\n');
  root.append(box);
});
