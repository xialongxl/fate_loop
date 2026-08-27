import { generateFloor } from '../../../core/map/generator.js';

/**
 * 官方地图生成器。以模组形式注册，体现"模组即原生"（铁律 3.2）：
 * 第三方可以提供同名 id 覆盖它，从而完全替换地图生成逻辑。
 */
export function setup(context) {
  context.log('注册官方网格地图生成器');
  return {
    mapGenerators: [
      {
        id: 'official.grid',
        name: '网格化地图（黑流树海风格）',
        generate: generateFloor,
      },
    ],
  };
}
