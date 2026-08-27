import { createHarness } from './helpers.js';
import { GAME_STATUS, NODE_TYPE, WINNER } from '../src/core/constants.js';

// 1) forced loss via empty sequence -> timeout
{
  const { store, engine, flow } = await createHarness({ seed: 7, gcdSequence: [], ogcdSlots: [] });
  flow.enterFloor(1);
  engine.begin({ nodeId: 'node_4_6', tier: 'normal' });
  const w = engine.runToEnd();
  const s = store.unsafeGetState();
  console.log('empty seq winner', w, 'reason', s.battleEndReason, 'status', s.status, 'vt', s.virtualTime);
  console.log('finishBattle', JSON.stringify(flow.finishBattle()));
  console.log('after status', store.unsafeGetState().status);
}

// 2) shop offers + purchase + recalc leak
{
  const { store, flow } = await createHarness({ seed: 7 });
  flow.enterFloor(1);
  const s = store.unsafeGetState();
  const shop = s.mapNodes.find((n) => n.type === NODE_TYPE.SHOP);
  const ev = s.mapNodes.find((n) => n.type === NODE_TYPE.EVENT);
  const rest = s.mapNodes.find((n) => n.type === NODE_TYPE.REST);
  store.update((d) => { d.currentNodeId = shop.id; d.fateShards = 500; });
  const offers = flow.getShopOffers();
  console.log('offers', JSON.stringify(offers.offers), 'again same?', JSON.stringify(flow.getShopOffers().offers) === JSON.stringify(offers.offers));
  const before = { ...store.unsafeGetState().player };
  const r = flow.purchase('shop.stat.maxHp');
  const afterBuy = { hp: store.unsafeGetState().player.hp, maxHp: store.unsafeGetState().player.maxHp };
  store.update((d) => { d.player.exp += 1; });
  const { recalcPlayer } = await import('../src/core/derived.js');
  store.update((d) => { recalcPlayer(d.player); });
  console.log('purchase', r, 'before', before.maxHp, 'afterBuy', afterBuy, 'afterRecalc', store.unsafeGetState().player.maxHp);
  console.log('events', JSON.stringify(flow.getEvent?.()));
  store.update((d) => { d.currentNodeId = ev.id; });
  const evt = flow.getEvent();
  console.log('event', evt?.id, evt?.choices?.map((c) => c.label));
  store.update((d) => { d.currentNodeId = rest.id; });
  console.log('rest ok', JSON.stringify(flow.useRest()), 'again', JSON.stringify(flow.useRest()));
}

// 3) descend
{
  const { store, flow } = await createHarness({ seed: 7 });
  flow.enterFloor(1);
  console.log('descend not at exit', JSON.stringify(flow.descend()));
  store.update((d) => { d.currentNodeId = d.exitNodeId; });
  console.log('descend', JSON.stringify(flow.descend()));
  const s = store.unsafeGetState();
  console.log('floor now', s.floorNumber, 'current==start?', s.currentNodeId === s.startNodeId, 'floorsCleared', s.metadata.floorsCleared, 'status', s.status);
  const s2 = store.getSnapshot();
  console.log('frozen?', Object.isFrozen(s2), Object.isFrozen(s2.shopStates), s2.shopStates instanceof Map);
}
