/**
 * 示例包入口。第三方包长什么样，这就是样板：**只 import 'fate' 和包内相对路径**。
 *
 * 想抄去用的话注意：本目录同时被 src/mods/dev/ 的原生加载器读取（靠 setup.js 适配器），
 * 而真实的第三方包是靠 manifest.json + 沙箱求值 —— 两条路共用下面这些文件。
 */
import { begin, family, buff, monster, encounter, skill, shopItem, event, finish } from 'fate';
import { VOID_SKILLS } from './skills.js';
import { VOID_SHOP_ITEMS, VOID_EVENTS } from './content.js';

begin({
  id: 'dev.example-pack',
  version: '1.0.0',
  title: '示例包 · 虚空',
  author: 'fate-loop',
  description: '教学用包：注册一个新流派、5 个技能、1 个 Buff、2 种怪物、3 个遭遇、2 件商品、1 个事件。',
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

finish();
