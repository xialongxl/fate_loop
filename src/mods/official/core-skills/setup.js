import { SKILL_FAMILIES, SKILL_FAMILY_LABELS } from '../../../core/constants.js';
import { OFFICIAL_BUFFS } from './buffs.js';
import { OFFICIAL_SKILLS } from './skills.js';

/** 官方六个流派也走注册制：与模组用同一套机制，UI 与解锁表都从 pool.families 读。 */
const OFFICIAL_FAMILIES = SKILL_FAMILIES.map((id) => ({ id, label: SKILL_FAMILY_LABELS[id] }));

export function setup(context) {
  context.log(
    `注册 ${OFFICIAL_SKILLS.length} 个官方技能、${OFFICIAL_BUFFS.length} 个 Buff、${OFFICIAL_FAMILIES.length} 个流派`,
  );
  return { skills: OFFICIAL_SKILLS, buffs: OFFICIAL_BUFFS, families: OFFICIAL_FAMILIES };
}
