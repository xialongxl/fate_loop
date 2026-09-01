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

import { LOG_CAPACITY, SPEED_MODES } from '../../core/constants.js';
import { logRows, formatAmount, createLogResolver } from '../logFormat.js';
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
  getLogLimit = null,
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

  /* ============================================================
   * 动效：飘字 + 卡片震 + 受击闪
   *
   * 四条约束（都不是美化考虑）：
   *  1. **纯表现，不回写任何状态** —— 与 logLimit 同一条原则：只影响展示，
   *     不影响战斗结果。否则“同种子必得同结果”就掺进了渲染逻辑。
   *  2. **全走 CSS animation**，不靠 JS 逐帧改 transform —— 因为 styles.css 里有
   *     `@media (prefers-reduced-motion: reduce) { animation: none }`，
   *     JS 动画会绕过它。对前庭功能障碍的人是硬需求。
   *  3. **飘字有预算**（同时最多 6 个）：4x 速度下不封顶会堆几十个节点拖死合成层。
   *  4. **只震卡片不震全屏**：全屏震看久了眩，而卡片震恰好把视线引到“谁挨了这一下”。
   * ========================================================== */
  const FLOATER_BUDGET = 6;
  let floaterLayer = null;
  const reducedMotion = () =>
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  /** MAX 模式不逐帧渲染，但结算后一次补写多条时也不该同屏放六个爆炸 */
  function ensureFloaterLayer() {
    if (floaterLayer !== null && floaterLayer.isConnected) return floaterLayer;
    floaterLayer = document.createElement('div');
    floaterLayer.className = 'fx-layer';
    floaterLayer.setAttribute('aria-hidden', 'true');
    element.append(floaterLayer);
    return floaterLayer;
  }

  /**
   * 飘字的随机偏移。**不用 Math.random**：
   * 一是 lint 在 UI 层也禁它（这条规则不该为一个装饰效果开口子），
   * 二是确定性偏移让截图对比与测试可复现 —— 装饰不需要真随机。
   */
  let fxTick = 0;
  function jitter() {
    fxTick = (fxTick + 1) >>> 0;
    const h = Math.imul(fxTick ^ (fxTick >>> 15), 2246822507) >>> 0;
    return ((h ^ (h >>> 13)) >>> 0) / 4294967296;
  }

  function pop(entityId, text, kind) {
    if (reducedMotion()) return;
    const card = cards.get(entityId)?.root ?? null;
    if (card === null) return;
    const layer = ensureFloaterLayer();
    while (layer.children.length >= FLOATER_BUDGET) layer.firstElementChild?.remove();
    const box = card.getBoundingClientRect();
    const host = element.getBoundingClientRect();
    if (box.height === 0) return;   // 屏幕没在显示（例如已回地图）时不要往左上角堆飘字
    const node = document.createElement('span');
    node.className = `fx-floater fx-${kind}`;
    node.textContent = text;
    node.style.left = `${Math.round(box.left - host.left + box.width * (0.25 + jitter() * 0.45))}px`;
    node.style.top = `${Math.round(box.top - host.top + 18)}px`;
    layer.append(node);
    node.addEventListener('animationend', () => node.remove());
  }

  function shake(entityId, level) {
    if (reducedMotion()) return;
    const card = cards.get(entityId)?.root ?? null;
    if (card === null) return;
    const cls = ['fx-shake-s', 'fx-shake-m', 'fx-shake-l'][Math.min(2, Math.max(0, level - 1))];
    card.classList.remove('fx-shake-s', 'fx-shake-m', 'fx-shake-l');
    void card.offsetWidth; // 重启动画：不读一次宽度，连续暴击不会重新震
    card.classList.add(cls);
  }

  function hitFlash(entityId) {
    if (reducedMotion()) return;
    const card = cards.get(entityId)?.root ?? null;
    if (card === null) return;
    card.classList.remove('fx-hit');
    void card.offsetWidth;
    card.classList.add('fx-hit');
  }

  /** 只对**刚写入的**事件放动效。每次重绘全量重放等于没有动效。 */
  function animateFresh(entries) {
    const playerId = entries.length > 0 ? 'player' : null;
    for (const e of entries) {
      if (e.kind === undefined || e.kind === null) continue;   // 叙事行不动
      const target = e.targetId ?? null;
      if (target === null) continue;
      const actorIsPlayer = e.actorId === playerId;
      if (e.kind === 'crit') {
        pop(target, `◆ ${formatAmount(e.amount)}`, 'crit');
        shake(target, 3);
        hitFlash(target);
      } else if (e.kind === 'damage') {
        pop(target, `−${formatAmount(e.amount)}`, 'dmg');
        hitFlash(target);
        // 只有“打到我身上”和“暴击”值得震屏；我方普通命中轻震就够了
        shake(target, actorIsPlayer ? 1 : 2);
      } else if (e.kind === 'heal') {
        pop(target, `+${formatAmount(e.amount)}`, 'heal');
      } else if (e.kind === 'buff' || e.kind === 'debuff') {
        pop(target, e.kind === 'buff' ? '✦' : '✧', 'status');
      }
    }
  }

  let lastLogKey = -1;
  /**
   * 上一次渲染时的最后一条日志（按**对象身份**记）。
   * 不能记下标：state.log 是环形缓冲，满 180 条后 splice 会让整体前移，
   * 用长度差算“新事件”会在满仓后开始漏放或重放。
   */
  let lastEntryRef = null;

  /** 名字在这里查，不在写入时拼（见 ui/logFormat.js 的说明） */
  const resolveLog = createLogResolver({ getSkills, getBuffs });

  function renderLog(snapshot) {
    // 只裁剪展示：state.log 的容量由引擎固定，设置项不得反向影响战斗状态
    const limit = Math.max(1, Math.min(LOG_CAPACITY, getLogLimit?.() ?? LOG_CAPACITY));
    const rows = snapshot.log.slice(-limit);
    // 键里带上 limit：只比长度的话，改设置后条数没变就永远不重绘
    const key = rows.length * 1000 + limit;
    const firstPaint = lastLogKey === -1;
    if (key === lastLogKey) return;
    lastLogKey = key;

    const resolve = resolveLog(snapshot);
    slots.log.replaceChildren();
    for (const entry of rows) {
      for (const row of logRows(entry, resolve)) {
        const li = document.createElement('li');
        li.className = `log-entry log-${row.kind}`;
        const time = document.createElement('span');
        time.className = 'log-time';
        time.textContent = `${(entry.t / 1000).toFixed(2)}s`;
        const icon = document.createElement('span');
        icon.className = 'log-icon';
        icon.setAttribute('aria-hidden', 'true');
        icon.textContent = row.icon;
        li.append(time, icon);
        for (const segment of row.segments) {
          if (segment.text === '') continue;
          const span = document.createElement('span');
          span.className = `log-${segment.cls}`;
          span.textContent = segment.text;
          li.append(span);
        }
        if (entry.hpLeft !== undefined && entry.kind !== 'heal') {
          const left = document.createElement('span');
          left.className = 'log-hp';
          left.textContent = `余 ${formatNumber(entry.hpLeft)}`;
          li.append(left);
        }
        slots.log.append(li);
      }
    }
    slots.log.scrollTop = slots.log.scrollHeight;

    /* 动效只给新事件。开场那一帧不放（否则读档/进屏会把旧日志当新事件炸一遍）；
     * 单帧最多处理 4 条，4x 下也不会堆积。 */
    const tail = snapshot.log[snapshot.log.length - 1] ?? null;
    const idx = lastEntryRef === null ? -1 : snapshot.log.lastIndexOf(lastEntryRef);
    const fresh = firstPaint || tail === null ? [] : idx >= 0 ? snapshot.log.slice(idx + 1) : [tail];
    lastEntryRef = tail;
    if (fresh.length > 0) animateFresh(fresh.slice(-4));
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
    // 暂停态也要能按速度按钮：否则玩家按下 ⏸ 之后再也开不回来
    const controllable = battling || snapshot.status === 'paused';

    slots.clock.textContent = formatSeconds(virtualTime);
    slots.phase.textContent = battling
      ? '进行中'
      : snapshot.status === 'paused'
        ? '已暂停'
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
      btn.disabled = !controllable;
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
      lastLogKey = -1;
      lastEntryRef = null;
      floaterLayer?.replaceChildren();
    },
  };
}
