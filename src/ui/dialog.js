/** 模态对话框（阶段 9 重写：支持背景点击关闭、ESC 关闭、焦点陷阱）。 */

export function createDialog(container) {
  container.className = 'app-dialog';
  container.hidden = true;

  let onCloseHook = null;
  let closeOnBackdrop = true;

  function open(html, { onClose = null, backdrop = true, wide = false } = {}) {
    onCloseHook = onClose;
    closeOnBackdrop = backdrop;
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

  return { open, close, isOpen, element: container };
}
