/**
 * 技能序列编辑器（规格 10.3）。
 *
 * GCD 序列可拖拽排序；oGCD 槽位最多 3 个，玩家只能选技能与优先级 ——
 * 条件谓词由技能自带，不可编辑（决定 C）。
 *
 * 无障碍：拖拽之外提供上移/下移/移除按钮，键盘用户不依赖指针操作。
 */

import { OGCD_SLOT_LIMIT, SKILL_TYPE } from '../../core/constants.js';

export function createSequenceEditor(container, { getState, getSkills, onChange, onPlayFeedback }) {
  container.className = 'panel panel-sequence';
  container.innerHTML = `
    <h2 class="panel-title">技能序列</h2>
    <div class="seq-section">
      <h3 class="seq-heading">GCD 循环序列 <span class="seq-count" data-field="gcd-count"></span></h3>
      <ol class="seq-list" data-slot="gcd-list" aria-label="GCD 技能序列"></ol>
      <div class="seq-add">
        <label class="visually-hidden" for="gcd-picker">添加 GCD 技能</label>
        <select id="gcd-picker" data-slot="gcd-picker"></select>
        <button type="button" data-action="add-gcd">添加</button>
      </div>
      <p class="seq-desc" data-slot="gcd-desc" aria-live="polite"></p>
    </div>
    <div class="seq-section">
      <h3 class="seq-heading">oGCD 槽位（最多 ${OGCD_SLOT_LIMIT}）</h3>
      <ol class="seq-list" data-slot="ogcd-list" aria-label="oGCD 槽位"></ol>
      <div class="seq-add">
        <label class="visually-hidden" for="ogcd-picker">添加 oGCD 技能</label>
        <select id="ogcd-picker" data-slot="ogcd-picker"></select>
        <button type="button" data-action="add-ogcd">添加</button>
      </div>
      <p class="seq-desc" data-slot="ogcd-desc" aria-live="polite"></p>
      <p class="seq-hint">oGCD 触发条件由技能自身定义，不可编辑。优先级高者先抢占。</p>
    </div>
  `;

  const gcdList = container.querySelector('[data-slot="gcd-list"]');
  const ogcdList = container.querySelector('[data-slot="ogcd-list"]');
  const gcdPicker = container.querySelector('[data-slot="gcd-picker"]');
  const ogcdPicker = container.querySelector('[data-slot="ogcd-picker"]');
  const gcdCount = container.querySelector('[data-field="gcd-count"]');
  const gcdDesc = container.querySelector('[data-slot="gcd-desc"]');
  const ogcdDesc = container.querySelector('[data-slot="ogcd-desc"]');

  gcdPicker.addEventListener('change', renderPickerHint);
  ogcdPicker.addEventListener('change', renderPickerHint);

  let dragIndex = null;

  function skillTiming(skill) {
    return skill.type === SKILL_TYPE.GCD
      ? `${(skill.gcdCostMs / 1000).toFixed(1)}s`
      : `CD ${(skill.cooldownMs / 1000).toFixed(0)}s`;
  }

  function skillLabel(skillId) {
    const skill = getSkills().get(skillId);
    if (skill === undefined) return `${skillId}（缺失）`;
    return `${skill.name} · ${skillTiming(skill)}`;
  }

  function populatePickers() {
    const skills = [...getSkills().values()].sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const [picker, type] of [
      [gcdPicker, SKILL_TYPE.GCD],
      [ogcdPicker, SKILL_TYPE.OGCD],
    ]) {
      picker.replaceChildren();
      for (const skill of skills.filter((s) => s.type === type)) {
        const option = document.createElement('option');
        option.value = skill.id;
        option.textContent = `${skill.name}（${skillTiming(skill)}）`;
        // 下拉项无法内嵌多行，描述放到原生 tooltip
        if (skill.description !== '') option.title = skill.description;
        picker.append(option);
      }
    }
    renderPickerHint();
  }

  /** 选中项的完整描述常驻显示，不靠悬停。 */
  function renderPickerHint() {
    for (const [picker, hint] of [
      [gcdPicker, gcdDesc],
      [ogcdPicker, ogcdDesc],
    ]) {
      const skill = getSkills().get(picker.value);
      hint.textContent = skill === undefined ? '' : skill.description;
    }
  }

  function render() {
    const state = getState();
    const sequence = state.player.gcdSequence;
    const slots = state.player.ogcdSlots;

    gcdCount.textContent = `${sequence.length} 个`;

    gcdList.replaceChildren();
    sequence.forEach((skillId, index) => {
      const li = document.createElement('li');
      li.className = 'seq-item';
      li.draggable = true;
      li.dataset.index = String(index);
      li.innerHTML = `
        <span class="seq-order">${index + 1}</span>
        <span class="seq-name">${skillLabel(skillId)}</span>
        <span class="seq-actions">
          <button type="button" data-move="up" aria-label="上移">▲</button>
          <button type="button" data-move="down" aria-label="下移">▼</button>
          <button type="button" data-remove aria-label="移除">✕</button>
        </span>
      `;
      const skill = getSkills().get(skillId);
      if (skill !== undefined && skill.description !== '') li.title = skill.description;
      gcdList.append(li);
    });

    ogcdList.replaceChildren();
    slots.forEach((slot, index) => {
      const li = document.createElement('li');
      li.className = 'seq-item seq-item-ogcd';
      li.dataset.index = String(index);
      li.innerHTML = `
        <span class="seq-order">${index + 1}</span>
        <span class="seq-name">${skillLabel(slot.skillId)}</span>
        <label class="seq-priority">
          优先级
          <input type="number" value="${slot.priority}" min="0" max="99" data-priority />
        </label>
        <button type="button" data-remove aria-label="移除">✕</button>
      `;
      const ogcdSkill = getSkills().get(slot.skillId);
      if (ogcdSkill !== undefined && ogcdSkill.description !== '') li.title = ogcdSkill.description;
      ogcdList.append(li);
    });
  }

  // 拖拽排序
  gcdList.addEventListener('dragstart', (event) => {
    const li = event.target.closest('.seq-item');
    if (li === null) return;
    dragIndex = Number(li.dataset.index);
    event.dataTransfer.effectAllowed = 'move';
    li.classList.add('is-dragging');
    onPlayFeedback?.('ui.drag');
  });

  gcdList.addEventListener('dragend', () => {
    dragIndex = null;
    for (const li of gcdList.children) li.classList.remove('is-dragging');
  });

  gcdList.addEventListener('dragover', (event) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  });

  gcdList.addEventListener('drop', (event) => {
    event.preventDefault();
    const li = event.target.closest('.seq-item');
    if (li === null || dragIndex === null) return;
    const targetIndex = Number(li.dataset.index);
    if (targetIndex === dragIndex) return;
    onChange((player) => {
      const [moved] = player.gcdSequence.splice(dragIndex, 1);
      player.gcdSequence.splice(targetIndex, 0, moved);
    });
  });

  // 按钮操作
  gcdList.addEventListener('click', (event) => {
    const li = event.target.closest('.seq-item');
    if (li === null) return;
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

  ogcdList.addEventListener('click', (event) => {
    if (!event.target.hasAttribute('data-remove')) return;
    const li = event.target.closest('.seq-item');
    const index = Number(li.dataset.index);
    onChange((player) => player.ogcdSlots.splice(index, 1));
  });

  ogcdList.addEventListener('change', (event) => {
    if (!event.target.hasAttribute('data-priority')) return;
    const li = event.target.closest('.seq-item');
    const index = Number(li.dataset.index);
    const priority = Math.max(0, Math.min(99, Number(event.target.value) || 0));
    onChange((player) => {
      if (player.ogcdSlots[index] !== undefined) player.ogcdSlots[index].priority = priority;
    });
  });

  container.querySelector('[data-action="add-gcd"]').addEventListener('click', () => {
    const skillId = gcdPicker.value;
    if (skillId === '') return;
    onChange((player) => player.gcdSequence.push(skillId));
  });

  container.querySelector('[data-action="add-ogcd"]').addEventListener('click', () => {
    const skillId = ogcdPicker.value;
    if (skillId === '') return;
    onChange((player) => {
      if (player.ogcdSlots.length >= OGCD_SLOT_LIMIT) return;
      if (player.ogcdSlots.some((s) => s.skillId === skillId)) return;
      player.ogcdSlots.push({ skillId, priority: 50, slotIndex: player.ogcdSlots.length });
    });
  });

  populatePickers();
  render();
  return { render, populatePickers };
}
