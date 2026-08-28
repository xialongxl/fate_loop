/**
 * 示例模组清单（manifest）。
 *
 * 这个包是**会被真正加载**的：加载器用 glob 扫描 src/mods 下所有 manifest.js，
 * 并且 `src/mods/dev/` 里的模组排在最后加载（最低优先级 → 可覆盖官方内容）。
 * 所以它同时充当模组作者的模板与活文档 —— 改坏了自己就会在启动时报错。
 *
 * 字段说明：
 *   id       全局唯一。重复会在加载期直接抛 ModLoadError（"模组 id 重复"）
 *   version  目前只用于日志与存档无关的展示；必填
 *   type     'content'（默认）或 'system'。system 模组可以注册契约实现
 *   provides 本模组对外声明的"能力"符号，供别的模组 requires
 *   requires 依赖声明。这里依赖官方怪物包：本模组的遭遇模板引用怪物 ID，
 *            拓扑排序保证官方怪物先实例化（虽然跨引用校验在全部加载后才做，
 *            但把依赖写清楚能让"覆盖"与"加载顺序"两件事可推理）
 */
export const PROVIDES_EXAMPLE_VOID = Symbol.for('fate.provide.example.void');
export const REQUIRES_CORE_MONSTERS = Symbol.for('fate.provide.monsters.core');

export default {
  id: 'dev.example-pack',
  version: '1.0.0',
  type: 'content',
  provides: [PROVIDES_EXAMPLE_VOID],
  requires: [REQUIRES_CORE_MONSTERS],
};
