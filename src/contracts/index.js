/**
 * 默认契约装配。
 *
 * 所有默认实现都通过闭包注入依赖（store / rng 提供者 / 音频 sink），
 * 使契约本身不持有全局状态，便于单测替换。
 */

import { Registry } from './registry.js';
import {
  AUDIO_PLAY,
  BUFF_APPLY,
  COMBAT_LOG,
  DAMAGE_APPLY,
  HEAL_APPLY,
  PRNG_NEXT,
  STATE_QUERY,
} from './symbols.js';
import { createDamageApply } from './defaults/damage.js';
import { createHealApply } from './defaults/heal.js';
import { createStateQuery } from './defaults/query.js';
import { createPrngNext } from './defaults/prng.js';
import { createBuffApply } from './defaults/buff.js';
import { createCombatLog, pushLog } from './defaults/log.js';
import { createAudioPlay } from './defaults/audio.js';

/** 在状态中按 id 查实体（玩家或怪物）。 */
export function findEntity(state, entityId) {
  if (state.player?.id === entityId) return state.player;
  for (const monster of state.monsters) {
    if (monster.id === entityId) return monster;
  }
  return null;
}

/**
 * @param {object} deps
 * @param {import('../core/store.js').Store} deps.store
 * @param {() => {next():number}} deps.getRng 返回当前活动随机流
 * @param {() => (Map<string,object>|undefined)} [deps.getBuffTable] 模组注册的 Buff 定义表
 * @param {() => ({play(id, opts):void}|null)} [deps.getAudioSink]
 * @param {Registry} [deps.registry]
 */
export function registerDefaultContracts({
  store,
  getRng,
  getBuffTable = () => undefined,
  getAudioSink = () => null,
  registry,
} = {}) {
  const reg = registry ?? new Registry();
  const shared = { store, getRng, findEntity, pushLog, getBuffTable };

  reg.register(DAMAGE_APPLY, createDamageApply(shared), { source: 'core' });
  reg.register(HEAL_APPLY, createHealApply(shared), { source: 'core' });
  reg.register(STATE_QUERY, createStateQuery(shared), { source: 'core' });
  reg.register(PRNG_NEXT, createPrngNext(shared), { source: 'core' });
  reg.register(BUFF_APPLY, createBuffApply(shared), { source: 'core' });
  reg.register(COMBAT_LOG, createCombatLog(shared), { source: 'core' });
  reg.register(AUDIO_PLAY, createAudioPlay({ getSink: getAudioSink }), { source: 'core' });

  return reg;
}

export { Registry, pushLog };
export * from './symbols.js';
