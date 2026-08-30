/**
 * zip 投递。重点不是"能不能解开"，而是**炸弹能不能在解开之前就被拦下**。
 */
import { describe, it, expect } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import {
  unpackArchive,
  MAX_ENTRY_BYTES,
  MAX_UNCOMPRESSED_BYTES,
} from '../../src/core/mods/sandbox/archive.js';
// MAX_PACK_FILES 属于 pack.js（archive.js 只是用它守门，没有再导出）——
// 从 archive.js 导入会拿到 undefined，循环跑 0 次，测试就"绿得毫无意义"
import { MAX_PACK_FILES } from '../../src/core/mods/sandbox/pack.js';

const MAIN = `import { begin, skill } from 'fate';
begin({ id: 'poc.zip', version: '1.0.0' });
skill({ id: 'poc.zip.a', type: 'GCD', gcdCost: 2.4, execute: () => {} });`;

describe('zip 包投递', () => {
  it('多文件包能解开，入口与内容都在', async () => {
    const bytes = zipSync({
      'main.js': strToU8(MAIN),
      'lib/hit.js': strToU8('export const X = 1;'),
    });
    const result = await unpackArchive(new Uint8Array(bytes));
    expect(result.ok).toBe(true);
    expect(result.entry).toBe('main.js');
    expect(result.files.get('lib/hit.js')).toBe('export const X = 1;');
  });

  it('zip 一个文件夹时共着的顶层目录被剥掉（否则 import 相对路径全断）', async () => {
    const bytes = zipSync({
      'my-pack/main.js': strToU8(MAIN),
      'my-pack/lib/hit.js': strToU8('export const X = 2;'),
    });
    const result = await unpackArchive(new Uint8Array(bytes));
    expect(result.ok).toBe(true);
    expect(result.files.get('lib/hit.js')).toBe('export const X = 2;');
  });

  it('pack.json 提供 entry 与标题', async () => {
    const bytes = zipSync({
      'src/index.js': strToU8(MAIN),
      'pack.json': strToU8(JSON.stringify({ id: 'poc.zip', version: '2.0.0', title: '带清单', entry: 'src/index.js' })),
    });
    const result = await unpackArchive(new Uint8Array(bytes));
    expect(result.ok).toBe(true);
    expect(result.entry).toBe('src/index.js');
    expect(result.meta.title).toBe('带清单');
  });

  it('没有入口就拒绝，并且把包内文件列出来（不然作者只能猜）', async () => {
    const bytes = zipSync({ 'lib/only.js': strToU8('export const X = 1;') });
    const result = await unpackArchive(new Uint8Array(bytes));
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/找不到入口 main.js/);
    // 只有一个顶层目录时会被剥掉（zip 一个文件夹的常见形态）
    expect(result.reason).toMatch(/only.js/);
  });

  it('路径逃逸（..）被拒', async () => {
    const bytes = zipSync({
      'main.js': strToU8(MAIN),
      '../evil.js': strToU8('bad'),
    });
    const result = await unpackArchive(new Uint8Array(bytes));
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/\.\./);
  });

  it('非文本文件（图片）被忽略，不占文件名额', async () => {
    const bytes = zipSync({
      'main.js': strToU8(MAIN),
      'art.png': strToU8('not really a png'),
    });
    const result = await unpackArchive(new Uint8Array(bytes));
    expect(result.ok).toBe(true);
    expect(result.files.has('art.png')).toBe(false);
  });

  it('zip bomb：头部声明的解压大小超限 ⇒ 在解压前就停', async () => {
    // 造一个"声明很大"的条目：真的塞一大坨可压缩数据，压缩后很小
    const huge = strToU8('A'.repeat(MAX_ENTRY_BYTES + 1024));
    const bytes = zipSync({ 'main.js': strToU8(MAIN), 'big.js': huge });
    const result = await unpackArchive(new Uint8Array(bytes));
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/解压后超过/);
  });

  it('总量上限：每个文件都合规但加起来超了也要拒', async () => {
    const files = { 'main.js': strToU8(MAIN) };
    const one = 'B'.repeat(200 * 1024);
    for (let i = 0; i < 12; i += 1) files[`lib/f${i}.js`] = strToU8(one);
    const bytes = zipSync(files);
    const result = await unpackArchive(new Uint8Array(bytes));
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/合计超过|文件数超过/);
    expect(MAX_UNCOMPRESSED_BYTES).toBeGreaterThan(0);
  });

  it('文件数超过 MAX_PACK_FILES 时拒绝而不是静默截断', async () => {
    const files = { 'main.js': strToU8(MAIN) };
    for (let i = 0; i < MAX_PACK_FILES + 2; i += 1) files[`lib/x${i}.js`] = strToU8('export const A = 1;');
    const result = await unpackArchive(new Uint8Array(zipSync(files)));
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/文件数超过/);
  });

  it('坏字节流不会抛异常，只给原因', async () => {
    const result = await unpackArchive(new Uint8Array([1, 2, 3, 4, 5]));
    expect(result.ok).toBe(false);
    expect(typeof result.reason).toBe('string');
  });
});
