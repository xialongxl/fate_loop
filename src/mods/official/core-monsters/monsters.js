/**
 * 官方怪物（300 种）。
 *
 * 生成方式：6 个元素族系 × 10 个原型 × 5 个层级 = 300。
 * 全部由纯索引算术构造，不消费任何随机数 —— 内容定义本身必须是确定性的，
 * 随机性只发生在"遭遇池抽取"阶段（遭遇流 PRNG）。
 *
 * 层级设计：
 *   T1 弱小 / T2 普通 / T3 强化 / T4 精英 / T5 首领
 * 属性按层级几何增长，精英与首领额外获得 oGCD 槽位。
 */

/** 族系定义：技能池 + 命名词缀。 */
const FAMILIES = [
  {
    key: 'blade',
    name: '锐锋',
    gcd: ['blade.jab', 'blade.slash', 'blade.cleave', 'blade.pierce', 'blade.overhead', 'blade.whirl'],
    ogcd: ['ogcd.suddenStrike', 'ogcd.crushingBlow', 'ogcd.warcry', 'ogcd.deathSentence'],
    hpBias: 1.0,
    atkBias: 1.1,
    defBias: 1.0,
  },
  {
    key: 'fire',
    name: '燔燎',
    gcd: ['fire.spark', 'fire.ignite', 'fire.fireball', 'fire.flameWave', 'fire.conflagration', 'fire.detonate'],
    ogcd: ['ogcd.meteor', 'ogcd.infernalMark', 'ogcd.blazingSoul', 'ogcd.cataclysm'],
    hpBias: 0.9,
    atkBias: 1.25,
    defBias: 0.85,
  },
  {
    key: 'frost',
    name: '霜蚀',
    gcd: ['frost.shard', 'frost.chill', 'frost.iceLance', 'frost.blizzard', 'frost.glacialSpike', 'frost.brittle'],
    ogcd: ['ogcd.frozenBastion', 'ogcd.massBrittle', 'ogcd.crushingBlow', 'ogcd.cataclysm'],
    hpBias: 1.15,
    atkBias: 0.95,
    defBias: 1.2,
  },
  {
    key: 'shadow',
    name: '幽噬',
    gcd: ['shadow.touch', 'shadow.siphon', 'shadow.bolt', 'shadow.devour', 'shadow.nightfall', 'shadow.curse'],
    ogcd: ['ogcd.bloodfeast', 'ogcd.plague', 'ogcd.shadowVeil', 'ogcd.assassinate'],
    hpBias: 1.05,
    atkBias: 1.05,
    defBias: 0.95,
  },
  {
    key: 'thunder',
    name: '骤雷',
    gcd: [
      'thunder.spark',
      'thunder.bolt',
      'thunder.chain',
      'thunder.arcRandom',
      'thunder.stormfront',
      'thunder.judgment',
    ],
    ogcd: ['ogcd.staticCharge', 'ogcd.multistrike', 'ogcd.swarmVolley', 'ogcd.lateGameNova'],
    hpBias: 0.95,
    atkBias: 1.2,
    defBias: 0.9,
  },
  {
    key: 'order',
    name: '肃律',
    gcd: [
      'order.mend',
      'order.smite',
      'order.restoration',
      'order.consecrate',
      'order.retribution',
      'order.fortify',
    ],
    ogcd: ['ogcd.divineFavor', 'ogcd.ironWill', 'ogcd.steadyRecovery', 'ogcd.fullRestore'],
    hpBias: 1.25,
    atkBias: 0.85,
    defBias: 1.25,
  },
];

/** 原型：决定体型定位与名称主干。 */
const ARCHETYPES = [
  { key: 'wisp', name: '游魂', hp: 0.55, atk: 1.25, def: 0.6 },
  { key: 'hound', name: '猎犬', hp: 0.8, atk: 1.15, def: 0.8 },
  { key: 'sentinel', name: '哨卫', hp: 1.35, atk: 0.8, def: 1.4 },
  { key: 'reaver', name: '掠夺者', hp: 1.0, atk: 1.2, def: 0.9 },
  { key: 'warden', name: '守望者', hp: 1.45, atk: 0.85, def: 1.3 },
  { key: 'seer', name: '窥视者', hp: 0.7, atk: 1.35, def: 0.65 },
  { key: 'brute', name: '巨蛮', hp: 1.6, atk: 1.05, def: 1.05 },
  { key: 'stalker', name: '潜袭者', hp: 0.85, atk: 1.3, def: 0.75 },
  { key: 'herald', name: '先驱', hp: 1.1, atk: 1.1, def: 1.0 },
  { key: 'colossus', name: '巨像', hp: 1.85, atk: 0.95, def: 1.5 },
];

/** 层级：属性倍率 + oGCD 槽位数量。 */
const TIERS = [
  { key: 'T1', name: '残破', mult: 1.0, tier: 'normal', ogcdCount: 0 },
  { key: 'T2', name: '', mult: 1.55, tier: 'normal', ogcdCount: 0 },
  { key: 'T3', name: '狂化', mult: 2.4, tier: 'normal', ogcdCount: 1 },
  { key: 'T4', name: '古老', mult: 3.7, tier: 'elite', ogcdCount: 2 },
  { key: 'T5', name: '君王', mult: 5.8, tier: 'elite', ogcdCount: 3 },
];

const BASE_HP = 90;
const BASE_ATK = 14;
const BASE_DEF = 5;

/**
 * 构造 GCD 序列：从族系技能池按原型索引旋转取 3~5 个。
 * 旋转而非随机，保证同一 id 永远得到同一序列。
 */
function buildGcdSequence(family, archetypeIndex, tierIndex) {
  const pool = family.gcd;
  const length = 3 + ((archetypeIndex + tierIndex) % 3); // 3 ~ 5
  const out = [];
  for (let i = 0; i < length; i += 1) {
    out.push(pool[(archetypeIndex + i * 2 + tierIndex) % pool.length]);
  }
  return out;
}

function buildOgcdSlots(family, archetypeIndex, count) {
  const slots = [];
  for (let i = 0; i < count; i += 1) {
    slots.push({
      skillId: family.ogcd[(archetypeIndex + i) % family.ogcd.length],
      priority: 50 - i * 10,
    });
  }
  return slots;
}

function buildMonsters() {
  const out = [];

  for (const family of FAMILIES) {
    for (let a = 0; a < ARCHETYPES.length; a += 1) {
      const archetype = ARCHETYPES[a];
      for (let t = 0; t < TIERS.length; t += 1) {
        const tier = TIERS[t];

        const displayName =
          tier.name === ''
            ? `${family.name}${archetype.name}`
            : `${tier.name}${family.name}${archetype.name}`;

        out.push({
          id: `mon.${family.key}.${archetype.key}.${tier.key.toLowerCase()}`,
          name: displayName,
          maxHp: Math.round(BASE_HP * family.hpBias * archetype.hp * tier.mult),
          attack: Math.round(BASE_ATK * family.atkBias * archetype.atk * tier.mult),
          defense: Math.round(BASE_DEF * family.defBias * archetype.def * tier.mult),
          gcdSequence: buildGcdSequence(family, a, t),
          ogcdSlots: buildOgcdSlots(family, a, tier.ogcdCount),
          tier: tier.tier,
          tags: [family.key, archetype.key, tier.key],
        });
      }
    }
  }

  return out;
}

export const OFFICIAL_MONSTERS = buildMonsters();
export { FAMILIES, ARCHETYPES, TIERS };
