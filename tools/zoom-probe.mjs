#!/usr/bin/env node
/**
 * 缩放对焦探针（`npm run map:probe`）
 *
 * 为什么要有它：`zoomAt` 的数学有 14 例单测全绿，而用户说"还是没对焦"。
 * 单测只能证明**公式对**，证明不了**接上去之后没被别的代码抵消** ——
 * 这次就是被我自己加的 clamp 抵消掉了（见下）。而 jsdom 没有布局引擎，
 * 量不到"节点在屏幕上的位置"。所以这条必须用真浏览器量。
 *
 * 它量的是唯一有意义的事：把光标钉在某个节点上滚一下，那个节点还在不在光标底下。
 *
 * 用法：
 *   npm run map:probe
 *   npm run map:probe -- --port=5321
 *
 * 退出码：0 通过 / 1 没对焦（真缺陷）/ 2 找不到浏览器 / 3 环境问题
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const PORT = Number((args.find((a) => a.startsWith('--port=')) ?? `--port=${5311 + (process.pid % 50)}`).split('=')[1]);
const PAGE = 'tools/ui-audit/zoom-probe.html';

function toNativePath(p) {
  const match = /^\/([a-zA-Z])\/(.*)/s.exec(p);
  return match === null ? p : `${match[1].toUpperCase()}:/${match[2]}`;
}

const browser = [
  process.env.UI_AUDIT_BROWSER,
  '/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/c/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/c/Program Files/Google/Chrome/Application/chrome.exe',
].filter(Boolean).find((p) => existsSync(p) || existsSync(toNativePath(p)));

if (browser === undefined) {
  console.error('找不到 Edge/Chrome。设 UI_AUDIT_BROWSER=/路径/msedge.exe 再跑。');
  process.exit(2);
}

const profiles = [];
function newProfile() {
  const dir = mkdtempSync(`${tmpdir()}zoom-probe-`);
  profiles.push(dir);
  return dir;
}

function startDevServer() {
  const child = spawn(process.execPath, [resolve(ROOT, 'node_modules/vite/bin/vite.js'), '--port', String(PORT), '--strictPort'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const ready = new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error('dev server 30s 没起来')), 30_000);
    child.stdout.on('data', async () => {
      try {
        const head = await fetch(`http://localhost:${PORT}/${PAGE}`);
        if (head.ok) {
          clearTimeout(timer);
          res();
        }
      } catch {
        /* 还没监听 */
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      rej(new Error(`dev server 退出（${String(code)}）`));
    });
  });
  return { child, ready };
}

async function runBrowser(url) {
  const profile = newProfile();
  return new Promise((res, rej) => {
    const child = spawn(toNativePath(browser), [
      '--headless',
      '--disable-gpu',
      '--no-sandbox',
      `--user-data-dir=${toNativePath(profile)}`,
      '--window-size=1280,900',
      '--virtual-time-budget=20000',
      '--dump-dom',
      url,
    ]);
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.on('exit', () => res({ stdout: out, stderr: err }));
    child.on('error', rej);
  });
}

const { child, ready } = startDevServer();
try {
  await ready;
  const { stdout, stderr } = await runBrowser(`http://localhost:${PORT}/${PAGE}`);
  const hit = stdout.match(/<script[^>]*id="probe-json"[^>]*>([\s\S]*?)<\/script>/);
  if (hit === null) {
    console.error('没拿到探针结果（浏览器或页面没跑完，不是对焦问题）');
    if (stderr !== '') console.error(stderr.split('\n').slice(0, 2).join(' '));
    process.exitCode = 3;
  } else {
    const result = JSON.parse(hit[1].replace(/&amp;/g, '&'));
    if (result.error !== null) {
      console.error(`探针自身报错：${result.error}`);
      process.exitCode = 3;
    } else {
      console.log('缩放对焦探针（真浏览器 · 把光标钉在节点上滚 + 拖拽）');
      console.log(
        `  初始 viewBox=${result.viewBox}  svg=${result.svgBox.w}×${result.svgBox.h}px  transform=${result.initialTransform}`,
      );
      for (const c of result.cases) {
        const dir = c.deltaY < 0 ? '放大' : '缩小';
        const head = c.noOp
          ? `  ${dir}（空操作，不计）`
          : `  ${dir} 光标钉在 (${c.at.x.toFixed(0)}, ${c.at.y.toFixed(0)}) → 节点到 (${c.after.x.toFixed(0)}, ${c.after.y.toFixed(0)}) 漂移 ${c.drift.toFixed(1)}px`;
        console.log(`${head}   ${c.transformBefore} → ${c.transformAfter}`);
      }
      console.log(
        `  拖拽指针走 60,40px → 节点实际走 ${result.drag.actual.x.toFixed(1)},${result.drag.actual.y.toFixed(1)}px
    transform: ${result.drag.transformBefore} → ${result.drag.transformAfter}`,
      );
      if (result.measured < 3) {
        console.log(`判定：✗ 只有 ${result.measured} 下是真操作，测不出东西（多半开局就顶在缩放上限）`);
        process.exitCode = 1;
      } else if (result.ok) {
        console.log('判定：✓ 每一下节点都 ≤2px 钉在光标底下，拖拽也跟手');
      } else {
        console.log('判定：✗ 有节点漂走 —— 锚点补偿被某处抵消了（查 clamp 与坐标空间）');
        process.exitCode = 1;
      }
    }
  }
} catch (error) {
  console.error(String(error?.stack ?? error));
  process.exitCode = 3;
} finally {
  child.kill();
  for (const dir of profiles) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 浏览器还在收尾，交给系统回收 */
    }
  }
}
