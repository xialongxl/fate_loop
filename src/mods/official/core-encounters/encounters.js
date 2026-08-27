/**
 * 官方遭遇模板（100 个）。
 *
 * 60 个普通 + 40 个精英。全部由算术组合构造，不消费随机数。
 * 每个模板绑定 minFloor/maxFloor，形成难度曲线：低层只出 T1/T2，高层才出 T4/T5。
 *
 * 组合形态：
 *   solo    单体（1 只，高层级）
 *   pair    双体（2 只同族）
 *   trio    三体（3 只，含混族）
 *   pack    群体（4~5 只低层级）
 *   mixed   混编（不同族系组合）
 */

import { ARCHETYPES, FAMILIES } from '../core-monsters/monsters.js';

function monsterId(familyKey, archetypeKey, tierKey) {
  return `mon.${familyKey}.${archetypeKey}.${tierKey.toLowerCase()}`;
}

/** 层级 → 建议出现的楼层范围。 */
const TIER_FLOORS = {
  T1: { minFloor: 1, maxFloor: 5 },
  T2: { minFloor: 2, maxFloor: 9 },
  T3: { minFloor: 4, maxFloor: 14 },
  T4: { minFloor: 7, maxFloor: 22 },
  T5: { minFloor: 11, maxFloor: 999 },
};

/**
 * 精英遭遇的层段表，独立于 TIER_FLOORS。
 *
 * 必须从第 1 层就有覆盖：地图生成器在任意层都会按 12% 权重投放精英节点，
 * 若精英模板最低只到第 7 层，第 1~6 层的精英节点会直接抢错。
 * 低层精英用比同层普通遭遇高一级的 tier 来体现“精英感”。
 */
const ELITE_FLOORS = {
  T2: { minFloor: 1, maxFloor: 6 },
  T3: { minFloor: 4, maxFloor: 12 },
  T4: { minFloor: 8, maxFloor: 18 },
  T5: { minFloor: 14, maxFloor: 999 },
};

function buildEncounters() {
  const out = [];
  const familyCount = FAMILIES.length;
  const archCount = ARCHETYPES.length;

  // ---- 普通遭遇 60 个 ----
  // 每族 10 个：2 solo + 3 pair + 3 trio + 2 pack
  // tier 分配必须让层段连续覆盖到无穷（T5 的 maxFloor 是 999），
  // 否则深层会因无可用模板直接抢错。
  for (let f = 0; f < familyCount; f += 1) {
    const family = FAMILIES[f];

    // 2 个单体（T2 / T3）
    for (const [i, tierKey] of ['T2', 'T3'].entries()) {
      const arch = ARCHETYPES[(f * 3 + i) % archCount];
      out.push({
        id: `enc.${family.key}.solo${i + 1}`,
        name: `孤身的${family.name}${arch.name}`,
        tier: 'normal',
        monsterIds: [monsterId(family.key, arch.key, tierKey)],
        ...TIER_FLOORS[tierKey],
        weight: 12,
      });
    }

    // 3 个双体（T1 / T3 / T4）
    for (const [i, tierKey] of ['T1', 'T3', 'T4'].entries()) {
      const a1 = ARCHETYPES[(f + i) % archCount];
      const a2 = ARCHETYPES[(f + i + 4) % archCount];
      out.push({
        id: `enc.${family.key}.pair${i + 1}`,
        name: `成对的${family.name}${a1.name}`,
        tier: 'normal',
        monsterIds: [monsterId(family.key, a1.key, tierKey), monsterId(family.key, a2.key, tierKey)],
        ...TIER_FLOORS[tierKey],
        weight: 14,
      });
    }

    // 3 个三体（第三只来自邻族，形成混编）
    for (const [i, tierKey] of ['T1', 'T2', 'T4'].entries()) {
      const other = FAMILIES[(f + 1 + i) % familyCount];
      const a1 = ARCHETYPES[(f * 2 + i) % archCount];
      const a2 = ARCHETYPES[(f * 2 + i + 3) % archCount];
      const a3 = ARCHETYPES[(f * 2 + i + 6) % archCount];
      out.push({
        id: `enc.${family.key}.trio${i + 1}`,
        name: `${family.name}小队`,
        tier: 'normal',
        monsterIds: [
          monsterId(family.key, a1.key, tierKey),
          monsterId(family.key, a2.key, tierKey),
          monsterId(other.key, a3.key, tierKey),
        ],
        ...TIER_FLOORS[tierKey],
        weight: 11,
      });
    }

    // 2 个群体：低层 T1 小队 + 高层 T5 尽头群（T5 开放层段，兼顾无限深层）
    for (const [i, tierKey] of ['T1', 'T5'].entries()) {
      const size = 4 + i;
      const ids = [];
      for (let k = 0; k < size; k += 1) {
        ids.push(monsterId(family.key, ARCHETYPES[(f + i + k) % archCount].key, tierKey));
      }
      out.push({
        id: `enc.${family.key}.pack${i + 1}`,
        name: `${family.name}群`,
        tier: 'normal',
        monsterIds: ids,
        ...TIER_FLOORS[tierKey],
        weight: 9,
      });
    }
  }

  // ---- 精英遭遇 40 个 ----
  // 每族 7 个变体，层段从 T2 到 T5 连续覆盖，保证任意层都有可用模板
  let eliteIndex = 0;
  let eliteCount = 0;
  for (let f = 0; f < familyCount && eliteCount < 40; f += 1) {
    const family = FAMILIES[f];
    const variants = [
      // 低层（1~6）：T2 单体与 T2 双体
      { kind: 'solo', tierKey: 'T2', extra: 0 },
      { kind: 'pair', tierKey: 'T2', extra: 0 },
      // 中层（4~12）：T3 单体与 T3 带随从
      { kind: 'solo', tierKey: 'T3', extra: 0 },
      { kind: 'retinue', tierKey: 'T3', extra: 2 },
      // 高层（8~18）：T4 单体与 T4 带随从
      { kind: 'solo', tierKey: 'T4', extra: 0 },
      { kind: 'retinue', tierKey: 'T4', extra: 2 },
      // 终局（14+）：T5 双王
      { kind: 'duoboss', tierKey: 'T5', extra: 0 },
    ];

    for (const [vi, variant] of variants.entries()) {
      if (eliteCount >= 40) break;
      eliteIndex += 1;
      eliteCount += 1;

      const leadArch = ARCHETYPES[(f * 3 + vi) % archCount];
      const ids = [monsterId(family.key, leadArch.key, variant.tierKey)];

      if (variant.kind === 'pair') {
        ids.push(monsterId(family.key, ARCHETYPES[(f * 3 + vi + 5) % archCount].key, variant.tierKey));
      } else if (variant.kind === 'duoboss') {
        ids.push(monsterId(family.key, ARCHETYPES[(f * 3 + vi + 4) % archCount].key, 'T4'));
      } else if (variant.kind === 'retinue') {
        const minionTier = variant.tierKey === 'T4' ? 'T2' : 'T1';
        for (let k = 0; k < variant.extra; k += 1) {
          ids.push(monsterId(family.key, ARCHETYPES[(f * 3 + vi + k + 2) % archCount].key, minionTier));
        }
      }

      const floors = ELITE_FLOORS[variant.tierKey];
      out.push({
        id: `enc.elite.${family.key}.${eliteIndex}`,
        name:
          variant.kind === 'retinue'
            ? `${family.name}${leadArch.name}与其随从`
            : variant.kind === 'duoboss'
              ? `双王：${family.name}${leadArch.name}`
              : `${family.name}${leadArch.name}`,
        tier: 'elite',
        monsterIds: ids,
        minFloor: floors.minFloor,
        maxFloor: floors.maxFloor,
        weight: variant.tierKey === 'T5' ? 8 : 12,
      });
    }
  }

  return out;
}

export const OFFICIAL_ENCOUNTERS = buildEncounters();
