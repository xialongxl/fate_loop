/**
 * 官方商店商品（决定 A）。
 *
 * apply(state) 直接修改探索状态 —— 商店发生在探索模式，不在战斗中，因此
 * 不经过战斗契约。引擎负责扣除命运碎片，商品只负责施加效果。
 */

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
      state.player.maxHp += 60;
      state.player.hp += 60;
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
      state.player.attack += 8;
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
      state.player.defense += 4;
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
      state.player.maxHp += 30;
      state.player.hp += 30;
      state.player.attack += 4;
      state.player.defense += 2;
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
      state.player.attack += 16;
      state.player.maxHp = Math.max(50, state.player.maxHp - 40);
      state.player.hp = Math.min(state.player.hp, state.player.maxHp);
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
      state.player.maxHp += 100;
      state.player.hp += 100;
      state.player.defense += 6;
      state.player.attack = Math.max(1, state.player.attack - 4);
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
