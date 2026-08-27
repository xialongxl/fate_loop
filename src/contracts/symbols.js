/**
 * 契约标识符（规格 8.2 六个内置契约 + 裁决 8 新增 audio.play）。
 *
 * 用 Symbol.for 注册到全局符号表：模组以独立 ESM 文件加载，可能拿到不同的
 * symbols.js 模块实例，Symbol.for 保证跨实例仍是同一个键。
 */

export const DAMAGE_APPLY = Symbol.for('fate.contract.damage.apply');
export const HEAL_APPLY = Symbol.for('fate.contract.heal.apply');
export const STATE_QUERY = Symbol.for('fate.contract.state.query');
export const PRNG_NEXT = Symbol.for('fate.contract.prng.next');
export const BUFF_APPLY = Symbol.for('fate.contract.buff.apply');
export const COMBAT_LOG = Symbol.for('fate.contract.combat.log');
export const AUDIO_PLAY = Symbol.for('fate.contract.audio.play');

/** 全部核心契约，供加载校验与调试面板遍历。 */
export const CORE_CONTRACTS = Object.freeze([
  DAMAGE_APPLY,
  HEAL_APPLY,
  STATE_QUERY,
  PRNG_NEXT,
  BUFF_APPLY,
  COMBAT_LOG,
  AUDIO_PLAY,
]);

/** 传给模组 setup 的契约映射，模组作者用 contracts.damageApply 取用。 */
export const CONTRACT_MAP = Object.freeze({
  damageApply: DAMAGE_APPLY,
  healApply: HEAL_APPLY,
  stateQuery: STATE_QUERY,
  prngNext: PRNG_NEXT,
  buffApply: BUFF_APPLY,
  combatLog: COMBAT_LOG,
  audioPlay: AUDIO_PLAY,
});

/** Symbol → 可读名称，用于错误信息。 */
export function contractName(symbol) {
  return symbol.description ?? String(symbol);
}
