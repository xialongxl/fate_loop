import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 默认 node 环境。需要 DOM 的测试文件在头部用
    // `// @vitest-environment jsdom` 单独声明。
    environment: 'node',
    include: ['tests/**/*.test.js'],
  },
});
