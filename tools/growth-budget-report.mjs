#!/usr/bin/env node
/**
 * 成长曲线报告（`npm run growth:report`，P3）
 *
 * 干什么用的：**全程扫描，不要只看控制点。**
 * `demo/scale-curve.html` 那轮反解实测过：三个控制点全命中（2.71/1.96/2.50 vs
 * 目标 2.7/2.0/2.5），但**第 11 层边际掉到 ×1.11、第 40 层鼓包到 ×2.92**。
 * 也就是说"曲线对不对"不能靠抽查几层回答 —— 这个脚本就是把那个回答变成常驻手段。
 *
 * 与 demo 的区别：demo 是**解析模型**（自己写的公式），本脚本**跑真引擎**：
 * 每层把所有战斗/精英节点打一遍，用真实战斗的实测伤害算边际，所以它读到的是
 * `GROWTH_BUDGET` 落地后的实际行为，不是它对世界的近似。
 *
 * 判据（血泪结论 1，别再换回去）：
 *   安全边际 = 玩家扛得住的秒数 ÷ 打完全部怪要的秒数
 *            = (maxHp / 承受DPS) ÷ (怪总血量 / 输出DPS)
 *   两条各自区间的写法会放过「要 26 刀才打死一个怪 vs 只能扛 8 刀」这种**必输组合**。
 *   注意 elapsed 会被约掉 —— 边际与倍速无关，这跟本作的确定性铁律一致。
 *
 * 扫描模式做了两处**归一化**，看数字前必须知道：
 *   1. 每层开局满血：把"补给曲线"从"成长曲线"里摘出去，两个问题分开看
 *   2. 阵亡不当局作废：记一条 ⚠ 后把血补回继续扫（否则第 60 层之后就没有数据了）
 * 装备策略是**贪心**：背包里同部位评分更高就换上（这是玩家会做的事，也是
 * 唯一无需人工干预就能确定下来的策略）。默认不强化、不买东西 —— 碎片只进不出的
 * 累积本身就是要量的东西之一（`--enhance` 打开强化）。
 *
 * 用法：
 *   npm run growth:report                      # 1..60 层，每层一行
 *   npm run growth:report -- --max=120 --step=5
 *   npm run growth:report -- --csv             # 机器可比对（改曲线前后的 diff 一眼看清）
 *   npm run growth:report -- --only-bad        # 只 print 越带/致命/超时层
 *   npm run growth:report -- --endless         # 附送：无尽段换 compound 表后的解析对照
 *   npm run growth:report -- --seed=7 --policy=none
 */

import { createHarness } from '../tests/helpers.js';
import { GROWTH_BUDGET, EQUIP_SLOTS, RARITIES, NODE_TYPE, ENHANCE_MAX, INVENTORY_CAPACITY } from '../src/core/constants.js';
import { monsterScaleAtFloor, playerGrowthAtLevel, targetMarginAtFloor } from '../src/core/growth.js';
import { expectedRarityAtFloor, rarityOf } from '../src/core/equipment.js';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const valueOf = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
};

const FROM = Number(valueOf('from', 1));
const MAX = Number(valueOf('max', 60));
const STEP = Math.max(1, Number(valueOf('step', 1)));
const SEED = Number(valueOf('seed', 20240101));
const CSV = flag('csv');
const ONLY_BAD = flag('only-bad');
const POLICY = valueOf('policy', 'greedy'); // greedy | none
const DO_ENHANCE = flag('enhance');

const BAND = GROWTH_BUDGET.targets.band;
const FIGHT_MAX = GROWTH_BUDGET.targets.fightSecondsMax;

/** 每层扫多少个战斗节点（0 = 全打）。深层全打太慢，抽样足够描述曲线。 */
const NODE_CAP = Number(valueOf('nodes', 0));

// ============================================================
// 一场战斗的实测边际
// ============================================================

/**
 * 由"这一场实际打了什么"算安全边际。
 * 全部用真实伤害累计，不用任何假设的系数 —— 出手间隔不同这件事，
 * 已经被"DPS = 实际伤害 ÷ 实际耗时"自然吃掉了。
 */
function marginOf({ elapsedMs, playerMaxHp, dealt, taken, mobHpPool }) {
  if (elapsedMs <= 0 || mobHpPool <= 0) return { margin: Number.NaN, ttk: Number.NaN, ttd: Number.NaN };
  const dpsOut = dealt / elapsedMs;
  const dpsIn = taken / elapsedMs;
  const timeToKill = dpsOut > 0 ? mobHpPool / dpsOut : Number.POSITIVE_INFINITY;
  const timeToDie = dpsIn > 0 ? playerMaxHp / dpsIn : Number.POSITIVE_INFINITY;
  const margin = Number.isFinite(timeToKill) ? timeToDie / timeToKill : Number.POSITIVE_INFINITY;
  return { margin, ttk: timeToKill, ttd: timeToDie };
}

// ============================================================
// 扫描
// ============================================================

const h = await createHarness({ seed: SEED });
const { store, flow, engine } = h;

const snap = () => store.getSnapshot();
const stand = (node) => store.update((d) => { d.currentNodeId = node.id; });
const fullHeal = () => store.update((d) => { d.player.hp = d.player.maxHp; });

/** 贪心换装：同部位评分更高就穿上；包快满了就主动熔低档（不让"包容量"污染曲线）。 */
function equipBest() {
  if (POLICY !== 'greedy') {
    let skipped = 0;
    for (const slot of EQUIP_SLOTS) skipped += snap().player.equipment[slot]?.score ?? 0;
    return { equipped: 0, score: skipped };
  }
  let equipped = 0;
  for (;;) {
    const state = snap();
    let best = null;
    for (const gear of state.player.inventory) {
      const current = state.player.equipment[gear.slot];
      if (current !== null && current !== undefined && gear.score <= current.score) continue;
      if (best === null || gear.score > best.score) best = gear;
    }
    if (best === null) break;
    if (!flow.equip(best.id).ok) break;
    equipped += 1;
  }

  // 接近容量上限时主动熔掉最低档：否则后半程掉落全被"包满自动分解"顶掉，
  // 量出来的曲线里混进了一个与成长无关的容量因素。
  let guard = 0;
  while (snap().player.inventory.length > INVENTORY_CAPACITY - 8 && guard < 200) {
    guard += 1;
    const junk = [...snap().player.inventory].sort((a, b) => a.score - b.score)[0];
    if (junk === undefined) break;
    if (!flow.salvage(junk.id).ok) break;
  }

  if (DO_ENHANCE) {
    for (const slot of EQUIP_SLOTS) {
      const gear = snap().player.equipment[slot];
      if (gear === null || gear === undefined) continue;
      let level = 0;
      while (level < ENHANCE_MAX && flow.enhance(gear.id).ok) level += 1; // 直到买不起/满级
    }
  }
  let score = 0;
  for (const slot of EQUIP_SLOTS) score += snap().player.equipment[slot]?.score ?? 0;
  return { equipped, score };
}

const rows = [];

for (let floor = FROM; floor <= MAX; floor += 1) {
  flow.enterFloor(floor);
  fullHeal();

  const combatNodes = snap()
    .mapNodes.filter((n) => n.type === NODE_TYPE.COMBAT || n.type === NODE_TYPE.ELITE)
    .slice(0, NODE_CAP === 0 ? undefined : NODE_CAP);

  const stats = { battles: 0, wins: 0, deaths: 0, margins: [], fightMs: [], mobHp: 0, mobCount: 0 };

  for (const node of combatNodes) {
    stand(node);
    const isElite = node.type === NODE_TYPE.ELITE;
    flow.startBattle();
    const before = snap();
    const mobHpPool = before.monsters.reduce((sum, m) => sum + m.maxHp, 0);
    engine.runToEnd();
    const mid = snap();
    const elapsed = mid.virtualTime;
    const dealt = mid.player.stats.damageDealt;
    const taken = mid.player.stats.damageTaken;
    const result = flow.finishBattle();

    const measured = marginOf({
      elapsedMs: elapsed,
      playerMaxHp: before.player.maxHp,
      dealt,
      taken,
      mobHpPool,
    });
    stats.battles += 1;
    if (result.won) stats.wins += 1;
    else stats.deaths += 1;
    stats.margins.push(measured.margin);
    stats.fightMs.push(elapsed);
    stats.mobHp += mobHpPool / Math.max(1, before.monsters.length);
    stats.mobCount += before.monsters.length;

    if (!result.won) fullHeal(); // 扫描模式：补满继续，不把整场扫描废掉
  }

  const { score } = equipBest();
  const state = snap();
  const finite = stats.margins.filter((m) => Number.isFinite(m));
  const sorted = [...finite].sort((a, b) => a - b);
  const median = sorted.length
    ? sorted.length % 2 === 1
      ? sorted[(sorted.length - 1) / 2]
      : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
    : Number.NaN;
  const worst = finite.length ? Math.min(...finite) : Number.NaN;
  const fightSec = stats.fightMs.reduce((a, b) => a + b, 0) / Math.max(1, stats.fightMs.length) / 1000;
  rows.push({
    floor,
    level: state.player.level,
    hp: state.player.maxHp,
    atk: state.player.attack,
    def: state.player.defense,
    crit: state.player.critChance,
    gearScore: score,
    shards: state.fateShards,
    expRarity: expectedRarityAtFloor(floor),
    mobHp: stats.mobHp / Math.max(1, stats.battles),
    mobCount: stats.mobCount / Math.max(1, stats.battles),
    battles: stats.battles,
    wins: stats.wins,
    deaths: stats.deaths,
    fightSec,
    marginMedian: median,
    marginWorst: worst,
    target: targetMarginAtFloor(floor),
  });
}

// ============================================================
// 输出
// ============================================================

const fmt = (v, digits = 2) => (Number.isFinite(v) ? v.toFixed(digits) : ' - ');
const band = (v) =>
  !Number.isFinite(v) ? '致命' : v < BAND.fatalBelow ? '致命' : v < BAND.min ? '偏紧' : v > BAND.max ? '偏松' : '健康';

function verdictOf(row) {
  const flags = [];
  const tag = band(row.marginWorst);
  if (tag !== '健康') flags.push(tag);
  if (row.deaths > 0) flags.push(`阵亡${row.deaths}`);
  if (Number.isFinite(row.fightSec) && row.fightSec > FIGHT_MAX) flags.push('过长');
  if (Math.abs(row.marginWorst - row.target) > row.target * 0.5 && flags.length === 0) flags.push('偏离目标');
  return flags.length === 0 ? 'ok' : flags.join(',');
}

if (CSV) {
  const head = ['floor', 'level', 'hp', 'atk', 'def', 'critPct', 'gearScore', 'shards', 'expRarity',
    'mobHp', 'battles', 'wins', 'deaths', 'fightSec', 'marginMedian', 'marginWorst', 'target', 'verdict'];
  console.info(head.join(','));
  for (const row of rows) {
    console.info([
      row.floor, row.level, row.hp, row.atk, row.def, (row.crit * 100).toFixed(1), row.gearScore,
      row.shards, row.expRarity.toFixed(2), Math.round(row.mobHp), row.battles, row.wins, row.deaths,
      fmt(row.fightSec, 1), fmt(row.marginMean), fmt(row.marginWorst), fmt(row.target), verdictOf(row),
    ].join(','));
  }
} else {
  console.log('成长曲线全程扫描（判据 = 安全边际，实测自真引擎）');
  console.log(
    `seed=${SEED} 层 ${FROM}..${MAX} 步长 ${STEP} 策略=${POLICY}${DO_ENHANCE ? '+强化' : ''}  ` +
    `健康带 ${BAND.min}~${BAND.max}（<${BAND.fatalBelow} 数学上必输），单场时长上限 ${FIGHT_MAX}s`,
  );
  console.log('归一化：每层开局满血、阵亡补满继续扫（这两条会掩盖"补给曲线"的问题，别拿它当通关性结论）');
  console.log(
    '策略：技能序列固定为开局那 8 招（不随解锁换招）⇒ 越深的层越悲观。'
      + '拿它评曲线的方式是**同一策略下横向比形状**（改表前后的 diff），不是把绝对值当结论。',
  );
  console.log('');
  console.log(
    '层   级  生命    攻击  防御  暴击%  装备分   碎片  期望品质 怪均血  场/胜/死  时长s  边际中位  边际最差  目标  判定',
  );
  for (const row of rows.filter((_, i) => i % STEP === 0)) {
    const verdict = verdictOf(row);
    if (ONLY_BAD && verdict === 'ok') continue;
    console.log(
      String(row.floor).padStart(3) + ' ' +
        String(row.level).padStart(3) + ' ' +
        String(row.hp).padStart(7) + ' ' +
        String(row.atk).padStart(5) + ' ' +
        String(row.def).padStart(4) + ' ' +
        (row.crit * 100).toFixed(1).padStart(5) + ' ' +
        String(row.gearScore).padStart(8) + ' ' +
        String(row.shards).padStart(6) + ' ' +
        row.expRarity.toFixed(2).padStart(7) + ' ' +
        String(Math.round(row.mobHp)).padStart(7) + ' ' +
        `${row.battles}/${row.wins}/${row.deaths}`.padStart(9) + ' ' +
        fmt(row.fightSec, 1).padStart(6) + ' ' +
        fmt(row.marginMedian).padStart(7) + ' ' +
        fmt(row.marginWorst).padStart(8) + ' ' +
        fmt(row.target).padStart(5) + '  ' + verdict,
    );
  }
}

// ============================================================
// 无尽段对照（--endless）：把 compound 旋钮的效果算给你看
// ============================================================

if (flag('endless')) {
  /**
   * ⚠️ 这是**解析估算**，不是重跑引擎。它只回答一个问题：
   * 把 51 层以后从"线性 +12%/层"换成"复利 +22%/层"，怪侧的相对强度会涨多少倍。
   * 为什么不做成真扫描：`GROWTH_BUDGET` 是冻结常量，运行时不许有第二份真相 ——
   * 与其在引擎里开一个"报告脚本专用后门"（那正是"设置能改变一局结果"的开端），
   * 不如把估算摆出来并标清楚它是估算。compound 机制本身由
   * `tests/unit/growth.test.js` 负责（段界连续、同底数比值恒定）。
   */
  const alt = {
    monster: {
      hp: [
        { fromFloor: 1, mode: 'linear', rate: 0.12 },
        { fromFloor: 51, mode: 'compound', rate: Number(valueOf('rate', 0.22)) },
      ],
      attack: [
        { fromFloor: 1, mode: 'linear', rate: 0.08 },
        { fromFloor: 51, mode: 'compound', rate: Number(valueOf('rate', 0.22)) },
      ],
      defense: GROWTH_BUDGET.monster.defense,
    },
  };
  const altBudget = { ...GROWTH_BUDGET, monster: alt.monster };

  console.log('');
  console.log('无尽段对照（--endless）：现表 vs 51 层起 compound（hp 与 atk 同底数 —— 分开配必有一条 TTK 漂走）');
  console.log('  边际 ∝ 1/(怪攻击 × 怪血量)，所以"边际倍数"列 = 玩家在不成长的前提下会掉到几分之一');
  console.log('  ⚠️ 解析估算，不重跑引擎；假定玩家成长不变（真实的无尽段应当靠 P4 精炼与更高档装备继续涨）');
  console.log('层    现表hp  compound hp   倍率   现表atk  compound atk  倍率   边际倍数');
  for (const floor of [50, 51, 55, 60, 75, 100, 150, 200]) {
    const now = monsterScaleAtFloor(floor, GROWTH_BUDGET);
    const other = monsterScaleAtFloor(floor, altBudget);
    const marginRatio = (now.hp * now.attack) / (other.hp * other.attack);
    console.log(
      String(floor).padStart(4) +
        fmt(now.hp, 2).padStart(9) + fmt(other.hp, 2).padStart(13) +
        (other.hp / now.hp).toFixed(2).padStart(8) +
        fmt(now.attack, 2).padStart(10) + fmt(other.attack, 2).padStart(14) +
        (other.attack / now.attack).toFixed(2).padStart(8) +
        marginRatio.toFixed(4).padStart(11),
    );
  }
  console.log('');
  console.log('玩家侧同理（player.perLevel 加第二段即可，注意 crit 单位是百分点）：');
  console.log(`  现状每级：${JSON.stringify(playerGrowthAtLevel(MAX))}  ← 单段 ⇒ 120 级内不变`);
}

// ---- 汇总 ----
const worstOverall = rows.filter((r) => Number.isFinite(r.marginWorst)).sort((a, b) => a.marginWorst - b.marginWorst)[0];
const bestOverall = rows.filter((r) => Number.isFinite(r.marginWorst)).sort((a, b) => b.marginWorst - a.marginWorst)[0];
console.log('');
console.log(`全程最差：第 ${worstOverall?.floor} 层 ×${fmt(worstOverall?.marginWorst)}（目标 ×${fmt(worstOverall?.target)}）`);
console.log(`全程最松：第 ${bestOverall?.floor} 层 ×${fmt(bestOverall?.marginWorst)}`);
const outOfBand = rows.filter((r) => verdictOf(r) !== 'ok');
console.log(
  outOfBand.length === 0
    ? '判定：全部层在带内 —— 但请连同"归一化"那两行一起看，它掩盖了补给问题。'
    : `判定：${outOfBand.length} 层越带/致命，见上面 verdict 列。品质期望 E(${FROM})=${expectedRarityAtFloor(FROM).toFixed(2)} → E(${MAX})=${expectedRarityAtFloor(MAX).toFixed(2)}，顶档是「${rarityOf({ rarityIndex: RARITIES.length - 1 }).name}」。`,
);
