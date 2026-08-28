/**
 * 构建期适配器（3 行）。
 *
 * 第三方包压成 zip 时**不需要这个文件** —— 沙箱直接求值 manifest.json 里指定的
 * entry（index.js），注册由宿主收集。这个文件只服务一条路径：把包目录放进
 * src/mods/dev/ 用 npm run dev 直接调试。
 *
 * 所以它是"两种解析方式共用一份包源码"的接缝，见
 * docs/模组沙箱与包格式设计.md §5.6。
 */
import { drainRegistrations } from 'fate';
import './index.js'; // 求值 index.js 即完成注册（注册作用域按包 id 分）

const PACK_ID = 'dev.example-pack';

export function setup() {
  // 显式传自己的 id：同一次加载里可能有多个包共用同一个 shim
  return drainRegistrations(PACK_ID);
}
