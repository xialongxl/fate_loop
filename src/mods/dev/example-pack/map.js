/**
 * 示例包的地图生成器 —— 演示"换掉地图逻辑"长什么样。
 *
 * ⚠️ 两件事必须先明白：
 *
 * 1. **想替换游戏用的图，id 必须写 `'official.grid'`**（GameFlow 按这个 id 取生成器）。
 *    本例故意用 `dev.example.grid`，这样它进池但**不接管**游戏 —— 示例包不该
 *    把开发时的地图换成 8 个格子的小路。想换就把 id 改掉。
 * 2. 换生成器会过一道**准入校验**（装包时跑 5 组 (seed, floor) 采样）：
 *    ① 同一组参数两次输出必须逐字节相同 ⇒ 不能用 `Math.random` / `Date.now`，
 *       随机性只能从传进来的 `seed` 自己派生；
 *    ② 起点可达出口、可通行节点无孤岛、节点 id 唯一、type 合法、邻接不指向未知节点。
 *    官方内容不过 lint 也不过测试，装包那一刻是唯一的拦截点。
 *
 * 还有一条容易搞错的：**单向邻接是合法的**，而且本作的死路就靠它表达
 * （死路节点列出邻居以便把连线画出来，邻居不列出它，于是 `areAdjacent`
 * 天然拒绝往死路里走）。不用为了"对称"去补反向边。
 */

/** 一个极小的确定性伪随机：完全由 (seed, floorNumber) 决定，绝不碰物理时钟。 */
function seededStream(seed, floorNumber) {
  let state = (seed ^ 0x9e3779b9) >>> 0;
  state = (state + floorNumber * 0x85ebca6b) >>> 0;
  return {
    next() {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
    int(min, max) {
      return min + Math.floor(this.next() * (max - min + 1));
    },
  };
}

const CYCLE = ['combat', 'event', 'shop', 'combat', 'rest', 'elite', 'combat', 'empty'];

export function buildExampleGrid({ seed, floorNumber }) {
  const rng = seededStream(seed, floorNumber);
  const width = rng.int(4, 8);
  const nodes = [];
  const adjacency = {};

  // 一条蛇形主路：简单、必然连通、起点到出口一定可达（写生成器时先保证这个）
  for (let i = 0; i < width; i += 1) {
    const id = `void.${floorNumber}.${i}`;
    const type = i === 0 ? 'start' : i === width - 1 ? 'exit' : CYCLE[(i + floorNumber) % CYCLE.length];
    nodes.push({
      id,
      gridX: i % 4,
      gridY: Math.floor(i / 4),
      type,
      displayName: `虚空回廊 ${i + 1}`,
      isRevealed: false,
      isCleared: false,
      combatEncounter: null,
      eventId: null,
    });
    adjacency[id] = [];
  }
  for (let i = 0; i < width - 1; i += 1) {
    const a = `void.${floorNumber}.${i}`;
    const b = `void.${floorNumber}.${i + 1}`;
    adjacency[a].push(b);
    adjacency[b].push(a); // 主路是双向的；只有死路才用单向边
  }

  // 挂一条死路演示单向边：它列出邻居，邻居不回列它 ⇒ 图上看得见、走不进去
  if (width >= 4) {
    const deadId = `void.${floorNumber}.dead`;
    nodes.push({
      id: deadId,
      gridX: 1,
      gridY: 2,
      type: 'deadEnd',
      displayName: '断裂',
      isRevealed: false,
      isCleared: false,
      combatEncounter: null,
      eventId: null,
    });
    adjacency[deadId] = [`void.${floorNumber}.1`];
  }

  return {
    nodes,
    adjacency,
    startNodeId: `void.${floorNumber}.0`,
    exitNodeId: `void.${floorNumber}.${width - 1}`,
    gridWidth: 4,
    gridHeight: 3,
  };
}
