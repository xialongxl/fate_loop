/**
 * 官方商店商品（决定 A）。
 *
 * apply(state) 直接修改探索状态 —— 商店发生在探索模式，不在战斗中，因此
 * 不经过战斗契约。引擎负责扣除命运碎片、并在 apply 后统一 recalcPlayer，
 * 商品只负责施加效果。
 *
 * 重要：maxHp / attack / defense / critChance 是派生值，写它们等于写空气
 * （下一次 recalc 就没了）。「永久提升」必须走 addPermanentBonus。
 * hp 不是派生值，可以直接写，但 recalc 会保持「缺失量」，因此加上限自然回血。
 */

import { addPermanentBonus } from '../../../core/derived.js';

export const OFFICIAL_SHOP_ITEMS = [
  {
    id: 'shop.heal.small',
    name: '草药束',
    description: '立即恢复 25% 最大生命。',
    cost: 15,
    kind: 'consumable',
    weight: 16,
    apply(state) {
      state.player.hp = Math.min(state.player.maxHp, state.player.hp + Math.floor(state.player.maxHp * 0.25));
    },
  },
  {
    id: 'shop.heal.large',
    name: '灵泉之水',
    description: '立即恢复 60% 最大生命。',
    cost: 35,
    kind: 'consumable',
    weight: 12,
    apply(state) {
      state.player.hp = Math.min(state.player.maxHp, state.player.hp + Math.floor(state.player.maxHp * 0.6));
    },
  },
  {
    id: 'shop.stat.maxHp',
    name: '磐石之核',
    description: '永久提升 60 点生命上限，并回复等量生命。',
    cost: 40,
    kind: 'upgrade',
    weight: 14,
    apply(state) {
      addPermanentBonus(state.player, { maxHp: 60 });
    },
  },
  {
    id: 'shop.stat.attack',
    name: '锐化油石',
    description: '永久提升 8 点攻击力。',
    cost: 45,
    kind: 'upgrade',
    weight: 14,
    apply(state) {
      addPermanentBonus(state.player, { attack: 8 });
    },
  },
  {
    id: 'shop.stat.defense',
    name: '铸铁护片',
    description: '永久提升 4 点防御力。',
    cost: 38,
    kind: 'upgrade',
    weight: 13,
    apply(state) {
      addPermanentBonus(state.player, { defense: 4 });
    },
  },
  {
    id: 'shop.stat.balanced',
    name: '命运护符',
    description: '永久提升 30 生命上限、4 攻击、2 防御。',
    cost: 55,
    kind: 'upgrade',
    weight: 10,
    apply(state) {
      addPermanentBonus(state.player, { maxHp: 30, attack: 4, defense: 2 });
    },
  },
  {
    id: 'shop.stat.glass',
    name: '狂徒之刃',
    description: '提升 16 点攻击力，但降低 40 点生命上限。',
    cost: 42,
    kind: 'upgrade',
    weight: 8,
    apply(state) {
      addPermanentBonus(state.player, { attack: 16, maxHp: -40 });
    },
  },
  {
    id: 'shop.stat.bulwark',
    name: '守誓壁垒',
    description: '提升 100 点生命上限与 6 点防御，但降低 4 点攻击。',
    cost: 50,
    kind: 'upgrade',
    weight: 8,
    apply(state) {
      addPermanentBonus(state.player, { maxHp: 100, defense: 6, attack: -4 });
    },
  },
  {
    id: 'shop.full.restore',
    name: '轮回沙漏',
    description: '完全恢复生命。',
    cost: 60,
    kind: 'consumable',
    weight: 7,
    apply(state) {
      state.player.hp = state.player.maxHp;
    },
  },
];
