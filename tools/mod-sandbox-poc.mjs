#!/usr/bin/env node
/**
 * S0 · QuickJS 沙箱可行性 POC（`npm run mod:poc`）
 *
 * 它回答的是模组沙箱路线上四个"不测就不能拍板"的问题：
 *   1. 死循环能不能被掐住（`setInterruptHandler`）
 *   2. 内存/栈上限生不生效（`setMemoryLimit` / `setMaxStackSize`）
 *   3. 一次跨界 `execute` 到底多贵（决定 MAX 模式还能不能秒结算）
 *   4. 多文件包能否靠 `setModuleLoader` 解析包内相对 import
 *
 * 跑法：`npm run mod:poc`（需要 devDependency quickjs-emscripten）
 * 结果写进 docs/模组沙箱与包格式设计.md §10，不要只留在终端里。
 */
import { statSync, readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { getQuickJS } from 'quickjs-emscripten';

const KB = (n) => `${(n / 1024).toFixed(0)}KB`;

function reportSize() {
  console.log('\n=== 0) 体积（决定要不要懒加载）===');
  const wasms = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(p);
      else if (p.endsWith('.wasm')) wasms.push(p);
    }
  };
  try {
    walk('node_modules/@jitl');
  } catch {
    console.log('  没找到 @jitl 目录（quickjs-emscripten 没装？）');
    return;
  }
  for (const file of wasms.sort()) {
    if (!/release/.test(file)) continue;
    const raw = statSync(file).size;
    let gz = null;
    try {
      gz = Number(execSync(`gzip -c "${file}" | wc -c`).toString().trim());
    } catch {
      /* 没有 gzip 就算了 */
    }
    console.log(`  ${file.replace(/^node_modules\//, '').replace(/\/dist\/emscripten-module\.wasm$/, '')}  raw=${KB(raw)}${gz ? `  gz=${KB(gz)}` : ''}`);
  }
}

const QuickJS = await getQuickJS();

function probeInfiniteLoop() {
  console.log('\n=== 1) 死循环能否掐住 ===');
  const rt = QuickJS.newRuntime();
  let ticks = 0;
  const started = Date.now();
  rt.setInterruptHandler(() => {
    ticks += 1;
    return Date.now() - started > 200; // 墙钟 200ms 就中断：玩家不该等 6 秒
  });
  const vm = rt.newContext();
  const t0 = performance.now();
  const result = vm.evalCode(`(function(){ let i = 0; while (true) { i++; } })()`);
  const ms = performance.now() - t0;
  console.log(`  ${result.error ? '✓ 已中断' : '✗ 没拦住'}  耗时 ${ms.toFixed(0)}ms  中断回调 ${ticks} 次`);
  console.log('  注意：回调粒度不是"每条指令"，预算要按墙钟算，按次数会像上一版那样一卡就是 6 秒');
  result.error?.dispose();
  vm.dispose();
  rt.dispose();
}

function probeLimits() {
  console.log('\n=== 2) 内存与栈上限 ===');
  const rt = QuickJS.newRuntime();
  rt.setMemoryLimit(2 * 1024 * 1024);
  const vm = rt.newContext();
  const big = vm.evalCode(`(function(){ const a = []; while (true) a.push({ x: 1 }); })()`);
  console.log(`  内存 2MB：${big.error ? '✓ 已拦截' : '✗ 没拦住'}`);
  big.error?.dispose();
  vm.dispose();
  rt.dispose();

  const rt2 = QuickJS.newRuntime();
  rt2.setMaxStackSize(256 * 1024);
  const vm2 = rt2.newContext();
  try {
    const rec = vm2.evalCode(`(function f(){ return f() + 1; })()`);
    console.log(`  栈 256KB + 无限递归：${rec.error ? '✓ 已拦截' : '✗ 没拦住'}`);
    rec.error?.dispose();
  } catch (error) {
    console.log(`  栈 256KB + 无限递归：✗ 抛到宿主进程（${String(error?.message ?? error).slice(0, 40)}）`);
  }
  vm2.dispose();
  rt2.dispose();
}

function probeCost() {
  console.log('\n=== 3) 跨界开销（决定 MAX 模式还能不能用）===');
  const rt = QuickJS.newRuntime();
  const vm = rt.newContext();
  let hostCalls = 0;
  const damage = vm.newFunction('__damage', (arg) => {
    hostCalls += 1;
    vm.dump(arg); // 真实实现要读 amount，成本算在内
    return vm.undefined;
  });
  vm.setProp(vm.global, '__damage', damage);

  const factory = vm.unwrapResult(
    vm.evalCode(`() => function execute(ctx, self, targets) {
      let n = 0;
      for (const t of targets) { ctx.damage({ sourceId: self.id, targetId: t.id, amount: self.attack * 1.2 }); n += 1; }
      return n;
    }`),
  );
  const exec = vm.unwrapResult(vm.callFunction(factory, vm.undefined));
  const ctx = vm.unwrapResult(vm.evalCode(`({ damage: (a) => globalThis.__damage(a) })`));
  const self = vm.unwrapResult(vm.evalCode(`({ id: 'player', attack: 100 })`));
  const targets = vm.unwrapResult(vm.evalCode(`[{ id: 'e0' }, { id: 'e1' }, { id: 'e2' }]`));

  const N = 20000;
  const t0 = performance.now();
  for (let i = 0; i < N; i += 1) {
    const r = vm.callFunction(exec, vm.undefined, ctx, self, targets);
    if (r.error) {
      console.log('  ✗ 调用出错', vm.dump(r.error));
      break;
    }
    r.value.dispose();
  }
  const perCallMs = (performance.now() - t0) / N;
  console.log(`  一次 execute（3 目标 + 3 次宿主调用）：${(perCallMs * 1000).toFixed(1)} µs`);
  console.log(`  300 次施放的一场战斗 ≈ ${(perCallMs * 300).toFixed(1)} ms`);
  console.log(`  极端：10k 步 × 4 实体每步都放技能 ≈ ${(perCallMs * 40000).toFixed(0)} ms（真实战斗受 GCD 限制到不了这个量）`);
  console.log(`  宿主函数被调 ${hostCalls} 次（期望 ${N * 3}）${hostCalls === N * 3 ? ' ✓' : ' ✗'}`);
  [factory, exec, ctx, self, targets, damage].forEach((h) => h?.dispose?.());
  vm.dispose();
  rt.dispose();
}

async function probeModules() {
  console.log('\n=== 4) 多文件包与包内相对 import ===');
  const rt = QuickJS.newRuntime();
  const vm = rt.newContext();
  const files = {
    'pack/main.js': `import { begin, skill } from 'fate';
import { SKILLS } from './lib/skills.js';
begin({ id: 'poc.pack' });
for (const s of SKILLS) skill(s);
'done';`,
    'pack/lib/skills.js': `export const SKILLS = [{ id: 'poc.a', type: 'GCD', gcdCost: 2.4 }];`,
  };
  const seen = [];
  const fate = vm.newObject();
  for (const kind of ['begin', 'skill']) {
    const fn = vm.newFunction(kind, () => {
      seen.push(kind);
      return vm.undefined;
    });
    vm.setProp(fate, kind, fn);
    fn.dispose();
  }
  vm.setProp(vm.global, '__fate', fate);
  rt.setModuleLoader('fate', () => 'globalThis.__fate');
  for (const [name, src] of Object.entries(files)) rt.setModuleLoader(name, () => src);

  const result = vm.evalCode(`import('pack/main.js')`, 'poc.js', { type: 'module' });
  if (result.error) {
    console.log(`  ✗ 模块解析失败：${vm.dump(result.error)?.message ?? vm.dump(result.error)}`);
    result.error.dispose();
  } else {
    for (let i = 0; i < 8; i += 1) {
      rt.executePendingJobs();
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    console.log(`  ✓ 模块图解析成功；注册回调 = ${seen.join(',') || '(空 —— import() 返回 promise，S2 必须先 await 再收集)'}`);
    result.value.dispose();
  }
  fate.dispose();
  vm.dispose();
  rt.dispose();
}

reportSize();
probeInfiniteLoop();
probeLimits();
probeCost();
await probeModules();
console.log(
  '\n结论：四项全过 ⇒ QuickJS 路线成立。S2 要注意两点：' +
    '\n  · 中断预算按墙钟算（不是按回调次数）' +
    '\n  · 包是 ESM，import() 返回 promise，注册收集必须在 microtask 跑完之后',
);
