/**
 * 构建期清单（原生加载器要求 manifest.js + setup.js）。
 *
 * 注意与第三方包的区别：真实第三方包带的是 **manifest.json**（沙箱按它找 entry），
 * 而本目录要能被 src/mods/ 的原生 glob 扫到，所以必须有这个 .js 清单。
 * 两份清单描述的是同一个包，内容保持一致即可 —— 这也是"一个包目录、两条加载路径"
 * 的代价，见 docs/模组沙箱与包格式设计.md §5.6。
 */
export const PROVIDES_EXAMPLE_VOID = Symbol.for('fate.provide.example.void');
export const REQUIRES_CORE_MONSTERS = Symbol.for('fate.provide.monsters.core');

export default {
  id: 'dev.example-pack',
  version: '1.1.0',
  type: 'content',
  provides: [PROVIDES_EXAMPLE_VOID],
  requires: [REQUIRES_CORE_MONSTERS],
};
