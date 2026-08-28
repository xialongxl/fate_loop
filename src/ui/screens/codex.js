/**
 * 图鉴（阶段 9 补齐：导航条与主菜单早就引用了 SCREEN.CODEX，但文件此前不存在，
 * 点过去会直接触发 invariant 崩溃 —— 见交接文档 P0-1）。
 *
 * 定位：只读的内容浏览器。数据源是内容池（模组加载结果），因此第三方模组
 * 注册的内容会一并出现 —— 这正是「模组驱动」的可观察入口。
 *
 * 刻意不做的事：不记录「已见过哪些条目」。那属于元进度，本作是局内 run，
 * 死亡即清零（equipment.js 的注释里写明了不引入局外养成的理由）。
 */

import { SKILL_FAMILIES, SKILL_FAMILY_LABELS, SKILL_TYPE } from '../../core/constants.js';
import { RARITIES } from '../../core/constants.js';
import { describeGear, rollEquipment } from '../../core/equipment.js';
import { mulberry32 } from '../../core/prng.js';
import { escapeHtml, formatNumber } from '../format.js';

const TABS = [
  { id: 'skill', label: '技能' },
  { id: 'buff', label: '状态' },
  { id: 'monster', label: '怪物' },
  { id: 'encounter', label: '遭遇' },
  { id: 'other', label: '商品与事件' },
];

/**
 * 非流派标签的中文名（起手/爆发…）。这些只用于展示与筛选，
 * 不参与解锁轮转；流派标签一律取自 core 的 SKILL_FAMILY_LABELS。
 */
const TAG_LABELS = Object.freeze({
  blade: '锋刃',
  opener: '起手',
  burst: '爆发',
  sustain: '持续',
  utility: '功能',
  ogcd: '插入',
});

export function createCodexScreen({ getPool, getUnlockTable, getSnapshot, onBack, familyLabels = null }) {
  /** 标签 → 中文名：core 官方流派 + 模组注册流派 + 辅助标签。 */
  const FAMILY_LABELS = Object.freeze({ ...SKILL_FAMILY_LABELS, ...TAG_LABELS, ...(familyLabels ?? {}) });
  /** 筛选顺序：官方流派 → 模组流派 → 辅助标签。去重后顺序稳定。 */
  const FAMILY_ORDER = Object.freeze([
    ...new Set([
      ...SKILL_FAMILIES,
      ...Object.keys(familyLabels ?? {}),
      ...Object.keys(TAG_LABELS),
    ]),
  ]);
  const element = document.createElement('section');
  element.className = 'screen-codex';
  element.innerHTML = `
    <header class="screen-head">
      <h2 tabindex="-1">图鉴</h2>
      <button type="button" class="btn-ghost" data-act="back">← 返回</button>
    </header>
    <p class="screen-hint">
      全部内容来自已加载的模组。同一种子下，这些数值与战斗结果完全一致。
      <span data-slot="counts"></span>
    </p>
    <div class="codex-tabs" role="tablist" data-slot="tabs"></div>
    <div class="library-controls">
      <label class="visually-hidden" for="codex-search">搜索图鉴</label>
      <input id="codex-search" type="search" placeholder="搜索名称、描述或 id…" data-slot="search" />
    </div>
    <div class="filter-row" data-slot="filters"></div>
    <ul class="codex-list" data-slot="list"></ul>
  `;

  const slots = {
    tabs: element.querySelector('[data-slot="tabs"]'),
    filters: element.querySelector('[data-slot="filters"]'),
    search: element.querySelector('[data-slot="search"]'),
    list: element.querySelector('[data-slot="list"]'),
    counts: element.querySelector('[data-slot="counts"]'),
  };

  let tab = 'skill';
  let family = 'all';
  let query = '';

  // ---- 行渲染 ----

  function tagRow(tags, extra = '') {
    return `
      <p class="library-tags">
        ${tags.map((t) => `<span class="tag">${escapeHtml(FAMILY_LABELS[t] ?? t)}</span>`).join('')}
        ${extra}
      </p>`;
  }

  function skillRow(skill, level) {
    const need = getUnlockTable().get(skill.id) ?? 1;
    const locked = level < need;
    const timing =
      skill.type === SKILL_TYPE.GCD
        ? `GCD ${(skill.gcdCostMs / 1000).toFixed(2)}s`
        : `oGCD 冷却 ${(skill.cooldownMs / 1000).toFixed(1)}s`;
    return `
      <li class="codex-item ${locked ? 'is-lock' : ''}">
        <div class="library-main">
          <p class="library-name">
            ${escapeHtml(skill.name)}
            <span class="library-timing">${skill.type === SKILL_TYPE.GCD ? 'GCD' : 'oGCD'} · ${timing}</span>
            ${skill.power > 0 ? `<span class="library-power">×${skill.power}</span>` : ''}
          </p>
          <p class="library-desc">${escapeHtml(skill.description)}</p>
          ${tagRow(
            [...(skill.tags ?? []), skill.range],
            locked ? `<span class="tag is-lock">需 Lv.${need}</span>` : '',
          )}
        </div>
        <span class="codex-id"><code>${escapeHtml(skill.id)}</code></span>
      </li>`;
  }

  function buffRow(buff) {
    const parts = [];
    for (const [key, value] of Object.entries(buff)) {
      if (typeof value !== 'number') continue;
      if (key.endsWith('Mul')) {
        const pct = Math.round((value - 1) * 100);
        parts.push(`${key.replace('Mul', '')} ${pct >= 0 ? '+' : ''}${pct}%/层`);
      }
    }
    return `
      <li class="codex-item ${buff.isDebuff ? 'is-debuff' : ''}">
        <div class="library-main">
          <p class="library-name">${escapeHtml(buff.name)}
            <span class="library-timing">${buff.isDebuff ? '减益' : '增益'}</span></p>
          <p class="library-desc">${escapeHtml(buff.description ?? '')}</p>
          ${tagRow([], `<span class="tag">${escapeHtml(parts.join(' · ') || '修饰项')}</span>`)}
        </div>
        <span class="codex-id"><code>${escapeHtml(buff.id)}</code></span>
      </li>`;
  }

  function monsterRow(monster) {
    return `
      <li class="codex-item">
        <div class="library-main">
          <p class="library-name">${escapeHtml(monster.name)}
            <span class="library-timing">${monster.tier === 'elite' ? '精英' : '普通'}</span></p>
          <p class="library-desc">
            生命 ${formatNumber(monster.maxHp)} · 攻击 ${formatNumber(monster.attack)} · 防御 ${formatNumber(
              monster.defense,
            )}
          </p>
          <p class="library-desc">序列：${escapeHtml((monster.gcdSequence ?? []).join(' → ') || '（空）')}</p>
          ${tagRow(monster.tags ?? [])}
        </div>
        <span class="codex-id"><code>${escapeHtml(monster.id)}</code></span>
      </li>`;
  }

  function encounterRow(encounter, pool) {
    const names = (encounter.monsterIds ?? [])
      .map((id) => pool.monsters.get(id)?.name ?? id)
      .join('、');
    return `
      <li class="codex-item">
        <div class="library-main">
          <p class="library-name">${escapeHtml(encounter.name)}
            <span class="library-timing">${encounter.tier === 'elite' ? '精英' : '普通'}</span></p>
          <p class="library-desc">${escapeHtml(names || '无怪物')}</p>
          <p class="library-desc">适用层数：${encounter.minFloor} ~ ${
            encounter.maxFloor === Infinity ? '∞' : encounter.maxFloor
          } · 权重 ${encounter.weight}</p>
        </div>
        <span class="codex-id"><code>${escapeHtml(encounter.id)}</code></span>
      </li>`;
  }

  function otherRow(entry, kind) {
    if (kind === 'gear') {
      return `
        <li class="codex-item">
          <div class="library-main">
            <p class="library-name">${escapeHtml(entry.name)}
              <span class="library-timing">${escapeHtml(entry.rarityName)}</span></p>
            <p class="library-desc">${escapeHtml(entry.text)}</p>
            <p class="library-desc">${escapeHtml(entry.note)}</p>
          </div>
        </li>`;
    }
    const choices = entry.choices ?? [];
    return `
      <li class="codex-item">
        <div class="library-main">
          <p class="library-name">${escapeHtml(entry.name)}
            <span class="library-timing">${kind === 'shop' ? `商品 · ${entry.cost} 碎片` : '事件'}</span></p>
          <p class="library-desc">${escapeHtml(entry.description ?? entry.text ?? '')}</p>
          ${
            choices.length === 0
              ? ''
              : `<p class="library-desc">选项：${escapeHtml(choices.map((c) => c.label).join(' / '))}</p>`
          }
          ${tagRow(entry.kind ? [entry.kind] : [])}
        </div>
        <span class="codex-id"><code>${escapeHtml(entry.id)}</code></span>
      </li>`;
  }


  // ---- 列表组装 ----

  function familiesIn(pool) {
    const found = new Set();
    for (const skill of pool.skills.values()) for (const t of skill.tags ?? []) found.add(t);
    return FAMILY_ORDER.filter((f) => found.has(f));
  }

  /** 装备品质示例：内容池里没有「品质」实体，用同一种子各造一件当展示样。 */
  function raritySamples() {
    return RARITIES.map((rarity, index) => {
      const gear = rollEquipment({
        rng: mulberry32(1000 + index),
        floorNumber: 10,
        idSuffix: `codex.${rarity.id}`,
        forceSlot: 'weapon',
        forceRarity: index,
      });
      return {
        name: gear.name,
        rarityName: `${rarity.name}（×${rarity.mult}）`,
        text: describeGear(gear),
        note: `词缀上限 ${rarity.affixMax} 条 · 出现权重 ${rarity.weight}${
          rarity.orbSlots > 0 ? ` · 宝珠槽 ${rarity.orbSlots}（系统未实装）` : ''
        }`,
      };
    });
  }

  function matches(text) {
    if (query === '') return true;
    return text.toLowerCase().includes(query.toLowerCase());
  }

  function renderTabs() {
    slots.tabs.innerHTML = TABS.map(
      (t) =>
        `<button type="button" role="tab" class="filter-btn" data-tab="${t.id}"
                aria-selected="${String(t.id === tab)}">${t.label}</button>`,
    ).join('');
  }

  function renderFilters(pool) {
    if (tab !== 'skill') {
      slots.filters.innerHTML = '';
      slots.filters.hidden = true;
      return;
    }
    slots.filters.hidden = false;
    const families = familiesIn(pool);
    slots.filters.innerHTML = `
      ${['all', ...families]
        .map(
          (f) =>
            `<button type="button" class="filter-btn ${f === family ? 'is-active' : ''}"
                     data-family="${escapeHtml(f)}">${escapeHtml(f === 'all' ? '全部流派' : FAMILY_LABELS[f] ?? f)}</button>`,
        )
        .join('')}
    `;
  }

  function render() {
    const pool = getPool();
    const level = getSnapshot().player.level ?? 1;
    renderTabs();
    renderFilters(pool);

    const rows = [];
    if (tab === 'skill') {
      const skills = [...pool.skills.values()].sort((a, b) => {
        if (a.type !== b.type) return a.type === SKILL_TYPE.GCD ? -1 : 1;
        return a.id < b.id ? -1 : 1;
      });
      for (const skill of skills) {
        if (family !== 'all' && !(skill.tags ?? []).includes(family)) continue;
        if (!matches(`${skill.name} ${skill.description} ${skill.id}`)) continue;
        rows.push(skillRow(skill, level));
      }
    } else if (tab === 'buff') {
      for (const buff of [...pool.buffs.values()].sort((a, b) => (a.id < b.id ? -1 : 1))) {
        if (!matches(`${buff.name} ${buff.description ?? ''} ${buff.id}`)) continue;
        rows.push(buffRow(buff));
      }
    } else if (tab === 'monster') {
      for (const monster of [...pool.monsters.values()].sort((a, b) => (a.id < b.id ? -1 : 1))) {
        if (family !== 'all' && !(monster.tags ?? []).includes(family)) continue;
        if (!matches(`${monster.name} ${monster.id}`)) continue;
        rows.push(monsterRow(monster));
      }
    } else if (tab === 'encounter') {
      for (const enc of [...pool.encounters.values()].sort((a, b) => (a.id < b.id ? -1 : 1))) {
        if (!matches(`${enc.name} ${enc.id}`)) continue;
        rows.push(encounterRow(enc, pool));
      }
    } else {
      for (const item of [...pool.shopItems.values()].sort((a, b) => (a.id < b.id ? -1 : 1))) {
        if (!matches(`${item.name} ${item.description} ${item.id}`)) continue;
        rows.push(otherRow(item, 'shop'));
      }
      for (const evt of [...pool.events.values()].sort((a, b) => (a.id < b.id ? -1 : 1))) {
        if (!matches(`${evt.name} ${evt.text} ${evt.id}`)) continue;
        rows.push(otherRow(evt, 'event'));
      }
      for (const sample of raritySamples()) {
        if (!matches(`${sample.name} ${sample.rarityName} ${sample.text}`)) continue;
        rows.push(otherRow(sample, 'gear'));
      }
    }

    slots.list.innerHTML =
      rows.length === 0
        ? '<li class="codex-item is-empty">没有匹配的内容</li>'
        : rows.join('');
    slots.counts.textContent = `（${rows.length} 条）`;
  }

  element.addEventListener('click', (event) => {
    if (event.target.closest?.('[data-act="back"]')) {
      onBack();
      return;
    }
    const tabBtn = event.target.closest?.('[data-tab]');
    if (tabBtn !== null && tabBtn !== undefined) {
      tab = tabBtn.getAttribute('data-tab');
      family = 'all';
      render();
      return;
    }
    const famBtn = event.target.closest?.('[data-family]');
    if (famBtn !== null && famBtn !== undefined) {
      family = famBtn.getAttribute('data-family');
      render();
    }
  });

  slots.search.addEventListener('input', () => {
    query = slots.search.value.trim();
    render();
  });

  return {
    element,
    render,
    onEnter() {
      render();
    },
  };
}
