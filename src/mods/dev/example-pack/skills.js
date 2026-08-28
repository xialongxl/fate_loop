/**
 * 示例包的技能。注意 ctx 提供的是**高层能力**（ctx.damage / ctx.applyBuff / …），
 * 不是 Symbol —— 第三方包拿不到宿主内部标识，也不该拿。
 * 见 docs/模组沙箱与包格式设计.md §5.1 与 src/mods/fate-shim.js 的 CTX_CAPABILITIES。
 */
import { SKILL_TYPE, SKILL_RANGE } from 'fate';

const MARK = 'void.mark';

/**
 * 导出数组而不是"导入即注册"：注册必须发生在 fate.begin() 之后，
 * 而 import 的求值顺序在 begin 之前 —— 所以由 index.js 统一登记。
 */
export const VOID_SKILLS = [
{
  id: 'void.rift',
  name: '虚空裂隙',
  description: '撕开一道裂隙，造成 1.05 倍攻击力的伤害。',
  type: SKILL_TYPE.GCD,
  gcdCost: 2.4, // 秒；normalize 会换算成整数毫秒并校验 16ms 对齐
  range: SKILL_RANGE.SINGLE,
  power: 1.05,
  tags: ['void'],
  execute(ctx, self, targets) {
    for (const target of targets) {
      const result = ctx.damage({ sourceId: self.id, targetId: target.id, amount: self.attack * 1.05 });
      ctx.sound(result.isCrit ? 'combat.crit' : 'combat.hit');
    }
  },
},
{
  id: 'void.collapse',
  name: '裂隙坍缩',
  description: '1.4 倍伤害，并给目标叠 2 层虚空印记（8 秒）。',
  type: SKILL_TYPE.GCD,
  gcdCost: 3.2,
  range: SKILL_RANGE.SINGLE,
  power: 1.4,
  tags: ['void', 'debuff'],
  buffId: MARK,
  buffDuration: 8, // 供图鉴与 UI 展示；实际时长由 execute 里的 applyBuff 决定
  // 目标还健康时才用来开印，残血交给 void.ruin 收尾
  condition: (ctx, self, targets) =>
    targets.length > 0 && targets[0].hp / targets[0].maxHp > 0.35,
  execute(ctx, self, targets) {
    for (const target of targets) {
      ctx.damage({ sourceId: self.id, targetId: target.id, amount: self.attack * 1.4 });
      ctx.applyBuff({ targetId: target.id, buffId: MARK, stacks: 2, durationMs: 8000 });
      ctx.log(`${self.name} 在 ${target.name} 身上刻下虚空印记`);
    }
  },
},
{
  id: 'void.ruin',
  name: '湮灭',
  description: '引爆目标全部虚空印记：每层追加 25% 倍率。',
  type: SKILL_TYPE.GCD,
  gcdCost: 2.4,
  range: SKILL_RANGE.SINGLE,
  power: 2.2,
  tags: ['void', 'execute'],
  condition: (ctx, self, targets) =>
    targets.length > 0 && targets[0].hp / targets[0].maxHp < 0.35,
  execute(ctx, self, targets) {
    for (const target of targets) {
      // 读运行时状态 → 倍率随层数走。这类"看状态再算"正是 JSON 词汇表做不到的地方。
      // 用 ctx.buffStacks 而不是自己摸 buffs：后者跨沙箱边界形状不同，容易静默拿 0
      const stacks = ctx.buffStacks(target, MARK);
      ctx.damage({ sourceId: self.id, targetId: target.id, amount: self.attack * (1 + 0.25 * stacks) });
      if (stacks > 0) ctx.removeBuff({ targetId: target.id, buffId: MARK });
    }
  },
},
{
  id: 'void.eclipse',
  name: '蚀',
  description: '随机吞噬一个敌人（1.6 倍）。oGCD，不占循环。',
  type: SKILL_TYPE.OGCD,
  cooldown: 12, // oGCD 用 cooldown
  range: SKILL_RANGE.RANDOM_ENEMY, // 该 range 会消费一次战斗流随机数
  priority: 40,
  power: 1.6,
  tags: ['void', 'ogcd', 'burst'],
  execute(ctx, self, targets) {
    for (const target of targets) {
      ctx.damage({ sourceId: self.id, targetId: target.id, amount: self.attack * 1.6 });
    }
  },
},
{
  id: 'void.siphon',
  name: '虹吸',
  description: '自身生命低于 45% 时回复 14% 最大生命。',
  type: SKILL_TYPE.GCD,
  gcdCost: 2.4,
  range: SKILL_RANGE.SELF,
  power: 0.14,
  tags: ['void', 'heal'],
  condition: (ctx, self) => self.hp / self.maxHp < 0.45,
  execute(ctx, self) {
    ctx.heal({ sourceId: self.id, targetId: self.id, amount: self.maxHp * 0.14 });
    ctx.sound('combat.heal');
  },
},
];
