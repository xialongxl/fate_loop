/**
 * 装备系统（阶段 8，参考 Fate_echo 的槽位/品质/词缀结构，按本作确定性约束重写）。
 *
 * 与 Fate_echo 的关键差异，全部源于本作的确定性铁律：
 *   1. 装备 id 不用 Date.now + Math.random，改为 `eq.<floor>.<nodeId>.<序号>`。
 *      同种子同节点掉落的装备 id 恒定，存档回读后引用不会错位。
 *   2. 强化不做成功率。概率强化会让「玩家点击次数」影响随机流消费量，
 *      而点击次数不在存档里 —— 重放会分叉。改为固定增幅 + 递增费用。
 *   3. 属性一律取整。浮点词缀在跨速度对拍时会出现末位差异。
 *   4. 不做宝珠/精炼/图鉴集齐。那三套是 Fate_echo 的局外养成，本作是局内 run。
 *
 * 词缀只有 maxHp / attack / defense / crit 四项，且都直接进伤害公式，
 * 不引入 haste（急速会改 GCD 时长，破坏 16ms 对齐）与 versa（无对应机制）。
 */

import {
  AFFIXES,
  EQUIP_SLOTS,
  ENHANCE_BASE_COST,
  ENHANCE_COST_RATE,
  ENHANCE_MAX,
  ENHANCE_STEP_MUL,
  LOOT_RARITY_CURVE,
  RARITIES,
  SALVAGE_BASE,
} from './constants.js';
import { invariant } from '../utils/invariant.js';

/** 部位基础名池。索引由随机流决定，因此顺序不可随意改动（会改变历史存档的名字）。 */
const SLOT_BASE_NAMES = Object.freeze({
  weapon: ['长刃', '断章', '回环剑', '序列匕', '重铘', '轮回刀'],
  head: ['额环', '观测冠', '兜帽', '静默面', '记忆冕'],
  chest: ['织甲', '轮回衣', '锁片胸铠', '残页袍', '缄默甲'],
  legs: ['行者裤', '铁胫', '折叠护腿', '灰纹裙甲'],
  feet: ['疾行靴', '沉铁履', '无声鞋', '踏痕靴'],
  pendant: ['碎片吊坠', '时序链', '低语项圈', '锚点坠'],
  ring: ['回声戒', '闭环指环', '刻痕戒', '空印'],
  trinket: ['残响核', '编织残片', '锚定符', '第七遗物'],
});

/** 词缀前缀，按品质下标取，纯装饰。 */
const RARITY_PREFIX = Object.freeze(['残破的', '', '磨砺的', '铭刻的', '共鸣的', '终末的']);

const WEAPON_SLOTS = new Set(['weapon']);
const ARMOR_SLOTS = new Set(['head', 'chest', 'legs', 'feet']);

function slotKind(slot) {
  if (WEAPON_SLOTS.has(slot)) return 'weapon';
  if (ARMOR_SLOTS.has(slot)) return 'armor';
  return 'accessory';
}

/**
 * 某一层的品质权重表（纯函数，不消费随机数）。
 *
 * 单独导出是为了让测试与 `npm run growth:report` 能直接拿“期望”做-guard，
 * 而不必去猜 rollRarityIndex 的内部。“改曲线”必须先能看见曲线，否则调参
 * 只能靠手感（上一版就是这么把曲线调成“40 层后不再变好”的）。
 */
export function rarityWeightsAtFloor(floorNumber) {
  const floor = Math.max(1, Math.floor(floorNumber) || 1);
  const { lowSuppressFloors, lowSuppressStep, lowSuppressCap, rampFloor, tierLift, progressCap } =
    LOOT_RARITY_CURVE;

  const suppression = Math.min(lowSuppressCap, Math.floor(floor / lowSuppressFloors) * lowSuppressStep);
  const progress = Math.min(progressCap, (floor - 1) / rampFloor);

  return RARITIES.map((rarity, index) => ({
    index,
    weight:
      index <= 1
        ? rarity.weight * (1 - suppression)
        : rarity.weight * (1 + tierLift) ** (progress * (index - 1)),
  }));
}

/** 该层品质分布的期望下标（供报告与测试用；与掉落本身同一张表，不会漂）。 */
export function expectedRarityAtFloor(floorNumber) {
  const weights = rarityWeightsAtFloor(floorNumber);
  const total = weights.reduce((sum, w) => sum + w.weight, 0);
  if (total <= 0) return 0;
  return weights.reduce((sum, w) => sum + w.weight * w.index, 0) / total;
}

/** 按权重挑品质。层数既压制低档、也抬升高档（见 LOOT_RARITY_CURVE）。 */
function rollRarityIndex(rng, floorNumber) {
  return rng.pickWeighted(rarityWeightsAtFloor(floorNumber)).index;
}

/**
 * 生成一件装备。
 *
 * @param {object} params
 * @param {object} params.rng 随机流（调用方负责选对流：掉落用遭遇流派生）
 * @param {number} params.floorNumber 楼层，决定强度基线
 * @param {string} params.idSuffix 保证 id 唯一的后缀（如 `${nodeId}.0`）
 * @param {string|null} [params.forceSlot]
 * @param {number|null} [params.forceRarity] 品质下标
 * @param {number} [params.minRarity] 品质下限（精英掉落用）
 */
export function rollEquipment({
  rng,
  floorNumber = 1,
  idSuffix,
  forceSlot = null,
  forceRarity = null,
  minRarity = 0,
}) {
  invariant(typeof idSuffix === 'string' && idSuffix !== '', 'rollEquipment 需要 idSuffix');

  const slot = forceSlot ?? rng.pick(EQUIP_SLOTS);
  let rarityIndex = forceRarity ?? rollRarityIndex(rng, floorNumber);
  rarityIndex = Math.max(minRarity, rarityIndex);
  const rarity = RARITIES[rarityIndex];

  const baseName = rng.pick(SLOT_BASE_NAMES[slot]);
  // 强度基线：√层数 让深层收益递减，避免第 50 层装备碾压一切
  const scale = Math.max(1, Math.sqrt(Math.max(1, floorNumber)) * 6);
  const power = scale * rarity.mult;

  const kind = slotKind(slot);
  const stats = { maxHp: 0, attack: 0, defense: 0, crit: 0 };

  if (kind === 'weapon') {
    stats.attack = Math.max(1, Math.floor(power * 1.6));
  } else if (kind === 'armor') {
    stats.defense = Math.max(1, Math.floor(power * 0.9));
    stats.maxHp = Math.max(1, Math.floor(power * 4));
  } else {
    stats.attack = Math.max(1, Math.floor(power * 0.5));
    stats.defense = Math.max(1, Math.floor(power * 0.4));
  }

  // 随机词缀。数量由品质决定，同一词缀可重复中签（累加）。
  for (let i = 0; i < rarity.affixMax; i += 1) {
    const affix = rng.pick(AFFIXES);
    if (affix.id === 'crit') {
      // 暴击以 0.1 个百分点为单位存整数，避免浮点累积
      stats.crit += rng.nextRange(3, 12);
    } else if (affix.id === 'maxHp') {
      stats.maxHp += Math.max(1, Math.floor(power * (0.8 + rng.next() * 1.2)));
    } else {
      stats[affix.id] += Math.max(1, Math.floor(power * (0.15 + rng.next() * 0.25)));
    }
  }

  const gear = {
    id: `eq.${idSuffix}`,
    name: `${RARITY_PREFIX[rarityIndex]}${baseName}`,
    slot,
    rarityIndex,
    floorNumber,
    enhanceLevel: 0,
    stats,
  };
  gear.score = gearScore(gear);
  return gear;
}

/** 装备评分：给「自动比较哪件更好」提供单一标量。 */
export function gearScore(gear) {
  const s = gear.stats;
  return Math.floor(s.attack * 10 + s.defense * 8 + s.maxHp * 0.8 + s.crit * 6);
}

/** 强化到下一级的费用（命运碎片）。 */
export function enhanceCost(gear) {
  const rarityFactor = 1 + gear.rarityIndex * 0.35;
  return Math.floor(ENHANCE_BASE_COST * rarityFactor * ENHANCE_COST_RATE ** gear.enhanceLevel);
}

/**
 * 强化一件装备（就地修改）。确定性：固定增幅，无随机、无失败。
 * @returns {{ok:boolean, reason?:string, cost?:number, level?:number}}
 */
export function enhanceGear(gear, availableShards) {
  if (gear.enhanceLevel >= ENHANCE_MAX) return { ok: false, reason: 'maxEnhance' };
  const cost = enhanceCost(gear);
  if (availableShards < cost) return { ok: false, reason: 'insufficientShards' };

  gear.enhanceLevel += 1;
  const kind = slotKind(gear.slot);
  const bump = (value) => Math.max(value + 1, Math.floor(value * (1 + ENHANCE_STEP_MUL)));

  if (kind === 'weapon') {
    gear.stats.attack = bump(gear.stats.attack);
  } else if (kind === 'armor') {
    gear.stats.defense = bump(gear.stats.defense);
    if (gear.stats.maxHp > 0) gear.stats.maxHp = bump(gear.stats.maxHp);
  } else {
    gear.stats.attack = bump(gear.stats.attack);
    gear.stats.defense = bump(gear.stats.defense);
  }

  gear.score = gearScore(gear);
  return { ok: true, cost, level: gear.enhanceLevel };
}

/** 分解回收的碎片数。 */
export function salvageValue(gear) {
  return Math.max(1, Math.floor(SALVAGE_BASE * (gear.rarityIndex + 1) * (1 + gear.enhanceLevel * 0.2)));
}

/** 空装备栏。 */
export function createEmptyEquipment() {
  const slots = {};
  for (const slot of EQUIP_SLOTS) slots[slot] = null;
  return slots;
}

/**
 * 汇总装备提供的属性加成。
 * 遍历顺序固定为 EQUIP_SLOTS 顺序 —— 整数加法虽满足交换律，但保持固定顺序
 * 让「加成来源明细」的展示顺序也稳定。
 */
export function totalEquipmentStats(equipment) {
  const total = { maxHp: 0, attack: 0, defense: 0, crit: 0 };
  for (const slot of EQUIP_SLOTS) {
    const gear = equipment?.[slot];
    if (gear === null || gear === undefined) continue;
    total.maxHp += gear.stats.maxHp;
    total.attack += gear.stats.attack;
    total.defense += gear.stats.defense;
    total.crit += gear.stats.crit;
  }
  return total;
}

/** 品质定义查表。 */
export function rarityOf(gear) {
  return RARITIES[gear.rarityIndex] ?? RARITIES[0];
}

/** 词缀可读摘要，UI 与图鉴共用。 */
export function describeGear(gear) {
  const parts = [];
  if (gear.stats.attack > 0) parts.push(`攻击 +${gear.stats.attack}`);
  if (gear.stats.defense > 0) parts.push(`防御 +${gear.stats.defense}`);
  if (gear.stats.maxHp > 0) parts.push(`生命 +${gear.stats.maxHp}`);
  if (gear.stats.crit > 0) parts.push(`暴击 +${(gear.stats.crit / 10).toFixed(1)}%`);
  return parts.join(' · ');
}

export { slotKind, SLOT_BASE_NAMES };
