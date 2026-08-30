/**
 * "这一局到底有没有发生过事情" / "这份档比现在这份更旧吗" —— 单一判定，三处共用：
 *   · GameFlow 决定要不要写自动存档槽
 *   · SaveService 决定要不要把当前自动存档收进备份历史
 *   · SaveService 决定覆盖前是否先备份（回退安全网）
 *
 * 为什么单独一个文件而不是各写一份：这三处判断的是同一件事。历史上它们
 * 不一致过一次，代价是玩家丢档。
 *
 * ⚠️ **必须同时吃两种形状**：
 *   - 运行时状态：`state.player.exp`、`clearedNodeIds` 是 Set、`shopStates` 是 Map
 *   - 存档形态：`serializeRun` 是**扁平**的 —— 顶层 `exp`、`equipment`、
 *     `clearedNodeIds` 是数组、商店叫 `shopPurchases`
 *   只认一种的话，"读盘上的档再判断"那条路会永远返回 false（我就踩过：
 *   备份安全网对 exp-only 的档静默不备份）。
 */

const countOf = (value) => {
  if (value instanceof Set || value instanceof Map) return value.size;
  if (Array.isArray(value)) return value.length;
  return 0;
};

/** 运行时/存档两种形状都能取到的字段访问器。 */
export const expOf = (run) => run?.player?.exp ?? run?.exp ?? 0;
const shardsOf = (run) => run?.fateShards ?? 0;
const equipmentOf = (run) => run?.player?.equipment ?? run?.equipment ?? {};
const inventoryOf = (run) => run?.player?.inventory ?? run?.inventory;
const clearedOf = (run) => run?.clearedNodeIds;
const shopsOf = (run) => run?.shopStates ?? run?.shopPurchases;
const metaOf = (run) => run?.metadata ?? {};

/**
 * 这局是否值得存。
 *
 * ⚠️ 关键一条：**不看 floorNumber**。走到第 2 层完全可以 0 胜场、0 碎片、0 装备、
 * 0 已清理节点 —— 那是"什么都没发生"，不是进度。以前这里写着 `floorNumber > 1`
 * 就算有进度，于是空局也够格覆盖自动存档槽。
 */
export function hasMeaningfulProgress(run) {
  if (run === null || run === undefined || typeof run !== 'object') return false;
  const m = metaOf(run);

  if (expOf(run) > 0) return true;
  if (shardsOf(run) > 0) return true;
  if (countOf(inventoryOf(run)) > 0) return true;
  if (Object.values(equipmentOf(run)).some((g) => g !== null && g !== undefined)) return true;
  if (countOf(clearedOf(run)) > 0) return true;
  if (countOf(shopsOf(run)) > 0) return true;

  for (const field of ['battlesWon', 'expEarned', 'shardsEarned', 'gearFound', 'floorsCleared']) {
    if ((m[field] ?? 0) > 0) return true;
  }
  return false;
}

/**
 * "新状态比现有存档更旧吗？" —— 自动存档覆盖前的安全网依据。
 *
 * 为什么光靠 hasMeaningfulProgress 不够：新局只要往下走一层，`floorsCleared`
 * 就 >0，它已经是"有进度"了 —— **任何**门控都挡不住"新局顶掉老局"，
 * 而那恰恰是丢档的现场。所以自动槽就该跟着当前局走，安全性由
 * "顶掉之前先把旧的存一份"保证。
 *
 * 主用 exp 判：一局内 exp 单调不降（升级、商店、事件都不扣 exp），
 * 所以 exp 变小只可能是"拿更旧的档去盖更新的档"。
 * 不看碎片：商店花碎片是合法变小，拿它当回退依据会天天误报。
 */
export function isSaveRegression(existing, incoming) {
  const before = expOf(existing);
  const after = expOf(incoming);
  if (after < before) return true;
  if (after > before) return false;
  // exp 相等时再比一层"下过几层"，盖住同 exp 但往回走的少量情况
  return (metaOf(existing).floorsCleared ?? 0) > (metaOf(incoming).floorsCleared ?? 0);
}
