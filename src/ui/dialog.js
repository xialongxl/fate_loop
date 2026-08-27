/**
 * 模态对话框（阶段 9 重写：背景点击关闭、ESC 关闭、焦点陷阱）。
 *
 * 三条硬约定，接线时依赖：
 *   1. `open()` 的选项名与调用方（format.js#createConfirm、main.js）必须一致。
 *      旧版这里叫 `backdrop`、调用方传 `closeOnBackdrop`，参数名错配导致
 *      点背景关闭弹窗却不 resolve Promise —— 见交接文档缺陷 P1-4(a)。
 *   2. 无论以何种方式关闭（按钮 / 背景 / ESC），`onClose` 回调都被调用一次。
 *      否则「等用户答复」的 Promise 会永久挂起。
 *   3. 打开时记录 `document.activeElement`，关闭时还回焦点；Tab 在弹窗内循环。
 *      键盘用户必须能退出模态，这是无障碍底线，不是增强项。
 */

import { escapeHtml } from './format.js';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function createDialog(container) {
  container.className = 'app-dialog';
  container.hidden = true;

  let onCloseHook = null;
  let closeOnBackdrop = true;
  let escapable = true;
  let previousFocus = null;

  function open(html, { onClose = null, closeOnBackdrop: backdrop = true, wide = false, escapable: esc = true } = {}) {
    onCloseHook = onClose;
    closeOnBackdrop = backdrop;
    escapable = esc;
    previousFocus = document.activeElement;
    container.hidden = false;
    container.innerHTML = `<div class="dialog-box ${wide ? 'is-wide' : ''}" role="dialog" aria-modal="true"></div>`;
    const box = container.querySelector('.dialog-box');
    box.innerHTML = html;

    const closeBtn = box.querySelector('[data-action="close"]');
    closeBtn?.addEventListener('click', () => close());

    // 焦点落到首个可交互元素，键盘用户不需要先 Tab 一圈
    const focusTarget = box.querySelector('[data-autofocus], [data-action="close"], button, input, select');
    focusTarget?.focus?.();
    return box;
  }

  function close() {
    if (container.hidden) return;
    container.hidden = true;
    container.innerHTML = '';
    const hook = onCloseHook;
    onCloseHook = null;
    // 先还焦点再回调：回调里常常要切屏，焦点顺序反了会跳回已隐藏的节点
    try {
      previousFocus?.focus?.();
    } catch {
      // 原焦点元素可能已被移除，忽略
    }
    previousFocus = null;
    hook?.();
  }

  function isOpen() {
    return !container.hidden;
  }

  container.addEventListener('click', (event) => {
    if (event.target !== container) return;
    if (!closeOnBackdrop) return;
    close();
  });

  // ESC 关闭 + Tab 焦点陷阱。监听挂在 container 上，只有模态内的焦点会命中。
  container.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (!escapable) return;
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== 'Tab') return;

    const box = container.querySelector('.dialog-box');
    // 不靠 offsetParent/getClientRects 筛“可见”：jsdom 下它们恒为空，
    // 真浏览器下又会漏掉 position:fixed 背板里的元素，两边都不对。
    // 弹窗内不该有 hidden 的可交互元素，有就是样式 bug。
    const items = [...(box?.querySelectorAll(FOCUSABLE) ?? [])];
    if (items.length === 0) return;

    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === box || !box.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !box.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  });

  /**
   * 结算面板（规格 11.1）。战斗失败或通关后弹出。
   * 快照里所有文本都经 escapeHtml —— 装备名与种子来自模组，不可信任。
   */
  function openSummary(snapshot, { outcome, onPrimary, primaryLabel = '开始新的轮回' } = {}) {
    const won = outcome === 'victory';
    const m = snapshot.metadata;
    const player = snapshot.player;
    const sequence = player.gcdSequence.length === 0 ? '（空序列）' : player.gcdSequence.length;

    const box = open(
      `
      <h2 tabindex="-1">${won ? '通关结算' : '探索结束'}</h2>
      <p class="dialog-text">${won ? '这一轮轮回走到了尽头。' : '序列编织者倒在了轮回里 —— 局内成长清零。'}</p>
      <dl class="summary-list">
        <div><dt>到达层数</dt><dd>第 ${snapshot.floorNumber} 层</dd></div>
        <div><dt>等级</dt><dd>Lv.${player.level}</dd></div>
        <div><dt>累计经验</dt><dd>${fmt(m.expEarned)}</dd></div>
        <div><dt>总逻辑耗时</dt><dd>${(snapshot.virtualTime / 1000).toFixed(2)} 秒</dd></div>
        <div><dt>总输出伤害</dt><dd>${fmt(m.totalDamage)}</dd></div>
        <div><dt>总治疗量</dt><dd>${fmt(m.totalHeal)}</dd></div>
        <div><dt>清理节点</dt><dd>${snapshot.clearedNodeIds.size} / ${m.nodesVisited} 已访问</dd></div>
        <div><dt>战斗胜利</dt><dd>${m.battlesWon} 场</dd></div>
        <div><dt>获得碎片</dt><dd>${fmt(m.shardsEarned)}</dd></div>
        <div><dt>拾获装备</dt><dd>${fmt(m.gearFound)} 件</dd></div>
        <div><dt>使用种子</dt><dd><code>${escapeHtml(String(snapshot.seed))}</code></dd></div>
        <div><dt>胜负</dt><dd>${won ? '通关' : '阵亡'}</dd></div>
      </dl>
      <h3>技能序列摘要</h3>
      <p class="summary-seq">${typeof sequence === 'number' ? `${sequence} 个 GCD 技能` : escapeHtml(String(sequence))}</p>
      <p class="summary-seq">oGCD：${
        player.ogcdSlots.length === 0
          ? '（未配置）'
          : escapeHtml(player.ogcdSlots.map((s) => s.skillId).join('、'))
      }</p>
      <div class="dialog-actions">
        <button type="button" data-action="close" class="btn-primary" data-autofocus>${escapeHtml(
          primaryLabel,
        )}</button>
      </div>
    `,
      { closeOnBackdrop: false, escapable: false, onClose: onPrimary ?? null },
    );

    return box;
  }

  return { open, close, isOpen, openSummary, element: container };
}

function fmt(value) {
  return Number(value ?? 0).toLocaleString('zh-CN');
}
