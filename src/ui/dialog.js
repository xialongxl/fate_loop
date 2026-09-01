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

  /**
   * 把第一个 h2 包成一条头部（eyebrow + 标题 + 右上 ✕ + 分隔线）。
   *
   * 为什么在 dialog.js 里做而不是改各对话框的标记：对话框有十几个，逐个改会漏；
   * 而“对话框长什么样”应该只有一个地方说了算。
   * 幂等：商店这类会重绘 innerHTML 的对话框要反复调它，不能注出两个 ✕。
   *
   * ✕ 用 `data-dialog-close` 而不是 `data-action="close"`：后者是对话框内容自己的
   * 动作钮（“离开”“取消”），两者语义不同；而且 ✕ 靠**容器代理**接，
   * 否则重绘一次监听就没了。
   */
  function decorateHeader(box, { eyebrow = null } = {}) {
    if (box === null || box === undefined) return box;
    const heading = box.querySelector('h2');
    if (heading === null) return box;
    let header = box.querySelector('.dialog-header');
    if (header === null) {
      header = document.createElement('div');
      header.className = 'dialog-header';
      box.insertBefore(header, heading);
      header.append(heading);
    }
    heading.classList.add('dialog-title');

    if (eyebrow !== null && header.querySelector('.dialog-eyebrow') === null) {
      const tag = document.createElement('p');
      tag.className = 'dialog-eyebrow';
      tag.textContent = eyebrow;
      header.insertBefore(tag, heading);
    } else if (eyebrow === null) {
      header.querySelector('.dialog-eyebrow')?.remove();
    }

    if (header.querySelector('[data-dialog-close]') === null) {
      const closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'dialog-close';
      closeBtn.setAttribute('data-dialog-close', '');
      closeBtn.setAttribute('aria-label', '关闭');
      closeBtn.title = '关闭（Esc）';
      closeBtn.textContent = '×';
      header.append(closeBtn);
    }
    return box;
  }

  function open(html, { onClose = null, closeOnBackdrop: backdrop = true, wide = false, xwide = false, escapable: esc = true, eyebrow = null } = {}) {
    onCloseHook = onClose;
    closeOnBackdrop = backdrop;
    escapable = esc;
    previousFocus = document.activeElement;
    container.hidden = false;
    // xwide 只给“看源码”这类需要横向空间的内容；商店/熔炼编辑器用 wide（720px）
    container.innerHTML = `<div class="dialog-box ${xwide ? 'is-xwide' : wide ? 'is-wide' : ''}" role="dialog" aria-modal="true"></div>`;
    const box = container.querySelector('.dialog-box');
    box.innerHTML = html;

    /**
     * 焦点目标在注头部**之前**算：否则初始焦点会被右上角的 ✕ 抢走，
     * 现有对话框“打开就落在主操作/输入框”的行为会静默变样（也有测试绑着它）。
     */
    const focusTarget = box.querySelector('[data-autofocus], [data-action="close"], button, input, select');
    decorateHeader(box, { eyebrow });

    const closeBtn = box.querySelector('[data-action="close"]');
    closeBtn?.addEventListener('click', () => close());

    focusTarget?.focus?.();
    // 重绘型对话框（商店）每次写完 innerHTML 都要再注一次头部
    box.decorateHeader = (options) => decorateHeader(box, options);
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
    // ✕ 走代理：商店这类对话框会重绘 innerHTML，在 open() 里一次性绑的监听会丢
    if (event.target?.closest?.('[data-dialog-close]')) {
      close();
      return;
    }
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
 * 内容指纹要显示出来：晒成绩的人必须能说清"这是哪个内容池打出来的"。
   *
   * 按钮走显式回调而不是 onClose：通关面板有两个出路（继续无尽 / 结束这局），
   * 而 onClose 在"任何方式关闭"时都会触发，会把玩家没选的那条也执行一遍。
   */
  function openSummary(snapshot, {
    outcome,
    contentHash = null,
    primaryLabel = '开始新的轮回',
    onPrimary = null,
    secondaryLabel = null,
    onSecondary = null,
  } = {}) {
    const won = outcome === 'victory';
    const m = snapshot.metadata;
    const player = snapshot.player;
    const sequence = player.gcdSequence.length === 0 ? '（空序列）' : player.gcdSequence.length;
    const endlessNote =
      won || snapshot.victoryAchieved !== true
        ? ''
        : '<p class="dialog-text">这一局先抵达了轮回尽头，之后是无尽段。</p>';

    const box = open(
      `
      <h2 tabindex="-1">${won ? '通关结算' : '探索结束'}</h2>
      <p class="dialog-text">${won ? '你走出了第 ' + snapshot.floorNumber + ' 层 —— 这一轮轮回到此为止。' : '序列编织者倒在了轮回里 —— 局内成长清零。'}</p>
      ${endlessNote}
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
        ${
          contentHash === null
            ? ''
            : `<div><dt>内容指纹</dt><dd><code>${escapeHtml(String(contentHash))}</code></dd></div>`
        }
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
        ${
          secondaryLabel === null
            ? ''
            : `<button type="button" data-sum="secondary" class="btn-ghost">${escapeHtml(secondaryLabel)}</button>`
        }
        <button type="button" data-sum="primary" class="btn-primary" data-autofocus>${escapeHtml(
          primaryLabel,
        )}</button>
      </div>
    `,
      { closeOnBackdrop: false, escapable: false },
    );

    box.querySelector('[data-sum="primary"]')?.addEventListener('click', () => {
      close();
      onPrimary?.();
    });
    box.querySelector('[data-sum="secondary"]')?.addEventListener('click', () => {
      close();
      onSecondary?.();
    });

    return box;
  }

  return { open, close, isOpen, openSummary, decorateHeader, element: container };
}

function fmt(value) {
  return Number(value ?? 0).toLocaleString('zh-CN');
}
