/** 事件 → soundId 映射表（数据驱动，UI 与技能都从此取名）。 */

export const SOUND_IDS = Object.freeze({
  UI_CLICK: 'ui.click',
  UI_MOVE: 'ui.move',
  UI_DENY: 'ui.deny',
  UI_DRAG: 'ui.drag',
  UI_CONFIRM: 'ui.confirm',
  UI_PURCHASE: 'ui.purchase',
  BATTLE_START: 'battle.start',
  BATTLE_VICTORY: 'battle.victory',
  BATTLE_DEFEAT: 'battle.defeat',
  HIT: 'combat.hit',
  CRIT: 'combat.crit',
  HEAL: 'combat.heal',
  BUFF: 'combat.buff',
  DEATH: 'combat.death',
  FLOOR_DOWN: 'map.floorDown',
  REST: 'map.rest',
});

/**
 * 音效清单。src 为空数组表示"尚无资源"，Howler 加载失败会静默降级 —— 
 * 这正是裁决 8 规则 3 的设计意图：缺资源不影响任何功能。
 */
export const SOUND_MANIFEST = Object.freeze(
  Object.values(SOUND_IDS).map((id) => ({
    id,
    src: [`/audio/${id}.webm`, `/audio/${id}.m4a`],
    volume: id.startsWith('ui.') ? 0.35 : 0.5,
  })),
);
