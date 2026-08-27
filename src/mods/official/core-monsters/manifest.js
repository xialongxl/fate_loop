export const PROVIDES_CORE_MONSTERS = Symbol.for('fate.provide.monsters.core');
export const REQUIRES_CORE_SKILLS = Symbol.for('fate.provide.skills.core');

export default {
  id: 'official.core-monsters',
  version: '1.0.0',
  type: 'content',
  provides: [PROVIDES_CORE_MONSTERS],
  // 怪物的 gcdSequence 引用技能 ID，必须在技能模组之后加载
  requires: [REQUIRES_CORE_SKILLS],
};
