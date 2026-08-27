/** HP 条与战斗进度面板（规格 10.3）。 */

import { SPEED_MODES } from '../../core/constants.js';

function hpBar(entity, { isPlayer = false } = {}) {
  const ratio = entity.maxHp === 0 ? 0 : Math.max(0, entity.hp / entity.maxHp);
  const pct = (ratio * 100).toFixed(1);
  const dead = entity.hp <= 0;
  return `
    <div class="hp-row ${isPlayer ? 'is-player' : ''} ${dead ? 'is-dead' : ''}">
      <div class="hp-label">
        <span class="hp-name">${entity.name}</span>
        <span class="hp-value">${entity.hp} / ${entity.maxHp}</span>
      </div>
      <div class="hp-track" role="progressbar" aria-valuenow="${entity.hp}" aria-valuemin="0"
           aria-valuemax="${entity.maxHp}" aria-label="${entity.name} 生命值">
        <div class="hp-fill" style="width:${pct}%"></div>
      </div>
    </div>
  `;
}

export function createBattlePanel(container, { onSpeedChange, onStartBattle, getSpeed }) {
  container.className = 'panel panel-battle';

  function render(snapshot, { canStartBattle }) {
    const speed = getSpeed();
    const battling = snapshot.status === 'battling';

    container.innerHTML = `
      <h2 class="panel-title">战斗</h2>
      <div class="battle-controls">
        ${
          canStartBattle
            ? '<button type="button" data-action="start" class="btn-primary">开始战斗</button>'
            : ''
        }
        <div class="speed-group" role="group" aria-label="战斗速度">
          ${[SPEED_MODES.PAUSED, SPEED_MODES.X1, SPEED_MODES.X4, SPEED_MODES.MAX]
            .map(
              (mode) => `
            <button type="button" data-speed="${mode}"
              class="${speed === mode ? 'is-active' : ''}"
              ${battling ? '' : 'disabled'}
              aria-pressed="${speed === mode}">${mode === 'paused' ? '⏸' : mode}</button>`,
            )
            .join('')}
        </div>
        <span class="battle-clock">${(snapshot.virtualTime / 1000).toFixed(2)}s</span>
      </div>
      <div class="hp-group">
        ${hpBar(snapshot.player, { isPlayer: true })}
        ${snapshot.monsters.map((m) => hpBar(m)).join('')}
      </div>
      <dl class="battle-stats">
        <div><dt>总伤害</dt><dd>${snapshot.metadata.totalDamage}</dd></div>
        <div><dt>总治疗</dt><dd>${snapshot.metadata.totalHeal}</dd></div>
        <div><dt>空转步</dt><dd>${snapshot.metadata.emptyLoops}</dd></div>
      </dl>
    `;
  }

  container.addEventListener('click', (event) => {
    const speed = event.target.getAttribute?.('data-speed');
    if (speed !== null && speed !== undefined) {
      onSpeedChange(speed);
      return;
    }
    if (event.target.getAttribute?.('data-action') === 'start') {
      onStartBattle();
    }
  });

  return { render };
}
