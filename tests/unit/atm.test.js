/**
 * ATM 的纯逻辑（`src/core/atm.js`）。
 *
 * 这里最重要的两条断言不是算术，而是两条"不许说谎"：
 *   ① 取款必须 1:1 无损 —— 历史累计**不能**因为取钱而变小，
 *      否则"存起来"就从"挪个地方"变成了"消费"，整个系统的动机塌掉
 *   ② 阶梯为空时必须说"待定"，不许显示"全部已解锁" ——
 *      "看着有其实没有"是本项目反复踩过的那类 bug
 */

import { describe, expect, it } from 'vitest';
import {
  ATM_DENOMS,
  ATM_REWARDS,
  WITHDRAW_UNLOCK_TOTAL,
  atmRewardInfo,
  atmSummary,
  canWithdraw,
  deposit,
  emptyAtm,
  normalizeAtm,
  withdraw,
} from '../../src/core/atm.js';

describe('账目规范化', () => {
  it('脏输入全部落到非负整数', () => {
    expect(normalizeAtm({ balance: -5, total: 'x', deposits: 2.9, withdrawals: null })).toEqual({
      balance: 0,
      total: 0,
      deposits: 2,
      withdrawals: 0,
    });
  });

  it('total < balance（被手改或旧数据）时以 balance 兜住 —— 累计只增不减', () => {
    expect(normalizeAtm({ balance: 900, total: 10 }).total).toBe(900);
  });

  it('非对象一律空账', () => {
    for (const raw of [undefined, null, 42, 'a', []]) expect(normalizeAtm(raw)).toEqual(emptyAtm());
  });

  it('规范化幂等（读盘→写盘→再读盘不该继续漂）', () => {
    const once = normalizeAtm({ balance: 12, total: 30, deposits: 3 });
    expect(normalizeAtm(once)).toEqual(once);
  });
});

describe('存款', () => {
  it('余额与累计一起涨，钱包相应扣掉', () => {
    const result = deposit(emptyAtm(), { amount: 500, shards: 800 });
    expect(result.ok).toBe(true);
    expect(result.spent).toBe(500);
    expect(result.atm).toEqual({ balance: 500, total: 500, deposits: 1, withdrawals: 0 });
  });

  it('连存两次：累计是两次之和（奖励按历史累计判定，不是按余额）', () => {
    const first = deposit(emptyAtm(), { amount: 100, shards: 1_000 });
    const second = deposit(first.atm, { amount: 50, shards: 900 });
    expect(second.atm).toMatchObject({ balance: 150, total: 150, deposits: 2 });
  });

  it('钱包不够、0、负数、非数、超单张上限都不成交', () => {
    const atm = emptyAtm();
    expect(deposit(atm, { amount: 100, shards: 99 }).reason).toBe('insufficientShards');
    expect(deposit(atm, { amount: 0, shards: 100 }).reason).toBe('badAmount');
    expect(deposit(atm, { amount: -50, shards: 100 }).reason).toBe('badAmount');
    expect(deposit(atm, { amount: NaN, shards: 100 }).reason).toBe('badAmount');
    expect(deposit(atm, { amount: 1e12, shards: 1e13 }).reason).toBe('tooBig');
  });

  it('不修改入参（装配层拿它做试算时不能污染当前账）', () => {
    const atm = normalizeAtm({ balance: 10, total: 10, deposits: 1 });
    const frozen = JSON.stringify(atm);
    deposit(atm, { amount: 5, shards: 100 });
    withdraw({ ...atm, balance: 999, total: 999 }, { amount: 5 });
    expect(JSON.stringify(atm)).toBe(frozen);
  });
});

describe('取款：1:1 无损是这整个系统的立论', () => {
  it('余额减、碎片加回同额，而**历史累计一格不动**', () => {
    const atm = normalizeAtm({ balance: 800, total: 800 });
    const result = withdraw(atm, { amount: 300 });
    expect(result.ok).toBe(true);
    expect(result.gained).toBe(300);
    expect(result.atm).toMatchObject({ balance: 500, total: 800, withdrawals: 1 });
  });

  it('取光余额也不会把累计取回去', () => {
    const atm = normalizeAtm({ balance: 120, total: 5_000 });
    const result = withdraw(atm, { amount: 120 });
    expect(result.atm).toMatchObject({ balance: 0, total: 5_000 });
  });

  it('余额不足与门槛未达是两种拒绝（措辞要分开：一个是"没钱"，一个是"还没解锁"）', () => {
    const poor = normalizeAtm({ balance: 10, total: 10 });
    expect(withdraw(poor, { amount: 50 }).reason).toBe('insufficientBalance');
    expect(withdraw(poor, { amount: 5, threshold: 100 }).reason).toBe('locked');
    expect(canWithdraw(poor, 5, { threshold: 100 })).toEqual({ ok: false, reason: 'locked' });
    expect(canWithdraw(poor, 5)).toEqual({ ok: true }); // 门槛未定案期间是开着的
  });

  it('0 / 负数 / 非数都不成交', () => {
    const atm = normalizeAtm({ balance: 500, total: 500 });
    for (const bad of [0, -10, NaN, undefined]) {
      expect(withdraw(atm, { amount: bad }).ok).toBe(false);
    }
  });
});

describe('奖励阶梯：空就得说空', () => {
  it('阶梯当前确实是空的（P4 精炼的费用曲线定了才填，别悄悄塞两个数进去）', () => {
    expect(ATM_REWARDS).toEqual([]);
    expect(WITHDRAW_UNLOCK_TOTAL).toBe(0);
  });

  it('空阶梯 ⇒ 摘要说"待定"，而且绝不出现"全部已解锁"', () => {
    const info = atmRewardInfo(999_999);
    expect(info.pending).toBe(true);
    expect(info.unlocked).toEqual([]);
    expect(info.next).toBeNull();
    const text = atmSummary({ balance: 1_000, total: 1_000 });
    expect(text).toContain('待定');
    expect(text).not.toContain('全部已解锁');
    expect(text).toContain('余额 1000');
  });

  it('有阶梯时：按历史累计判解锁、给下一档差额', () => {
    const ladder = [
      { threshold: 15, desc: '解锁取款' },
      { threshold: 50, desc: '商店 9 折' },
    ];
    // 阶梯参数是给未来的自己用的：填表之后所有取用方都不用改措辞
    const info = atmRewardInfo(50, ladder);
    expect(info.pending).toBe(false);
    expect(info.unlocked).toHaveLength(2);
    expect(info.next).toBeNull();
    const mid = atmRewardInfo(20, ladder);
    expect(mid.nextGap).toBe(30);
  });
});

describe('面额只是按钮，规则允许任意额度', () => {
  it('面额递增且都是正整数', () => {
    expect(ATM_DENOMS.every((n) => Number.isInteger(n) && n > 0)).toBe(true);
    expect([...ATM_DENOMS].sort((a, b) => a - b)).toEqual(ATM_DENOMS);
  });

  it('非面额的整数额度也接受（"存全部"这类快捷操作靠它）', () => {
    const odd = ATM_DENOMS[0] + 1;
    expect(deposit(emptyAtm(), { amount: odd, shards: 10_000 }).ok).toBe(true);
  });
});
