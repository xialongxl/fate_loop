/**
 * 示例包的商品与事件。
 *
 * apply(state, ops) 的第二个参数是**绑定到当前探索状态的安全原语**
 * （清单见 fate-shim.js 的 STATE_OPERATIONS）。永久属性必须走
 * ops.permanentBonus —— 直接写 state.player.maxHp 会在下一次 recalcPlayer
 * 时凭空消失（官方内容历史上就踩过，现在有守卫测试扫这种写法）。
 *
 * ⚠️ 第三方包还要知道一条：**这里的 state 是只读快照**。
 * 官方模组能直接改 state（拿到的是活对象），沙箱里的包改不动 ——
 * 快照在 VM 里是深冻的，写它会当场抛 TypeError 并把包摘掉。
 * 这是故意的：静默无效（"我写了血药但没回血"）比报错难查一百倍。
 * 所有效果都必须走 ops。
 */
/** 导出数组，由 index.js 在 fate.begin() 之后统一登记（见 skills.js 的说明）。 */
export const VOID_SHOP_ITEMS = [
{
  id: 'shop.void.core',
  name: '虚空核',
  description: '永久提升 5 点攻击与 25 点生命上限。',
  cost: 58,
  kind: 'upgrade',
  weight: 5,
  apply(state, ops) {
    ops.permanentBonus({ attack: 5, maxHp: 25 });
  },
},

{
  id: 'shop.void.mend',
  name: '裂隙缝合剂',
  description: '立即恢复 40% 最大生命。',
  cost: 24,
  kind: 'consumable',
  weight: 6,
  apply(state, ops) {
    ops.healRatio(0.4);
  },
},
];

export const VOID_EVENTS = [
{
  id: 'event.void.altar',
  name: '虚空祭坛',
  text: '一座没有影子的祭坛。刻文说：献上碎片者，将被虚空记住。',
  weight: 6,
  choices: [
    {
      label: '献上 30 碎片',
      description: '永久 +10 攻击，但生命上限 -20。碎片不足则无事发生。',
      apply(state, ops) {
        if (ops.spendShards(30)) ops.permanentBonus({ attack: 10, maxHp: -20 });
      },
    },
    {
      label: '取走供品',
      description: '获得 25 碎片，但失去 15% 当前生命。',
      apply(state, ops) {
        ops.gainShards(25);
        ops.hpCostRatio(0.15);
      },
    },
    { label: '离开', description: '什么也不发生。', apply() {} },
  ],
},
];
