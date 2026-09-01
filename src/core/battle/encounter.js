/**
 * 遭遇池抽取（规格 7.1）。
 *
 * 用遭遇流（seed, floorNumber, nodeId），与地图流隔离 —— 这保证玩家反复往返
 * 探索时，同一节点的怪物配置恒定（裁决 2 要解决的核心问题）。
 */

import { encounterStream } from '../prng.js';
import { createEntity } from '../entity.js';
import { FACTION } from '../constants.js';
import { monsterScaleAtFloor } from '../growth.js';
import { ContractViolationError } from '../../utils/invariant.js';

/**
 * 为节点抽取遭遇模板。
 * @param {object} params
 * @param {number} params.seed
 * @param {number} params.floorNumber
 * @param {string} params.nodeId
 * @param {'normal'|'elite'} params.tier
 * @param {Map} params.encounters 内容池中的遭遇模板
 */
export function pickEncounter({ seed, floorNumber, nodeId, tier, encounters }) {
  const rng = encounterStream(seed, floorNumber, nodeId);
  const byId = (a, b) => (a.id < b.id ? -1 : 1);
  let eligible = [...encounters.values()]
    .filter((e) => e.tier === tier && floorNumber >= e.minFloor && floorNumber <= e.maxFloor)
    .sort(byId);

  if (eligible.length === 0) {
    // 无尽模式可以跑到内容池覆盖不到的深度（官方模板最深到 999 层）。
    // 与其抛错把一局好局打死，不如退回最深的那一档：取 minFloor 不超过本层的
    // 模板中最深的一组。仍是纯函数，不消费随机数，因此不破坏确定性。
    const ofTier = [...encounters.values()].filter((e) => e.tier === tier);
    const reachable = ofTier.filter((e) => e.minFloor <= floorNumber).sort((a, b) => b.minFloor - a.minFloor);
    const deepest = reachable.length > 0 ? reachable[0].minFloor : null;
    eligible =
      deepest === null
        ? ofTier.slice().sort(byId)
        : ofTier.filter((e) => e.minFloor === deepest).sort(byId);
  }

  if (eligible.length === 0) {
    throw new ContractViolationError(`内容池里一个 ${tier} 遭遇模板都没有`, { floorNumber, tier });
  }

  return rng.pickWeighted(eligible);
}

/**
 * 按遭遇模板实例化怪物实体。
 *
 * 层数缩放：读 `GROWTH_BUDGET.monster`（默认表下就是现状的 +12% HP / +8% 攻击，
 * 向下取整）。以前这两个系数是本文件里硬编码的字面量 —— 它就是「没人总账」
 * 的现场之一：玩家侧长得多快写在 constants，怪侧长得多快写在这里，
 * 两边各自“看着对”，合起来到 40 层就坡了。P3 把它们收进同一张表。
 * 缩放仍是确定性的纯函数，不消费随机数 —— 属性浮动才消费（下方 variance）。
 */
export function instantiateMonsters({ encounter, monsters, floorNumber, seed, nodeId }) {
  const rng = encounterStream(seed, floorNumber, `${nodeId}:stats`);
  const scale = monsterScaleAtFloor(floorNumber);

  return encounter.monsterIds.map((monsterId, index) => {
    const template = monsters.get(monsterId);
    if (template === undefined) {
      throw new ContractViolationError(`遭遇 ${encounter.id} 引用了不存在的怪物 ${monsterId}`, { monsterId });
    }

    // ±5% 属性浮动，让同一模板的重复出现略有差异
    const variance = 0.95 + rng.next() * 0.1;

    return createEntity({
      id: `${monsterId}#${index}`,
      name: template.name,
      faction: FACTION.MONSTER,
      maxHp: Math.max(1, Math.floor(template.maxHp * scale.hp * variance)),
      attack: Math.max(0, Math.floor(template.attack * scale.attack * variance)),
      defense: Math.max(0, Math.floor(template.defense * scale.defense)),
      gcdSequence: [...template.gcdSequence],
      ogcdSlots: template.ogcdSlots.map((s) => ({ ...s })),
    });
  });
}
