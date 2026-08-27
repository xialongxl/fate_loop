/**
 * 角色界面（阶段 9）。
 *
 * 存在意义：把「属性从哪来」摊开。自动战斗游戏里玩家看不到操作细节，
 * 唯一能理解强弱的途径就是面板拆解 —— 基础值、装备加成、种子浮动各占多少。
 */

import { MAX_LEVEL } from '../../core/constants.js';
import { baseStatsAtLevel, expProgress, expToNextLevel } from '../../core/progression.js';
import { totalEquipmentStats } from '../../core/equipment.js';
import { formatNumber, formatPercent } from '../format.js';
export function createCharacterScreen({ getState }) {
  const element = document.createElement('section');
  element.className = 'screen-character';
  element.innerHTML = `
    <header class="screen-head">
      <h2 tabindex="-1">角色</h2>
      <span class="screen-head-note" data-slot="head-note"></span>
    </header>

    <div class="char-layout">
      <section class="panel">
        <h3 class="panel-title">等级与经验</h3>
        <div data-slot="level"></div>
      </section>

      <section class="panel">
        <h3 class="panel-title">属性拆解</h3>
        <table class="breakdown-table">
          <caption class="visually-hidden">属性来源拆解</caption>
          <thead>
            <tr><th scope="col">属性</th><th scope="col">等级基础</th><th scope="col">装备</th><th scope="col">种子浮动</th><th scope="col">合计</th></tr>
          </thead>
          <tbody data-slot="breakdown"></tbody>
        </table>
        <p class="panel-note">
          伤害公式：<code>伤害 × 攻方增伤 ÷ (1 + 防御/100) × 受击易伤</code>，暴击 ×1.5，下限 1 点。
          防御是递减收益，因此堆防御不会无限收益。
        </p>
      </section>

      <section class="panel">
        <h3 class="panel-title">本局统计</h3>
        <dl class="char-stats" data-slot="stats"></dl>
      </section>

      <section class="panel">
        <h3 class="panel-title">下一级</h3>
        <div data-slot="next"></div>
      </section>
    </div>
  `;

  const slots = {
    headNote: element.querySelector('[data-slot="head-note"]'),
    level: element.querySelector('[data-slot="level"]'),
    breakdown: element.querySelector('[data-slot="breakdown"]'),
    stats: element.querySelector('[data-slot="stats"]'),
    next: element.querySelector('[data-slot="next"]'),
  };

  function render() {
    const state = getState();
    const player = state.player;
    const progress = expProgress(player.exp ?? 0);
    const base = baseStatsAtLevel(progress.level);
    const gear = totalEquipmentStats(player.equipment);
    const bonus = player.seedBonus ?? { maxHp: 0, attack: 0, defense: 0 };

    slots.headNote.textContent = `种子 ${state.seed} · 第 ${state.floorNumber} 层`;

    slots.level.innerHTML = `
      <p class="level-badge">Lv.<strong>${progress.level}</strong> <small>/ ${MAX_LEVEL}</small></p>
      <div class="exp-track" role="progressbar" aria-valuemin="0" aria-valuemax="${progress.need}"
           aria-valuenow="${progress.current}" aria-label="经验进度">
        <div class="exp-fill" style="width:${(progress.ratio * 100).toFixed(1)}%"></div>
      </div>
      <p class="panel-note">
        ${
          progress.maxed
            ? '已达满级。'
            : `${formatNumber(progress.current)} / ${formatNumber(progress.need)} 经验（${formatPercent(
                progress.ratio,
              )}）`
        }
      </p>
      <p class="panel-note">累计经验 ${formatNumber(player.exp ?? 0)}</p>
    `;

    const rows = [
      { label: '最大生命', base: base.maxHp, gear: gear.maxHp, bonus: bonus.maxHp, total: player.maxHp },
      { label: '攻击力', base: base.attack, gear: gear.attack, bonus: bonus.attack, total: player.attack },
      { label: '防御力', base: base.defense, gear: gear.defense, bonus: bonus.defense, total: player.defense },
    ];

    slots.breakdown.innerHTML = `
      ${rows
        .map(
          (row) => `
        <tr>
          <th scope="row">${row.label}</th>
          <td>${formatNumber(row.base)}</td>
          <td>${row.gear > 0 ? `+${formatNumber(row.gear)}` : '—'}</td>
          <td>${row.bonus > 0 ? `+${formatNumber(row.bonus)}` : '—'}</td>
          <td><strong>${formatNumber(row.total)}</strong></td>
        </tr>`,
        )
        .join('')}
      <tr>
        <th scope="row">暴击率</th>
        <td>${formatPercent(base.critChance)}</td>
        <td>${gear.crit > 0 ? `+${(gear.crit / 10).toFixed(1)}%` : '—'}</td>
        <td>—</td>
        <td><strong>${formatPercent(player.critChance ?? 0)}</strong></td>
      </tr>
    `;

    const m = state.metadata;
    slots.stats.innerHTML = `
      <div><dt>已访问节点</dt><dd>${m.nodesVisited}</dd></div>
      <div><dt>已清理节点</dt><dd>${state.clearedNodeIds.size}</dd></div>
      <div><dt>胜场</dt><dd>${m.battlesWon}</dd></div>
      <div><dt>通过层数</dt><dd>${m.floorsCleared}</dd></div>
      <div><dt>累计伤害</dt><dd>${formatNumber(m.totalDamage)}</dd></div>
      <div><dt>累计治疗</dt><dd>${formatNumber(m.totalHeal)}</dd></div>
      <div><dt>累计经验</dt><dd>${formatNumber(m.expEarned ?? 0)}</dd></div>
      <div><dt>累计碎片</dt><dd>${formatNumber(m.shardsEarned)}</dd></div>
      <div><dt>获得装备</dt><dd>${m.gearFound ?? 0}</dd></div>
      <div><dt>持有碎片</dt><dd>${formatNumber(state.fateShards)}</dd></div>
    `;

    if (progress.maxed) {
      slots.next.innerHTML = '<p class="panel-note">已达满级，属性不再随等级增长。</p>';
    } else {
      const nextBase = baseStatsAtLevel(progress.level + 1);
      slots.next.innerHTML = `
        <p class="panel-note">升到 Lv.${progress.level + 1} 还需 ${formatNumber(
          expToNextLevel(progress.level) - progress.current,
        )} 经验，将获得：</p>
        <dl class="char-stats">
          <div><dt>最大生命</dt><dd>+${nextBase.maxHp - base.maxHp}</dd></div>
          <div><dt>攻击力</dt><dd>+${nextBase.attack - base.attack}</dd></div>
          <div><dt>防御力</dt><dd>+${nextBase.defense - base.defense}</dd></div>
          <div><dt>暴击率</dt><dd>+${((nextBase.critChance - base.critChance) * 100).toFixed(2)}%</dd></div>
        </dl>
        <p class="panel-note">升级会按「保持缺失生命量」补齐上限，不会白送回血。</p>
      `;
    }
  }

  return { element, render };
}
