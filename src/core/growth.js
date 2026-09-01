/**
 * 成长曲线的**读表层**（P3）。
 *
 * 为什么要单独一层：曲线的数字原本散在五处（每级成长、楼层缩放、掉落权重、
 * 品质倍率、经验曲线），合起来是什么形状没人能回答 —— 「数值不膨胀」不是谁
 * 调过的结果，是因为没人总账。P3 把旋钮收进 `constants.js#GROWTH_BUDGET`，
 * 本模块只干一件事：**把表读成数**，不含任何游戏语义。
 *
 * 一句话分工：
 *   `GROWTH_BUDGET` 是「玩家应多强 / 怪应多强 / 装备应多好」的单一来源
 *   本模块负责把它算成增量与倍率；`targets` 那块不参与运行时，只给
 *   `npm run growth:report` 当对照组（曲线是不是真的想要，量出来才知道）。
 *
 * 确定性：全是纯函数 —— 不消费随机数、不读时钟、不碰状态。所以倍速、
 * 存档、重放都不会因为它而改变（见交接文档「不可违反的内核不变量」）。
 */

import { GROWTH_BUDGET } from './constants.js';
import { invariant } from '../utils/invariant.js';

/** 楼层缩放的两种模式。 */
export const GROWTH_MODE = Object.freeze({
  /** base + rate × 步数（现状：1 + 0.12(f-1)） */
  LINEAR: 'linear',
  /** base × (1 + rate)^步数（无尽段要用它，且必须与 hp/attack 同一个底数） */
  COMPOUND: 'compound',
});

/** 玩家成长字段（表里出现的键，顺序即累加顺序）。 */
const PLAYER_FIELDS = Object.freeze(['maxHp', 'attack', 'defense', 'crit']);

/** 段起点字段名：玩家表按级、怪表按层。 */
const LEVEL_KEY = 'fromLevel';
const FLOOR_KEY = 'fromFloor';

function normalizeIndex(value, min) {
  const n = Math.floor(Number.isFinite(value) ? value : min);
  return Math.max(min, n);
}

/**
 * 把「本段起点值」往前推：linear 累加、compound 复利。
 * 段界连续就靠它 —— 新段用上一段**外推到本段起点**的值当 base，
 * 所以 50→51 层不会出现凭空跳一档（那是无尽段能接上前半段的前提）。
 */
function applySegment(segment, base, fromIndex, index) {
  const steps = Math.max(0, index - fromIndex);
  return segment.mode === GROWTH_MODE.COMPOUND
    ? base * (1 + segment.rate) ** steps
    : base + segment.rate * steps;
}

/**
 * 按段查一个「倍率」。用于怪侧楼层缩放（首段起点之前恒为 1）。
 * @param {Array<{fromFloor:number, mode:string, rate:number}>} segments 升序分段表
 * @param {number} index 查询点（层号）
 */
function scaleOf(segments, index) {
  if (index < startIndex(segments[0])) return 1;

  let base = 1; // 本段起点处的值，由上一段外推而来
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i];
    const from = startIndex(segment);
    if (i > 0) {
      const previous = segments[i - 1];
      base = applySegment(previous, base, startIndex(previous), from);
    }
    const next = i + 1 < segments.length ? startIndex(segments[i + 1]) : Infinity;
    if (index < next) return applySegment(segment, base, from, index);
  }
  return base;
}

/** 段起点：怪表用 fromFloor、玩家表用 fromLevel，两边共用一个读法。 */
function startIndex(segment) {
  const value = segment[FLOOR_KEY] ?? segment[LEVEL_KEY];
  invariant(
    Number.isFinite(value),
    `成长表的段必须有 ${FLOOR_KEY} 或 ${LEVEL_KEY}，实际拿到 ${JSON.stringify(segment)}`,
  );
  return value;
}

/** 首段起点（玩家/怪表用同一个 helper 读，避免两边各写一份口径）。 */
function firstIndex(segments) {
  return startIndex(segments[0]);
}

/**
 * 某一级适用的「每级增量」（表分段后它不再是常数）。
 * @param {number} level
 * @param {object} [budget] 可注入的表（报告脚本要演示"如果换成这条曲线"）
 * @returns {{maxHp:number, attack:number, defense:number, crit:number}}
 */
export function playerGrowthAtLevel(level, budget = GROWTH_BUDGET) {
  const lv = normalizeIndex(level, 1);
  const segments = budget.player.perLevel;
  let chosen = segments[0];
  for (const segment of segments) {
    if (lv >= startIndex(segment)) chosen = segment;
    else break;
  }
  const out = {};
  for (const field of PLAYER_FIELDS) out[field] = chosen[field];
  return out;
}

/**
 * 从 `fromLevel` 涨到 `toLevel` 的**累计**增量（含 fromLevel 级那一跳，不含 toLevel 级）。
 *
 * 按段闭式累加，不逐级 loop —— 但更重要的是**浮点口径**：crit 用 `段内级数 × rate`
 * 一次乘出，与旧实现 `n * GROWTH_PER_LEVEL.crit` 逐位相同（0.25 是二进制精确量）。
 * 这不是洁癖：派生属性要能跨速度对拍与存档往返幂等。
 *
 * @returns {{maxHp:number, attack:number, defense:number, crit:number}}
 */
export function playerGrowthTotal(fromLevel, toLevel, budget = GROWTH_BUDGET) {
  const lo = normalizeIndex(fromLevel, 1);
  const hi = Math.max(lo, normalizeIndex(toLevel, 1));
  const segments = budget.player.perLevel;
  const total = {};
  for (const field of PLAYER_FIELDS) total[field] = 0;

  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i];
    const start = Math.max(lo, startIndex(segment));
    const end = Math.min(hi, i + 1 < segments.length ? startIndex(segments[i + 1]) : Infinity);
    if (end <= start) continue;
    const steps = end - start;
    for (const field of PLAYER_FIELDS) total[field] += steps * segment[field];
  }
  return total;
}

/**
 * 楼层缩放倍率（怪侧）。默认表下逐项等于现状闭式：
 * `hp = 1 + 0.12(f-1)`、`attack = 1 + 0.08(f-1)`、`defense = 1`。
 * @param {number} floorNumber
 * @param {object} [budget]
 * @returns {{hp:number, attack:number, defense:number}}
 */
export function monsterScaleAtFloor(floorNumber, budget = GROWTH_BUDGET) {
  const floor = normalizeIndex(floorNumber, 1);
  const out = {};
  for (const stat of Object.keys(budget.monster)) {
    out[stat] = scaleOf(budget.monster[stat], floor);
  }
  return out;
}

/**
 * 目标安全边际（`targets.margin` 控制点之间的线性插值）。
 * 只给报告脚本与文档用 —— 运行时不读它，读它就等于把"设计意图"偷偷变成"游戏规则"。
 */
export function targetMarginAtFloor(floorNumber, budget = GROWTH_BUDGET) {
  const points = budget.targets.margin;
  const floor = normalizeIndex(floorNumber, 1);
  const at = (point) => point.floor;
  if (floor <= at(points[0])) return points[0].value;
  const last = points[points.length - 1];
  if (floor >= at(last)) return last.value;

  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i];
    const b = points[i + 1];
    if (floor >= at(a) && floor <= at(b)) {
      const ratio = (floor - at(a)) / (at(b) - at(a));
      return a.value + ratio * (b.value - a.value);
    }
  }
  return last.value;
}

/**
 * 表自检（启动断言与测试都用它）。
 *
 * 为什么要拦：半张表不会报错，只会安静地按错的样子算 —— 比如段起点没升序，
 * `scaleOf` 会提前命中前一段，后面的段永远不生效。这类"看着生效其实没生效"
 * 在示例包 `void.ruin` 上已经栽过一次（路径含点导致永远 undefined）。
 *
 * @throws 表非法时抛错（带具体是哪一段）
 */
export function validateGrowthBudget(budget = GROWTH_BUDGET) {
  const bad = (message) => invariant(false, `GROWTH_BUDGET 非法：${message}`);

  const perLevel = budget?.player?.perLevel;
  if (!Array.isArray(perLevel) || perLevel.length === 0) bad('player.perLevel 必须是非空数组');
  if (startIndex(perLevel[0]) !== 1) bad('player.perLevel 首段必须 fromLevel:1（否则 1 级没有增量来源）');
  perLevel.forEach((segment, i) => {
    for (const field of PLAYER_FIELDS) {
      if (!Number.isFinite(segment[field])) bad(`player.perLevel[${i}].${field} 不是有限数`);
    }
    if (i > 0 && startIndex(segment) <= startIndex(perLevel[i - 1])) {
      bad(`player.perLevel[${i}].fromLevel 必须严格大于前一段（否则这一段永远不生效）`);
    }
  });

  for (const [stat, segments] of Object.entries(budget?.monster ?? {})) {
    if (!Array.isArray(segments) || segments.length === 0) bad(`monster.${stat} 必须是非空数组`);
    if (firstIndex(segments) !== 1) bad(`monster.${stat} 首段必须 fromFloor:1`);
    segments.forEach((segment, i) => {
      if (segment.mode !== GROWTH_MODE.LINEAR && segment.mode !== GROWTH_MODE.COMPOUND) {
        bad(`monster.${stat}[${i}].mode 只能是 linear/compound，实际 ${String(segment.mode)}`);
      }
      if (!Number.isFinite(segment.rate) || segment.rate < 0) {
        bad(`monster.${stat}[${i}].rate 必须是 ≥0 的有限数（要变弱请调模板值，不要在楼层上取负）`);
      }
      if (i > 0 && startIndex(segments[i]) <= startIndex(segments[i - 1])) {
        bad(`monster.${stat}[${i}].fromFloor 必须严格大于前一段`);
      }
    });
  }

  for (const field of ['lowSuppressFloors', 'lowSuppressStep', 'lowSuppressCap', 'rampFloor', 'tierLift', 'progressCap']) {
    const value = budget?.loot?.[field];
    if (!Number.isFinite(value) || value < 0) bad(`loot.${field} 必须是 ≥0 的有限数`);
  }
  if (!Number.isFinite(budget?.loot?.lowSuppressFloors) || budget.loot.lowSuppressFloors < 1) {
    bad('loot.lowSuppressFloors 必须 ≥1');
  }
  if (budget.loot.lowSuppressCap > 1) bad('loot.lowSuppressCap 不能超过 1（那是"权重变负"）');
  if (budget.loot.rampFloor < 1) bad('loot.rampFloor 必须 ≥1');

  const points = budget?.targets?.margin;
  if (!Array.isArray(points) || points.length < 2) bad('targets.margin 至少两个控制点');
  points.forEach((point) => {
    if (!Number.isFinite(point.floor) || !Number.isFinite(point.value)) {
      bad('targets.margin 的 floor/value 必须是有限数');
    }
  });
  for (let i = 1; i < points.length; i += 1) {
    if (points[i].floor <= points[i - 1].floor) bad('targets.margin 的 floor 必须严格升序');
  }

  return true;
}

/**
 * 「玩家面板 = 基线 + 累计成长」—— 给报告脚本与角色屏之外的一致性检查用。
 * 运行时面板仍走 `derived.js`（那边还要叠装备/种子/永久加成），这里只管 base 那一源。
 */
export function playerBaseStatsAtLevel(level, budget = GROWTH_BUDGET) {
  const lv = normalizeIndex(level, 1);
  const base = budget.player.base;
  const growth = playerGrowthTotal(1, lv, budget);
  return {
    maxHp: base.maxHp + growth.maxHp,
    attack: base.attack + growth.attack,
    defense: base.defense + growth.defense,
    critChance: base.critChance + growth.crit / 100,
  };
}
