/**
 * 遭遇池抽取（规格 7.1）。
 *
 * 用遭遇流（seed, floorNumber, nodeId），与地图流隔离 —— 这保证玩家反复往返
 * 探索时，同一节点的怪物配置恒定（裁决 2 要解决的核心问题）。
 */

import { encounterStream } from '../prng.js';
import { createEntity } from '../entity.js';
import { FACTION } from '../constants.js';
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
  const eligible = [...encounters.values()]
    .filter((e) => e.tier === tier && floorNumber >= e.minFloor && floorNumber <= e.maxFloor)
    .sort((a, b) => (a.id < b.id ? -1 : 1));

  if (eligible.length === 0) {
    throw new ContractViolationError(`没有适用于第 ${floorNumber} 层的 ${tier} 遭遇模板`, {
      floorNumber,
      tier,
    });
  }

  return rng.pickWeighted(eligible);
}

/**
 * 按遭遇模板实例化怪物实体。
 *
 * 层数缩放：每层 +12% HP、+8% 攻击，向下取整。缩放是确定性的纯函数，
 * 不消费随机数 —— 属性浮动才消费（下方 variance）。
 */
export function instantiateMonsters({ encounter, monsters, floorNumber, seed, nodeId }) {
  const rng = encounterStream(seed, floorNumber, `${nodeId}:stats`);
  const hpScale = 1 + (floorNumber - 1) * 0.12;
  const atkScale = 1 + (floorNumber - 1) * 0.08;

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
      maxHp: Math.max(1, Math.floor(template.maxHp * hpScale * variance)),
      attack: Math.max(0, Math.floor(template.attack * atkScale * variance)),
      defense: template.defense,
      gcdSequence: [...template.gcdSequence],
      ogcdSlots: template.ogcdSlots.map((s) => ({ ...s })),
    });
  });
}
