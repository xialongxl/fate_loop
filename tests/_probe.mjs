import { createHarness } from './helpers.js';
import { GAME_STATUS, NODE_TYPE, WINNER } from '../src/core/constants.js';
import { totalExpForLevel } from '../src/core/progression.js';

const { store, engine, flow } = await createHarness({ seed: 20240101 });
flow.enterFloor(1);
const s = store.unsafeGetState();
console.log('floor', s.floorNumber, 'nodes', s.mapNodes.length, 'w/h', s.gridWidth, s.gridHeight);
const byType = {};
for (const n of s.mapNodes) byType[n.type] = (byType[n.type] ?? 0) + 1;
console.log('types', byType);
console.log('start', s.startNodeId, 'exit', s.exitNodeId, 'current', s.currentNodeId);
console.log('adj[start]', s.mapAdjacency[s.startNodeId]);
console.log('node sample', JSON.stringify(s.mapNodes[0]));
console.log('player', { hp: s.player.hp, maxHp: s.player.maxHp, atk: s.player.attack, def: s.player.defense, seedBonus: s.player.seedBonus });

// win/loss probe for several nodes
for (const nodeId of ['node_4_6', 'node_1_1', 'node_2_3']) {
  const { store: st2, engine: e2, flow: f2 } = await createHarness({ seed: 20240101 });
  f2.enterFloor(1);
  e2.begin({ nodeId, tier: 'normal' });
  const m = st2.unsafeGetState().monsters.map((x) => ({ hp: x.hp, atk: x.attack, def: x.defense }));
  const w = e2.runToEnd();
  console.log('lv1 battle', nodeId, 'winner', w, 'reason', st2.unsafeGetState().battleEndReason, 'monsters', m.length, m[0], 'playerHp', st2.unsafeGetState().player.hp);
}

// level 30 probe
{
  const { store: st3, engine: e3, flow: f3 } = await createHarness({ seed: 20240101 });
  f3.enterFloor(1);
  st3.update((d) => {
    d.player.exp = totalExpForLevel(30);
  });
  e3.begin({ nodeId: 'node_4_6', tier: 'normal' });
  const w = e3.runToEnd();
  console.log('lv30 winner', w, st3.unsafeGetState().battleEndReason);
}
// force loss probe: hp=1 at level 1
{
  const { store: st4, engine: e4, flow: f4 } = await createHarness({ seed: 20240101 });
  f4.enterFloor(1);
  st4.update((d) => { d.player.hp = 1; });
  e4.begin({ nodeId: 'node_4_6', tier: 'normal' });
  const w = e4.runToEnd();
  const st = st4.unsafeGetState();
  console.log('lv1 hp=1 winner', w, st.battleEndReason, 'monsters', st.monsters.map((m) => m.hp));
}
console.log('status enum', GAME_STATUS, 'winner', WINNER, NODE_TYPE.ELITE);
