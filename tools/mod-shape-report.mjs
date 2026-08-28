#!/usr/bin/env node
/**
 * 内容形状报告：官方内容里有多少是"少数模板 + 参数"，多少需要真正的代码。
 *
 * 为什么要这个工具：它在回答一个架构问题 —— **模组格式该不该是 JSON**。
 * 答案是可测量的：如果官方技能 100% 由 5 个工厂模板生成、条件只有 6 种谓词形状、
 * 商品与事件只用 10 种操作，那么"JSON 数据包"就不是阉割版模组系统，
 * 而是把现有工厂参数序列化而已；反之如果大量内容是手写 execute，JSON 层就得
 * 长出一套真语言，那是另一个量级的工程。
 *
 * 用法：node tools/mod-shape-report.mjs
 *
 * 注意两个曾经踩过的测量坑（别改回去）：
 *   1. 必须先归一化空白再匹配源码。damageSkill 的 damage({…}) 调用在源码里是
 *      多行写法，按单行正则会漏掉 47 个技能、误判成"手写"。
 *   2. 工厂判定要按特异性排序。damageSkill 的宽松模式会把 damageBuff/drain 全吞掉，
 *      曾经因此报出"90 个技能只用了 2 个工厂"。
 */

import { loadOfficialPool } from '../tests/helpers.js';

/* ---------- 技能工厂：按特异性排序，先具体后一般 ---------- */
const FACTORIES = [
  ['drainSkill', /drained \+= result\.dealt/],
  ['damageBuffSkill', /damage\(\{[\s\S]*?applyBuff\(\{/],
  ['buffSkill', /applyBuff\(\{[\s\S]*?durationMs/],
  ['healSkill', /heal\(\{ sourceId: self\.id, targetId: target\.id, amount: target\.maxHp \* ratio/],
  ['damageSkill', /damage\(\{ sourceId: self\.id, targetId: target\.id, amount: self\.attack \* multiplier/],
];

function factoryOf(skill) {
  const src = skill.execute.toString().replace(/\s+/g, ' ');
  for (const [name, re] of FACTORIES) {
    if (re.test(src)) return name;
  }
  return '手写';
}

/* ---------- 条件谓词形状 ---------- */
function predicateOf(condition) {
  if (condition === null) return '(无条件)';
  const src = condition.toString().replace(/\s+/g, ' ');
  if (/hp \/ self\.maxHp < /.test(src)) return 'hpBelow';
  if (/hp \/ self\.maxHp > /.test(src)) return 'hpAbove';
  if (/targets\[0\]\.hp \/ targets\[0\]\.maxHp < /.test(src)) return 'targetHpBelow';
  if (/targets\[0\]\.hp \/ targets\[0\]\.maxHp > /.test(src)) return 'targetHpAbove';
  if (/targets\.length >= /.test(src)) return 'enemiesAtLeast';
  if (/buffs\.get\(/.test(src)) {
    return /virtualTime >= buff\.expiresAtMs/.test(src) ? 'lacksBuff' : 'hasBuff';
  }
  if (/virtualTime >= /.test(src)) return 'afterSeconds';
  if (/every\(/.test(src)) return 'all(…)';
  if (/some\(/.test(src)) return 'any(…)';
  return '其他（需要新谓词）';
}

/* ---------- 商品/事件选项用到的状态操作 ---------- */
function opsOf(fn) {
  const src = fn.toString();
  const ops = new Set();
  if (/fateShards\s*\+=/.test(src)) ops.add('gainShards');
  if (/fateShards\s*-=`|fateShards\s*-=|fateShards\s*>=/.test(src)) ops.add('spendShards(需够)');
  if (/addPermanentBonus/.test(src)) ops.add('permanentBonus');
  if (/player\.hp\s*=\s*Math\.min\([^)]*maxHp[^)]*\+/.test(src)) ops.add('healRatio');
  if (/player\.hp\s*=\s*Math\.max\(1,[^)]*-\s*Math\.floor/.test(src)) ops.add('hpCostRatio');
  if (/player\.hp\s*=\s*state\.player\.maxHp/.test(src)) ops.add('fullHeal');
  if (/metadata\./.test(src)) ops.add('metadata');
  if (/% 2 === 0/.test(src)) ops.add('按状态奇偶判定');
  if (/\* 2\b/.test(src) || /\/ 2\)/.test(src)) ops.add('翻倍/减半');
  if (/if \(/.test(src)) ops.add('有条件');
  if (ops.size === 0) ops.add('(空操作)');
  return [...ops];
}

/* ---------- 是否本来就是纯数据 ---------- */
function isPureData(obj) {
  try {
    const clone = { ...obj };
    for (const key of Object.keys(clone)) {
      if (typeof clone[key] === 'function') delete clone[key];
    }
    const round = JSON.parse(JSON.stringify(clone));
    return JSON.stringify(round) === JSON.stringify(clone);
  } catch {
    return false;
  }
}

function tally(list, label, showOther = false) {
  const by = new Map();
  for (const item of list) by.set(item.k, (by.get(item.k) ?? 0) + 1);
  const sorted = [...by.entries()].sort((a, b) => b[1] - a[1]);
  console.log(`\n=== ${label}（共 ${list.length}）===`);
  for (const [k, v] of sorted) {
    if (!showOther && k === '其他（需要新谓词）' && v === 0) continue;
    console.log(`  ${String(v).padStart(4)}  ${k}`);
  }
  return sorted;
}

const pool = await loadOfficialPool();

/* 1. 技能来自哪些工厂 */
const skills = [...pool.skills.values()];
const factoryRows = skills.map((s) => ({ k: factoryOf(s), id: s.id }));
const factories = tally(factoryRows, '技能 execute 的来源工厂');
const handWritten = factoryRows.filter((r) => r.k === '手写');
const templated = skills.length - handWritten.length;
if (handWritten.length > 0) {
  console.log(`  ↳ 手写明细：${handWritten.map((r) => r.id).join(' ')}`);
}

/* 2. 条件谓词 */
const predicateRows = skills.map((s) => ({ k: predicateOf(s.condition), id: s.id }));
tally(predicateRows, '条件谓词形状');

/* 3. 商品与事件选项的操作 */
const opRows = [
  ...[...pool.shopItems.values()].map((item) => ({ k: `商品 · ${item.id}`, ops: opsOf(item.apply) })),
  ...[...pool.events.values()].flatMap((evt) =>
    evt.choices.map((choice, i) => ({ k: `事件 · ${evt.id}[${i}]`, ops: opsOf(choice.apply) })),
  ),
];
const opCounts = new Map();
for (const row of opRows) for (const op of row.ops) opCounts.set(op, (opCounts.get(op) ?? 0) + 1);
console.log(`\n=== 商品与事件选项用到的状态操作（共 ${opRows.length} 个 apply）===`);
for (const [op, count] of [...opCounts.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(count).padStart(4)}  ${op}`);
}

/* 4. 纯数据产物 */
console.log('\n=== 本来就是纯数据（可直接 JSON 化）===');
for (const [name, map] of [
  ['怪物', pool.monsters],
  ['遭遇', pool.encounters],
  ['Buff', pool.buffs],
]) {
  const pure = [...map.values()].filter(isPureData).length;
  console.log(`  ${name.padEnd(4)} ${pure}/${map.size}${pure === map.size ? '  ✓ 全纯数据' : '  ⚠ 有函数字段'}`);
}

/* 5. 结论 */
const vocabulary = factories.filter(([k]) => k !== '手写').length;
console.log(
  `\n>>> 技能：${templated}/${skills.length}（${((templated / skills.length) * 100).toFixed(0)}%）` +
    `由 ${vocabulary} 个工厂模板生成，手写 ${handWritten.length} 个。`,
);
console.log(`>>> 条件：${new Set(predicateRows.map((r) => r.k)).size} 种谓词形状覆盖全部技能。`);
console.log(`>>> 商品+事件：${opCounts.size} 种状态操作。`);
console.log(
  handWritten.length === 0
    ? '>>> 判定：JSON 数据包格式可行 —— 它只是把现有工厂参数序列化，不需要新语言。\n'
    : '>>> 判定：存在手写技能，JSON 层需要扩词汇表或保留 JS 逃生口。\n',
);
