/**
 * 示例模组：怪物、遭遇、商店商品、事件。
 *
 * 怪物与遭遇演示"引用官方内容"：本模组的怪物用官方技能排循环，遭遇里
 * 混了一只官方怪物。跨引用在全部模组加载完后统一校验（loader 的
 * validatePoolReferences），写错 ID 会在启动时直接报"悬空引用"而不是静默失效。
 */

import { addPermanentBonus } from '../../../core/derived.js';

export const EXAMPLE_MONSTERS = Object.freeze([
  Object.freeze({
    id: 'mon.void.riftling',
    name: '虚空裂崽',
    maxHp: 74,
    attack: 21,
    defense: 5,
    // 引用官方技能 + 本模组技能：混合排布是允许的
    gcdSequence: ['void.rift', 'blade.jab', 'void.collapse'],
    ogcdSlots: [{ skillId: 'void.eclipse', priority: 40 }],
    tier: 'normal',
    tags: ['void', 'riftling'],
  }),
  Object.freeze({
    id: 'mon.void.herald',
    name: '虚空先声',
    maxHp: 168,
    attack: 26,
    defense: 9,
    gcdSequence: ['void.siphon', 'void.collapse', 'void.execute', 'void.rift'],
    ogcdSlots: [{ skillId: 'void.eclipse', priority: 60 }],
    tier: 'elite',
    tags: ['void', 'elite'],
  }),
]);

export const EXAMPLE_ENCOUNTERS = Object.freeze([
  Object.freeze({
    id: 'enc.void.lone',
    name: '独行裂崽',
    tier: 'normal',
    monsterIds: ['mon.void.riftling'],
    minFloor: 1,
    maxFloor: 999, // 与官方模板同样的覆盖区间，否则深层会抽不到
    weight: 4, // 权重低一些：示例内容不该抢走官方遭遇的出场率
  }),
  Object.freeze({
    id: 'enc.void.pair',
    name: '裂隙双子',
    tier: 'normal',
    // 混编：一只本模组怪物 + 一只官方怪物（ID 可在官方 core-monsters/monsters.js 查）
    monsterIds: ['mon.void.riftling', 'mon.void.riftling'],
    minFloor: 3,
    maxFloor: 999,
    weight: 3,
  }),
  Object.freeze({
    id: 'enc.void.herald',
    name: '虚空先声的试炼',
    tier: 'elite',
    monsterIds: ['mon.void.herald'],
    minFloor: 2,
    maxFloor: 999,
    weight: 4,
  }),
]);

/**
 * 商店商品。
 *
 * **永久属性必须走 addPermanentBonus**：maxHp / attack / defense / critChance
 * 是派生值，直接 `state.player.maxHp += 60` 会在下一次 recalcPlayer 时被抹掉
 * （官方内容历史上就踩过这个坑，现在有守卫测试扫这类写法）。
 * hp 不是派生值，可以直接写；但重算会"保持缺失量"，所以加上限等于回等量生命。
 */
export const EXAMPLE_SHOP_ITEMS = Object.freeze([
  {
    id: 'shop.example.voidCore',
    name: '虚空核',
    description: '永久提升 5 点攻击与 25 点生命上限。',
    cost: 58,
    kind: 'upgrade',
    weight: 5,
    apply(state) {
      addPermanentBonus(state.player, { attack: 5, maxHp: 25 });
    },
  },
  {
    id: 'shop.example.mend',
    name: '裂隙缝合剂',
    description: '立即恢复 40% 最大生命。',
    cost: 24,
    kind: 'consumable',
    weight: 6,
    apply(state) {
      state.player.hp = Math.min(state.player.maxHp, state.player.hp + Math.floor(state.player.maxHp * 0.4));
    },
  },
]);

/** 事件：每个选项都必须是"取舍"，而且同样只能用 addPermanentBonus 给永久成长。 */
export const EXAMPLE_EVENTS = Object.freeze([
  {
    id: 'event.example.voidAltar',
    name: '虚空祭坛',
    text: '一座没有影子的祭坛。刻文说：献上碎片者，将被虚空记住。',
    weight: 6,
    choices: [
      {
        label: '献上 30 碎片',
        description: '永久提升 10 点攻击，但生命上限 -20。',
        apply(state) {
          if (state.fateShards < 30) return;
          state.fateShards -= 30;
          addPermanentBonus(state.player, { attack: 10, maxHp: -20 });
        },
      },
      {
        label: '取走供品',
        description: '获得 25 碎片，但失去 15% 当前生命。',
        apply(state) {
          state.fateShards += 25;
          state.metadata.shardsEarned += 25;
          state.player.hp = Math.max(1, state.player.hp - Math.floor(state.player.hp * 0.15));
        },
      },
      { label: '离开', description: '什么也不发生。', apply() {} },
    ],
  },
]);
