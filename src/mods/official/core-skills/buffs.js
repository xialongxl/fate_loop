/**
 * 官方 Buff 定义表（规格 5.2）。
 *
 * 每个 Buff 只声明乘数修正，由 core/buffs.js 在结算时查表。
 * 数值取"每层线性叠加"，例如 attackMul 1.15 的 2 层 = 1.30 倍。
 */

export const OFFICIAL_BUFFS = [
  // ---- 增益 ----
  {
    id: 'blade.momentum',
    name: '势能',
    description: '连击积累的攻势，每层提升 8% 攻击力。',
    attackMul: 1.08,
    isDebuff: false,
  },
  {
    id: 'buff.fortified',
    name: '坚壁',
    description: '每层提升 15% 防御力。',
    defenseMul: 1.15,
    isDebuff: false,
  },
  {
    id: 'buff.trance',
    name: '战斗恍惚',
    description: '每层提升 20% 输出，但受到伤害增加 10%。',
    damageDealtMul: 1.2,
    damageTakenMul: 1.1,
    isDebuff: false,
  },
  {
    id: 'buff.blazing',
    name: '炽魂',
    description: '每层提升 18% 攻击力。',
    attackMul: 1.18,
    isDebuff: false,
  },
  {
    id: 'buff.charged',
    name: '充能',
    description: '每层提升 12% 输出。',
    damageDealtMul: 1.12,
    isDebuff: false,
  },
  {
    id: 'buff.blessed',
    name: '神恩',
    description: '每层减少 10% 受到伤害并提升 15% 治疗效果。',
    damageTakenMul: 0.9,
    healMul: 1.15,
    isDebuff: false,
  },
  {
    id: 'buff.shrouded',
    name: '影蔽',
    description: '每层减少 12% 受到伤害。',
    damageTakenMul: 0.88,
    isDebuff: false,
  },
  {
    id: 'buff.frostArmor',
    name: '霜甲',
    description: '每层提升 20% 防御力。',
    defenseMul: 1.2,
    isDebuff: false,
  },

  // ---- 减益 ----
  {
    id: 'debuff.weakened',
    name: '虚弱',
    description: '每层降低 12% 攻击力。',
    attackMul: 0.88,
    isDebuff: true,
  },
  {
    id: 'debuff.brittle',
    name: '脆化',
    description: '每层降低 15% 防御力。',
    defenseMul: 0.85,
    isDebuff: true,
  },
  {
    id: 'debuff.burning',
    name: '引燃',
    description: '每层使受到伤害增加 10%。',
    damageTakenMul: 1.1,
    isDebuff: true,
  },
  {
    id: 'debuff.chilled',
    name: '冰缓',
    description: '每层降低 10% 攻击力与 8% 防御力。',
    attackMul: 0.9,
    defenseMul: 0.92,
    isDebuff: true,
  },
  {
    id: 'debuff.paralyzed',
    name: '麻痹',
    description: '每层降低 18% 输出。',
    damageDealtMul: 0.82,
    isDebuff: true,
  },
  {
    id: 'debuff.decay',
    name: '衰败',
    description: '每层降低 20% 治疗效果并使受到伤害增加 8%。',
    healMul: 0.8,
    damageTakenMul: 1.08,
    isDebuff: true,
  },
];
