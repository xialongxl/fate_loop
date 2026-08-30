// @vitest-environment node
/**
 * 包注册表的持久化。重点测两件事：
 *  - 装进去的包能**逐字节**读回来（源文件是内容，不是元数据）
 *  - 坏记录不会把启动带崩（读不回就跳过并报告）
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { PackService, MAX_INSTALLED_PACKS } from '../../src/persistence/packs.js';
import { resetAdapterCache } from '../../src/persistence/storageAdapter.js';
import { createPack } from '../../src/core/mods/sandbox/pack.js';

const SOURCE = `import { begin, skill } from 'fate';
begin({ id: 'poc.store', version: '1.0.0' });
skill({ id: 'poc.store.a', type: 'GCD', gcdCost: 2.4, execute: () => {} });`;

function specOf(id = 'poc.store', version = '1.0.0') {
  return { id, version, files: { 'main.js': SOURCE, 'lib/x.js': 'export const X = 1;' }, title: '仓库包' };
}

beforeEach(async () => {
  resetAdapterCache();
  const { adapter } = await import('../../src/persistence/storageAdapter.js').then((m) => m.pickAdapter({}));
  await adapter.clear();
});

describe('PackService', () => {
  it('安装后能原样读回，且 hash 稳定', async () => {
    const svc = await new PackService().init();
    const installed = await svc.install(specOf());
    expect(installed.ok, installed.reason).toBe(true);
    expect(installed.pack.hash.hex).toMatch(/^[0-9a-f]+$/);

    const loaded = await svc.load('poc.store');
    expect(loaded.pack.files.get('lib/x.js')).toBe('export const X = 1;');
    const { hashPack } = await import('../../src/core/mods/sandbox/pack.js');
    expect(await hashPack(loaded.pack)).toEqual(installed.pack.hash);
  });

  it('同 id 再装是覆盖，不是叠加', async () => {
    const svc = await new PackService().init();
    await svc.install(specOf('poc.store', '1.0.0'));
    await svc.install(specOf('poc.store', '1.0.1'));
    const list = await svc.list();
    expect(list).toHaveLength(1);
    expect(list[0].version).toBe('1.0.1');
  });

  it('启停与删除；loadEnabled 按 id 排序（覆盖顺序必须确定）', async () => {
    const svc = await new PackService().init();
    await svc.install(specOf('z.last'));
    await svc.install(specOf('a.first'));
    await svc.setEnabled('z.last', false);

    const { entries, broken } = await svc.loadEnabled();
    expect(broken).toEqual([]);
    expect(entries.map((e) => e.pack.id)).toEqual(['a.first']);

    await svc.setEnabled('z.last', true);
    const again = await svc.loadEnabled();
    expect(again.entries.map((e) => e.pack.id)).toEqual(['a.first', 'z.last']);

    expect(await svc.remove('a.first')).toBe(true);
    expect(await svc.remove('nope.nope')).toBe(false);
    expect((await svc.list()).map((r) => r.id)).toEqual(['z.last']);
  });

  it('超过上限要拒绝，而不是静默丢', async () => {
    const svc = await new PackService().init();
    for (let i = 0; i < MAX_INSTALLED_PACKS; i += 1) {
      expect((await svc.install(specOf(`poc.p${i}`))).ok).toBe(true);
    }
    const overflow = await svc.install(specOf('poc.over'));
    expect(overflow.ok).toBe(false);
    expect(overflow.reason).toMatch(/最多同时安装/);
  });

  it('坏记录（源文件丢了）跳过并报告，不抛异常', async () => {
    const svc = await new PackService().init();
    await svc.install(specOf('poc.good'));
    await svc.install(specOf('poc.rotten'));
    // 模拟数据被清坏：直接删底层记录，清单里还留着
    const { adapter } = await import('../../src/persistence/storageAdapter.js').then((m) => m.pickAdapter({}));
    await adapter.delete('pack:poc.rotten');

    const { entries, broken } = await svc.loadEnabled();
    expect(entries.map((e) => e.pack.id)).toEqual(['poc.good']);
    expect(broken).toEqual(['poc.rotten']);
  });

  it('非法包定义在安装入口就被挡（不会写进库里等启动时炸）', async () => {
    const svc = await new PackService().init();
    const bad = await svc.install({ id: 'poc.evil', version: '1.0.0', files: { '../out.js': 'x' } });
    expect(bad.ok).toBe(false);
    expect(bad.reason).toMatch(/\.\./);
    expect(await svc.list()).toHaveLength(0);
  });

  it('createPack 与存储层对同一份内容给出同一个 hash', async () => {
    const svc = await new PackService().init();
    const installed = await svc.install(specOf('poc.cross'));
    const direct = await hashOf(specOf('poc.cross'));
    expect(installed.pack.hash).toEqual(direct);
  });
});

async function hashOf(spec) {
  const { hashPack } = await import('../../src/core/mods/sandbox/pack.js');
  return hashPack(createPack(spec));
}
