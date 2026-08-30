/**
 * 示例包的技能。
 *
 * 三条作者最容易踩的规则，都在下面的代码里示范了：
 *  1. 时长用**秒**，加载器换算成毫秒；换算结果必须是 STEP_MS(16ms) 的整数倍
 *  2. 永久属性只能走 `ops.permanentBonus`（见 content.js），直接写 `state.player.*`
 *     会在下一次 recalcPlayer 时凭空消失
 *  3. **技能里不要写 `self.hp = ...`** —— 沙箱递给包的 self/targets 是**深冻快照**，
 *     写它会立刻抛错（这是故意的：静默无效比报错难查一百倍）。
 *     要产生效果只能调 `ctx.damage / ctx.heal / ctx.applyBuff / ...`
 *
 * 最后一条示范是 `void.debt`：**带记忆的机制**。官方技能全是无状态的，而包可以
 * 用模块级变量记住上一次施放 —— 代价是必须配合 `onBattleStart` 清记忆，
 * 否则上一场的状态会漏进下一场，"同种子必得同结果"就只在整局层面成立。
 * 清记忆的地方在 index.js。
 */
import { SKILL_TYPE, SKILL_RANGE } from 'fate';

/**
 * 跨次施放的记忆：目标 id → 上次见到它时的血量。
 *
 * ⚠️ 必须是**模块级**且**每场清空**（index.js 里 onBattleStart 负责 clear）。
 * 不清空的后果不是崩溃，而是"同一张种子地图打两次结果不一样"——那种 bug
 * 查起来会让人怀疑引擎。
 */
export const lastSeenHp = new Map();

export const VOID_SKILLS = [
{
  id: 'void.rift',
  name: '裂隙',
  description: '造成 1.15 倍攻击伤害，并给目标叠一层虚空印记。',
  type: SKILL_TYPE.GCD,
  gcdCost: 2.4,
  range: SKILL_RANGE.SINGLE,
  power: 1.15,
  tags: ['void'],
  execute(ctx, self, targets) {
    for (const target of targets) {
      ctx.damage({ sourceId: self.id, targetId: target.id, amount: self.attack * 1.15, element: 'shadow' });
      ctx.applyBuff({ targetId: target.id, buffId: 'void.mark', stacks: 1, durationMs: 8000 });
    }
  },
},
{
  id: 'void.collapse',
  name: '崩解',
  description: '全场伤害；目标身上每层虚空印记额外加 8% 伤害。',
  type: SKILL_TYPE.GCD,
  gcdCost: 3.2,
  range: SKILL_RANGE.ALL_ENEMIES,
  power: 0.9,
  buffId: 'void.mark',
  buffStacks: 1,
  buffDuration: 8,
  tags: ['void', 'aoe'],
  execute(ctx, self, targets) {
    for (const target of targets) {
      // 读层数走 ctx.buffStacks —— 别去 query 路径：实体 id 含点，路径按 '.' 分段必挂
      const stacks = ctx.buffStacks(target, 'void.mark');
      const bonus = 1 + stacks * 0.08;
      ctx.damage({ sourceId: self.id, targetId: target.id, amount: self.attack * 0.9 * bonus, element: 'shadow' });
    }
  },
},
{
  id: 'void.eclipse',
  name: '蚀',
  description: '长冷却爆发：造成 1.6 倍攻击伤害。',
  type: SKILL_TYPE.OGCD,
  cooldown: 12,
  range: SKILL_RANGE.SINGLE,
  priority: 40,
  power: 1.6,
  tags: ['void', 'burst'],
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
{
  id: 'void.ruin',
  name: '湮灭',
  description: '自身生命低于 40% 时造成 2.2 倍攻击伤害。',
  type: SKILL_TYPE.OGCD,
  cooldown: 18,
  range: SKILL_RANGE.ALL_ENEMIES,
  priority: 55,
  power: 2.2,
  tags: ['void', 'execute'],
  condition: (ctx, self) => self.hp / self.maxHp < 0.4,
  execute(ctx, self, targets) {
    for (const target of targets) {
      ctx.damage({ sourceId: self.id, targetId: target.id, amount: self.attack * 2.2 });
    }
  },
},

// ── 带记忆的机制：官方内容里没有等价物，靠模块级 Map + onBattleStart 写成 ──────
{
  id: 'void.debt',
  name: '血债',
  description: '造成基础伤害；若目标比上次见到它时**更满**（回过血），追讨差额的两倍。',
  type: SKILL_TYPE.GCD,
  gcdCost: 2.4,
  range: SKILL_RANGE.SINGLE,
  power: 0.8,
  tags: ['void', 'memory'],
  execute(ctx, self, targets) {
    for (const target of targets) {
      // 读**当前真实状态**必须走 ctx.entity(id)：参数里的 target 是本次施放开始时的快照
      const live = ctx.entity(target.id) ?? target;
      const before = lastSeenHp.get(target.id);
      lastSeenHp.set(target.id, live.hp);

      let amount = self.attack * 0.8;
      if (before !== undefined && live.hp > before) {
        // 这就是"记忆"带来的判定：依据在上一次施放里，官方技能做不到这件事
        amount += (live.hp - before) * 2;
        ctx.log(`血债追讨 ${live.hp - before} 点回血`);
      }
      ctx.damage({ sourceId: self.id, targetId: target.id, amount, element: 'shadow' });
    }
  },
},
];
