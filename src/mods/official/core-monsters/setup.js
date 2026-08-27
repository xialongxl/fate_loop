import { OFFICIAL_MONSTERS } from './monsters.js';

export function setup(context) {
  context.log(`注册 ${OFFICIAL_MONSTERS.length} 种官方怪物`);
  return { monsters: OFFICIAL_MONSTERS };
}
