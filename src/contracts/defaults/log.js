/**
 * combat.log 契约实现 —— 日志条目的**唯一入口**。
 *
 * 定长裁剪至 LOG_CAPACITY（规格 8.2 环形缓冲的等价语义）。
 * 每条附 virtualTime，UI 据此画时间轴。
 *
 * ## 为什么日志存结构而不是存句子
 *
 * 以前这里只有 `pushLog(state, message)`，一条日志就是一句中文。后果是 UI 想按
 * 类型排版（伤害橙、暴击抢行、治疗绿）只能 `message.includes('伤害')` 去猜 ——
 * 而技能描述里也会出现"伤害"两个字，猜错就是静默错版。
 *
 * 现在战斗事件带字段（kind / actorId / targetId / skillId / amount / crit…），
 * 叙事行仍然可以只给一个字符串（自动落成 `{ t, text }`）。两条路共用同一条缓冲。
 *
 * ## 两条刻意的取舍
 *
 * 1. **存 id 不存名字**。渲染时才查池拿显示名。写死名字的话，改文案等于改了
 *    历史日志，而日志参与战斗指纹对拍 —— 那会让"只改措辞"变成"改行为"。
 * 2. **战斗指纹不再看措辞**（见 tests/helpers.js 的 battleFingerprint）。
 *    结构化字段才是可对比的东西，散文不是。
 */

import { LOG_CAPACITY } from '../../core/constants.js';

/**
 * 支持的 kind：
 *   damage / heal / buff / debuff —— 战斗事件，带数值
 *   （没有 kind 的即叙事行，只有 text）
 *
 * 引擎内部也用这个函数写日志，保证格式统一。
 */
export function pushLog(state, entry) {
  const record =
    typeof entry === 'string'
      ? { t: state.virtualTime, text: entry }
      : { t: state.virtualTime, ...entry };
  state.log.push(record);
  if (state.log.length > LOG_CAPACITY) {
    state.log.splice(0, state.log.length - LOG_CAPACITY);
  }
  return record;
}

export function createCombatLog({ store }) {
  /** 第三方包的 ctx.log('…') 走这条：只给字符串，落成为叙事行。 */
  return function combatLog(message) {
    pushLog(store.unsafeGetState(), String(message));
  };
}
