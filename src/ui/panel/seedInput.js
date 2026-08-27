/** 种子输入框（规格 10.4）。修改需确认，旁带随机刷新按钮。 */

import { normalizeSeed, randomSeed } from '../../core/prng.js';

export function createSeedPanel(container, { getSeed, onSeedChange }) {
  container.className = 'panel panel-seed';
  container.innerHTML = `
    <h2 class="panel-title">种子</h2>
    <div class="seed-row">
      <label class="visually-hidden" for="seed-input">当前种子</label>
      <input id="seed-input" type="text" class="seed-input" inputmode="numeric" />
      <button type="button" class="seed-random" title="随机新种子" aria-label="随机新种子">🔄</button>
      <button type="button" class="seed-apply">应用</button>
    </div>
    <p class="seed-hint">修改种子会重置地图与进度。留空则保持当前种子。</p>
  `;

  const input = container.querySelector('.seed-input');
  const applyBtn = container.querySelector('.seed-apply');
  const randomBtn = container.querySelector('.seed-random');

  function sync() {
    input.value = String(getSeed());
  }

  function apply(nextSeed) {
    // eslint-disable-next-line no-alert
    if (!window.confirm('重置地图？当前进度将丢失。')) return;
    onSeedChange(nextSeed);
    sync();
  }

  applyBtn.addEventListener('click', () => {
    const parsed = normalizeSeed(input.value);
    if (parsed === null) {
      sync();
      return;
    }
    if (parsed === getSeed()) return;
    apply(parsed);
  });

  randomBtn.addEventListener('click', () => {
    apply(randomSeed());
  });

  sync();
  return { sync };
}
