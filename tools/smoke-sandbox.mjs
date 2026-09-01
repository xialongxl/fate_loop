#!/usr/bin/env node
/**
 * 沙箱真浏览器冒烟（`npm run mod:smoke`）
 *
 * 干什么用的：在**真浏览器 + dev server** 下装一个第三方包并跑完整 `createApp`，
 * 看 QuickJS 的 wasm 到底能不能实例化。
 *
 * 为什么 vitest 替不了它：沙箱测试都在 Node 里跑，而 wasm 的定位方式在
 * Node 与浏览器是两套解析路径。真实事故：Vite dev 的依赖预打包只把 .js 搬进
 * `node_modules/.vite/deps/`，不搬 `.wasm` 兄弟文件 ⇒ 浏览器要不到 wasm ⇒
 * SPA fallback 递回 index.html ⇒ `WebAssembly.instantiate` 报
 * "expected magic word 00 61 73 6d, found 3c 21 64 6f"（`<!do`）⇒ 白屏。
 * 那次全量 695 测试是**全绿**的 —— 所以这条得用浏览器测。
 *
 * 它同时验第二个结论：就算 wasm 拿不到，游戏也必须能开（main.js 里那段 try/catch）。
 * 所以判定不是"wasm 一定成功"，而是"**要么包生效，要么明确报错且 booted=true**"。
 *
 * 用法：
 *   npm run mod:smoke
 *   npm run mod:smoke -- --port=5200 --keep   # 留着 dev server 手动开页面看
 *
 * ⚠️ 浏览器坏掉 ≠ 沙箱坏掉：拿不到输出时按退出码 3 报"环境问题"，
 *    这条纪律是从 ui:audit 那六个血泪约束里抄来的。
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const BROWSER_CANDIDATES = [
  process.env.UI_AUDIT_BROWSER,
  '/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/c/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/c/Program Files/Google/Chrome/Application/chrome.exe',
].filter(Boolean);

const args = process.argv.slice(2);
const PORT = Number((args.find((a) => a.startsWith('--port=')) ?? '--port=5299').split('=')[1]);
const KEEP = args.includes('--keep');

function findBrowser() {
  return (
    BROWSER_CANDIDATES.find((p) => existsSync(p) || existsSync(toNativePath(p))) ?? null
  );
}

/**
 * Git Bash 风格 /c/... → C:/...。
 * 不能拿 String.replace 草草处理 —— 只换匹配到的前三个字符会把尾巴留在后面，
 * 拼出 `C:/c/Program Files (x86)/...` 这种鬼东西（工具自己踩过一次，现抄过来）。
 */
function toNativePath(p) {
  const match = /^\/([a-zA-Z])\/(.*)/s.exec(p);
  return match === null ? p : `${match[1].toUpperCase()}:/${match[2]}`;
}

const browser = findBrowser();
if (browser === null) {
  console.error('找不到 Edge/Chrome。设 UI_AUDIT_BROWSER=/路径/msedge.exe 再跑。');
  process.exit(2);
}
const browserPath = toNativePath(browser);

/** 起 vite dev server，等到它真的能回东西为止（不预热第一个请求几乎必超时）。 */
function startDevServer() {
  const child = spawn(process.execPath, [resolve(ROOT, 'node_modules/vite/bin/vite.js'), '--port', String(PORT), '--strictPort'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const ready = new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error('dev server 30s 没起来')), 30_000);
    let text = '';
    child.stdout.on('data', async (chunk) => {
      text += chunk.toString();
      try {
        const head = await fetch(`http://localhost:${PORT}/tools/smoke-sandbox.html`);
        if (head.ok) {
          clearTimeout(timer);
          res();
        }
      } catch {
        /* 还没监听，继续等 */
      }
    });
    child.stderr.on('data', (chunk) => {
      text += chunk.toString();
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      rej(new Error(`dev server 退出（${String(code)}）：\n${text}`));
    });
  });
  return { child, ready };
}

async function runBrowser(url) {
  const profile = mkdtempSync(`${tmpdir()}sandbox-smoke-`);
  try {
    const { stdout, stderr } = await new Promise((res, rej) => {
      const child = spawn(browserPath, [
        '--headless',
        '--disable-gpu',
        '--no-sandbox',
        '--disable-software-rasterizer',
        `--user-data-dir=${toNativePath(profile)}`,
        '--window-size=1000,700',
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
    return { stdout, stderr };
  } finally {
    // 删不掉就算了：浏览器 helper 进程还在收尾时会占着 profile（EBUSY）。
    // 这是**一次性**冒烟，不是长跑工具；报错盖掉真实结论才是大问题。
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {
      /* 留着，tmp 目录由系统回收 */
    }
  }
}

const { child, ready } = startDevServer();
let failed = false;
try {
  await ready;
  const { stdout, stderr } = await runBrowser(`http://localhost:${PORT}/tools/smoke-sandbox.html`);

  const hit = stdout.match(/<script[^>]*id="smoke-json"[^>]*>([\s\S]*?)<\/script>/);
  if (stdout === '' || hit === null) {
    console.error('浏览器没给出结果（多半是浏览器自己起不来，不是沙箱的事）');
    if (stderr !== '') console.error(stderr.slice(0, 500));
    failed = true;
    process.exitCode = 3;
  } else {
    const result = JSON.parse(hit[1].replace(/&amp;/g, '&'));
    console.log('真浏览器 · 装了 1 个第三方包 · createApp 全流程');
    console.log(JSON.stringify(result, null, 2));
    if (result.booted !== true) {
      console.log('判定：✗ 游戏没开起来 —— 沙箱失败不该阻断启动（main.js 的 try/catch 漏了）');
      console.log(`      页面错误：${result.error ?? result.sandboxError ?? '(无)'}`);
      failed = true;
      process.exitCode = 1;
    } else if (result.sandboxError !== null) {
      console.log(`判定：△ wasm 没起来（${result.sandboxError.slice(0, 120)}），但游戏能开、包未生效`);
      console.log('      —— 这是**可接受的降级**；但 dev 下走到这条通常意味着 optimizeDeps.exclude 失效了');
      failed = true;
      process.exitCode = 1;
    } else if (result.hasSkill !== true) {
      console.log('判定：✗ 沙箱没报错但包内容没进池 —— 静默失效，最难查的那类');
      failed = true;
      process.exitCode = 1;
    } else {
      console.log(`判定：✓ QuickJS wasm 在浏览器里可用，包内容进了池（${result.loaded.join('、')}）`);
    }
  }
} catch (error) {
  console.error(String(error?.stack ?? error));
  failed = true;
  process.exitCode = 3;
} finally {
  if (KEEP && !failed) {
    console.log(`dev server 留在 http://localhost:${PORT}/tools/smoke-sandbox.html（Ctrl-C 结束）`);
  } else {
    child.kill();
  }
}
