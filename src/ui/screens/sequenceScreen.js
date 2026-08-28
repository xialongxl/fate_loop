/**
 * 技能序列界面（阶段 9：从右侧面板提升为独立屏幕）。
 *
 * 相对旧面板的三处实质变化：
 *   1. 技能不再全部可用 —— 按等级解锁（用户决定：局内等级解锁）。未解锁的技能
 *      仍然列出但禁用并标注所需等级，让玩家看得到成长目标。
 *   2. 技能库改为可筛选、可搜索的完整列表，90 个技能不再塞在一个 <select> 里。
 *   3. 每个技能显示完整描述、倍率、时长、标签，不再只有 tooltip。
 */

import { OGCD_SLOT_LIMIT, SKILL_FAMILY_LABELS, SKILL_TYPE } from '../../core/constants.js';
import { escapeHtml } from '../format.js';

/** 没传 familyLabels 时的兜底：core 登记的官方流派。 */
const DEFAULT_FAMILY_LABELS = Object.freeze({ all: '全部', ...SKILL_FAMILY_LABELS });

export function createSequenceScreen({
  getState,
  getSkills,
  getUnlockTable,
  onChange,
  onPlayFeedback,
  onToast,
  familyLabels = null,
}) {
  /** 筛选按钮的流派列表。模组注册的新流派由 main.js 合并进来传这里。 */
  const FAMILY_LABELS = familyLabels === null
    ? DEFAULT_FAMILY_LABELS
    : Object.freeze({ all: '全部', ...familyLabels });
  const element = document.createElement('section');
  element.className = 'screen-sequence';
  element.innerHTML = `
    <header class="screen-head">
      <h2 tabindex="-1">技能序列</h2>
      <span class="screen-head-note" data-slot="level-note"></span>
    </header>

    <div class="seq-layout">
      <div class="seq-column">
        <section class="panel">
          <h3 class="panel-title">
            GCD 循环序列 <span class="panel-count" data-slot="gcd-count"></span>
          </h3>
          <p class="panel-note">
            战斗中按此顺序循环释放。条件不满足的技能会被跳过并前进指针。
            可拖拽排序，或用 ▲▼ 按钮调整（键盘可达）。
          </p>
          <ol class="seq-list" data-slot="gcd-list" aria-label="GCD 技能序列"></ol>
          <p class="seq-summary" data-slot="gcd-summary"></p>
        </section>

        <section class="panel">
          <h3 class="panel-title">oGCD 槽位 <span class="panel-count" data-slot="ogcd-count"></span></h3>
          <p class="panel-note">
            最多 ${OGCD_SLOT_LIMIT} 个。触发条件由技能自身定义，不可编辑。
            每步每实体至多触发一个，优先级高者胜出。
          </p>
          <ol class="seq-list" data-slot="ogcd-list" aria-label="oGCD 槽位"></ol>
        </section>
      </div>

      <div class="seq-column is-library">
        <section class="panel">
          <h3 class="panel-title">技能库</h3>
          <div class="library-controls">
            <div class="library-search">
              <label class="visually-hidden" for="skill-search">搜索技能</label>
              <input id="skill-search" type="search" placeholder="搜索名称或描述…" data-slot="search" />
              <label class="filter-check">
                <input type="checkbox" data-slot="only-unlocked" checked />
                仅显示已解锁
              </label>
            </div>
            <div class="filter-groups">
              <div class="filter-group">
                <span class="filter-caption" aria-hidden="true">类型</span>
                <div class="filter-row" role="group" aria-label="技能类型筛选">
                  <button type="button" data-type="GCD" class="filter-btn is-active">GCD</button>
                  <button type="button" data-type="oGCD" class="filter-btn">oGCD</button>
                </div>
              </div>
              <div class="filter-group">
                <span class="filter-caption" aria-hidden="true">流派</span>
                <div class="filter-row" role="group" aria-label="流派筛选" data-slot="family-row">
                  ${Object.entries(FAMILY_LABELS)
                    .map(
                      ([id, label]) =>
                        `<button type="button" data-family="${id}" class="filter-btn ${
                          id === 'all' ? 'is-active' : ''
                        }">${label}</button>`,
                    )
                    .join('')}
                </div>
              </div>
            </div>
          </div>
          <ul class="skill-library" data-slot="library"></ul>
        </section>
      </div>
    </div>
  `;

  const slots = {
    levelNote: element.querySelector('[data-slot="level-note"]'),
    gcdList: element.querySelector('[data-slot="gcd-list"]'),
    gcdCount: element.querySelector('[data-slot="gcd-count"]'),
    gcdSummary: element.querySelector('[data-slot="gcd-summary"]'),
    ogcdList: element.querySelector('[data-slot="ogcd-list"]'),
    ogcdCount: element.querySelector('[data-slot="ogcd-count"]'),
    library: element.querySelector('[data-slot="library"]'),
    search: element.querySelector('[data-slot="search"]'),
    onlyUnlocked: element.querySelector('[data-slot="only-unlocked"]'),
  };

  let filterType = SKILL_TYPE.GCD;
  let filterFamily = 'all';
  let dragIndex = null;

  function timing(skill) {
    return skill.type === SKILL_TYPE.GCD
      ? `${(skill.gcdCostMs / 1000).toFixed(1)}s`
      : `CD ${(skill.cooldownMs / 1000).toFixed(0)}s`;
  }

  function requiredLevel(skillId) {
    return getUnlockTable().get(skillId) ?? 1;
  }

  function isUnlocked(skillId, level) {
    return level >= requiredLevel(skillId);
  }

  // ---- 已配置的序列 ----

  function renderGcdList(state) {
    const skills = getSkills();
    const level = state.player.level;
    slots.gcdCount.textContent = `${state.player.gcdSequence.length} 个`;
    slots.gcdList.replaceChildren();

    if (state.player.gcdSequence.length === 0) {
      slots.gcdList.innerHTML =
        '<li class="seq-item is-empty">序列为空 —— 战斗中将无法行动，请从右侧技能库添加。</li>';
      slots.gcdSummary.textContent = '';
      return;
    }

    let totalMs = 0;
    state.player.gcdSequence.forEach((skillId, index) => {
      const skill = skills.get(skillId);
      totalMs += skill?.gcdCostMs ?? 0;
      const locked = !isUnlocked(skillId, level);

      const li = document.createElement('li');
      li.className = `seq-item ${locked ? 'is-locked' : ''}`;
      li.draggable = true;
      li.dataset.index = String(index);
      li.innerHTML = `
        <span class="seq-order">${index + 1}</span>
        <span class="seq-body">
          <span class="seq-head">
            <span class="seq-name">${escapeHtml(skill?.name ?? `${skillId}（缺失）`)}</span>
            <span class="seq-meta">${skill === undefined ? '' : timing(skill)}${
              locked ? ` · 需 Lv.${requiredLevel(skillId)}` : ''
            }</span>
          </span>
          <span class="seq-desc">${escapeHtml(skill?.description ?? '')}</span>
        </span>
        <span class="seq-actions">
          <button type="button" data-move="up" aria-label="上移第 ${index + 1} 项">▲</button>
          <button type="button" data-move="down" aria-label="下移第 ${index + 1} 项">▼</button>
          <button type="button" data-remove aria-label="移除第 ${index + 1} 项">✕</button>
        </span>
      `;
      slots.gcdList.append(li);
    });

    slots.gcdSummary.textContent = `一轮循环 ${(totalMs / 1000).toFixed(1)} 秒`;
  }

  function renderOgcdList(state) {
    const skills = getSkills();
    const level = state.player.level;
    slots.ogcdCount.textContent = `${state.player.ogcdSlots.length} / ${OGCD_SLOT_LIMIT}`;
    slots.ogcdList.replaceChildren();

    if (state.player.ogcdSlots.length === 0) {
      slots.ogcdList.innerHTML = '<li class="seq-item is-empty">未配置 oGCD。</li>';
      return;
    }

    state.player.ogcdSlots.forEach((slot, index) => {
      const skill = skills.get(slot.skillId);
      const locked = !isUnlocked(slot.skillId, level);
      const li = document.createElement('li');
      li.className = `seq-item seq-item-ogcd ${locked ? 'is-locked' : ''}`;
      li.dataset.index = String(index);
      li.innerHTML = `
        <span class="seq-order">${index + 1}</span>
        <span class="seq-body">
          <span class="seq-head">
            <span class="seq-name">${escapeHtml(skill?.name ?? `${slot.skillId}（缺失）`)}</span>
            <span class="seq-meta">${skill === undefined ? '' : timing(skill)}${
              locked ? ` · 需 Lv.${requiredLevel(slot.skillId)}` : ''
            }</span>
          </span>
          <span class="seq-desc">${escapeHtml(skill?.description ?? '')}</span>
        </span>
        <label class="seq-priority">
          优先级
          <input type="number" value="${slot.priority}" min="0" max="99" data-priority
                 aria-label="第 ${index + 1} 个 oGCD 的优先级" />
        </label>
        <button type="button" data-remove aria-label="移除第 ${index + 1} 个 oGCD">✕</button>
      `;
      slots.ogcdList.append(li);
    });
  }

  // ---- 技能库 ----

  function renderLibrary(state) {
    const skills = getSkills();
    const level = state.player.level;
    const query = slots.search.value.trim().toLowerCase();
    const onlyUnlocked = slots.onlyUnlocked.checked;

    const inSequence = new Set(state.player.gcdSequence);
    const inSlots = new Set(state.player.ogcdSlots.map((s) => s.skillId));

    const list = [...skills.values()]
      .filter((skill) => skill.type === filterType)
      .filter((skill) => filterFamily === 'all' || skill.tags.includes(filterFamily))
      .filter((skill) => {
        if (!onlyUnlocked) return true;
        return isUnlocked(skill.id, level);
      })
      .filter((skill) => {
        if (query === '') return true;
        return (
          skill.name.toLowerCase().includes(query) ||
          skill.description.toLowerCase().includes(query) ||
          skill.id.toLowerCase().includes(query)
        );
      })
      .sort((a, b) => {
        const la = requiredLevel(a.id);
        const lb = requiredLevel(b.id);
        if (la !== lb) return la - lb;
        return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
      });

    if (list.length === 0) {
      slots.library.innerHTML = '<li class="library-item is-empty">没有符合条件的技能。</li>';
      return;
    }

    slots.library.innerHTML = list
      .map((skill) => {
        const need = requiredLevel(skill.id);
        const locked = level < need;
        const added = filterType === SKILL_TYPE.GCD ? inSequence.has(skill.id) : inSlots.has(skill.id);
        const slotsFull = filterType === SKILL_TYPE.OGCD && state.player.ogcdSlots.length >= OGCD_SLOT_LIMIT;
        const disabled = locked || (filterType === SKILL_TYPE.OGCD && (added || slotsFull));

        return `
        <li class="library-item ${locked ? 'is-locked' : ''}">
          <div class="library-main">
            <p class="library-name">
              ${escapeHtml(skill.name)}
              <span class="library-timing">${timing(skill)}</span>
              ${skill.power > 0 ? `<span class="library-power">×${skill.power}</span>` : ''}
            </p>
            <p class="library-desc">${escapeHtml(skill.description)}</p>
            <p class="library-tags">
              ${skill.tags.map((t) => `<span class="tag">${escapeHtml(FAMILY_LABELS[t] ?? t)}</span>`).join('')}
              ${locked ? `<span class="tag is-lock">需 Lv.${need}</span>` : ''}
              ${added && filterType === SKILL_TYPE.OGCD ? '<span class="tag is-added">已装配</span>' : ''}
            </p>
          </div>
          <button type="button" data-add="${escapeHtml(skill.id)}" class="btn-primary"
                  ${disabled ? 'disabled' : ''}>
            ${locked ? '未解锁' : added && filterType === SKILL_TYPE.OGCD ? '已装配' : '添加'}
          </button>
        </li>`;
      })
      .join('');
  }

  function render() {
    const state = getState();
    slots.levelNote.textContent = `当前 Lv.${state.player.level} · 已解锁 ${
      [...getSkills().keys()].filter((id) => isUnlocked(id, state.player.level)).length
    } / ${getSkills().size} 个技能`;
    renderGcdList(state);
    renderOgcdList(state);
    renderLibrary(state);
  }

  // ---- 交互 ----

  slots.search.addEventListener('input', render);
  slots.onlyUnlocked.addEventListener('change', render);

  element.addEventListener('click', (event) => {
    const typeBtn = event.target.closest?.('[data-type]');
    if (typeBtn !== null && typeBtn !== undefined) {
      filterType = typeBtn.getAttribute('data-type');
      for (const btn of element.querySelectorAll('[data-type]')) {
        btn.classList.toggle('is-active', btn === typeBtn);
      }
      render();
      return;
    }

    const familyBtn = event.target.closest?.('[data-family]');
    if (familyBtn !== null && familyBtn !== undefined) {
      filterFamily = familyBtn.getAttribute('data-family');
      for (const btn of element.querySelectorAll('[data-family]')) {
        btn.classList.toggle('is-active', btn === familyBtn);
      }
      render();
      return;
    }

    const addId = event.target.getAttribute?.('data-add');
    if (addId !== null && addId !== undefined) {
      addSkill(addId);
    }
  });

  function addSkill(skillId) {
    const state = getState();
    const skill = getSkills().get(skillId);
    if (skill === undefined) return;
    if (!isUnlocked(skillId, state.player.level)) {
      onToast?.(`${skill.name} 需要 Lv.${requiredLevel(skillId)}`, 'warn');
      return;
    }

    if (skill.type === SKILL_TYPE.GCD) {
      onChange((player) => player.gcdSequence.push(skillId));
      onPlayFeedback?.('ui.click');
      return;
    }

    if (state.player.ogcdSlots.length >= OGCD_SLOT_LIMIT) {
      onToast?.(`oGCD 槽位已满（上限 ${OGCD_SLOT_LIMIT}）`, 'warn');
      return;
    }
    if (state.player.ogcdSlots.some((s) => s.skillId === skillId)) {
      onToast?.(`${skill.name} 已装配`, 'warn');
      return;
    }
    onChange((player) => {
      player.ogcdSlots.push({ skillId, priority: 50, slotIndex: player.ogcdSlots.length });
    });
    onPlayFeedback?.('ui.click');
  }

  // GCD 列表：移动与移除
  slots.gcdList.addEventListener('click', (event) => {
    const li = event.target.closest('.seq-item');
    if (li === null || li.dataset.index === undefined) return;
    const index = Number(li.dataset.index);

    if (event.target.hasAttribute('data-remove')) {
      onChange((player) => player.gcdSequence.splice(index, 1));
      return;
    }
    const move = event.target.getAttribute('data-move');
    if (move === null) return;
    const target = move === 'up' ? index - 1 : index + 1;
    onChange((player) => {
      if (target < 0 || target >= player.gcdSequence.length) return;
      const tmp = player.gcdSequence[index];
      player.gcdSequence[index] = player.gcdSequence[target];
      player.gcdSequence[target] = tmp;
    });
  });

  // 拖拽排序
  slots.gcdList.addEventListener('dragstart', (event) => {
    const li = event.target.closest('.seq-item');
    if (li === null || li.dataset.index === undefined) return;
    dragIndex = Number(li.dataset.index);
    event.dataTransfer.effectAllowed = 'move';
    li.classList.add('is-dragging');
    onPlayFeedback?.('ui.drag');
  });

  slots.gcdList.addEventListener('dragend', () => {
    dragIndex = null;
    for (const li of slots.gcdList.children) li.classList.remove('is-dragging');
  });

  slots.gcdList.addEventListener('dragover', (event) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  });

  slots.gcdList.addEventListener('drop', (event) => {
    event.preventDefault();
    const li = event.target.closest('.seq-item');
    if (li === null || dragIndex === null || li.dataset.index === undefined) return;
    const targetIndex = Number(li.dataset.index);
    if (targetIndex === dragIndex) return;
    const from = dragIndex;
    onChange((player) => {
      const [moved] = player.gcdSequence.splice(from, 1);
      player.gcdSequence.splice(targetIndex, 0, moved);
    });
  });

  // oGCD 列表：移除与优先级
  slots.ogcdList.addEventListener('click', (event) => {
    if (!event.target.hasAttribute('data-remove')) return;
    const li = event.target.closest('.seq-item');
    const index = Number(li.dataset.index);
    onChange((player) => player.ogcdSlots.splice(index, 1));
  });

  slots.ogcdList.addEventListener('change', (event) => {
    if (!event.target.hasAttribute('data-priority')) return;
    const li = event.target.closest('.seq-item');
    const index = Number(li.dataset.index);
    const priority = Math.max(0, Math.min(99, Number(event.target.value) || 0));
    onChange((player) => {
      if (player.ogcdSlots[index] !== undefined) player.ogcdSlots[index].priority = priority;
    });
  });

  return { element, render };
}
