export const PROVIDES_CORE_ENCOUNTERS = Symbol.for('fate.provide.encounters.core');
export const REQUIRES_CORE_MONSTERS = Symbol.for('fate.provide.monsters.core');

export default {
  id: 'official.core-encounters',
  version: '1.0.0',
  type: 'content',
  provides: [PROVIDES_CORE_ENCOUNTERS],
  // 遭遇模板引用怪物 ID，必须在怪物模组之后加载
  requires: [REQUIRES_CORE_MONSTERS],
};
