/**
 * ESLint 硬约束：把《技术实施细化方案》第 7 节的确定性铁律变成机器可验证的规则。
 *
 * 核心思想：确定性不是靠自觉，而是靠 lint 在提交前拦住。
 * - core / contracts / mods 是确定性区，禁止一切非确定性来源与异步。
 * - core/mods（加载器）是启动期一次性行为，动态 import() 天然异步，放宽 async。
 *   注意区分：`src/core/mods/**` 是加载器代码，`src/mods/**` 是模组内容，后者仍全禁。
 * - persistence 必须异步（IndexedDB API 本身异步），单独放宽。
 * - ui/audio 允许物理时钟（节流去重窗口），但不参与逻辑。
 */

const DETERMINISM_BANS = [
  'error',
  { object: 'Math', property: 'random', message: '禁用 Math.random()：请使用 prng 契约（铁律 3.3）' },
  { object: 'Date', property: 'now', message: '禁用 Date.now()：仅 core/prng.js#randomSeed 可用（铁律 3.3）' },
  {
    object: 'performance',
    property: 'now',
    message: '禁用 performance.now()：战斗逻辑不得依赖物理时钟（规格 4.5）',
  },
];

const SYNC_ONLY = [
  'error',
  { selector: 'AwaitExpression', message: '战斗与生成逻辑必须同步（规格 5.3 execute 必须同步）' },
  { selector: 'FunctionDeclaration[async=true]', message: '确定性区禁止 async 函数' },
  { selector: 'FunctionExpression[async=true]', message: '确定性区禁止 async 函数' },
  { selector: 'ArrowFunctionExpression[async=true]', message: '确定性区禁止 async 函数' },
  { selector: 'NewExpression[callee.name="Date"]', message: '禁止构造 Date：破坏确定性' },
  { selector: 'NewExpression[callee.name="Promise"]', message: '确定性区禁止 Promise' },
];

const baseLanguageOptions = {
  ecmaVersion: 2022,
  sourceType: 'module',
};

export default [
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**'],
  },

  // 全局基线
  {
    files: ['**/*.js'],
    languageOptions: {
      ...baseLanguageOptions,
      globals: {
        console: 'readonly',
        structuredClone: 'readonly',
        globalThis: 'readonly',
      },
    },
    linterOptions: {
      // 失效的 eslint-disable 注释往往意味着规则没按预期生效，必须当错误看
      reportUnusedDisableDirectives: 'error',
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-undef': 'error',
      eqeqeq: ['error', 'always'],
      'prefer-const': 'error',
      'no-var': 'error',
      'no-alert': 'error',
    },
  },

  // 确定性区：core / contracts / mods
  {
    files: ['src/core/**/*.js', 'src/contracts/**/*.js', 'src/mods/**/*.js'],
    rules: {
      'no-restricted-properties': DETERMINISM_BANS,
      'no-restricted-syntax': SYNC_ONLY,
    },
  },

  // 模组加载器：动态 import() 必须异步（启动期一次性，不参与确定性断言）。
  // 非确定性来源（Math.random / Date.now）仍然禁止 —— 加载结果必须可复现。
  {
    files: ['src/core/mods/**/*.js'],
    rules: {
      'no-restricted-syntax': [
        'error',
        { selector: 'NewExpression[callee.name="Date"]', message: '禁止构造 Date：破坏确定性' },
      ],
    },
  },

  // randomSeed 是种子的唯一来源，按规格 6.1 允许混合一次 Date.now 后立即丢弃
  {
    files: ['src/core/prng.js'],
    rules: {
      'no-restricted-properties': [
        'error',
        { object: 'Math', property: 'random', message: '即使在 prng.js 也禁用 Math.random()' },
      ],
    },
  },

  // 音频适配层：允许物理时钟做节流去重（裁决 8，不参与逻辑）
  {
    files: ['src/contracts/defaults/audio.js', 'src/ui/audio/**/*.js'],
    rules: {
      'no-restricted-properties': 'off',
      'no-restricted-syntax': 'off',
    },
  },

  // 持久化层：IndexedDB 强制异步（裁决 7）
  {
    files: ['src/persistence/**/*.js'],
    rules: {
      'no-restricted-syntax': 'off',
    },
  },

  // UI 层：允许 DOM 与物理时钟（渲染节流、动画）。
  // boot.js 是浏览器入口（只做装配与错误兜底），与 main.js 同级放宽。
  {
    files: ['src/ui/**/*.js', 'src/main.js', 'src/boot.js'],
    languageOptions: {
      ...baseLanguageOptions,
      globals: {
        console: 'readonly',
        structuredClone: 'readonly',
        globalThis: 'readonly',
        document: 'readonly',
        window: 'readonly',
        location: 'readonly',
        requestAnimationFrame: 'readonly',
        cancelAnimationFrame: 'readonly',
        localStorage: 'readonly',
        indexedDB: 'readonly',
        performance: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        queueMicrotask: 'readonly',
        SVGElement: 'readonly',
        Audio: 'readonly',
      },
    },
    rules: {
      'no-restricted-properties': [
        'error',
        { object: 'Math', property: 'random', message: 'UI 层也禁用 Math.random()：请使用 prng 契约' },
      ],
    },
  },

  // 持久化层全局
  {
    files: ['src/persistence/**/*.js'],
    languageOptions: {
      ...baseLanguageOptions,
      globals: {
        console: 'readonly',
        structuredClone: 'readonly',
        globalThis: 'readonly',
        indexedDB: 'readonly',
        localStorage: 'readonly',
        queueMicrotask: 'readonly',
        setTimeout: 'readonly',
        IDBKeyRange: 'readonly',
      },
    },
  },

  // UI 体检工具的浏览器侧（tools/ui-audit/harness.js）：跑在真浏览器里，
  // 需要一整套 DOM 全局。Node 侧的 run.mjs 不被 '**/*.js' 匹配，另配。
  {
    files: ['tools/**/*.js'],
    languageOptions: {
      ...baseLanguageOptions,
      globals: {
        console: 'readonly',
        document: 'readonly',
        window: 'readonly',
        location: 'readonly',
        URLSearchParams: 'readonly',
        MouseEvent: 'readonly',
        innerWidth: 'readonly',
        innerHeight: 'readonly',
        getComputedStyle: 'readonly',
        setTimeout: 'readonly',
      },
    },
  },

  // 测试：放宽全部约束（需要构造边界情况）
  {
    files: ['tests/**/*.js'],
    languageOptions: {
      ...baseLanguageOptions,
      globals: {
        console: 'readonly',
        structuredClone: 'readonly',
        globalThis: 'readonly',
        document: 'readonly',
        window: 'readonly',
        indexedDB: 'readonly',
        localStorage: 'readonly',
        performance: 'readonly',
        setTimeout: 'readonly',
        queueMicrotask: 'readonly',
      },
    },
    rules: {
      'no-restricted-properties': 'off',
      'no-restricted-syntax': 'off',
    },
  },

  // 配置文件
  {
    files: ['*.config.js', 'eslint.config.js', 'scripts/**/*.js'],
    rules: {
      'no-restricted-properties': 'off',
      'no-restricted-syntax': 'off',
    },
  },
];
