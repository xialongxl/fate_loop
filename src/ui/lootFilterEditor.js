/**
 * 自动熔炼规则的编辑面板（独立对话框，P2b）。
 *
 * 为什么是独立对话框而不是塞在装备屏右列：补全到「8 槽逐位 ×（品质 + 必需词条 +
 * 每条下限 + 评分下限 + 带则熔）」之后，控件数是 9 段 × 14 = 126 个。
 * 塞在右列会长到滚不到头，而 ui:audit 那类"没溢出但塌了"的事故最容易在这种
 * 又长又密的面板上发生。所以：装备屏只留摘要 + 预设 + 试算 +「编辑规则…」，
 * 细则进这里。
 *
 * 折叠段是**懒渲染**：展开时才建控件。理由不是省内存（126 个控件不算什么），
 * 而是"收起的段落里留着 stale 值"这件事一定会漂移 —— 不建就没有。
 */

import { AFFIXES, EQUIP_SLOTS, EQUIP_SLOT_NAMES, RARITIES } from '../core/constants.js';
import { NO_MIN_RARITY, rulePhrase } from '../core/lootFilter.js';
import { slotKind } from '../core/equipment.js';
import { escapeHtml } from './format.js';

const GROUP_LABELS = Object.freeze({ weapon: '武器', armor: '防具', accessory: '首饰' });

/** 段的顺序：全局 → 8 个槽（与装备栏同序，玩家不用重新记一遍部位表）。 */
const SECTIONS = Object.freeze([
  { key: 'global', title: '全局规则', hint: '所有槽位的底' },
  ...EQUIP_SLOTS.map((slot) => ({
    key: `slot:${slot}`,
    slot,
    title: EQUIP_SLOT_NAMES[slot],
    hint: `继承组「${GROUP_LABELS[slotKind(slot)]}」`,
  })),
]);

function rarityOptions(selected, { placeholder }) {
  return [
    `<option value="${NO_MIN_RARITY}"${selected === NO_MIN_RARITY ? ' selected' : ''}>${placeholder}</option>`,
    ...RARITIES.map(
      (rarity, index) =>
        `<option value="${index}"${selected === index ? ' selected' : ''}>${escapeHtml(rarity.name)}</option>`,
    ),
  ].join('');
}

/** 一段规则的全部控件（展开时才生成）。 */
function ruleControlsHtml(rule, sectionKey) {
  const safe = rule ?? {
    minRarity: NO_MIN_RARITY,
    requiredAffixes: [],
    minAffixValues: {},
    minScore: 0,
    meltAffixes: [],
  };
  const affixChecks = (cls, list) =>
    AFFIXES.map(
      (affix) => `
        <label class="lf-check">
          <input type="checkbox" data-${cls}="${affix.id}" data-section="${sectionKey}"
            ${(list ?? []).includes(affix.id) ? 'checked' : ''} />
          <span>${escapeHtml(affix.name)}</span>
        </label>`,
    ).join('');

  const affixValues = AFFIXES.map(
    (affix) => `
      <label class="lf-num">
        <span>${escapeHtml(affix.name)}≥</span>
        <input type="number" min="0" step="1" data-affix-value="${affix.id}" data-section="${sectionKey}"
          value="${safe.minAffixValues?.[affix.id] ?? ''}" />
      </label>` +
      (affix.id === 'crit' ? '<span class="lf-unit">0.1%</span>' : ''),
  ).join('');

  return `
    <div class="lf-field">
      <span class="lf-label">最低品质</span>
      <select data-min-rarity data-section="${sectionKey}">
        ${rarityOptions(safe.minRarity, {
          placeholder: sectionKey === 'global' ? '不设品质门槛' : '继承上层',
        })}
      </select>
    </div>
    <div class="lf-field">
      <span class="lf-label">必需词条</span>
      <span class="lf-inline">${affixChecks('required', safe.requiredAffixes)}</span>
    </div>
    <div class="lf-field">
      <span class="lf-label">词条下限</span>
      <span class="lf-inline is-nums">${affixValues}</span>
    </div>
    <div class="lf-field">
      <span class="lf-label">评分≥</span>
      <input class="lf-score" type="number" min="0" step="100" data-min-score data-section="${sectionKey}"
        value="${safe.minScore || ''}" placeholder="不设" />
    </div>
    <div class="lf-field">
      <span class="lf-label">带则熔</span>
      <span class="lf-inline">${affixChecks('melt', safe.meltAffixes)}</span>
    </div>
    ${
      sectionKey === 'global'
        ? ''
        : `<button type="button" class="btn-ghost lf-clear" data-clear-section="${sectionKey}">清除本段（回到继承）</button>`
    }
  `;
}

/** 面板 HTML（交给 dialog.open，第一个 h2 会被 dialog.js 包成头部条）。 */
export function buildLootFilterEditor(filter) {
  const sections = SECTIONS.map((section) => {
    const rule =
      section.key === 'global'
        ? {
            minRarity: filter.minRarity,
            requiredAffixes: filter.requiredAffixes,
            minAffixValues: filter.minAffixValues,
            minScore: filter.minScore,
            meltAffixes: filter.meltAffixes,
          }
        : filter.slots?.[section.slot];
    return `
      <section class="lf-block" data-block="${section.key}">
        <button type="button" class="lf-toggle" data-toggle="${section.key}" aria-expanded="${String(section.key === 'global')}" title="${escapeHtml(section.hint)}">
          <span class="lf-toggle-title">${escapeHtml(section.title)}</span>
          <span class="lf-toggle-rule">${escapeHtml(rulePhrase(rule ?? null))}</span>
          <span class="lf-caret" aria-hidden="true">${section.key === 'global' ? '▲' : '▼'}</span>
        </button>
        <div class="lf-body" data-body="${section.key}"${section.key === 'global' ? '' : ' hidden'}></div>
      </section>`;
  }).join('');

  return `
    <h2 tabindex="-1">自动熔炼规则</h2>
    <p class="dialog-text">
      优先级：<strong>逐槽 &gt; 部位组 &gt; 全局</strong>。每段只覆盖它自己明说的条件 ——
      槽里没填的项会继承上一层，不会被清零。
    </p>
    <label class="lf-enable">
      <input type="checkbox" data-toggle-enabled${filter.enabled ? ' checked' : ''} />
      <span>启用自动熔炼</span>
    </label>
    <p class="lf-hint">不开启时下面所有规则都不生效（掉落全部进背包，只有背包满了才折碎片）。</p>
    ${sections}
    <p class="lf-hint">
      规则改完立即对本局的下一次掉落生效；<strong>已经进背包的装备不会被追溯熔炼</strong>。
    </p>
    <div class="dialog-actions">
      <button type="button" class="btn-danger" data-lf-reset>清空全部规则</button>
      <button type="button" class="btn-primary" data-action="close">完成</button>
    </div>
  `;
}

/**
 * 接事件。返回 cleanup（对话框关闭时其实元素已经没了，留着是为了对称与复用安全）。
 *
 * @param {{box: HTMLElement, getFilter: () => object,
 *   onPatch: (patch: object) => void, onReset: () => void, onRerender: () => void}} deps
 */
export function wireLootFilterEditor({ box, getFilter, onPatch, onReset, onRerender }) {
  const cleanups = [];
  const on = (type, handler, options) => {
    box.addEventListener(type, handler, options);
    cleanups.push(() => box.removeEventListener(type, handler, options));
  };

  /** 展开时才建控件：收起的段落里留 stale 值一定会漂。 */
  function ensureBody(key) {
    // key 来自本模块内部的固定列表（global / slot:xxx），只有字母与冒号，
    // 放进带引号的属性选择器里不需要 CSS.escape（那玩意在 jsdom 上还不一定存在）。
    const body = box.querySelector(`[data-body="${key}"]`);
    if (body === null || body.dataset.filled === '1') return body;
    const filter = getFilter();
    const rule =
      key === 'global'
        ? filter
        : filter.slots?.[key.slice('slot:'.length)] ?? null;
    body.innerHTML = ruleControlsHtml(rule, key);
    body.dataset.filled = '1';
    return body;
  }

  function readSection(key) {
    const body = box.querySelector(`[data-body="${key}"]`);
    if (body === null) return null;
    const rarity = body.querySelector('[data-min-rarity]');
    const required = [...body.querySelectorAll('[data-required]')].filter((c) => c.checked).map((c) => c.dataset.required);
    const melt = [...body.querySelectorAll('[data-melt]')].filter((c) => c.checked).map((c) => c.dataset.melt);
    const values = {};
    for (const input of body.querySelectorAll('[data-affix-value]')) {
      const n = Number(input.value);
      if (input.value !== '' && Number.isFinite(n) && n > 0) values[input.dataset.affixValue] = Math.trunc(n);
    }
    const scoreInput = body.querySelector('[data-min-score]');
    return {
      minRarity: rarity === null ? NO_MIN_RARITY : Number(rarity.value),
      requiredAffixes: required,
      meltAffixes: melt,
      minAffixValues: values,
      minScore: scoreInput && scoreInput.value !== '' ? Math.max(0, Number(scoreInput.value) || 0) : 0,
    };
  }

  /** 把当前 DOM 状态整份写回（core 的 normalize 会丢掉"什么都没设"的段）。 */
  function commit() {
    const filter = getFilter();
    const patch = { slots: { ...filter.slots } };
    const globalRule = readSection('global');
    if (globalRule !== null) Object.assign(patch, globalRule);
    for (const section of SECTIONS) {
      if (section.key === 'global') continue;
      const body = box.querySelector(`[data-body="${section.key}"]`);
      if (body === null || body.dataset.filled !== '1') continue; // 没展开过 ⇒ 不写、保持原样
      const rule = readSection(section.key);
      if (rule !== null) patch.slots[section.slot] = rule;
    }
    onPatch(patch);
  }

  on('click', (event) => {
    const target = event.target;

    if (target.closest?.('[data-lf-reset]')) {
      onReset();
      onRerender();
      return;
    }

    const toggle = target.closest?.('[data-toggle]');
    if (toggle !== null && toggle !== undefined) {
      const key = toggle.getAttribute('data-toggle');
      const body = ensureBody(key);
      const open = body !== null && body.hidden;
      if (body !== null) body.hidden = !open;
      toggle.setAttribute('aria-expanded', String(open));
      const caret = toggle.querySelector('.lf-caret');
      if (caret !== null) caret.textContent = open ? '▲' : '▼';
      return;
    }

    const clear = target.closest?.('[data-clear-section]');
    if (clear !== null && clear !== undefined) {
      const key = clear.getAttribute('data-clear-section');
      const body = box.querySelector(`[data-body="${key}"]`);
      if (body !== null) {
        // 全部回到"未设"：品质=继承、勾选清空、数值清空
        const rarity = body.querySelector('[data-min-rarity]');
        if (rarity !== null) rarity.value = String(NO_MIN_RARITY);
        for (const input of body.querySelectorAll('input')) {
          if (input.type === 'checkbox') input.checked = false;
          else input.value = '';
        }
      }
      const filter = getFilter();
      const slots = { ...filter.slots };
      delete slots[key.slice('slot:'.length)];
      onPatch({ slots });
      onRerender();
    }
  });

  const commitOnChange = (event) => {
    const el = event.target;
    if (el?.hasAttribute?.('data-toggle-enabled')) {
      onPatch({ enabled: el.checked === true });
      onRerender();
      return;
    }
    if (el?.closest?.('[data-body]') === null && el?.closest?.('[data-body]') === undefined) return;
    if (
      el?.hasAttribute?.('data-min-rarity') ||
      el?.hasAttribute?.('data-required') ||
      el?.hasAttribute?.('data-melt') ||
      el?.hasAttribute?.('data-affix-value') ||
      el?.hasAttribute?.('data-min-score')
    ) {
      commit();
    }
  };
  on('change', commitOnChange);

  // 全局段默认就是展开的，所以建完监听要立刻填一次；
  // 忘了这一步的话，面板打开时那段是空的（其余收起的段等点击再懒渲染）。
  ensureBody('global');

  return () => {
    for (const off of cleanups) off();
  };
}

/** 段的显示名（装备屏摘要要用，避免两处各写一份措辞）。 */
export function filterGroupLabel(slot) {
  return GROUP_LABELS[slotKind(slot)];
}
