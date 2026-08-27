/**
 * prng.next 契约实现。
 * 推进当前活动流（战斗中为战斗流），返回 [0,1)。
 */

export function createPrngNext({ getRng }) {
  return function prngNext() {
    return getRng().next();
  };
}
