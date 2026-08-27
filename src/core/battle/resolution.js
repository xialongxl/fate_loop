/** 战斗终止判定与超时保护（规格 7.2 步骤 6，规格 13）。 */

import { BATTLE_TIMEOUT_MS, GAME_STATUS, WINNER } from '../constants.js';
import { isAlive } from '../entity.js';

/**
 * @returns {{finished:boolean, winner:string|null, reason:string|null}}
 */
export function evaluateOutcome(state) {
  const playerAlive = isAlive(state.player);
  const monstersAlive = state.monsters.some(isAlive);

  if (!playerAlive) {
    return { finished: true, winner: WINNER.MONSTERS, reason: 'playerDown' };
  }
  if (!monstersAlive) {
    return { finished: true, winner: WINNER.PLAYER, reason: 'monstersCleared' };
  }
  // 超时保护：虚拟时间超 5 分钟未结束，判负（规格 13）
  if (state.virtualTime >= BATTLE_TIMEOUT_MS) {
    return { finished: true, winner: WINNER.MONSTERS, reason: 'timeout' };
  }
  return { finished: false, winner: null, reason: null };
}

/** 把结果写入状态。 */
export function applyOutcome(state, outcome) {
  state.status = GAME_STATUS.FINISHED;
  state.winner = outcome.winner;
  state.battleEndReason = outcome.reason;
  return state;
}
