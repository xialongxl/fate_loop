/** 邻接表构建（规格 5.1 mapAdjacency）。四方向连通，键序稳定。 */

const DIRECTIONS = Object.freeze([
  { dx: 0, dy: -1 },
  { dx: 1, dy: 0 },
  { dx: 0, dy: 1 },
  { dx: -1, dy: 0 },
]);

/**
 * @param {string[]} nodeIds 参与连通的节点 ID
 * @param {Map<string,{gridX:number,gridY:number}>} cells 全部格子（含不参与连通的）
 * @param {number} gridWidth
 * @param {number} gridHeight
 * @returns {Record<string,string[]>}
 */
export function buildAdjacency(nodeIds, cells, gridWidth, gridHeight) {
  const included = new Set(nodeIds);
  const adjacency = {};

  for (const id of [...included].sort()) {
    const cell = cells.get(id);
    if (cell === undefined) {
      adjacency[id] = [];
      continue;
    }
    const neighbors = [];
    for (const dir of DIRECTIONS) {
      const nx = cell.gridX + dir.dx;
      const ny = cell.gridY + dir.dy;
      if (nx < 0 || ny < 0 || nx >= gridWidth || ny >= gridHeight) continue;
      const nk = `node_${nx}_${ny}`;
      if (included.has(nk)) neighbors.push(nk);
    }
    adjacency[id] = neighbors.sort();
  }

  return adjacency;
}

/** 判断两节点是否上下左右相邻（规格 6.3）。 */
export function areAdjacent(adjacency, fromId, toId) {
  return (adjacency[fromId] ?? []).includes(toId);
}
