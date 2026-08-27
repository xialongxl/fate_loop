/**
 * 通用 UI 小工具：转义、格式化、Toast、确认框。
 *
 * 转义是必需的：装备名、技能描述都来自模组，模组是第三方内容。
 * 虽然官方模组的文本可控，但 innerHTML 拼接第三方字符串是标准 XSS 面，
 * 一律走 escapeHtml。
 */

const ESCAPE_MAP = Object.freeze({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
});

/** HTML 实体转义。所有插入 innerHTML 的动态文本都必须经过它。 */
export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ESCAPE_MAP[ch]);
}

/** 千分位。 */
export function formatNumber(value) {
  return Number(value ?? 0).toLocaleString('zh-CN');
}

/** 毫秒 → 秒，两位小数。 */
export function formatSeconds(ms) {
  return `${((ms ?? 0) / 1000).toFixed(2)}s`;
}

/** 时间戳 → 本地日期时间。存档列表用。 */
export function formatTimestamp(ts) {
  if (!Number.isFinite(ts)) return '—';
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}`;
}

/** 百分比。 */
export function formatPercent(ratio, digits = 1) {
  return `${(Math.max(0, ratio ?? 0) * 100).toFixed(digits)}%`;
}

/**
 * Toast 提示。用于「碎片不足」「背包已满」这类轻量反馈。
 * 同一时刻只显示一条，新的直接覆盖 —— 排队显示会让快速连点变成烦人的队列。
 */
export function createToast(container) {
  let timer = null;

  function show(message, { kind = 'info', duration = 2200 } = {}) {
    container.hidden = false;
    container.className = `app-toast is-${kind}`;
    container.textContent = message;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      container.hidden = true;
      timer = null;
    }, duration);
  }

  return { show };
}

/**
 * 确认对话框。返回 Promise<boolean>。
 * 不用 window.confirm：它被 eslint 的 no-alert 禁止，且无法样式化。
 */
export function createConfirm(dialog) {
  return function confirm(message, { confirmLabel = '确认', cancelLabel = '取消' } = {}) {
    return new Promise((resolve) => {
      const box = dialog.open(
        `
        <h2>确认操作</h2>
        <p class="dialog-text">${escapeHtml(message)}</p>
        <div class="dialog-actions">
          <button type="button" data-confirm class="btn-primary">${escapeHtml(confirmLabel)}</button>
          <button type="button" data-cancel class="btn-ghost">${escapeHtml(cancelLabel)}</button>
        </div>
      `,
        { closeOnBackdrop: false },
      );

      const finish = (result) => {
        dialog.close();
        resolve(result);
      };
      box.querySelector('[data-confirm]').addEventListener('click', () => finish(true));
      box.querySelector('[data-cancel]').addEventListener('click', () => finish(false));
      box.querySelector('[data-confirm]').focus();
    });
  };
}

/** HP 条 HTML。战斗界面与角色界面共用。 */
export function hpBarHtml({ name, hp, maxHp, isPlayer = false, extra = '' }) {
  const ratio = maxHp === 0 ? 0 : Math.max(0, Math.min(1, hp / maxHp));
  const dead = hp <= 0;
  const low = ratio <= 0.3;
  return `
    <div class="hp-row ${isPlayer ? 'is-player' : ''} ${dead ? 'is-dead' : ''} ${low ? 'is-low' : ''}">
      <div class="hp-label">
        <span class="hp-name">${escapeHtml(name)}</span>
        <span class="hp-value">${formatNumber(Math.max(0, hp))} / ${formatNumber(maxHp)}</span>
      </div>
      <div class="hp-track" role="progressbar" aria-valuenow="${Math.max(0, hp)}" aria-valuemin="0"
           aria-valuemax="${maxHp}" aria-label="${escapeHtml(name)} 生命值">
        <div class="hp-fill" style="width:${(ratio * 100).toFixed(1)}%"></div>
      </div>
      ${extra}
    </div>
  `;
}
