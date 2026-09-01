/**
 * 前瞻性投资系统 · ATM（纯逻辑，不碰存储与 DOM）
 *
 * 一句话：把「死亡就清零的命运碎片」存进一台跨局保留的存款机。
 * 余额与**历史累计**分开记：奖励按历史累计判定，取钱不会把累计取回去。
 *
 * 蓝本是 Fate_echo 的 `js/atm.js`（它的蓝本又是黑流树海的 PRTS 投资系统），
 * 那里被验证过的三件事这里原样保留：
 *   1. **1:1 无损取出**（以撒捐款机"钱能拿回来"的语义）——
 *      存进去不是消费，是"把钱从本局挪到跨局"。这条是玩家敢存的前提
 *   2. **余额与累计两个数**（累计只增不减）——奖励阶梯因此不会来回跳
 *   3. **不假装热生效**：Fate_echo 那句「折扣跨门槛后立即生效；商品扩容下次进店生效」
 *      是好的 UI 纪律，我们的阶梯接上时也要照写
 *
 * ## 两件本作特有的事，别弄错
 *
 * - **这是本项目第一个跨局的数值**。它一进来，"同种子必得同结果"就多了一个
 *   输入：同一份种子，ATM 余额不同 ⇒ 本局可用的碎片不同。所以装配层要把它
 *   显示出来（商店/设置屏），而战绩要留下当时的余额与累计 ——
 *   不是防作弊（本作是单机），而是让两个人对不上账时**有地方查**。
 * - **它不进存档导出/导入**（与设置同类：那是本机数据，不是某一局的进度）。
 *   代价是明写的：换浏览器或清本站数据会丢余额。真要跨设备，得先定「两台设备
 *   怎么合账」的规则，而不是默默拿 max 把坑填掉。
 * - **奖励阶梯目前是空的**（`ATM_REWARDS = []`）。这是刻意的：先落"存取与跨局余额"
 *   这件确定的事，阶梯的数值要等 P4 精炼的费用曲线一起算（三个出口抢同一枚碎片：
 *   强化一套终焉 ≈32.5k、精炼一套 ≈73.9k，实测一局到 50 层约 20k、之后 ≈+500/层）。
 *   阶梯为空时所有取用方都必须**如实说"待定"**，不许显示"全部已解锁"。
 */

/** 单次存取的快捷面额（只是按钮；规则允许任意整数额度，见 deposit/withdraw）。 */
export const ATM_DENOMS = Object.freeze([50, 200, 1000]);

/** 奖励阶梯：`{ threshold, desc, ...效果 }`，按 `total` 判定。**待定**。 */
export const ATM_REWARDS = Object.freeze([]);

/**
 * 取款解锁所需的累计存款额。
 *
 * 阶梯定案前先设 0（=取款直接开放）。理由不是"方便"，而是**没有奖励可解锁时，
 * 取款门槛毫无意义** —— 而它一旦有意义就必须与 `ATM_REWARDS` 一起改：
 * 门槛写在阶梯里（15 → "解锁取款功能"）才只有一个真相源，这里这个临时值是第二个，
 * 所以把它标成 TODO 而不是当设计。
 */
export const WITHDRAW_UNLOCK_TOTAL = 0;

/** 一次最多存/取多少（防手滑输入一个天文数字把界面撑坏）。 */
export const ATM_MAX_TICKET = 1_000_000_000;

/** 空的 ATM 记录（新环境、或读不到盘时的兜底）。 */
export function emptyAtm() {
  return { balance: 0, total: 0, deposits: 0, withdrawals: 0 };
}

function amount(value, fallback = 0) {
  const n = Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Math.max(0, n);
}

/** 把任意来源的记录洗成合法值（负数归零、非数字归零、不认识的字段丢掉）。 */
export function normalizeAtm(raw) {
  if (raw === null || raw === undefined || typeof raw !== 'object') return emptyAtm();
  const balance = amount(raw.balance);
  // 累计只增不减：盘上万一出现 total < balance（被手改/旧版数据），以 balance 兜底
  const total = Math.max(amount(raw.total), balance);
  return {
    balance,
    total,
    deposits: amount(raw.deposits),
    withdrawals: amount(raw.withdrawals),
  };
}

/**
 * 阶梯进度（阶梯为空时返回"待定"而不是"全部已解锁"）。
 * @param {number} total 历史累计投资额
 * @param {Array<{threshold:number, desc:string}>} [ladder] 可注入的阶梯表。
 *   今天走默认值（空），但它让“阶梯填上之后”的所有分支都能被测试覆盖 ——
 *   不然 `locked` / `next` 这些分支就是“测不到的分支”（= 可能错到的分支）。
 * @returns {{pending:boolean, unlocked:Array, next:object|null, nextGap:number}}
 */
export function atmRewardInfo(total, ladder = ATM_REWARDS) {
  const t = amount(total);
  if (ladder.length === 0) {
    return { pending: true, unlocked: [], next: null, nextGap: 0 };
  }
  const unlocked = ladder.filter((reward) => t >= reward.threshold);
  const next = ladder.find((reward) => t < reward.threshold) ?? null;
  return { pending: false, unlocked, next, nextGap: next === null ? 0 : next.threshold - t };
}

/**
 * 能不能取（累计门槛 + 余额够）。
 * `threshold` 默认取常量，但**可以传**：阶梯还没定，门槛值将来一定会改，
 * 不传参就没法在测试里走 `locked` 那条分支（而“测不到的分支”就是“可能错到的分支”）。
 */
export function canWithdraw(atm, requested = 0, { threshold = WITHDRAW_UNLOCK_TOTAL } = {}) {
  const record = normalizeAtm(atm);
  if (record.total < threshold) return { ok: false, reason: 'locked' };
  if (requested > 0 && record.balance < requested) return { ok: false, reason: 'insufficientBalance' };
  return { ok: true };
}

/**
 * 存款：从本局碎片里扣，写进跨局余额与累计。
 * 不消费随机数、不读时钟 —— 纯函数，`(atm, {amount, shards}) → {ok, atm, spent}`。
 */
export function deposit(atm, { amount: raw, shards = 0 } = {}) {
  const record = normalizeAtm(atm);
  const wanted = amount(raw);
  if (wanted <= 0) return { ok: false, reason: 'badAmount', atm: record };
  if (wanted > ATM_MAX_TICKET) return { ok: false, reason: 'tooBig', atm: record };
  const wallet = amount(shards);
  if (wanted > wallet) return { ok: false, reason: 'insufficientShards', atm: record };

  return {
    ok: true,
    spent: wanted,
    atm: {
      ...record,
      balance: record.balance + wanted,
      total: record.total + wanted,
      deposits: record.deposits + 1,
    },
  };
}

/** 取款：从跨局余额里取回本局碎片。累计不动（这就是"无损"的含义）。 */
export function withdraw(atm, { amount: raw, threshold = WITHDRAW_UNLOCK_TOTAL } = {}) {
  const record = normalizeAtm(atm);
  const wanted = amount(raw);
  if (wanted <= 0) return { ok: false, reason: 'badAmount', atm: record };
  const gate = canWithdraw(record, wanted, { threshold });
  if (!gate.ok) return { ok: false, reason: gate.reason, atm: record };

  return {
    ok: true,
    gained: wanted,
    atm: {
      ...record,
      balance: record.balance - wanted,
      withdrawals: record.withdrawals + 1,
    },
  };
}

/** 一行话摘要（商店面板与设置屏共用同一句措辞，不各写一份）。 */
export function atmSummary(atm) {
  const record = normalizeAtm(atm);
  const info = atmRewardInfo(record.total);
  const head = `余额 ${record.balance} · 历史累计 ${record.total}`;
  if (info.pending) return `${head} · 投资奖励待定（当前存取 1:1，累计照常记）`;
  if (info.next === null) return `${head} · 投资奖励已全部解锁`;
  return `${head} · 下一档 ${info.next.threshold}（还差 ${info.nextGap}）`;
}
