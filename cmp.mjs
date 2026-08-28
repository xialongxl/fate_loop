import { createHarness } from './tests/helpers.js';
const { buildUnlockTable } = await import('./src/core/progression.js');
const pool = (await createHarness({ seed: 1 })).pool;
console.log('families in pool:', [...pool.families.keys()].join(','));
const ids = [...pool.families.keys()];
const naive = buildUnlockTable(pool.skills);
const aware = buildUnlockTable(pool.skills, { families: ids });
for (const sk of [...pool.skills.values()].filter((x) => (x.tags ?? []).includes('void'))) {
  console.log(sk.id, 'naive=', naive.get(sk.id), 'aware=', aware.get(sk.id));
}
