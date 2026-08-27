/**
 * 官方事件（规格 5.4 eventId）。
 *
 * 事件在探索模式触发，choices[].apply(state) 直接修改探索状态。
 * 设计原则：每个事件都是"取舍"而非纯赠礼，让 8% 的事件节点有决策价值。
 */

export const OFFICIAL_EVENTS = [
  {
    id: 'event.stele',
    name: '歧路石碑',
    text: '一块半塌的石碑刻着无法辨读的文字。你伸手触碰时，掌心传来刺痛。',
    weight: 12,
    choices: [
      {
        label: '以血为墨',
        description: '失去 15% 当前生命，获得 25 命运碎片。',
        apply(state) {
          state.player.hp = Math.max(1, state.player.hp - Math.floor(state.player.hp * 0.15));
          state.fateShards += 25;
          state.metadata.shardsEarned += 25;
        },
      },
      { label: '转身离开', description: '什么也不发生。', apply() {} },
    ],
  },
  {
    id: 'event.satchel',
    name: '无主行囊',
    text: '路边横着一只鼓胀的行囊，主人不知所踪。',
    weight: 14,
    choices: [
      {
        label: '取走碎片',
        description: '获得 20 命运碎片。',
        apply(state) {
          state.fateShards += 20;
          state.metadata.shardsEarned += 20;
        },
      },
      {
        label: '翻找药品',
        description: '恢复 30% 最大生命。',
        apply(state) {
          state.player.hp = Math.min(state.player.maxHp, state.player.hp + Math.floor(state.player.maxHp * 0.3));
        },
      },
    ],
  },
  {
    id: 'event.well',
    name: '低吟古井',
    text: '井底传来规律的低吟，像是某种呼吸。',
    weight: 10,
    choices: [
      {
        label: '饮下井水',
        description: '永久提升 40 生命上限，但失去 10% 当前生命。',
        apply(state) {
          state.player.maxHp += 40;
          state.player.hp = Math.max(1, state.player.hp - Math.floor(state.player.hp * 0.1));
        },
      },
      {
        label: '投入碎片',
        description: '消耗 20 碎片，永久提升 6 点攻击。碎片不足则无事发生。',
        apply(state) {
          if (state.fateShards >= 20) {
            state.fateShards -= 20;
            state.player.attack += 6;
          }
        },
      },
      { label: '不予理会', description: '什么也不发生。', apply() {} },
    ],
  },
  {
    id: 'event.mural',
    name: '褪色壁画',
    text: '壁画描绘着一场早已被遗忘的战争。凝视越久，画中细节越多。',
    weight: 11,
    choices: [
      {
        label: '研读战术',
        description: '永久提升 5 点攻击与 3 点防御。',
        apply(state) {
          state.player.attack += 5;
          state.player.defense += 3;
        },
      },
      {
        label: '刮下颜料',
        description: '获得 18 命运碎片。',
        apply(state) {
          state.fateShards += 18;
          state.metadata.shardsEarned += 18;
        },
      },
    ],
  },
  {
    id: 'event.shrine',
    name: '倾颓神龛',
    text: '神像的面容已被磨平，供台上仍残留着新鲜的供品。',
    weight: 9,
    choices: [
      {
        label: '献上碎片',
        description: '消耗 30 碎片，完全恢复生命。碎片不足则无事发生。',
        apply(state) {
          if (state.fateShards >= 30) {
            state.fateShards -= 30;
            state.player.hp = state.player.maxHp;
          }
        },
      },
      {
        label: '取走供品',
        description: '恢复 20% 生命，但失去 5 点防御。',
        apply(state) {
          state.player.hp = Math.min(state.player.maxHp, state.player.hp + Math.floor(state.player.maxHp * 0.2));
          state.player.defense = Math.max(0, state.player.defense - 5);
        },
      },
    ],
  },
  {
    id: 'event.gambler',
    name: '蒙面赌徒',
    text: '一个蒙面人邀你赌一局，赌注是你的运气。',
    weight: 8,
    choices: [
      {
        label: '押上一半碎片',
        description: '碎片翻倍或全失，各半机会。由当前碎片数奇偶决定（确定性）。',
        apply(state) {
          // 用状态自身的确定性属性判定，不消费随机数：
          // 探索期不应消费战斗流，且这样玩家可以推理结果
          if ((state.fateShards + state.metadata.nodesVisited) % 2 === 0) {
            state.fateShards *= 2;
          } else {
            state.fateShards = Math.floor(state.fateShards / 2);
          }
        },
      },
      { label: '拒绝', description: '什么也不发生。', apply() {} },
    ],
  },
];
