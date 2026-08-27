import { OFFICIAL_ENCOUNTERS } from './encounters.js';
import { OFFICIAL_SHOP_ITEMS } from './shopItems.js';
import { OFFICIAL_EVENTS } from './events.js';

export function setup(context) {
  const normal = OFFICIAL_ENCOUNTERS.filter((e) => e.tier === 'normal').length;
  const elite = OFFICIAL_ENCOUNTERS.filter((e) => e.tier === 'elite').length;
  context.log(`注册 ${OFFICIAL_ENCOUNTERS.length} 个遭遇模板（普通 ${normal} / 精英 ${elite}）`);
  return {
    encounters: OFFICIAL_ENCOUNTERS,
    shopItems: OFFICIAL_SHOP_ITEMS,
    events: OFFICIAL_EVENTS,
  };
}
