/**
 * 示例模组入口。
 *
 * 加载器调用 `setup(context)`，context 里有四样东西：
 *   context.registry    契约注册表。system 模组可以 register 自己的契约实现
 *   context.contracts   核心契约符号映射（damageApply / healApply / buffApply /
 *                       stateQuery / prngNext / combatLog / audioPlay）
 *   context.modId       本模组 id，会作为内容的 source 字段写进内容池
 *   context.log(msg)    带模组前缀的日志，启动时能在控制台看到
 *
 * 返回值里有什么就注册什么：families / skills / buffs / monsters / encounters /
 * shopItems / events / mapGenerators。没返回的字段视为不贡献。
 */

import {
  buildExampleSkills,
  EXAMPLE_BUFFS,
  EXAMPLE_FAMILY,
} from './skills.js';
import {
  EXAMPLE_ENCOUNTERS,
  EXAMPLE_EVENTS,
  EXAMPLE_MONSTERS,
  EXAMPLE_SHOP_ITEMS,
} from './content.js';

export function setup(context) {
  context.log(
    `注册流派「${EXAMPLE_FAMILY.label}」：${EXAMPLE_BUFFS.length} 个 Buff、` +
      `5 个技能、${EXAMPLE_MONSTERS.length} 种怪物、${EXAMPLE_ENCOUNTERS.length} 个遭遇、` +
      `${EXAMPLE_SHOP_ITEMS.length} 件商品、${EXAMPLE_EVENTS.length} 个事件`,
  );

  return {
    families: [EXAMPLE_FAMILY],
    skills: buildExampleSkills(context.contracts),
    buffs: EXAMPLE_BUFFS,
    monsters: EXAMPLE_MONSTERS,
    encounters: EXAMPLE_ENCOUNTERS,
    shopItems: EXAMPLE_SHOP_ITEMS,
    events: EXAMPLE_EVENTS,
  };
}

/* ---------------------------------------------------------------------------
 * 覆盖官方内容（演示，故意注释掉 —— 解开会真的改掉官方数值）
 *
 * 规则：`src/mods/dev/` 排在最后加载，同 id 后写覆盖先写（loader 的 mergeIntoPool）。
 * 所以模组可以“就地改官方技能”，而不必复制整个官方包。
 *
 * 两个坑：
 *   1. 覆盖写的是**整条定义**，不是字段合并。只写 { id, name } 会把原技能的
 *      execute / gcdCost 全丢掉，然后在 normalize 阶段报“必须提供 execute 函数”。
 *      正确做法就是一次写全（下面这样）。
 *   2. 覆盖会改变确定性表现：同一种子下的战斗结果与官方版本不同。这是设计允许的
 *      （模组就是内容），但别在同一个存档槽上混用两套模组来回读档。
 *
 * export function setup(context) {
 *   return {
 *     skills: [
 *       {
 *         id: 'blade.jab',            // 与官方同 id ⇒ 整条被替换
 *         name: '刺击（示例改）',
 *         description: '示例：把官方起手技的倍率从 0.75 抬到 1.0。',
 *         type: 'GCD',
 *         gcdCost: 1.6,
 *         range: 'single',
 *         power: 1.0,
 *         tags: ['physical', 'opener'],
 *         soundId: 'combat.hit',
 *         condition: null,
 *         buffId: null,
 *         execute(ctx, self, targets) {
 *           const damage = ctx.get(ctx.contracts ?? context.contracts);
 *           void damage; void self; void targets;   // 实际写法见 skills.js 里 void.rift
 *         },
 *       },
 *     ],
 *   };
 * }
 * ------------------------------------------------------------------------- */
