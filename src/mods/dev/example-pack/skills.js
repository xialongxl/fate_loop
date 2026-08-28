/**
 * 示例模组：流派注册 + Buff + 技能。
 *
 * 三件事值得注意：
 *
 * 1. **不 import 官方 helpers，也不用碰 core 内部。** 契约符号由 setup 的
 *    `context.contracts` 提供（见 setup.js），所以这个文件除了常量以外零依赖。
 *    官方技能用的是 core-skills/helpers.js 里的工厂，那只是官方自己的便利品，
 *    不是模组接口。
 *
 * 2. **时间量以「秒」书写。** normalize 阶段会换算成整数毫秒并强制对齐 16ms
 *    （STEP_MS）。写 2.5 可以，写 2.50001 会在加载期直接报错 —— 这是裁决 4，
 *    为的是 1x / 4x / MAX 三种倍速结果逐位一致。
 *
 * 3. **execute 必须同步，且只能用契约产生副作用。** async 会被 normalize 拒绝。
 *    想读状态用 `contracts.stateQuery`，想随机用 `context.rng()`（它走战斗流，
 *    每次调用都会推进随机序列 —— 因此"什么时候摇骰子"是确定性的一部分）。
 */

/** 新流派注册。id 会进 pool.families，参与解锁表的流派轮转。 */
export const EXAMPLE_FAMILY = Object.freeze({ id: 'void', label: '虚空' });

/** Buff 定义。至少要有一个乘数字段，否则加载期报错（零效果的 Buff 该删）。 */
export const EXAMPLE_BUFFS = Object.freeze([
  Object.freeze({
    id: 'example.voidmark',
    name: '虚空印记',
    description: '被虚空侵蚀的目标，受到伤害提升 12%（每层叠加）。',
    isDebuff: true,
    damageTakenMul: 1.12,
  }),
]);

/** 条件谓词。模组自己写就行，不必依赖官方 helpers。 */
const when = Object.freeze({
  hpBelow: (ratio) => (context, self) => self.hp / self.maxHp < ratio,
  targetHpBelow: (ratio) => (context, self, targets) =>
    targets.length > 0 && targets[0].hp / targets[0].maxHp < ratio,
  lacksBuff: (buffId) => (context, self) => {
    const buff = self.buffs.get(buffId);
    return buff === undefined || context.virtualTime >= buff.expiresAtMs;
  },
});

/**
 * 构造技能定义。
 * @param {Record<string, symbol>} contracts setup 注入的契约映射
 */
export function buildExampleSkills(contracts) {
  return [
    {
      id: 'void.rift',
      name: '虚空裂隙',
      description: '撕开一道裂隙，造成 1.05 倍攻击力的伤害，并为后续技能铺印记。',
      type: 'GCD',
      gcdCost: 2.4, // 秒；2400 % 16 === 0 ✓
      range: 'single',
      tags: ['void'],
      power: 1.05,
      soundId: 'combat.hit',
      condition: null,
      buffId: null,
      execute(context, self, targets) {
        const damage = context.get(contracts.damageApply);
        const audio = context.get(contracts.audioPlay);
        for (const target of targets) {
          const result = damage({ sourceId: self.id, targetId: target.id, amount: self.attack * 1.05 });
          audio({ soundId: result.isCrit ? 'combat.crit' : 'combat.hit' });
        }
      },
    },

    {
      id: 'void.collapse',
      name: '裂隙坍缩',
      description: '高倍伤害，并给目标叠 2 层虚空印记（持续 8 秒）。',
      type: 'GCD',
      gcdCost: 3.2,
      range: 'single',
      tags: ['void', 'debuff'],
      power: 1.4,
      soundId: 'combat.hit',
      buffId: 'example.voidmark', // 引用未注册的 Buff 会在加载期被拦下
      buffDuration: 8,
      // 只在目标还健康时用来开印；残血交给 void.execute 收尾
      condition: (context, self, targets) =>
        targets.length > 0 && targets[0].hp / targets[0].maxHp > 0.35,
      execute(context, self, targets) {
        const damage = context.get(contracts.damageApply);
        const applyBuff = context.get(contracts.buffApply);
        const log = context.get(contracts.combatLog);
        for (const target of targets) {
          damage({ sourceId: self.id, targetId: target.id, amount: self.attack * 1.4 });
          applyBuff({ targetId: target.id, buffId: 'example.voidmark', stacks: 2, durationMs: 8000 });
          log(`${self.name} 在 ${target.name} 身上刻下虚空印记`);
        }
      },
    },

    {
      id: 'void.execute',
      name: '湮灭',
      description: '对生命低于 35% 的目标出手，倍率 2.2。',
      type: 'GCD',
      gcdCost: 2.4,
      range: 'single',
      tags: ['void', 'execute'],
      power: 2.2,
      soundId: 'combat.hit',
      condition: when.targetHpBelow(0.35),
      execute(context, self, targets) {
        const damage = context.get(contracts.damageApply);
        for (const target of targets) {
          damage({ sourceId: self.id, targetId: target.id, amount: self.attack * 2.2 });
        }
      },
    },

    {
      id: 'void.eclipse',
      name: '蚀',
      description: '随机吞噬一个敌人（1.6 倍）。oGCD，不占循环。',
      type: 'oGCD',
      cooldown: 12, // oGCD 用 cooldown，不用 gcdCost
      range: 'randomEnemy', // 该 range 会消费一次战斗流随机数
      tags: ['void', 'ogcd', 'burst'],
      priority: 40,
      power: 1.6,
      soundId: 'combat.hit',
      execute(context, self, targets) {
        const damage = context.get(contracts.damageApply);
        for (const target of targets) {
          damage({ sourceId: self.id, targetId: target.id, amount: self.attack * 1.6 });
        }
      },
    },

    {
      id: 'void.siphon',
      name: '虹吸',
      description: '自身生命低于 45% 时回复 14% 最大生命。',
      type: 'GCD',
      gcdCost: 2.4,
      range: 'self',
      tags: ['void', 'heal'],
      power: 0.14,
      soundId: 'combat.heal',
      condition: when.hpBelow(0.45),
      execute(context, self) {
        const heal = context.get(contracts.healApply);
        const audio = context.get(contracts.audioPlay);
        heal({ sourceId: self.id, targetId: self.id, amount: self.maxHp * 0.14 });
        audio({ soundId: 'combat.heal' });
      },
    },
  ];
}
