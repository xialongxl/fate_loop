#!/usr/bin/env node
/**
 * UI 布局体检的 Node 侧：起 dev server → 用无头浏览器逐屏逐视口跑 harness →
 * 汇总结果 → 有问题就非零退出。
 *
 *   npm run ui:audit                     13 个界面 × 1440x900
 *   npm run ui:audit -- --views=1440x900,900x900,420x900
 *   npm run ui:audit -- --only=map,battle --shots=.ui-audit
 *
 * 浏览器找的是系统里的 Edge / Chrome（可用 UI_AUDIT_BROWSER 指定绝对路径），
 * 不引入 puppeteer/playwright：本项目只有 howler 一个运行时依赖，为一个体检
 * 装 200MB 浏览器驱动不值当。
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const SCREENS = [
  'menu',
  'map',
  'battle',
  'sequence',
  'equipment',
  'character',
  'saves',
  'settings',
  'codex',
  'history',
  'shop',
  'event',
  'victory',
];

const BROWSER_CANDIDATES = [
  process.env.UI_AUDIT_BROWSER,
  '/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/c/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/c/Program Files/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter((p) => typeof p === 'string' && p !== '');

function parseArgs(argv) {
  const out = { views: ['1440x900'], only: SCREENS, shots: null, budget: 60000 };
  for (const raw of argv) {
    const [key, value] = raw.replace(/^--/, '').split('=');
    if (key === 'views') out.views = value.split(',').map((v) => v.trim());
    else if (key === 'only') out.only = value.split(',').map((v) => v.trim());
    else if (key === 'shots') out.shots = value === undefined ? '.ui-audit' : value;
    else if (key === 'budget') out.budget = Number(value);
    else if (key === 'help') {
      console.log('用法：npm run ui:audit -- [--views=1440x900,900x900] [--only=map,battle] [--shots=目录]');
      process.exit(0);
    }
  }
  return out;
}

function findBrowser() {
  return BROWSER_CANDIDATES.find((p) => existsSync(p) || existsSync(p.replace(/^\/c\//, 'C:/'))) ?? null;
}

function toNativePath(p) {
  // Git Bash 风格 /c/... → C:/...，其余原样交给浏览器。
  // 不能用 String.replace：只替换匹配到的 "/c/" 三个字符，剩下的路径会被留下，
  // 于是拼出 "C:/Program Files/msedge.exeProgram Files/msedge.exe" 这种鬼东西。
  const match = /^\/([a-zA-Z])\/(.*)/s.exec(p);
  return match === null ? p : `${match[1].toUpperCase()}:/${match[2]}`;
}

const stripAnsi = (text) => text.replace(/\[[0-9;]*m/g, '');

function startDevServer() {
  // 直接跑 node_modules/vite/bin/vite.js：绕开 npx/.cmd（Windows 下 spawn .cmd 要么
  // shell:true 拼参数、要么 EINVAL），也省一次 npx 解析
  const viteBin = fileURLToPath(new URL('../../node_modules/vite/bin/vite.js', import.meta.url));
  // 不指定 --port：让 vite 自己挑一个空闲端口并打印出来，我们从**自己这个子进程**的
  // stdout 解析。固定端口 + strictPort 会在撞车时连试几个都失败；而解析别人的
  // 服务（比如同机另一个项目的 dev server）更糟 —— 那会量到错的东西。
  const child = spawn(process.execPath, [viteBin], { stdio: ['ignore', 'pipe', 'pipe'] });
  let buffer = '';
  const ready = new Promise((resolve, reject) => {
    const onData = (chunk) => {
      buffer += stripAnsi(String(chunk));
      const match = buffer.match(/http:\/\/localhost:(\d+)/);
      if (match !== null && match !== undefined) resolve(Number(match[1]));
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', reject);
    // 端口被占时 vite 会因 --strictPort 直接退出：必须有 close 兜底，
    // 否则这个 promise 永不 settle，Node 只会报 "unsettled top-level await"
    child.on('close', (code) => reject(new Error(`dev server 提前退出（code ${String(code)}）：
${buffer}`)));
    setTimeout(() => reject(new Error(`dev server 启动超时：
${buffer}`)), 25000);
  });
  return { child, ready };
}

function runBrowser(browser, args) {
  return new Promise((resolve) => {
    const child = spawn(browser, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += String(c)));
    child.stderr.on('data', (c) => (stderr += String(c)));
    const killer = setTimeout(() => child.kill('SIGKILL'), 120000);
    child.on('close', () => {
      clearTimeout(killer);
      resolve({ stdout, stderr });
    });
  });
}

function extractAudit(html) {
  const match = html.match(/<script type="application\/json" id="audit-json">([\s\S]*?)<\/script>/);
  if (match === null || match === undefined) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

const args = parseArgs(process.argv.slice(2));
const browser = findBrowser();
if (browser === null) {
  console.error('找不到 Edge/Chrome。设一个再跑：UI_AUDIT_BROWSER=/路径/msedge.exe npm run ui:audit');
  process.exit(2);
}
const browserPath = toNativePath(browser);
if (args.shots !== null) {
  // 必须给绝对路径：无头浏览器解析相对 --screenshot 时按它自己的 cwd 走，
  // 结果就是"报告说写了、目录其实空的"
  args.shots = resolve(args.shots);
  mkdirSync(args.shots, { recursive: true });
}

const profile = join(tmpdir(), `ui-audit-profile-${process.pid}`);
const baseFlags = [
  '--headless',
  '--disable-gpu',
  '--no-sandbox',
  '--disable-software-rasterizer',
  '--hide-scrollbars',
  `--user-data-dir=${toNativePath(profile)}`,
];

/**
 * 预检：浏览器能不能跑。
 * Edge 自动升级后出现过"启动即崩、exit=0 且零输出"的情况 —— 那时 13 个组合会
 * 全部报"没拿到结果"，看起来像 UI 出了 13 个问题。必须先分清是**浏览器坏了**
 * 还是**页面真的有问题**，否则这个工具会指错方向。
 */
async function browserPreflight() {
  const { stdout, stderr } = await runBrowser(browserPath, [
    ...baseFlags,
    '--window-size=800,600',
    '--virtual-time-budget=8000',
    '--dump-dom',
    'data:text/html,<p>preflight</p>',
  ]);
  return { ok: stdout.includes('preflight'), stdout, stderr };
}

let server = null;
const results = [];
let failures = 0;

try {
  const preflight = await browserPreflight();
  if (!preflight.ok) {
    console.error(`浏览器预检失败：${browserPath} 启动后没有任何输出。`);
    console.error('这通常是 Edge 刚自动升级（Application/ 下出现多个版本目录）或残留进程卡住。');
    console.error(`先确认它能跑：${browserPath} --version`);
    console.error('本次不跑矩阵 —— 否则会把"浏览器坏了"误报成"界面有问题"。');
    console.error('（跳过：' + browserPath + '）');
    process.exit(3);
  }

  server = startDevServer();
  const port = await server.ready;
  const baseUrl = `http://localhost:${port}/`;
  console.log(`dev server :${port} · 浏览器 ${browserPath.split('/').pop()}`);

  // 预热：让 vite 把依赖图与模块转译跑完，否则第一个界面几乎必然超时误报
  await runBrowser(browserPath, [
    ...baseFlags,
    '--window-size=1440,900',
    `--virtual-time-budget=${args.budget}`,
    '--dump-dom',
    `${baseUrl}tools/ui-audit/audit-page.html?screen=menu`,
  ]);

  for (const view of args.views) {
    const [width, height] = view.split('x');
    for (const screen of args.only) {
      const url = `${baseUrl}tools/ui-audit/audit-page.html?screen=${encodeURIComponent(screen)}`;
      if (args.shots !== null) {
        await runBrowser(browserPath, [
          ...baseFlags,
          `--window-size=${width},${height}`,
          `--virtual-time-budget=${args.budget}`,
          `--screenshot=${toNativePath(join(args.shots, `${screen}-${view}.png`))}`,
          url,
        ]);
      }
      let { stdout, stderr } = await runBrowser(browserPath, [
        ...baseFlags,
        `--window-size=${width},${height}`,
        `--virtual-time-budget=${args.budget}`,
        '--dump-dom',
        url,
      ]);
      let audit = extractAudit(stdout);
      if (audit === null) {
        // 首屏要等 vite 现编译依赖图，虚拟时间预算不够就会误报"没拿到结果"。
        // 重试一次并放宽预算，比直接判失败诚实。
        ({ stdout, stderr } = await runBrowser(browserPath, [
          ...baseFlags,
          `--window-size=${width},${height}`,
          `--virtual-time-budget=${args.budget * 2}`,
          '--dump-dom',
          url,
        ]));
        audit = extractAudit(stdout);
      }
      if (audit === null) {
        failures += 1;
        results.push({ screen, view, ok: false, problems: ['没拿到体检结果（页面报错或超时）'], metrics: {} });
        console.error(`   stderr: ${stderr.split('\n').slice(0, 2).join(' ')}`);
        continue;
      }
      if (!audit.ok) failures += 1;
      results.push(audit);

      const metricText = Object.entries(audit.metrics)
        .filter(([, v]) => typeof v === 'number' && v > 0)
        .map(([k, v]) => `${k}=${v}`)
        .join(' ');
      const mark = audit.ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
      console.log(`${mark} ${screen.padEnd(10)} ${view.padEnd(9)} ${audit.problems.length} 问题  ${metricText}`);
      for (const problem of audit.problems) console.log(`      · ${problem}`);
    }
  }
} finally {
  if (server !== null && server !== undefined) server.child.kill('SIGKILL');
  await sleep(200);
}

console.log(
  failures === 0
    ? `\n\x1b[32mUI 体检通过\x1b[0m：${results.length} 个「界面 × 视口」组合，0 问题`
    : `\n\x1b[31mUI 体检失败\x1b[0m：${results.length} 个组合中 ${failures} 个有问题`,
);
if (args.shots !== null) console.log(`截图在 ${args.shots}/`);
process.exit(failures === 0 ? 0 : 1);
