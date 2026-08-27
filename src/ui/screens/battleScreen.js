/**
 * 战斗界面（阶段 9：独立全屏，战斗时看不到地图 —— 用户选择 fullscreen）。
 *
 * 信息密度是这个屏幕的全部意义：玩家不能操作战斗，只能观察，所以必须把
 * 「为什么会这样」摊开 —— 双方 HP、在场 Buff 及层数、当前序列指针位置、
 * oGCD 冷却剩余、完整日志。
 *
 * 渲染成本：战斗中每帧调 render()，1x 下每秒约 60 次。因此这里不做全量
 * innerHTML 重建，而是一次建结构、之后只改 textContent 与 style.width。
 * 全量重建会在 4x 下产生可见掉帧（实测 4 个怪 + 90 行日志时尤其明显）。
 */

import { SPEED_MODES } from '../../core/constants.js';
import { escapeHtml, formatNumber, formatSeconds } from '../format.js';

const SPEED_BUTTONS = [SPEED_MODES.PAUSED, SPEED_MODES.X1, SPEED_MODES.X4, SPEED_MODES.MAX];
const SPEED_LABELS = { paused: '⏸ 暂停', '1x': '1x', '4x': '4x', MAX: 'MAX' };

export function createBattleScreen({
  getSnapshot,
  getSkills,
  getBuffs,
  getSpeed,
  onSpeedChange,
  onLeave,
}) {
  const element = document.createElement('section');
  element.className = 'screen-battle';
  element.innerHTML = `
    <header class="battle-head">
      <div class="battle-title">
        <h2 tabindex="-1">战斗</h2>
        <span class="battle-encounter" data-slot="encounter"></span>
      </div>
      <div class="battle-clock-group">
        <span class="battle-clock" data-slot="clock">0.00s</span>
        <span class="battle-phase" data-slot="phase">进行中</span>
      </div>
      <div class="speed-group" role="group" aria-label="战斗速度">
        ${SPEED_BUTTONS.map(
          (mode) =>
            `<button type="button" data-speed="${mode}" class="speed-btn">${SPEED_LABELS[mode]}</button>`,
        ).join('')}
      </div>
    </header>

    <div class="battle-body">
      <section class="battle-side battle-player" aria-label="玩家">
        <h3 class="battle-side-title">序列编织者</h3>
        <div data-slot="player-card"></div>
        <div class="seq-track" data-slot="seq-track" aria-label="GCD 序列进度"></div>
        <div class="ogcd-track" data-slot="ogcd-track" aria-label="oGCD 冷却"></div>
      </section>

      <section class="battle-side battle-enemies" aria-label="敌方">
        <h3 class="battle-side-title">敌方 <span data-slot="enemy-count"></span></h3>
        <div data-slot="enemy-cards"></div>
      </section>
    </div>

    <section class="battle-stats-row">
      <dl class="battle-stats">
        <div><dt>总伤害</dt><dd data-slot="stat-damage">0</dd></div>
        <div><dt>总治疗</dt><dd data-slot="stat-heal">0</dd></div>
        <div><dt>暴击率</dt><dd data-slot="stat-crit">—</dd></div>
        <div><dt>空转步</dt><dd data-slot="stat-idle">0</dd></div>
      </dl>
    </section>

    <section class="battle-log-section">
      <h3 class="battle-side-title">战斗日志</h3>
      <ol class="log-list is-full" data-slot="log" aria-live="polite"></ol>
    </section>

    <footer class="battle-foot" data-slot="foot" hidden></footer>
  `;

  const slots = {
    encounter: element.querySelector('[data-slot="encounter"]'),
    clock: element.querySelector('[data-slot="clock"]'),
    phase: element.querySelector('[data-slot="phase"]'),
    playerCard: element.querySelector('[data-slot="player-card"]'),
    seqTrack: element.querySelector('[data-slot="seq-track"]'),
    ogcdTrack: element.querySelector('[data-slot="ogcd-track"]'),
    enemyCards: element.querySelector('[data-slot="enemy-cards"]'),
    enemyCount: element.querySelector('[data-slot="enemy-count"]'),
    statDamage: element.querySelector('[data-slot="stat-damage"]'),
    statHeal: element.querySelector('[data-slot="stat-heal"]'),
    statCrit: element.querySelector('[data-slot="stat-crit"]'),
    statIdle: element.querySelector('[data-slot="stat-idle"]'),
    log: element.querySelector('[data-slot="log"]'),
    foot: element.querySelector('[data-slot="foot"]'),
  };

  element.addEventListener('click', (event) => {
    const speed = event.target.closest?.('[data-speed]')?.getAttribute('data-speed');
    if (speed !== null && speed !== undefined) {
      onSpeedChange(speed);
      return;
    }
    if (event.target.getAttribute?.('data-act') === 'leave') onLeave();
  });

  // ---- 实体卡：一次建结构，之后只改文本与宽度 ----

  /** 复用的实体卡缓存，key 为实体 id。 */
  const cards = new Map();

  function createCard(entity, isPlayer) {
    const card = document.createElement('div');
    card.className = `entity-card ${isPlayer ? 'is-player' : 'is-enemy'}`;
    card.innerHTML = `
      <div class="hp-row">
        <div class="hp-label">
          <span class="hp-name"></span>
          <span class="hp-value"></span>
        </div>
        <div class="hp-track" role="progressbar" aria-valuemin="0" aria-label="">
          <div class="hp-fill"></div>
        </div>
      </div>
      <dl class="entity-stats">
        <div><dt>攻</dt><dd data-f="atk"></dd></div>
        <div><dt>防</dt><dd data-f="def"></dd></div>
        <div><dt>输出</dt><dd data-f="dealt"></dd></div>
        <div><dt>承受</dt><dd data-f="taken"></dd></div>
      </dl>
      <div class="buff-strip" data-f="buffs" aria-label="在场状态"></div>
    `;
    const refs = {
      root: card,
      name: card.querySelector('.hp-name'),
      value: card.querySelector('.hp-value'),
      track: card.querySelector('.hp-track'),
      fill: card.querySelector('.hp-fill'),
      atk: card.querySelector('[data-f="atk"]'),
      def: card.querySelector('[data-f="def"]'),
      dealt: card.querySelector('[data-f="dealt"]'),
      taken: card.querySelector('[data-f="taken"]'),
      buffs: card.querySelector('[data-f="buffs"]'),
    };
    refs.name.textContent = entity.name;
    refs.track.setAttribute('aria-label', `${entity.name} 生命值`);
    cards.set(entity.id, refs);
    return refs;
  }

  function updateCard(entity, virtualTime, isPlayer) {
    const refs = cards.get(entity.id) ?? createCard(entity, isPlayer);
    const ratio = entity.maxHp === 0 ? 0 : Math.max(0, Math.min(1, entity.hp / entity.maxHp));

    refs.value.textContent = `${formatNumber(Math.max(0, entity.hp))} / ${formatNumber(entity.maxHp)}`;
    refs.fill.style.width = `${(ratio * 100).toFixed(1)}%`;
    refs.track.setAttribute('aria-valuenow', String(Math.max(0, entity.hp)));
    refs.track.setAttribute('aria-valuemax', String(entity.maxHp));
    refs.root.classList.toggle('is-dead', entity.hp <= 0);
    refs.root.classList.toggle('is-low', ratio <= 0.3 && entity.hp > 0);

    refs.atk.textContent = formatNumber(entity.attack);
    refs.def.textContent = formatNumber(entity.defense);
    refs.dealt.textContent = formatNumber(entity.stats.damageDealt);
    refs.taken.textContent = formatNumber(entity.stats.damageTaken);

    renderBuffs(refs.buffs, entity, virtualTime);
    return refs;
  }

  /** Buff 条：显示名字 + 层数 + 剩余秒数。用模组声明的显示名，不暴露 buffId。 */
  function renderBuffs(container, entity, virtualTime) {
    const buffTable = getBuffs();
    // buffs 是 Map（快照里被 deepClone 保留为 Map）
    const active = [...entity.buffs.entries()]
      .filter(([, buff]) => virtualTime < buff.expiresAtMs)
      .sort((a, b) => (a[0] < b[0] ? -1 : 1));

    if (active.length === 0) {
      container.replaceChildren();
      return;
    }

    const html = active
      .map(([buffId, buff]) => {
        const def = buffTable?.get(buffId);
        const name = def?.name ?? buffId;
        const remain = ((buff.expiresAtMs - virtualTime) / 1000).toFixed(1);
        const cls = def?.isDebuff === true ? 'is-debuff' : 'is-buff';
        const title = def?.description ?? '';
        return `<span class="buff-chip ${cls}" title="${escapeHtml(title)}">${escapeHtml(name)}${
          buff.stacks > 1 ? `<b>${buff.stacks}</b>` : ''
        }<i>${remain}s</i></span>`;
      })
      .join('');
    container.innerHTML = html;
  }

  /** GCD 序列轨：高亮当前指针位置。 */
  function renderSeqTrack(player) {
    const skills = getSkills();
    const html = player.gcdSequence
      .map((skillId, index) => {
        const skill = skills.get(skillId);
        const active = index === player.gcdIndex;
        return `<span class="seq-cell ${active ? 'is-active' : ''}" title="${escapeHtml(
          skill?.description ?? '',
        )}">${escapeHtml(skill?.name ?? skillId)}</span>`;
      })
      .join('');
    slots.seqTrack.innerHTML =
      html === '' ? '<span class="seq-cell is-empty">GCD 序列为空</span>' : html;
  }

  /** oGCD 轨：显示剩余冷却。 */
  function renderOgcdTrack(player, virtualTime) {
    const skills = getSkills();
    if (player.ogcdSlots.length === 0) {
      slots.ogcdTrack.innerHTML = '<span class="seq-cell is-empty">未配置 oGCD</span>';
      return;
    }
    slots.ogcdTrack.innerHTML = player.ogcdSlots
      .map((slot) => {
        const skill = skills.get(slot.skillId);
        const readyAt = player.ogcdReadyAtMs.get(slot.skillId) ?? 0;
        const remain = Math.max(0, readyAt - virtualTime);
        const ready = remain === 0;
        return `<span class="ogcd-cell ${ready ? 'is-ready' : ''}" title="${escapeHtml(
          skill?.description ?? '',
        )}">
          <b>${escapeHtml(skill?.name ?? slot.skillId)}</b>
          <i>${ready ? '就绪' : `${(remain / 1000).toFixed(1)}s`}</i>
          <em>P${slot.priority}</em>
        </span>`;
      })
      .join('');
  }

  let lastLogLength = -1;

  function renderLog(snapshot) {
    if (snapshot.log.length === lastLogLength) return;
    lastLogLength = snapshot.log.length;
    slots.log.replaceChildren();
    for (const entry of snapshot.log) {
      const li = document.createElement('li');
      li.className = 'log-entry';
      const time = document.createElement('span');
      time.className = 'log-time';
      time.textContent = `${(entry.t / 1000).toFixed(2)}s`;
      const msg = document.createElement('span');
      msg.className = 'log-msg';
      msg.textContent = entry.message;
      li.append(time, msg);
      slots.log.append(li);
    }
    slots.log.scrollTop = slots.log.scrollHeight;
  }

  /** 结算区：战斗结束后显示奖励与「返回地图」。 */
  function renderFoot(snapshot) {
    const finished = snapshot.status === 'finished' || snapshot.lastBattleReward !== null;
    if (!finished || snapshot.status === 'battling') {
      slots.foot.hidden = true;
      return;
    }

    const reward = snapshot.lastBattleReward;
    if (reward === null || reward === undefined) {
      slots.foot.hidden = true;
      return;
    }

    const levelUp =
      reward.levelAfter > reward.levelBefore
        ? `<span class="reward-chip is-level">升级 ${reward.levelBefore} → ${reward.levelAfter}</span>`
        : '';
    const loot =
      reward.loot.length === 0
        ? ''
        : reward.loot
            .map((g) => `<span class="reward-chip is-loot q${g.rarityIndex}">${escapeHtml(g.name)}</span>`)
            .join('');

    slots.foot.hidden = false;
    slots.foot.innerHTML = `
      <div class="reward-row">
        <span class="reward-chip">+${reward.shards} 碎片</span>
        <span class="reward-chip">+${reward.exp} 经验</span>
        ${levelUp}
        ${loot}
        ${reward.discarded > 0 ? `<span class="reward-chip is-warn">${reward.discarded} 件自动分解</span>` : ''}
      </div>
      <button type="button" data-act="leave" class="btn-primary" data-autofocus>返回地图</button>
    `;
  }

  function render() {
    const snapshot = getSnapshot();
    const { player, monsters, virtualTime } = snapshot;
    const battling = snapshot.status === 'battling';

    slots.clock.textContent = formatSeconds(virtualTime);
    slots.phase.textContent = battling
      ? '进行中'
      : snapshot.winner === 'player'
        ? '胜利'
        : snapshot.winner === 'monsters'
          ? '失败'
          : '待开始';
    slots.phase.className = `battle-phase is-${snapshot.winner ?? 'running'}`;
    slots.encounter.textContent =
      snapshot.activeBattle === null ? '' : `第 ${snapshot.floorNumber} 层 · ${snapshot.activeBattle.tier === 'elite' ? '精英' : '普通'}遭遇`;

    // 速度按钮状态
    const speed = getSpeed();
    for (const btn of element.querySelectorAll('[data-speed]')) {
      const mode = btn.getAttribute('data-speed');
      btn.classList.toggle('is-active', mode === speed);
      btn.setAttribute('aria-pressed', String(mode === speed));
      btn.disabled = !battling;
    }

    // 玩家卡
    const playerRefs = updateCard(player, virtualTime, true);
    if (playerRefs.root.parentElement === null) slots.playerCard.append(playerRefs.root);

    // 敌方卡：怪物集合在一场战斗内不变，故只在首次或换场时重挂
    slots.enemyCount.textContent = `${monsters.filter((m) => m.hp > 0).length} / ${monsters.length}`;
    for (const monster of monsters) {
      const refs = updateCard(monster, virtualTime, false);
      if (refs.root.parentElement === null) slots.enemyCards.append(refs.root);
    }

    renderSeqTrack(player);
    renderOgcdTrack(player, virtualTime);

    slots.statDamage.textContent = formatNumber(snapshot.metadata.totalDamage);
    slots.statHeal.textContent = formatNumber(snapshot.metadata.totalHeal);
    slots.statCrit.textContent =
      player.stats.skillsCast === 0 ? '—' : `${player.stats.skillsCast} 次施放`;
    slots.statIdle.textContent = formatNumber(snapshot.metadata.emptyLoops);

    renderLog(snapshot);
    renderFoot(snapshot);
  }

  return {
    element,
    render,
    /** 新战斗开始时清空缓存的实体卡，否则上一场的怪物卡会残留。 */
    onEnter() {
      cards.clear();
      slots.playerCard.replaceChildren();
      slots.enemyCards.replaceChildren();
      lastLogLength = -1;
    },
  };
}
