import { defineConfig } from 'vite';

export default defineConfig({
  // 不要在此用 optimizeDeps.exclude 排除 src/mods：
  // 该选项只接受裸模块标识符（npm 包名），对项目自有源码路径无效；
  // 且它最终透传给 esbuild 的 external，而 external 路径不允许出现两个 *
  // 通配符，`/src/mods/**` 会直接让构建报错。
  //
  // 模组的独立性由 loader.js 的 import.meta.glob 保证：默认惰性模式产出
  // 动态 import()，Rollup 会为每个模组单独切出 chunk，不会被并入主 bundle，
  // 「模组即原生 ESM」的自举原则依然成立。
  server: {
    port: 5173,
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
});
