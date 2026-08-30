#!/usr/bin/env node
/**
 * 解锁表报告（`npm run unlock:report`）
 *
 * 干什么用的：`buildUnlockTable` 有两条策略 ——
 *   naive  按技能 id 排序依次发等级（**曾经的实现**）
 *   aware  按**流派轮转**发等级（现在的实现）
 *
 * naive 那条有个真实缺陷：官方 90 个技能里绝大多数是工厂批量生成的，同族技能
 * id 前缀相同 ⇒ 排序后天然聚成一坨 ⇒ 一个流派的技能被连续塞进 2/3/4/6/7 级，
 * 另一个流派整族挤到 30+ 级。实测同族空档从 **14 级变成 53 级**：玩家开了 40 级
 * 还没见过第二个流派的技能，"自选流派"名存实亡。
 *
 * 这个脚本就是当时用来定位那 53 级的，现在留作回归手段 —— 改解锁逻辑时
 * 跑一次就能看见每个流派的等级跨度有没有再次散开。
 *
 * ⚠️ 关于 "naive" 列：**它是模拟出来的，不是旧实现**。`buildUnlockTable` 现在
 * 永远走流派轮转（`families` 参数只负责把模组流派加进轮转），已经没有
 * "不按流派排"这个开关了。所以本脚本拿**同一批等级值按 id 顺序重发**做反事实。
 * 它跟历史那个 53 级**不是同一把尺**（当年是真跑了旧实现），别把两个数字混着说；
 * 它的用处是：如果哪天排序逻辑退化，这一列会立刻拉开而轮转列不会。
 *
 * 用法：
 *   npm run unlock:report                  # 全部流派的等级跨度汇总
 *   npm run unlock:report -- --family=fire # 展开某个流派逐技能对比
 *   npm run unlock:report -- --dev         # 连示例包一起加载（看第三方流派参与轮转）
 *   npm run unlock:report -- --worst       # 只看空档最大的三个流派
 *
 * 输出是确定性的（不读时钟、不用随机），所以可以直接 diff。
 *
 * 为什么走 vite-node 而不是裸 node：`--dev` 要加载示例包，而示例包
 * `import 'fate'` —— 那是 vite.config.js 里的构建期 alias，裸 node 解析不了。
 * vite-node 随 vitest 一起装，不需要新增依赖。
 */
import { buildUnlockTable, familyOf } from '../src/core/progression.js';
import { loadMods } from '../src/core/mods/loader.js';
import { Registry } from '../src/contracts/registry.js';
import { SKILL_FAMILY_LABELS, UNGROUPED_FAMILY } from '../src/core/constants.js';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? null : hit.slice(name.length + 3);
};

/**
 * 这里刻意**不**用 import.meta.glob（那是构建期/浏览器路径），而是把模组条目
 * 显式注入 —— 本脚本用裸 node 跑，不经过 vite。
 * 条目形状直接复用 tests/helpers.js 的 officialModuleEntries（两处同源，
 * 官方模组目录改了记得一起改）。
 */
async function loadPool({ withDev }) {
  const { officialModuleEntries } = await import('../tests/helpers.js');
  const entries = [...officialModuleEntries()];
  if (withDev) {
    const dir = '/src/mods/dev/example-pack';
    entries.push({
      path: `${dir}/manifest.js`,
      dir,
      loadManifest: async () => await import('../src/mods/dev/example-pack/manifest.js'),
      loadSetup: async () => await import('../src/mods/dev/example-pack/setup.js'),
    });
  }
  const { pool } = await loadMods({ registry: new Registry(), modules: entries });
  return pool;
}

const pool = await loadPool({ withDev: flag('dev') });
const familyIds = [...pool.families.keys()];
const skills = [...pool.skills.values()];

const aware = buildUnlockTable(skills, { families: familyIds });

/**
 * 没有"naive 模式"可以调了 —— `buildUnlockTable` 现在**永远**走流派轮转，
 * `families` 参数只负责把模组流派加进轮转。所以旧行为在这里**自己构造**：
 * 拿同一批等级值（多重集不变），改成按 id 顺序发。
 * 这样比的纯粹是**排序**，不掺入等级集合本身的差异。
 */
const levelMultiset = skills
  .map((skill) => aware.get(skill.id) ?? 99)
  .slice()
  .sort((a, b) => a - b);
const naive = new Map(
  skills
    .slice()
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((skill, index) => [skill.id, levelMultiset[index] ?? 99]),
);

/**
 * 每个流派在一套解锁表里的**同族空档**。
 *
 * ⚠️ 不能用 min→max 跨度：90 个技能摊到 120 级，不管怎么排每族都是 1→11x，
 * 两列长得一模一样，看不出任何东西（本脚本第一版就错在这）。
 * 真正的信号是**相邻两个同族技能等级差的最大值**：naive 按 id 排会让同族聚堆，
 * 于是某个流派要等到 50+ 级才第二次露面。
 */
function gapsOf(table) {
  const byFamily = new Map();
  for (const skill of skills) {
    const family = familyOf(skill, familyIds);
    const level = table.get(skill.id) ?? 99;    const row = byFamily.get(family) ?? { levels: [] };
    row.levels.push(level);
    byFamily.set(family, row);
  }
  const out = new Map();
  for (const [family, row] of byFamily) {
    const levels = row.levels.slice().sort((a, b) => a - b);
    let maxGap = 0;
    for (let i = 1; i < levels.length; i += 1) maxGap = Math.max(maxGap, levels[i] - levels[i - 1]);
    out.set(family, { count: levels.length, first: levels[0] ?? 0, maxGap, last: levels[levels.length - 1] ?? 0 });
  }
  return out;
}

const naiveSpans = gapsOf(naive);
const awareSpans = gapsOf(aware);

console.log(`技能 ${String(skills.length)} · 流派 ${String(familyIds.length)}：${familyIds.join(', ')}\n`);
console.log('流派            技能数  首次  naive 最大空档   轮转后最大空档');
console.log('-'.repeat(68));

const worstOnly = flag('worst');
const rows = familyIds.map((family) => {
  const n = naiveSpans.get(family) ?? { count: 0, first: 0, maxGap: 0, last: 0 };
  const a = awareSpans.get(family) ?? { count: 0, first: 0, maxGap: 0, last: 0 };
  return { family, ...n, aGap: a.maxGap, aFirst: a.first, aCount: a.count };
});
// 按轮转后的空档从大到小排：最需要关注的那行在最上面
rows.sort((x, y) => y.aGap - x.aGap);
const shown = worstOnly ? rows.slice(0, 3) : rows;
for (const row of shown) {
  // 模组流派的名字在 pool.families 里（SKILL_FAMILY_LABELS 只有官方的六个）
  const label = (
    SKILL_FAMILY_LABELS[row.family] ??
    pool.families.get(row.family)?.label ??
    (row.family === UNGROUPED_FAMILY ? '未归组' : row.family)
  ).padEnd(6);
  console.log(
    `${label.padEnd(15)} ${String(row.count).padStart(5)}  ${String(row.aFirst).padStart(4)}  ` +
      `${String(row.maxGap).padStart(9)}      ${String(row.aGap).padStart(9)}`,
  );
}
const worstNaive = Math.max(...rows.map((r) => r.maxGap));
const worstAware = Math.max(...rows.map((r) => r.aGap));
console.log(`\n最差空档：naive=${String(worstNaive)} 级 → 轮转后=${String(worstAware)} 级`);

const only = value('family');
if (only !== null) {
  console.log(`\n流派 ${only} 逐技能对比：`);
  // 注意 familyOf 收的是**技能对象**（它读 tags），传 id 会全落 untagged、这里就空了
  for (const skill of skills.filter((s) => familyOf(s, familyIds) === only)) {
    console.log(
      `  ${skill.id.padEnd(26)} naive=${String(naive.get(skill.id)).padStart(3)}  轮转后=${String(aware.get(skill.id)).padStart(3)}`,
    );
  }
}
console.log(
  '\n读法：“轮转后最大空档”是某个流派相邻两次露面的等级差峰值，越小越均匀。' +
    '\n它明显变大而 naive 列跟着拉开，说明解锁顺序退化成按 id 排、同族聚堆了。' +
    '\n（naive 列是模拟的反事实，与历史那个 53 级不是同一把尺 —— 见文件头）',
);
