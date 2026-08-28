import { defineConfig } from 'vitest/config';

export default defineConfig({
  // 与 vite.config.js 保持一致：第三方写法的示例包 import 'fate'，
  // 两边解析到同一个模块才不会测出一个生产环境不存在的行为。
  resolve: {
    alias: { fate: '/src/mods/fate-shim.js' },
  },
  test: {
    // 默认 node 环境。需要 DOM 的测试文件在头部用
    // `// @vitest-environment jsdom` 单独声明。
    environment: 'node',
    include: ['tests/**/*.test.js'],
  },
});
