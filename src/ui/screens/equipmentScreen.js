/**
 * 装备界面（阶段 9）。
 *
 * 参考 Fate_echo 的「装备栏 + 背包 + 详情面板」三区结构，但去掉了它的
 * 宝珠/精炼/图鉴集齐（那三套属于局外养成，本作是局内 run）。
 *
 * 交互设计：选中背包物品后在详情区显示与「当前已装备同槽位」的逐项对比 ——
 * 自动战斗游戏里玩家唯一的决策是「换不换」，把差值直接摊开比让玩家心算好。
 */

import { EQUIP_SLOTS, EQUIP_SLOT_NAMES, ENHANCE_MAX, INVENTORY_CAPACITY } from '../../core/constants.js';
import { describeGear, enhanceCost, rarityOf, salvageValue } from '../../core/equipment.js';
import { escapeHtml, formatNumber } from '../format.js';

export function createEquipmentScreen({
  getState,
  onEquip,
  onUnequip,
  onSalvage,
  onEnhance,
  onToast,
}) {
  const element = document.createElement('section');
  element.className = 'screen-equipment';
  element.innerHTML = `
    <header class="screen-head">
      <h2 tabindex="-1">装备</h2>
      <span class="screen-head-note" data-slot="capacity"></span>
    </header>

    <div class="equip-layout">
      <section class="panel equip-slots-panel">
        <h3 class="panel-title">装备栏</h3>
        <ul class="equip-slots" data-slot="slots"></ul>
        <dl class="equip-total" data-slot="total"></dl>
      </section>

      <section class="panel equip-bag-panel">
        <div class="panel-title-row">
          <h3 class="panel-title">背包 <span class="panel-count" data-slot="bag-count"></span></h3>
          <div class="bag-tools">
            <label class="visually-hidden" for="bag-sort">排序</label>
            <select id="bag-sort" data-slot="sort">
              <option value="score">按评分</option>
              <option value="rarity">按品质</option>
              <option value="slot">按部位</option>
            </select>
            <button type="button" data-act="salvage-worn" class="btn-ghost">分解破损与普通</button>
          </div>
        </div>
        <ul class="bag-list" data-slot="bag"></ul>
      </section>

      <section class="panel equip-detail-panel">
        <h3 class="panel-title">详情</h3>
        <div data-slot="detail"><p class="panel-note">选择一件装备查看详情与对比。</p></div>
      </section>
    </div>
  `;

  const slots = {
    capacity: element.querySelector('[data-slot="capacity"]'),
    slotList: element.querySelector('[data-slot="slots"]'),
    total: element.querySelector('[data-slot="total"]'),
    bag: element.querySelector('[data-slot="bag"]'),
    bagCount: element.querySelector('[data-slot="bag-count"]'),
    detail: element.querySelector('[data-slot="detail"]'),
    sort: element.querySelector('[data-slot="sort"]'),
  };

  let selectedId = null;

  function gearChip(gear) {
    const rarity = rarityOf(gear);
    const enhance = gear.enhanceLevel > 0 ? ` +${gear.enhanceLevel}` : '';
    return `<span class="gear-name ${rarity.cls}">${escapeHtml(gear.name)}${enhance}</span>`;
  }

  function renderSlots(state) {
    const equipment = state.player.equipment;
    slots.slotList.innerHTML = EQUIP_SLOTS.map((slot) => {
      const gear = equipment[slot];
      if (gear === null || gear === undefined) {
        return `
          <li class="equip-slot is-empty">
            <span class="equip-slot-name">${EQUIP_SLOT_NAMES[slot]}</span>
            <span class="equip-slot-body">未装备</span>
          </li>`;
      }
      const selected = gear.id === selectedId;
      return `
        <li class="equip-slot ${selected ? 'is-selected' : ''}">
          <span class="equip-slot-name">${EQUIP_SLOT_NAMES[slot]}</span>
          <span class="equip-slot-body">
            <button type="button" class="gear-link" data-select="${escapeHtml(gear.id)}">
              ${gearChip(gear)}
            </button>
            <span class="gear-stats">${escapeHtml(describeGear(gear))}</span>
          </span>
          <button type="button" class="btn-ghost" data-unequip="${slot}">卸下</button>
        </li>`;
    }).join('');
  }

  function renderTotal(state) {
    const p = state.player;
    slots.total.innerHTML = `
      <div><dt>等级</dt><dd>Lv.${p.level}</dd></div>
      <div><dt>生命</dt><dd>${formatNumber(p.hp)} / ${formatNumber(p.maxHp)}</dd></div>
      <div><dt>攻击</dt><dd>${formatNumber(p.attack)}</dd></div>
      <div><dt>防御</dt><dd>${formatNumber(p.defense)}</dd></div>
      <div><dt>暴击</dt><dd>${((p.critChance ?? 0) * 100).toFixed(1)}%</dd></div>
      <div><dt>碎片</dt><dd>${formatNumber(state.fateShards)}</dd></div>
    `;
  }

  function sortedInventory(state) {
    const list = [...state.player.inventory];
    const mode = slots.sort.value;
    if (mode === 'rarity') {
      list.sort((a, b) => b.rarityIndex - a.rarityIndex || b.score - a.score);
    } else if (mode === 'slot') {
      list.sort(
        (a, b) => EQUIP_SLOTS.indexOf(a.slot) - EQUIP_SLOTS.indexOf(b.slot) || b.score - a.score,
      );
    } else {
      list.sort((a, b) => b.score - a.score);
    }
    return list;
  }

  function renderBag(state) {
    const list = sortedInventory(state);
    slots.bagCount.textContent = `${state.player.inventory.length} / ${INVENTORY_CAPACITY}`;
    slots.capacity.textContent = `背包 ${state.player.inventory.length} / ${INVENTORY_CAPACITY} · 碎片 ${formatNumber(
      state.fateShards,
    )}`;

    if (list.length === 0) {
      slots.bag.innerHTML = '<li class="bag-item is-empty">背包是空的。战斗胜利与商店都能获得装备。</li>';
      return;
    }

    slots.bag.innerHTML = list
      .map((gear) => {
        const equipped = state.player.equipment[gear.slot];
        const better = equipped === null || equipped === undefined ? true : gear.score > equipped.score;
        return `
        <li class="bag-item ${gear.id === selectedId ? 'is-selected' : ''}">
          <button type="button" class="bag-main" data-select="${escapeHtml(gear.id)}">
            <span class="bag-line">
              ${gearChip(gear)}
              <span class="bag-slot">${EQUIP_SLOT_NAMES[gear.slot]}</span>
              ${better ? '<span class="bag-up" title="评分高于当前装备">▲</span>' : ''}
            </span>
            <span class="gear-stats">${escapeHtml(describeGear(gear))}</span>
          </button>
          <span class="bag-actions">
            <button type="button" class="btn-primary" data-equip="${escapeHtml(gear.id)}">装备</button>
            <button type="button" class="btn-danger" data-salvage="${escapeHtml(gear.id)}"
              title="回收 ${salvageValue(gear)} 碎片">分解</button>
          </span>
        </li>`;
      })
      .join('');
  }

  /** 找到选中的装备（背包或装备栏）。 */
  function findSelected(state) {
    for (const slot of EQUIP_SLOTS) {
      const gear = state.player.equipment[slot];
      if (gear !== null && gear !== undefined && gear.id === selectedId) {
        return { gear, equipped: true };
      }
    }
    const gear = state.player.inventory.find((g) => g.id === selectedId);
    return gear === undefined ? null : { gear, equipped: false };
  }

  function diffRow(label, next, current) {
    const delta = next - current;
    const sign = delta > 0 ? '+' : '';
    const cls = delta > 0 ? 'is-up' : delta < 0 ? 'is-down' : '';
    return `
      <div>
        <dt>${label}</dt>
        <dd>${formatNumber(next)}
          ${delta === 0 ? '' : `<span class="diff ${cls}">${sign}${formatNumber(delta)}</span>`}
        </dd>
      </div>`;
  }

  function renderDetail(state) {
    const found = findSelected(state);
    if (found === null) {
      selectedId = null;
      slots.detail.innerHTML = '<p class="panel-note">选择一件装备查看详情与对比。</p>';
      return;
    }

    const { gear, equipped } = found;
    const rarity = rarityOf(gear);
    const current = equipped ? null : state.player.equipment[gear.slot];
    const cost = enhanceCost(gear);
    const canEnhance = gear.enhanceLevel < ENHANCE_MAX;
    const affordable = state.fateShards >= cost;

    const comparison =
      current === null || current === undefined
        ? ''
        : `
      <h4 class="detail-heading">与当前 ${EQUIP_SLOT_NAMES[gear.slot]} 对比</h4>
      <p class="detail-current">当前：${gearChip(current)}</p>
      <dl class="detail-diff">
        ${diffRow('攻击', gear.stats.attack, current.stats.attack)}
        ${diffRow('防御', gear.stats.defense, current.stats.defense)}
        ${diffRow('生命', gear.stats.maxHp, current.stats.maxHp)}
        ${diffRow('暴击(0.1%)', gear.stats.crit, current.stats.crit)}
        ${diffRow('评分', gear.score, current.score)}
      </dl>`;

    slots.detail.innerHTML = `
      <p class="detail-title">${gearChip(gear)}</p>
      <p class="detail-meta">
        <span class="tag ${rarity.cls}">${rarity.name}</span>
        <span class="tag">${EQUIP_SLOT_NAMES[gear.slot]}</span>
        <span class="tag">第 ${gear.floorNumber} 层产出</span>
        ${equipped ? '<span class="tag is-added">已装备</span>' : ''}
      </p>
      <dl class="detail-stats">
        <div><dt>攻击</dt><dd>${formatNumber(gear.stats.attack)}</dd></div>
        <div><dt>防御</dt><dd>${formatNumber(gear.stats.defense)}</dd></div>
        <div><dt>生命</dt><dd>${formatNumber(gear.stats.maxHp)}</dd></div>
        <div><dt>暴击</dt><dd>+${(gear.stats.crit / 10).toFixed(1)}%</dd></div>
        <div><dt>强化</dt><dd>+${gear.enhanceLevel} / ${ENHANCE_MAX}</dd></div>
        <div><dt>评分</dt><dd>${formatNumber(gear.score)}</dd></div>
      </dl>
      ${comparison}
      <div class="detail-actions">
        ${
          equipped
            ? `<button type="button" class="btn-ghost" data-unequip="${gear.slot}">卸下</button>`
            : `<button type="button" class="btn-primary" data-equip="${escapeHtml(gear.id)}">装备</button>`
        }
        <button type="button" class="btn-ghost" data-enhance="${escapeHtml(gear.id)}"
          ${!canEnhance || !affordable ? 'disabled' : ''}>
          ${canEnhance ? `强化（${cost} 碎片）` : '已满强化'}
        </button>
        ${
          equipped
            ? ''
            : `<button type="button" class="btn-danger" data-salvage="${escapeHtml(gear.id)}">分解（+${salvageValue(
                gear,
              )}）</button>`
        }
      </div>
      <p class="panel-note">强化不会失败：确定性区不引入概率消耗，费用随等级递增。</p>
    `;
  }

  function render() {
    const state = getState();
    renderSlots(state);
    renderTotal(state);
    renderBag(state);
    renderDetail(state);
  }

  slots.sort.addEventListener('change', render);

  element.addEventListener('click', (event) => {
    const target = event.target;

    const selectId = target.closest?.('[data-select]')?.getAttribute('data-select');
    if (selectId !== null && selectId !== undefined) {
      selectedId = selectId;
      render();
      return;
    }

    const equipId = target.getAttribute?.('data-equip');
    if (equipId !== null && equipId !== undefined) {
      const result = onEquip(equipId);
      if (!result.ok) onToast?.('无法装备', 'warn');
      render();
      return;
    }

    const unequipSlot = target.getAttribute?.('data-unequip');
    if (unequipSlot !== null && unequipSlot !== undefined) {
      const result = onUnequip(unequipSlot);
      if (!result.ok) {
        onToast?.(result.reason === 'inventoryFull' ? '背包已满，先分解一些装备' : '无法卸下', 'warn');
      }
      render();
      return;
    }

    const salvageId = target.getAttribute?.('data-salvage');
    if (salvageId !== null && salvageId !== undefined) {
      const result = onSalvage(salvageId);
      if (result.ok) {
        onToast?.(`回收 ${result.gained} 枚碎片`, 'info');
        if (selectedId === salvageId) selectedId = null;
      }
      render();
      return;
    }

    const enhanceId = target.getAttribute?.('data-enhance');
    if (enhanceId !== null && enhanceId !== undefined) {
      const result = onEnhance(enhanceId);
      if (!result.ok) {
        onToast?.(result.reason === 'insufficientShards' ? '碎片不足' : '已达强化上限', 'warn');
      } else {
        onToast?.(`强化至 +${result.level}`, 'info');
      }
      render();
      return;
    }

    if (target.getAttribute?.('data-act') === 'salvage-worn') {
      const state = getState();
      // 只批量分解破损(0)与普通(1)，更高品质要求逐件确认 —— 批量误删是不可逆损失
      const ids = state.player.inventory.filter((g) => g.rarityIndex <= 1).map((g) => g.id);
      if (ids.length === 0) {
        onToast?.('没有可批量分解的低品质装备', 'info');
        return;
      }
      let gained = 0;
      for (const id of ids) {
        const result = onSalvage(id);
        if (result.ok) gained += result.gained;
      }
      onToast?.(`分解 ${ids.length} 件，回收 ${gained} 枚碎片`, 'info');
      render();
    }
  });

  return { element, render };
}
