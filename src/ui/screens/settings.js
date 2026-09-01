/**
 * 设置界面（阶段 9）。
 *
 * 设置立即生效并立即入队保存 —— 没有「应用」按钮。理由：所有设置项都是
 * 可逆的偏好，不存在需要批量确认的破坏性变更。
 */

import { SPEED_MODES } from '../../core/constants.js';
import { formatPercent } from '../format.js';

export function createSettingsScreen({ getSettings, onChange, onBack, onResetData, getAtm = null }) {
  const element = document.createElement('section');
  element.className = 'screen-settings';
  element.innerHTML = `
    <header class="screen-head">
      <h2 tabindex="-1">设置</h2>
      <button type="button" class="btn-ghost" data-act="back">← 返回</button>
    </header>

    <div class="settings-group">
      <h3 class="settings-heading">音频</h3>
      <label class="setting-row">
        <span class="setting-label">静音</span>
        <input type="checkbox" data-set="muted" />
      </label>
      <label class="setting-row">
        <span class="setting-label">音量 <output data-out="volume"></output></span>
        <input type="range" min="0" max="100" step="5" data-set="volume" />
      </label>
      <p class="setting-note">MAX 速度全程静音，只在结算播放一次胜/败音效。</p>
      <p class="setting-note">日志条数只影响显示，不改变战斗状态与存档 —— 同一种子在任何设置下终态逐字节相同。</p>
    </div>

    <div class="settings-group">
      <h3 class="settings-heading">战斗</h3>
      <label class="setting-row">
        <span class="setting-label">默认战斗速度</span>
        <select data-set="defaultSpeed">
          ${[SPEED_MODES.X1, SPEED_MODES.X4, SPEED_MODES.MAX]
            .map((mode) => `<option value="${mode}">${mode}</option>`)
            .join('')}
        </select>
      </label>
      <label class="setting-row">
        <span class="setting-label">踏入战斗节点后自动开战</span>
        <input type="checkbox" data-set="autoStartBattle" />
      </label>
      <label class="setting-row">
        <span class="setting-label">日志显示条数</span>
        <select data-set="logLimit">
          ${[50, 100, 200]
            .map((n) => `<option value="${n}">${n} 条</option>`)
            .join('')}
        </select>
      </label>
    </div>

    <div class="settings-group is-danger">
      <h3 class="settings-heading">数据</h3>
      <!-- 跳局 ATM 账得在这里看见：它是全项目唯一不在某一局里的数值，
           不显示的话“清空全部”会顺手抹掉一笔玩家看不见的钱。 -->
      <p class="setting-note" data-slot="atm"></p>
      <p class="setting-note">
        清空全部本地数据：4 个存档槽、历史战绩、设置，以及<strong>跳局 ATM 的余额与累计</strong>。此操作不可撤销。
      </p>
      <button type="button" class="btn-danger" data-act="reset">清空全部数据</button>
      <p class="setting-note" data-slot="storage"></p>
    </div>
  `;

  const volumeOut = element.querySelector('[data-out="volume"]');
  const atmNote = element.querySelector('[data-slot="atm"]');
  const storageNote = element.querySelector('[data-slot="storage"]');

  function render() {
    const settings = getSettings();
    element.querySelector('[data-set="muted"]').checked = settings.muted === true;
    element.querySelector('[data-set="volume"]').value = String(Math.round(settings.volume * 100));
    volumeOut.textContent = formatPercent(settings.volume, 0);
    element.querySelector('[data-set="defaultSpeed"]').value = settings.defaultSpeed;
    element.querySelector('[data-set="autoStartBattle"]').checked = settings.autoStartBattle !== false;
    element.querySelector('[data-set="logLimit"]').value = String(settings.logLimit ?? 100);
    // 跳局 ATM：只读一行。设置屏不许改它（钱只能在商店存/取），
    // 但必须在这里看得见 —— 因为同一个屏下面就是“全部清空”按钮。
    if (atmNote !== null && getAtm !== null) {
      const account = getAtm();
      atmNote.textContent =
        account === null || account === undefined
          ? '跳局投资（ATM）：本次不可用'
          : `跳局投资（ATM）：余额 ${account.balance} · 历史累计 ${account.total}（存在本地，不随存档导出）`;
    }
  }

  /** 设置存储信息（降级提示）。由 main 在 init 后注入一次。 */
  function setStorageInfo(text) {
    storageNote.textContent = text;
  }

  element.addEventListener('input', (event) => {
    const key = event.target.getAttribute?.('data-set');
    if (key === null || key === undefined) return;

    let value;
    if (event.target.type === 'checkbox') {
      value = event.target.checked;
    } else if (key === 'volume') {
      value = Number(event.target.value) / 100;
      volumeOut.textContent = formatPercent(value, 0);
    } else if (key === 'logLimit') {
      value = Number(event.target.value);
    } else {
      value = event.target.value;
    }

    onChange({ [key]: value });
  });

  element.addEventListener('click', (event) => {
    const act = event.target.getAttribute?.('data-act');
    if (act === 'back') onBack();
    if (act === 'reset') void onResetData();
  });

  return {
    element,
    render,
    setStorageInfo,
    onEnter() {
      render();
    },
  };
}
