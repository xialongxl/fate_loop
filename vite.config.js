import { defineConfig } from 'vite';

export default defineConfig({
  /**
   * 相对路径产物 —— GitHub Pages **项目页**（`用户.github.io/仓库名/`）的硬要求。
   *
   * 不写这行时产物引用 `/assets/xxx.js`，部署到子路径后浏览器会去站点根目录要
   * 文件 ⇒ 全部 404 ⇒ 打开就是白屏（而且控制台之外没有任何提示）。
   * 用 './' 而不是 '/fate_loop/'：项目页、用户页根目录、本地起静态服务器
   * 三种情形都能跑，不需要知道最终仓库名。
   *
   * 回归手段：`npm run deploy:check` 把 dist 挂到子路径下逐个资源请求验 200。
   */
  base: './',
  // 不要在此用 optimizeDeps.exclude 排除 src/mods：
  // 该选项只接受裸模块标识符（npm 包名），对项目自有源码路径无效；
  // 且它最终透传给 esbuild 的 external，而 external 路径不允许出现两个 *
  // 通配符，`/src/mods/**` 会直接让构建报错。
  //
  // 模组的独立性由 loader.js 的 import.meta.glob 保证：默认惰性模式产出
  // 动态 import()，Rollup 会为每个模组单独切出 chunk，不会被并入主 bundle，
  // 「模组即原生 ESM」的自举原则依然成立。
  resolve: {
    // 'fate' 的构建期解析（沙箱期由宿主注入同名模块）。
    // 让同一个第三方包目录既能放进 src/mods/dev/ 直接调试，也能压成 zip 给玩家装。
    // 见 docs/模组沙箱与包格式设计.md §5.6
    alias: { fate: '/src/mods/fate-shim.js' },
  },
  server: {
    port: 5173,
  },
  /**
   * QuickJS 的 wasm 变体不能进依赖预打包（实测过坑）。
   *
   * 它的胶水用 `new URL('emscripten-module.wasm', import.meta.url)` 定位 wasm，
   * 而 esbuild 预打包只把 .js 摄进 `node_modules/.vite/deps/`，**不会搬那个 503KB 的
   * 兄弟文件** ⇒ dev 下请求 `.vite/deps/emscripten-module.wasm` 要不到 ⇒ 被 SPA
   * fallback 挡成 index.html ⇒ `WebAssembly.instantiate` 报
   * “expected magic word 00 61 73 6d, found 3c 21 64 6f”（`<!do`）。
   * 排除之后浏览器直接从真实包目录拿 ESM，wasm 就在它旁边。
   *
   * 这个坑**只在 dev**：`vite build` 走 Rollup，它认 `new URL(字面量, import.meta.url)`
   * 并把 wasm 发进 dist/assets —— 所以上了线一切正常，而本地装包直接白屏。
   * 另一道防线在 main.js：就算 wasm 真的拿不到，游必须能开（沙箱失败不杀进程）。
   */
  optimizeDeps: {
    exclude: ['@jitl/quickjs-wasmfile-release-sync', 'quickjs-emscripten-core', 'quickjs-emscripten'],
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
});
