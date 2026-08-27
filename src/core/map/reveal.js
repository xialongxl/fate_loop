/**
 * 节点揭示规则（规格 6.2 第三步补充 / 6.3）。
 * 初始仅起点及其相邻节点可见；每进入一个节点，揭示其相邻节点。
 */

/** 揭示指定节点及其相邻节点。就地修改 nodes 数组中的 isRevealed。 */
export function revealAround(nodes, adjacency, nodeId) {
  const toReveal = new Set([nodeId, ...(adjacency[nodeId] ?? [])]);
  for (const node of nodes) {
    if (toReveal.has(node.id)) node.isRevealed = true;
  }
  return nodes;
}

/** 初始揭示：起点 + 相邻。 */
export function revealInitial(nodes, adjacency, startNodeId) {
  return revealAround(nodes, adjacency, startNodeId);
}
