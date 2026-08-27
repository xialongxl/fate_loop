/**
 * 主菜单（阶段 9）。
 *
 * 「继续游戏」的可用性取决于自动槽是否有兼容存档，因此 onEnter 时异步探测一次。
 * 探测失败（存储不可用）时按钮禁用而非隐藏 —— 隐藏会让玩家以为存档丢了。
 */

import { SCREEN } from '../../core/constants.js';
import { escapeHtml, formatTimestamp } from '../format.js';

export function createMainMenuScreen({ onContinue, onNewGame, onOpen, getAutoSlot }) {
  const element = document.createElement('section');
  element.className = 'screen-menu';
  element.innerHTML = `
    <div class="menu-panel">
      <h1 class="menu-title" tabindex="-1">命运轮回</h1>
      <p class="menu-subtitle">FATE LOOP · 确定性自动战斗</p>

      <div class="menu-continue" data-slot="continue"></div>

      <div class="menu-actions">
        <button type="button" class="menu-btn is-primary" data-act="continue" disabled>
          <span class="menu-btn-icon" aria-hidden="true">▶</span>
          <span class="menu-btn-body"><strong>继续游戏</strong><small data-slot="continue-note">检查存档…</small></span>
        </button>
        <button type="button" class="menu-btn" data-act="new">
          <span class="menu-btn-icon" aria-hidden="true">✦</span>
          <span class="menu-btn-body"><strong>新的轮回</strong><small>指定种子或随机开局</small></span>
        </button>
        <button type="button" class="menu-btn" data-act="saves">
          <span class="menu-btn-icon" aria-hidden="true">▣</span>
          <span class="menu-btn-body"><strong>存档管理</strong><small>3 个手动槽 + 1 个自动槽</small></span>
        </button>
        <button type="button" class="menu-btn" data-act="settings">
          <span class="menu-btn-icon" aria-hidden="true">⚙</span>
          <span class="menu-btn-body"><strong>设置</strong><small>音量、默认速度、界面选项</small></span>
        </button>
        <button type="button" class="menu-btn" data-act="codex">
          <span class="menu-btn-icon" aria-hidden="true">❖</span>
          <span class="menu-btn-body"><strong>图鉴</strong><small>90 技能 · 300 怪物 · 装备品质</small></span>
        </button>
        <button type="button" class="menu-btn" data-act="history">
          <span class="menu-btn-icon" aria-hidden="true">⏱</span>
          <span class="menu-btn-body"><strong>历史战绩</strong><small>最近 50 次轮回</small></span>
        </button>
      </div>

      <p class="menu-foot">纯文字 · 纯单机 · 模组驱动 · 同种子必得同结果</p>
    </div>
  `;

  const continueBtn = element.querySelector('[data-act="continue"]');
  const continueNote = element.querySelector('[data-slot="continue-note"]');

  element.addEventListener('click', (event) => {
    const act = event.target.closest?.('[data-act]')?.getAttribute('data-act');
    if (act === null || act === undefined) return;
    if (act === 'continue') {
      if (!continueBtn.disabled) onContinue();
      return;
    }
    if (act === 'new') {
      onNewGame();
      return;
    }
    const map = {
      saves: SCREEN.SAVES,
      settings: SCREEN.SETTINGS,
      codex: SCREEN.CODEX,
      history: SCREEN.HISTORY,
    };
    if (map[act] !== undefined) onOpen(map[act]);
  });

  /** 异步刷新「继续游戏」的可用性。切屏时调用。 */
  async function refreshContinue() {
    continueBtn.disabled = true;
    continueNote.textContent = '检查存档…';
    let slot = null;
    try {
      slot = await getAutoSlot();
    } catch {
      slot = null;
    }

    if (slot === null || slot.empty === true) {
      continueNote.textContent = '暂无自动存档';
      return;
    }
    if (slot.incompatible === true) {
      continueNote.textContent = `存档版本不兼容（v${escapeHtml(slot.schemaVersion)}）`;
      return;
    }
    continueBtn.disabled = false;
    continueNote.textContent = `第 ${slot.floorNumber} 层 · 已清理 ${slot.nodesCleared} 节点 · ${formatTimestamp(
      slot.savedAt,
    )}`;
  }

  return {
    element,
    onEnter() {
      void refreshContinue();
    },
  };
}
