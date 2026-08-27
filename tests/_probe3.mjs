import { createHarness } from './helpers.js';
import { NODE_TYPE } from '../src/core/constants.js';
import { rollBattleLoot } from '../src/core/loot.js';

const { store, flow, engine } = await createHarness({ seed: 20240101 });
flow.enterFloor(1);
const s = store.unsafeGetState();
const ids = new Set(s.mapNodes.map((n) => n.id));
const deadEnds = s.mapNodes.filter((n) => n.type === NODE_TYPE.DEAD_END).map((n) => n.id);
const reachableDead = deadEnds.filter((id) => Object.values(s.mapAdjacency).some((list) => list.includes(id)));
console.log('deadEnd count', deadEnds.length, 'adjacency keys', Object.keys(s.mapAdjacency).length, 'ids', ids.size);
console.log('dead ends reachable:', reachableDead);
console.log('adjacency has deadEnd keys?', deadEnds.filter((id) => id in s.mapAdjacency));

// seed sensitivity of map
const sig = async (seed) => {
  const h = await createHarness({ seed });
  h.flow.enterFloor(1);
  const st = h.store.unsafeGetState();
  return `${st.gridWidth}x${st.gridHeight}|${st.mapNodes.map((n) => n.type[0]).join('')}|${st.startNodeId}|${st.exitNodeId}`;
};
const a = await sig(20240101);
const b = await sig(777);
console.log('sigA', a);
console.log('sigB', b, 'differ?', a !== b);

// elite battle via startBattle
const { store: s2, flow: f2, engine: e2 } = await createHarness({ seed: 20240101 });
f2.enterFloor(1);
const elite = s2.unsafeGetState().mapNodes.find((n) => n.type === NODE_TYPE.ELITE);
s2.update((d) => { d.currentNodeId = elite.id; d.visitedNodeIds.add(elite.id); });
console.log('moveTo elite', JSON.stringify(f2.moveTo(elite.id)));
const combat = s2.unsafeGetState().mapNodes.find((n) => n.type === NODE_TYPE.COMBAT);
console.log('moveTo combat from elite? (not adjacent likely)', JSON.stringify(f2.moveTo(combat.id)));
f2.startBattle();
const mons = s2.unsafeGetState().monsters.length;
e2.runToEnd();
console.log('elite win', s2.unsafeGetState().winner, 'monsters', mons);
console.log('finish', JSON.stringify(f2.finishBattle()));
console.log('lastReward', JSON.stringify(s2.unsafeGetState().lastBattleReward));

// loot-bearing node
const withLoot = s2.unsafeGetState().mapNodes.filter((n) => rollBattleLoot({ seed: 20240101, floorNumber: 1, nodeId: n.id, isElite: false }).length > 0);
console.log('nodes with normal loot:', withLoot.length, withLoot.slice(0, 3).map((n) => n.id + ':' + n.type));
