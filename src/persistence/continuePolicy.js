/**
 * 「继续游戏」该读哪一份存档。
 *
 * 为什么需要这个文件：以前 `continueRun()` 写死读自动槽，于是发生过这样的事 ——
 * 玩家误点一次「新的轮回」，自动槽变成 Lv.1 空局，而 Lv.14 那一局还好好躺在
 * 存档位 2 里。这时候点「继续游戏」，游戏把他领进一个空局，看起来就像"存档没了"。
 * **"继续游戏"承诺的是"回到我在玩的那局"，不是"回到自动槽"**。
 *
 * 选择规则（按产品决定）：
 *  1. 时间优先 —— 最近写入的那份可用存档就是"我在玩的"
 *  2. **但**如果最新那份根本没有真进度（exp=0、0 胜场、0 已清理 —— 典型就是
 *     误点新局后还没打的自动槽），降级为**进度最高**的那份
 *  3. 进度按 exp 排（一局内 exp 单调不降，是等级的唯一真相源），
 *     平手再看层数与胜场
 *
 * 不兼容版本与空槽一律跳过：读它们只会抛错，而"继续游戏"不该抛错。
 */

import { hasMeaningfulProgress } from '../core/runProgress.js';

const num = (value) => (Number.isFinite(value) ? value : 0);

/** summarizeSave 的形状 → hasMeaningfulProgress 认识的形状。 */
function toRunLike(summary) {
  return {
    exp: num(summary?.exp),
    fateShards: num(summary?.fateShards),
    clearedNodeIds: num(summary?.nodesCleared),
    metadata: { battlesWon: num(summary?.battlesWon), floorsCleared: num(summary?.floorsCleared) },
  };
}

/** 进度排名：exp 为主，层数与胜场破平。 */
function progressRank(summary) {
  return num(summary?.exp) * 1000 + num(summary?.floorNumber) * 100 + num(summary?.battlesWon);
}

/** 可用的（非空、版本兼容）存档。 */
function usableSlots(slots) {
  return (slots ?? []).filter((slot) => slot !== null && slot !== undefined && slot.empty !== true && slot.incompatible !== true);
}

/**
 * @param {Array} slots SaveService.listSlots() 的输出
 * @returns {{slot: object, downgraded: boolean} | null}
 *   `downgraded` 为真表示"最新那份是空局，所以改读了进度更高的那份" ——
 *   UI 该把这件事说出来，不要让玩家自己猜。
 */
export function pickResumableSlot(slots) {
  const usable = usableSlots(slots);
  if (usable.length === 0) return null;

  const newest = [...usable].sort((a, b) => num(b.savedAt) - num(a.savedAt))[0];
  if (hasMeaningfulProgress(toRunLike(newest))) return { slot: newest, downgraded: false };

  const best = [...usable].sort((a, b) => progressRank(b) - progressRank(a))[0];
  if (best !== undefined && hasMeaningfulProgress(toRunLike(best)) && progressRank(best) > 0) {
    return { slot: best, downgraded: best.slotId !== newest.slotId };
  }
  // 全都空着：还是回到最新那份，至少是玩家最后碰过的
  return { slot: newest, downgraded: false };
}
