import { OFFICIAL_BUFFS } from './buffs.js';
import { OFFICIAL_SKILLS } from './skills.js';

export function setup(context) {
  context.log(`注册 ${OFFICIAL_SKILLS.length} 个官方技能、${OFFICIAL_BUFFS.length} 个 Buff`);
  return { skills: OFFICIAL_SKILLS, buffs: OFFICIAL_BUFFS };
}
