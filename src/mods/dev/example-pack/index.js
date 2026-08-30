/**
 * 示例包入口。第三方包长什么样，这就是样板：**只 import 'fate' 和包内相对路径**。
 *
 * 想抄去用的话注意：本目录同时被 src/mods/dev/ 的原生加载器读取（靠 setup.js 适配器），
 * 而真实的第三方包是靠 manifest.json + 沙箱求值 —— 两条路共用下面这些文件。
 */
import {
  begin,
  family,
  buff,
  monster,
  encounter,
  skill,
  shopItem,
  event,
  mapGenerator,
  onBattleStart,
  finish,
} from 'fate';
import { VOID_SKILLS, lastSeenHp } from './skills.js';
import { VOID_SHOP_ITEMS, VOID_EVENTS } from './content.js';
import { buildExampleGrid } from './map.js';

begin({
  id: 'dev.example-pack',
  version: '1.1.0',
  title: '示例包 · 虚空',
  author: 'fate-loop',
  description:
    '教学用包：一个新流派、6 个技能（含一个带记忆的）、1 个 Buff、2 种怪物、' +
    '3 个遭遇、2 件商品、1 个事件、一个地图生成器、一个 onBattleStart 钩子。',
});

/**
 * 每场开头清掉技能记忆。
 *
 * `void.debt`（血债）用模块级 Map 记住目标上次的血量 —— 那种记忆会**活过整场战斗**。
 * 不清掉的后果不是报错，而是"同一种子同一序列，只因为先打过一场，第二场结果就不同"，
 * 直接动摇本作"同种子必得同结果"。挂这一行就把单场可复现拿回来了。
 */
onBattleStart(() => {
  lastSeenHp.clear();
});

family({ id: 'void', label: '虚空' });

buff({
  id: 'void.mark',
  name: '虚空印记',
  description: '被虚空侵蚀的目标，受到伤害提升 12%（每层叠加）。',
  isDebuff: true,
  damageTakenMul: 1.12,
});

monster({
  id: 'mon.void.riftling',
  name: '虚空裂崽',
  maxHp: 74,
  attack: 21,
  defense: 5,
  // 混编官方技能与本包技能：跨包引用一律用 ID 字符串
  gcdSequence: ['void.rift', 'blade.jab', 'void.collapse'],
  ogcdSlots: [{ skillId: 'void.eclipse', priority: 40 }],
  tier: 'normal',
  tags: ['void'],
});

monster({
  id: 'mon.void.herald',
  name: '虚空先声',
  maxHp: 168,
  attack: 26,
  defense: 9,
  gcdSequence: ['void.siphon', 'void.collapse', 'void.ruin', 'void.rift'],
  ogcdSlots: [{ skillId: 'void.eclipse', priority: 60 }],
  tier: 'elite',
  tags: ['void', 'elite'],
});

// 权重刻意压低：示例内容不该抢走官方遭遇的出场率
encounter({ id: 'enc.void.lone', name: '独行裂崽', tier: 'normal', monsterIds: ['mon.void.riftling'], minFloor: 1, maxFloor: 999, weight: 4 });
encounter({ id: 'enc.void.pair', name: '裂隙双子', tier: 'normal', monsterIds: ['mon.void.riftling', 'mon.void.riftling'], minFloor: 3, maxFloor: 999, weight: 3 });
encounter({ id: 'enc.void.herald', name: '虚空先声的试炼', tier: 'elite', monsterIds: ['mon.void.herald'], minFloor: 2, maxFloor: 999, weight: 4 });

for (const s of VOID_SKILLS) skill(s);
for (const s of VOID_SHOP_ITEMS) shopItem(s);
for (const s of VOID_EVENTS) event(s);

/**
 * 地图生成器。**id 用 `dev.example.grid` 而不是 `official.grid`** —— 示例包不该
 * 把开发时的地图换成几个格子的小路。想真的接管游戏，把 id 改成 `'official.grid'`
 * （后加载覆盖先加载）。见 docs/模组开发指南.md 的准入校验一节。
 */
mapGenerator({ id: 'dev.example.grid', generate: buildExampleGrid });

finish();
