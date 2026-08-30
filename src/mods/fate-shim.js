/**
 * `'fate'` —— 第三方包唯一的能力入口。
 *
 * 两种解析方式（这是设计文档 §5.6 的核心决定）：
 *   构建期   vite alias: 'fate' → 本文件。包目录放进 src/mods/dev/ 就能直接跑，
 *            作者改一行看一行，不用打包。
 *   沙箱内   宿主按 `fateApiKeys()` 这份清单注入等价模块（S2）。
 * 两边的键集合必须一致 —— 由 tests/unit/fate-api.test.js 守住，不靠文档自觉。
 *
 * 为什么可信层要绕这一圈：官方模组可以直接 import core，第三方不行。
 * 如果示例包用官方写法，它就是"看着能抄、其实装不上"的陷阱。所以示例包
 * 一律走这里，让它同时是文档、S2 的测试夹具、以及 API 契约的单一声明处。
 *
 * 注册是**导入即生效**的命令式：`skill({...})` 在模块求值时就把定义收进缓冲区，
 * 由包入口的 setup.js 适配器 drain 给加载器。顺序由静态 import 决定，因此确定。
 */

import {
  OGCD_SLOT_LIMIT,
  SKILL_RANGE,
  SKILL_TYPE,
  STEP_MS,
  VICTORY_FLOOR,
} from '../core/constants.js';

const KINDS = Object.freeze([
  'families',
  'skills',
  'buffs',
  'monsters',
  'encounters',
  'shopItems',
  'events',
  'mapGenerators',
]);

/**
 * 注册按**包 id 分作用域**。两个理由，都是先踩过才改的：
 *   1. 一个模块级全局缓冲 + drain 即清空 ⇒ 同一个包被加载第二次（测试里、
 *      或将来热重载）会拿到空内容
 *   2. 多个包同时 import 'fate'（同一个 shim 实例）⇒ 互相吞掉对方的注册
 * 所以 begin() 开一个作用域，后续注册进那个作用域，drain 按 id 取**副本**。
 */
const scopes = new Map();
let currentId = null;

function openScope(id) {
  let scope = scopes.get(id);
  if (scope === undefined) {
    scope = Object.fromEntries(KINDS.map((kind) => [kind, []]));
    // 钩子不是内容，单独一格；重复加载同一个包时也要重置
    scope.hooks = { battleStart: [] };
    scopes.set(id, scope);
  }
  return scope;
}

function collect(kind, item, label) {
  if (currentId === null) {
    throw new TypeError(`fate.${label}(...) 之前必须先调用 fate.begin({ id, version, ... })`);
  }
  if (item === null || typeof item !== 'object') {
    throw new TypeError(`fate.${label}(...) 需要一个对象，实际为 ${String(item)}`);
  }
  if (typeof item.id !== 'string' || item.id === '') {
    throw new TypeError(`fate.${label}(...) 缺少非空 id`);
  }
  scopes.get(currentId)[kind].push(item);
  return item;
}

/**
 * 声明包身份。构建期只是元信息（真正的 id/version 在 manifest.js），
 * 沙箱期它会成为存档与指纹里那条记录。
 */
export function begin(spec) {
  if (spec === null || typeof spec !== 'object' || typeof spec.id !== 'string') {
    throw new TypeError('fate.begin({ id, version, title, author, description }) 需要带 id 的对象');
  }
  currentId = spec.id;
  const scope = openScope(currentId);
  for (const kind of KINDS) scope[kind] = []; // 同一份源码被重复加载时不累加
  scope.manifest = { ...spec };
  scope.hooks = { battleStart: [] };
  return scope.manifest;
}

export const family = (spec) => collect('families', spec, 'family');
export const skill = (spec) => collect('skills', spec, 'skill');
export const buff = (spec) => collect('buffs', spec, 'buff');
export const monster = (spec) => collect('monsters', spec, 'monster');
export const encounter = (spec) => collect('encounters', spec, 'encounter');
export const shopItem = (spec) => collect('shopItems', spec, 'shopItem');
export const event = (spec) => collect('events', spec, 'event');
export const mapGenerator = (spec) => collect('mapGenerators', spec, 'mapGenerator');

/**
 * 注册"每场战斗开始时"的回调。
 *
 * 为什么第三方包需要它：包可以用模块级变量记住跨次施放的状态（官方技能全是
 * 无状态的），而那种记忆会**活过整场战斗** —— 于是"同种子、同序列，但先打过
 * 一场"就会算出不同结果，直接动摇本作"同种子必得同结果"的承诺。
 * 有了这个钩子，包可以在每场开头自己把记忆清掉，把单场可复现性拿回来。
 *
 * 回调签名 (ctx, state)，只能走 ctx/ops 那套官方操作，跟技能一样。
 */
export function onBattleStart(fn) {
  if (typeof fn !== 'function') {
    throw new TypeError('fate.onBattleStart(fn) 需要一个函数');
  }
  if (currentId === null) {
    throw new TypeError('fate.onBattleStart 之前必须先调用 fate.begin({ id, version })');
  }
  const scope = scopes.get(currentId);
  scope.hooks.battleStart.push(fn);
  return fn;
}

/** 取某个包的钩子列表（**不清空**，与 drainRegistrations 同样的可重复加载语义）。 */
export function drainHooks(id = currentId) {
  if (id === null || id === undefined) return { battleStart: [] };
  const scope = scopes.get(id);
  if (scope === undefined) return { battleStart: [] };
  return { battleStart: [...scope.hooks.battleStart] };
}

/** 声明注册结束。构建期不强制，但沙箱期用它检测"包没注册完就结束"。 */
export function finish() {
  return currentId === null ? null : scopes.get(currentId).manifest;
}

/** 当前正在注册的那个包的 id（setup.js 适配器会显式传自己的 id，不依赖它）。 */
export function currentPackId() {
  return currentId;
}

/**
 * 取某个包注册到的内容。**返回副本且不清空** —— 同一个包被加载两次
 * （测试、热重载）必须拿到同样的结果。
 * @param {string} [id] 省略时用当前作用域
 */
export function drainRegistrations(id = currentId) {
  if (id === null || id === undefined) return Object.fromEntries(KINDS.map((kind) => [kind, []]));
  const scope = scopes.get(id);
  if (scope === undefined) return Object.fromEntries(KINDS.map((kind) => [kind, []]));
  return Object.fromEntries(KINDS.map((kind) => [kind, [...scope[kind]]]));
}

/**
 * 沙箱注入模块必须提供的键集合 —— API 契约的单一声明处。
 * 加一个能力就在这里加一项，测试会要求沙箱侧同步跟上。
 */
export function fateApiKeys() {
  return Object.freeze([
    'begin',
    'family',
    'skill',
    'buff',
    'monster',
    'encounter',
    'shopItem',
    'event',
    'mapGenerator',
    'onBattleStart',
    'finish',
    'currentPackId',
    'drainRegistrations',
    'drainHooks',
    // 常量：包作者不该去猜 core 里的字面量
    'SKILL_TYPE',
    'SKILL_RANGE',
    'STEP_MS',
    'OGCD_SLOT_LIMIT',
    'VICTORY_FLOOR',
  ]);
}

/* 常量再导出：包作者拿不到 core/constants.js，这些是他们能看到的字面量。 */
export { SKILL_TYPE, SKILL_RANGE, STEP_MS, OGCD_SLOT_LIMIT, VICTORY_FLOOR };

/**
 * execute(ctx, self, targets) 里 ctx 提供的能力（文档性质，运行时不消费）。
 * 列在这里是为了让"第三方能做什么"有一处可查的清单；S2 的沙箱注入必须与它一致。
 *
 * ⚠️ 一条作者必须知道的限制：**不要用 query 路径去取实体**。
 *   实体 id 含点（'mon.thunder.herald.t1#0'），而 stateQuery 的字符串路径按 '.'
 *   分段，所以 `ctx.query('monsters.' + target.id + '.hp')` 永远返回 undefined ——
 *   然后技能就会安静地按"读不到"的分支跑，看上去生效其实没生效。
 *   按 id 取实体用 `ctx.entity(id)`，读 Buff 层数用 `ctx.buffStacks(entity, buffId)`。
 */
export const CTX_CAPABILITIES = Object.freeze([
  'damage',
  'heal',
  'applyBuff',
  'removeBuff',
  'buffStacks',
  'hasBuff',
  'log',
  'sound',
  'query',
  'entity',
  'rng',
  'virtualTime',
  'floorNumber',
]);

/**
 * apply(state, ops) 里 ops 提供的安全原语（同上，清单化）。
 * 集合来源：node tools/mod-shape-report.mjs 测出的官方内容实际用到的操作。
 */
export const STATE_OPERATIONS = Object.freeze([
  'permanentBonus',
  'shards',
  'gainShards',
  'spendShards',
  'setShards',
  'healRatio',
  'hpCostRatio',
  'fullHeal',
  'addMetadata',
]);
