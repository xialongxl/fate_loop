#!/usr/bin/env node
/**
 * 部署自检（`npm run deploy:check`）
 *
 * 专治 GitHub Pages 上最常见的那类翻车：**构建成功、页面白屏、控制台之外零提示**。
 * 起因通常是产物用了绝对路径 `/assets/xxx.js`，而项目页挂在子路径 `/仓库名/` 下 ——
 * 浏览器去站点根目录要文件，全部 404。`vite build` 不会告诉你这件事。
 *
 * 所以这里把 dist 挂到一个**子路径**下真起一个静态服务器，只服务那个子路径
 * （别的都返 404 —— 就是要让绝对路径引用暴露出来），然后把 index.html 引用的
 * 每个资源逐个请求一遍。
 */
import { createServer, request } from 'node:http';
import { readFile, mkdtemp, rm, mkdir, cp } from 'node:fs/promises';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
};

/** 模拟 Pages 项目页：内容挂在 /fate_loop/ 下面。 */
const SUBPATH = '/fate_loop';

function runBuild() {
  return new Promise((resolvePromise, rejectPromise) => {
    const viteBin = resolve('node_modules/vite/bin/vite.js');
    const child = spawn(process.execPath, [viteBin, 'build', '--logLevel', 'warn'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (c) => (out += String(c)));
    child.stderr.on('data', (c) => (out += String(c)));
    child.on('close', (code) => {
      if (code === 0) resolvePromise(out);
      else rejectPromise(new Error(`vite build 失败（code ${String(code)}）：\n${out}`));
    });
  });
}

function startServer(rootDir) {
  return new Promise((resolvePromise) => {
    const server = createServer(async (req, res) => {
      const url = decodeURIComponent((req.url ?? '/').split('?')[0]);
      // 只服务子路径下的内容：绝对路径引用打到 '/' 就会 404，正是要的效果
      if (!url.startsWith(`${SUBPATH}/`)) {
        res.writeHead(404);
        res.end('outside subpath');
        return;
      }
      const rel = url.slice(SUBPATH.length + 1);
      const file = join(rootDir, rel === '' ? 'index.html' : rel);
      if (!file.startsWith(rootDir) || !existsSync(file)) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      try {
        const body = await readFile(file);
        res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
        res.end(body);
      } catch {
        res.writeHead(500);
        res.end('server error');
      }
    });
    server.listen(0, '127.0.0.1', () => resolvePromise(server));
  });
}

function httpGet(port, path) {
  return new Promise((resolvePromise) => {
    const req = request({ host: '127.0.0.1', port, path }, (res) => {
      res.resume();
      res.on('end', () => resolvePromise(res.statusCode ?? 0));
    });
    req.on('error', () => resolvePromise(0));
    req.end();
  });
}

async function main() {
  console.log('构建产物…');
  await runBuild();

  const work = await mkdtemp(join(tmpdir(), 'deploy-check-'));
  const mounted = join(work, 'site', SUBPATH.slice(1));
  await mkdir(join(work, 'site'), { recursive: true });
  await cp(resolve('dist'), mounted, { recursive: true });

  // root 必须是子路径**对应的那个目录**（site/fate_loop），
  // 因为下面会把 /fate_loop 前缀剥掉再拼路径 —— 指到 site 会全部 404
  const server = await startServer(mounted);
  const port = server.address().port;
  const problems = [];

  try {
    const index = readFileSync(join(mounted, 'index.html'), 'utf8');
    const refs = [...index.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
    console.log(`子路径预览：http://127.0.0.1:${String(port)}${SUBPATH}/`);
    console.log(`index.html 引用 ${String(refs.length)} 个资源`);

    for (const ref of refs) {
      if (/^(https?:)?\/\//.test(ref)) continue; // 外链不管
      if (ref.startsWith('/')) {
        problems.push(`绝对路径引用（base 没生效）：${ref}`);
        continue;
      }
      const path = `${SUBPATH}/${ref.replace(/^\.\//, '')}`;
      const status = await httpGet(port, path);
      if (status !== 200) problems.push(`资源取不到（HTTP ${String(status)}）：${path}`);
    }

    // 沙箱用的 wasm 必须在产物里：它没了的话，装了第三方包的玩家点开就是坏体验，
    // 而这条在 index.html 里看不见（懒加载），所以直接扫 assets
    const assets = existsSync(join(mounted, 'assets')) ? readdirSync(join(mounted, 'assets')) : [];
    const wasm = assets.filter((f) => f.endsWith('.wasm'));
    if (wasm.length === 0) {
      problems.push('产物里没有 .wasm —— 第三方包沙箱会挂（检查 @jitl/quickjs-wasmfile-release-sync 是否被构建）');
    }
    for (const file of wasm) {
      const status = await httpGet(port, `${SUBPATH}/assets/${file}`);
      if (status !== 200) problems.push(`wasm 取不到（HTTP ${String(status)}）：assets/${file}`);
    }

    if ((await httpGet(port, '/')) === 200) {
      problems.push('站点根目录不该有内容（说明挂载方式不对，测不出绝对路径问题）');
    }
  } finally {
    server.close();
    await sleep(50);
    await rm(work, { recursive: true, force: true });
  }

  if (problems.length > 0) {
    console.error(`\n\x1b[31m部署自检失败\x1b[0m（${String(problems.length)} 项）：`);
    for (const problem of problems) console.error(`  · ${problem}`);
    console.error('\n典型原因：vite.config.js 的 base 没设成相对路径，或某处写死了 /assets、/audio。');
    process.exit(1);
  }
  console.log('\n\x1b[32m部署自检通过\x1b[0m：子路径下所有资源都能取到，没有绝对路径引用。');
}

main().catch((error) => {
  console.error(String(error?.stack ?? error));
  process.exit(1);
});
