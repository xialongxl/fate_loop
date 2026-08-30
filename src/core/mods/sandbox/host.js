/**
 * 沙箱宿主：把第三方包放进 QuickJS-WASM 里求值，并把注册收回来。
 *
 * 三条铁律（都在设计文档 §6 论证过，S0 POC 实测确认）：
 *
 * 1. **一个包一个 runtime**。内存/栈上限是 runtime 级的；共用 runtime 时一个
 *    贪内存的包会把同车的官方内容一起拖死。包之间零共享（连 'fate' 模块实例
 *    都是各自的），坏包只影响它自己。
 * 2. **中断预算按墙钟算，不按指令数**。POC 实测按回调次数设预算会一卡 6 秒，
 *    回调粒度很粗（200ms 才 ~690 次）。所以每次进 VM 前设 deadline，超时即
 *    把该包标记失效并拒用其后续技能。
 * 3. **栈上限必须小**。实测 512KB 时无限递归会把**宿主进程**直接打崩，256KB
 *    才只是抛 JS 异常。这不是调优，是"页面整个没了"与"报个错"的分界。
 *
 * 跨界只传 JSON 文本：包拿到的是实体快照，改不动真实状态；要产生效果必须通过
 * ctx 的操作，而那些操作走的正是官方技能用的同一条 registry 路径。
 */

import { ModLoadError } from '../../../utils/invariant.js';
import {
  OGCD_SLOT_LIMIT,
  SKILL_RANGE,
  SKILL_TYPE,
  STEP_MS,
  VICTORY_FLOOR,
} from '../../constants.js';
import { fateApiKeys } from '../../../mods/fate-shim.js';

/**
 * 每个 kind 里"值是函数"的字段。表外的函数型字段直接拒绝，不静默丢。
 *
 * **支持一层数组内路径**（`choices[].apply`）：事件的函数不是顶层字段，
 * 而是嵌在选择项里 —— 只拆顶层就会把它当普通数据吐掉，然后事件安静地选不动。
 */
export const SANDBOX_FUNCTION_PROPS = Object.freeze({
  skills: ['execute', 'condition'],
  buffs: [],
  monsters: [],
  encounters: [],
  families: [],
  shopItems: ['apply'],
  events: ['choices[].apply'],
  mapGenerators: ['generate'],
});

/** `choices[].apply` → { list: 'choices', prop: 'apply' }；顶层字段返回 null。 */
const NESTED_PROP = /^(\w+)\[\]\.(\w+)$/;

/** 已开放的注册种类。 */
export const SANDBOX_SUPPORTED_KINDS = Object.freeze([
  'families',
  'skills',
  'buffs',
  'monsters',
  'encounters',
  'shopItems',
  'events',
  'mapGenerators',
]);

/** API 方法 → 它写进哪个内容列表。 */
const METHOD_TARGETS = Object.freeze({
  begin: null,
  finish: null,
  /** 钩子不是内容：值本身就是函数，走单独一条跨界通道 */
  onBattleStart: '__hook.battleStart',
  family: 'families',
  skill: 'skills',
  buff: 'buffs',
  monster: 'monsters',
  encounter: 'encounters',
  shopItem: 'shopItems',
  event: 'events',
  mapGenerator: 'mapGenerators',
});
/** 仍未开放的 API 方法（现在全开完了；留着这条机制以便将来加能力时明确拒绝） */
const NOT_YET_METHODS = Object.freeze([]);

const CONST_VALUES = Object.freeze({ SKILL_TYPE, SKILL_RANGE, STEP_MS, OGCD_SLOT_LIMIT, VICTORY_FLOOR });

/**
 * 'fate' 的键集合由 fate-shim 单点声明。这里注入少了、拼错了，都该在启动时
 * 立刻炸，而不是等某个包在运行时 `skill is not a function`。
 */
function assertApiContract() {
  const injected = [...Object.keys(METHOD_TARGETS), ...NOT_YET_METHODS, ...Object.keys(CONST_VALUES)];
  const declared = [...fateApiKeys()];
  const missing = injected.filter((key) => !declared.includes(key));
  const forgotten = declared.filter(
    (key) =>
      !injected.includes(key) && key !== 'drainRegistrations' && key !== 'currentPackId' && key !== 'drainHooks',
  );
  if (missing.length > 0 || forgotten.length > 0) {
    throw new ModLoadError('沙箱注入的 fate API 与 fateApiKeys() 不一致', {
      injectedNotDeclared: missing,
      declaredNotInjected: forgotten,
    });
  }
}

/** VM 侧胶水：ctx 代理（读走快照、写走宿主操作）+ 按 JSON 取参数调用 VM 内函数。 */
const PRELUDE = `
globalThis.__ctx = {
  damage: (a) => globalThis.__op('damage', JSON.stringify(a)),
  heal: (a) => globalThis.__op('heal', JSON.stringify(a)),
  applyBuff: (a) => globalThis.__op('applyBuff', JSON.stringify(a)),
  removeBuff: (a) => globalThis.__op('removeBuff', JSON.stringify(a)),
  log: (m) => globalThis.__op('log', JSON.stringify(String(m))),
  sound: (s) => globalThis.__op('sound', JSON.stringify(String(s))),
  query: (sel) => JSON.parse(globalThis.__op('query', JSON.stringify(String(sel))) ?? 'null'),
  entity: (ref) => JSON.parse(globalThis.__op('entity', JSON.stringify(typeof ref === 'string' ? ref : String(ref?.id ?? ref))) ?? 'null'),
  buffStacks: (e, b) => globalThis.__opNum('buffStacks', JSON.stringify([e?.id ?? e, b])),
  hasBuff: (e, b) => globalThis.__ctx.buffStacks(e, b) > 0,
  rng: () => globalThis.__opNum('rng', 'null'),
  get virtualTime() { return globalThis.__opNum('virtualTime', 'null'); },
  get floorNumber() { return globalThis.__opNum('floorNumber', 'null'); },
};
globalThis.__applyFn = (fn, ctx, argsJson) => {
  const args = globalThis.__freeze(JSON.parse(argsJson));
  return fn(ctx, args[0], args[1]);
};
// 递进 VM 的一切都是**快照**，冻住它。理由：官方技能的 execute 能直接改实体，
// 而包改的是拷贝 —— 不冻的话写 state.player.hp = 999 会**静默无效**，
// 那正是"看着生效其实没生效"最难查的一类。冻住之后它立刻抛 TypeError，
// 宿主接住、摘包、报给 UI。包要产生效果只能走 ctx / ops。
// （注：这段是模板字符串里的 VM 代码，注释里**不能写反引号** —— 会提前终结模板）
globalThis.__freeze = (v) => {
  if (v === null || typeof v !== 'object' || Object.isFrozen(v)) return v;
  for (const key of Object.keys(v)) globalThis.__freeze(v[key]);
  return Object.freeze(v);
};
// 钩子签名是 (ctx, state)，与技能的 (ctx, self, targets) 不同 —— 分开一条，
// 不往 args 里塞 null 占位（那会让作者以为能拿到 targets）
globalThis.__applyHook = (fn, ctx, stateJson) => fn(ctx, globalThis.__freeze(JSON.parse(stateJson)));
// 商店/事件的 apply(state, ops)：state 是快照，改动只能通过 ops 走官方原语
globalThis.__applyOp = (fn, stateJson, ops) => fn(globalThis.__freeze(JSON.parse(stateJson)), ops);
// 地图生成器第三种形状：generate({ seed, floorNumber }) → 返回**数据**（不是副作用）。
// 返回值会被宿主深拷贝并做结构 + 确定性校验，所以这里不冻参数以外的东西
globalThis.__applyGen = (fn, argJson) => fn(globalThis.__freeze(JSON.parse(argJson)));
globalThis.__ops = {
  permanentBonus: (b) => {
    globalThis.__opVal('permanentBonus', JSON.stringify(b ?? {}));
  },
  get shards() { return globalThis.__opNum('shards', 'null'); },
  gainShards: (n) => globalThis.__opVal('gainShards', JSON.stringify(Number(n) || 0)),
  // 布尔过界只能借数字（VM 里没有 JS 布尔可传）：宿主回 1/0，这里 !! 转回来。
  // 写 === true 会永远 false，表现为"扣钱成功但什么都不发生"——最难查的那种
  spendShards: (n) => !!globalThis.__opVal('spendShards', JSON.stringify(Number(n) || 0)),
  setShards: (n) => globalThis.__opVal('setShards', JSON.stringify(Number(n) || 0)),
  healRatio: (r) => globalThis.__opVal('healRatio', JSON.stringify(Number(r) || 0)),
  hpCostRatio: (r) => globalThis.__opVal('hpCostRatio', JSON.stringify(Number(r) || 0)),
  fullHeal: () => globalThis.__opVal('fullHeal', 'null'),
  addMetadata: (k, v) => globalThis.__opVal('addMetadata', JSON.stringify([String(k), Number(v) || 0])),
};
`;

/** `'fate'` 的 ESM 门面。具名导出必须是静态的 —— 包作者写的是 `import { skill } from 'fate'`。 */
function fateModuleSource() {
  const methods = Object.keys(METHOD_TARGETS).map(
    (name) => `export const ${name} = (...a) => globalThis.__fate.${name}(...a);`,
  );
  const notYet = NOT_YET_METHODS.map(
    (name) =>
      `export const ${name} = () => { throw new Error('fate.${name}() 尚未开放（当前支持：begin/family/skill/buff/monster/encounter/shopItem/event/onBattleStart/finish）'); };`,
  );
  const consts = Object.keys(CONST_VALUES).map((name) => `export const ${name} = globalThis.__fate.${name};`);
  return [...methods, ...notYet, ...consts, 'export default globalThis.__fate;'].join('\n');
}

/** Map/Set 字段（buffs、ogcdReadyAtMs…）过界前必须摊平，否则 JSON.stringify 会静默变成 {}。 */
export function snapshotEntity(entity) {
  const plain = {};
  for (const [key, value] of Object.entries(entity ?? {})) {
    if (value instanceof Map) {
      plain[key] = Object.fromEntries(value.entries());
    } else if (value instanceof Set) {
      plain[key] = [...value.values()];
    } else if (typeof value !== 'function') {
      plain[key] = value;
    }
  }
  return plain;
}

/** ctx 的读操作要 JSON 化，写操作直接透传。 */
/**
 * ops 白名单（商店/事件的写入口）。清单与 fate-shim 的 STATE_OPERATIONS 对拍，
 * 两边不一致就是"文档能做、运行时一调就报错"。不在这张表里的操作根本不存在，
 * 所以包改不了它本来就该改不了的东西（序列、等级、地图）。
 */
const STATE_OP_METHODS = Object.freeze([
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

function invokeStateOp(ops, kind, arg) {
  if (!STATE_OP_METHODS.includes(kind)) throw new Error(`ops.${kind} 不存在`);
  if (kind === 'shards') return ops.shards;
  if (kind === 'addMetadata') return ops.addMetadata(arg[0], arg[1]);
  return ops[kind](arg);
}

function invokeContextOp(context, kind, arg) {
  switch (kind) {
    case 'damage':
      return context.damage(arg);
    case 'heal':
      return context.heal(arg);
    case 'applyBuff':
      return context.applyBuff(arg);
    case 'removeBuff':
      return context.removeBuff(arg);
    case 'log':
      return context.log(arg);
    case 'sound':
      return context.sound(arg);
    case 'query':
      return JSON.stringify(context.query(arg) ?? null);
    case 'entity': {
      const found = context.entity(arg);
      return found === undefined ? null : JSON.stringify(snapshotEntity(found));
    }
    case 'buffStacks':
      return context.buffStacks(arg[0], arg[1]);
    case 'hasBuff':
      return context.hasBuff(arg[0], arg[1]) ? 1 : 0;
    case 'rng':
      return context.rng();
    case 'virtualTime':
      return context.virtualTime;
    case 'floorNumber':
      return context.floorNumber;
    default:
      throw new Error(`ctx.${kind} 不存在`);
  }
}

let modulePromise = null;
/** 只在真要装包时才拉 wasm —— 主包 gzip 28KB，不能被 227KB 的 QuickJS 污染。 */
export function loadQuickJsModule() {
  modulePromise ??= (async () => {
    const [variantMod, core] = await Promise.all([
      import('@jitl/quickjs-wasmfile-release-sync'),
      import('quickjs-emscripten-core'),
    ]);
    return core.newQuickJSWASMModuleFromVariant(variantMod.default);
  })();
  return modulePromise;
}

/**
 * 同步变体里 promise 不会自己收敛，必须手动跑 microtask 队列。
 * POC 漏了这一步的后果是"import 成功、注册为空"——静默且致命，所以单列出来。
 */
function pumpUntilSettled(vm, runtime, promiseHandle) {
  for (let i = 0; i < 200; i += 1) {
    runtime.executePendingJobs();
    const state = vm.getPromiseState(promiseHandle);
    if (state.type === 'fulfilled') {
      // 坑：用 {type:'module'} 求值时拿到的**不是 promise 而是模块完成值**，
      // getPromiseState 会把**同一个句柄**回传（notAPromise: true）。
      // 这里 dispose 它就是二次释放 —— 下一行访问 .value 就抱 "Lifetime not alive"。
      if (state.notAPromise !== true) state.value.dispose();
      return null;
    }
    if (state.type === 'rejected') {
      const dumped = vm.dump(state.error);
      const message = typeof dumped === 'object' ? (dumped?.message ?? JSON.stringify(dumped)) : String(dumped);
      state.error.dispose();
      return message;
    }
  }
  return '模块求值没有收敛（悬空的 promise）';
}

/**
 * @param {{clock:()=>number, budgetMs?:number, loadBudgetMs?:number,
 *          memoryLimitBytes?:number, stackLimitBytes?:number,
 *          onPackFailure?:(id:string,reason:string)=>void}} options
 *   clock 必须由调用方注入：core 里禁读物理时钟（lint 铁律），而中断预算恰恰
 *   需要物理时钟 —— 所以它是宿主的参数，不是宿主的依赖。
 */
export async function createSandboxHost({
  clock,
  budgetMs = 120,
  loadBudgetMs = 400,
  memoryLimitBytes = 8 * 1024 * 1024,
  stackLimitBytes = 256 * 1024,
  onPackFailure = () => {},
} = {}) {
  assertApiContract();
  if (typeof clock !== 'function') {
    throw new ModLoadError('createSandboxHost 需要 clock()：中断预算依赖宿主时钟', {});
  }

  const QuickJS = await loadQuickJsModule();
  const installed = new Map();
  /** 出过事、不敢 free 的 runtime（见 disposeRecord 注释） */
  const quarantine = [];
  let disposed = false;

  /** 每次进 VM 都要过这里：设墙钟 deadline，出界即标记失效。 */
  function enter(record) {
    record.deadline = clock() + budgetMs;
    record.interrupted = false;
  }
  function exit(record) {
    record.deadline = Number.POSITIVE_INFINITY;
    if (record.interrupted) {
      markDead(record, `执行超过 ${budgetMs}ms 被打断（疑似死循环）`);
    }
    return !record.failed;
  }

  /**
   * 释放一个包的 VM。
   *
   * ⚠️ 出事过的 runtime **一律不 free，只 park**。原因：QuickJS 在 JS_FreeRuntime
   * 时发现 gc 对象表非空会直接 abort() —— wasm 级终止，try/catch 拦不住，整个页面
   * 的 QuickJS 实例（连同其它包与官方内容）一起没。而“跑过死循环 / 被中断 / 抛过
   * 异常”的 runtime 恰恰最可能残留对象。代价有界：parked 数 ≤ 装包数（≤ 8）。
   */
  function disposeRecord(record) {
    if (record.disposed) return;
    record.disposed = true;
    record.currentContext = null;
    if (record.failed || record.interrupted || record.dirty) {
      quarantine.push(record);
      return;
    }
    for (const handle of record.functions.values()) {
      if (handle.alive) handle.dispose();
    }
    if (record.ctxHandle?.alive) record.ctxHandle.dispose();
    if (record.applyFn?.alive) record.applyFn.dispose();
    if (record.hookFn?.alive) record.hookFn.dispose();
    if (record.opFn?.alive) record.opFn.dispose();
    if (record.opsHandle?.alive) record.opsHandle.dispose();
    if (record.genFn?.alive) record.genFn.dispose();
    if (record.collectRef?.alive) record.collectRef.dispose();
    record.vm.dispose();
    record.runtime.dispose();
  }

  function unloadPack(id) {
    const record = installed.get(id);
    if (record === undefined) return false;
    installed.delete(id);
    disposeRecord(record);
    return true;
  }

  async function installPack(pack) {
    if (disposed) throw new ModLoadError('沙箱宿主已销毁', {});
    unloadPack(pack.id); // 热重载 / 重复安装：旧的先干净拆掉

    const runtime = QuickJS.newRuntime();
    runtime.setMemoryLimit(memoryLimitBytes);
    runtime.setMaxStackSize(stackLimitBytes);
    const vm = runtime.newContext();

    const record = {
      pack,
      runtime,
      vm,
      registrations: [],
      /** 已登记的钩子（battleStart 等） */
      hooks: [],
      functions: new Map(),
      manifest: null,
      deadline: Number.POSITIVE_INFINITY,
      interrupted: false,
      failed: false,
      failureReason: null,
      currentContext: null,
      /** 商店/事件结算中：当前那套 ops（真实对象，只在 apply 调用期间非空） */
      currentOps: null,
      disposed: false,
    };
    runtime.setInterruptHandler(() => {
      if (clock() <= record.deadline) return false;
      record.interrupted = true;
      return true;
    });

    const fail = (message) => {
      if (record.failureReason === null) record.failureReason = message;
      record.failed = true;
    };

    // ---- 注册方法：VM 侧统一走 __collect，宿主按 listName 收进 record ----
    const collectFn = vm.newFunction('__collect', (listNameHandle, specHandle) => {
      const listName = String(vm.dump(listNameHandle));
      try {
        const data = vm.dump(specHandle);
        if (data === null || typeof data !== 'object' || typeof data.id !== 'string' || data.id === '') {
          throw new Error(`${listName} 条目需要非空 id`);
        }
        const funcProps = {};
        for (const prop of SANDBOX_FUNCTION_PROPS[listName] ?? []) {
          const nested = NESTED_PROP.exec(prop);
          if (nested === null) {
            const handle = vm.getProp(specHandle, prop);
            if (vm.typeof(handle) === 'function') {
              const index = record.functions.size;
              record.functions.set(index, handle);
              funcProps[prop] = index;
            } else if (handle !== vm.undefined && handle !== vm.null) {
              // vm.undefined / vm.null 是库内**共享静态句柄**，dispose 它等于把整个
              // context 的 undefined 杀掉，之后每次属性读取都报 "Lifetime not alive"
              handle.dispose();
            }
            continue;
          }
          // 一层数组内路径：choices[].apply —— 逐项取，函数按 "list#i.prop" 记
          const [, listKey, itemProp] = nested;
          const listHandle = vm.getProp(specHandle, listKey);
          const length = vm.getLength(listHandle) ?? 0;
          for (let i = 0; i < length; i += 1) {
            const itemHandle = vm.getProp(listHandle, i);
            const handle = vm.getProp(itemHandle, itemProp);
            if (vm.typeof(handle) === 'function') {
              const index = record.functions.size;
              record.functions.set(index, handle);
              funcProps[`${listKey}#${i}.${itemProp}`] = index;
            } else if (handle !== vm.undefined && handle !== vm.null) {
              handle.dispose();
            }
            // 数组项里的**其他**函数型字段同样不能静默丢（choices[].onPick 这种）
            const itemNames = vm.getOwnPropertyNames(itemHandle).unwrap();
            for (const nameHandle of itemNames) {
              const itemName = String(vm.dump(nameHandle));
              if (itemName === itemProp) continue;
              const value = vm.getProp(itemHandle, itemName);
              const isFunction = vm.typeof(value) === 'function';
              if (value !== vm.undefined && value !== vm.null) value.dispose();
              if (isFunction) {
                itemNames.dispose();
                throw new Error(`${listName}.${listKey}[${i}].${itemName} 是函数，沙箱不接收`);
              }
            }
            itemNames.dispose();
            if (itemHandle !== vm.undefined && itemHandle !== vm.null) itemHandle.dispose();
          }
          if (listHandle !== vm.undefined && listHandle !== vm.null) listHandle.dispose();
        }
        // 白名单外的函数型字段：静默丢弃会让人查一整天，直接拒
        const names = vm.getOwnPropertyNames(specHandle).unwrap();
        for (const nameHandle of names) {
          const name = String(vm.dump(nameHandle));
          if ((SANDBOX_FUNCTION_PROPS[listName] ?? []).includes(name)) continue;
          const value = vm.getProp(specHandle, name);
          const isFunction = vm.typeof(value) === 'function';
          if (value !== vm.undefined && value !== vm.null) value.dispose();
          if (isFunction) throw new Error(`${listName}.${name} 是函数，沙箱不接收`);
        }
        names.dispose();
        record.registrations.push({ list: listName, data, funcProps });
      } catch (error) {
        fail(`${pack.id}: ${error?.message ?? String(error)}`);
      }
      return vm.undefined;
    });
    vm.setProp(vm.global, '__collectHost', collectFn);
    collectFn.dispose();

    const collectRef = vm.getProp(vm.global, '__collectHost');
    const api = vm.newObject();
    for (const [name, listName] of Object.entries(METHOD_TARGETS)) {
      const fn =
        name === 'begin'
          ? vm.newFunction('begin', (h) => {
              const spec = vm.dump(h) ?? {};
              if (typeof spec.id !== 'string' || spec.id === '') {
                fail(`${pack.id}: fate.begin 需要非空 id`);
                return vm.undefined;
              }
              record.manifest = spec;
              return vm.undefined;
            })
          : name === 'finish'
            ? vm.newFunction('finish', () => vm.undefined)
            : name === 'onBattleStart'
              ? vm.newFunction('onBattleStart', (fnHandle) => {
                  if (vm.typeof(fnHandle) !== 'function') {
                    fail(`${pack.id}: fate.onBattleStart 需要一个函数`);
                    return vm.undefined;
                  }
                  const index = record.functions.size;
                  record.functions.set(index, fnHandle.dup());
                  record.hooks.push({ kind: 'battleStart', index });
                  return vm.undefined;
                })
            : vm.newFunction(name, (h) => {
                const listHandle = vm.newString(listName);
                const result = vm.callFunction(collectRef, vm.undefined, listHandle, h);
                listHandle.dispose();
                result.value?.dispose?.();
                result.error?.dispose();
                return vm.undefined;
              });
      vm.setProp(api, name, fn);
      fn.dispose();
    }

    for (const [name, value] of Object.entries(CONST_VALUES)) {
      const handle = vm.unwrapResult(vm.evalCode(`JSON.parse(${JSON.stringify(JSON.stringify(value))})`));
      vm.setProp(api, name, handle);
      handle.dispose();
    }
    vm.setProp(vm.global, '__fate', api);
    api.dispose();

    // ---- ctx 的宿主侧出口 ----
    const op = vm.newFunction('__op', (kindHandle, argHandle) => {
      const kind = String(vm.dump(kindHandle));
      const raw = JSON.parse(String(vm.dump(argHandle) ?? 'null'));
      if (record.currentContext === null) {
        throw new Error(`${pack.id}: 在技能执行之外调用了 ctx.${kind}()`);
      }
      const result = invokeContextOp(record.currentContext, kind, raw);
      if (typeof result === 'string') return vm.newString(result);
      if (typeof result === 'number') return vm.newNumber(result);
      return vm.undefined;
    });
    vm.setProp(vm.global, '__op', op);
    op.dispose();
    const opNum = vm.newFunction('__opNum', (kindHandle, argHandle) => {
      const kind = String(vm.dump(kindHandle));
      const raw = JSON.parse(String(vm.dump(argHandle) ?? 'null'));
      if (record.currentContext === null) return vm.newNumber(0);
      return vm.newNumber(Number(invokeContextOp(record.currentContext, kind, raw)) || 0);
    });
    vm.setProp(vm.global, '__opNum', opNum);
    opNum.dispose();
    // ops 通道：返回**任意 JSON**（spendShards 要返回布尔、shards 要返回数字）
    const opVal = vm.newFunction('__opVal', (kindHandle, argHandle) => {
      const kind = String(vm.dump(kindHandle));
      const raw = JSON.parse(String(vm.dump(argHandle) ?? 'null'));
      const ops = record.currentOps;
      if (ops === null || ops === undefined) {
        throw new Error(`${pack.id}: 在商店/事件结算之外调用了 ops.${kind}()`);
      }
      const result = invokeStateOp(ops, kind, raw);
      if (typeof result === 'string') return vm.newString(result);
      if (typeof result === 'number') return vm.newNumber(result);
      if (typeof result === 'boolean') return vm.newNumber(result ? 1 : 0);
      return vm.undefined;
    });
    vm.setProp(vm.global, '__opVal', opVal);
    opVal.dispose();

    // 预lude 最后一个表达式是函数值，句柄不 dispose 会让 runtime 释放时撞上
    // gc_obj_list 断言 —— 那是 wasm 级 abort，整个页面一起没
    vm.unwrapResult(vm.evalCode(PRELUDE, 'fate-prelude.js')).dispose();
    record.ctxHandle = vm.getProp(vm.global, '__ctx');
    record.applyFn = vm.unwrapResult(vm.evalCode('(fn, ctx, argsJson) => globalThis.__applyFn(fn, ctx, argsJson)', 'apply.js'));
    record.hookFn = vm.unwrapResult(vm.evalCode('(fn, ctx, stateJson) => globalThis.__applyHook(fn, ctx, stateJson)', 'hook.js'));
    record.opFn = vm.unwrapResult(vm.evalCode('(fn, stateJson, ops) => globalThis.__applyOp(fn, stateJson, ops)', 'op.js'));
    record.opsHandle = vm.getProp(vm.global, '__ops');
    record.genFn = vm.unwrapResult(vm.evalCode('(fn, argJson) => globalThis.__applyGen(fn, argJson)', 'gen.js'));
    // ---- 模块加载器：'fate' → 门面；其余 → 包内文件（只认包内路径） ----
    const sources = new Map([['fate', fateModuleSource()]]);
    for (const [path, text] of pack.files) sources.set(path, text);
    // 加载器里的错误**不能靠 throw 传出去**：QuickJS 把动态 import 的实例化
    // 推到 job 队列里，宿主抛出的异常会被 executePendingJobs 吞掉（实测：
    // 包 import 包外模块时 record.failed 仍然是 false）。所以记下第一个错，
    // 等 pump 结束后统一判定。
    let loaderError = null;
    runtime.setModuleLoader((name) => {
      const clean = name.replace(/^\.\//, '');
      const hit = sources.get(clean) ?? sources.get(`./${clean}`);
      if (hit === undefined) {
        loaderError ??= `包 ${pack.id} 引用了包外模块：${name}（只允许 'fate' 与包内相对路径）`;
        return 'export {};';
      }
      return hit;
    });

    record.deadline = clock() + loadBudgetMs;
    record.interrupted = false;
    try {
      // 注意用**脚本模式**求值：{type:'module'} 下 evalCode 返回的是 undefined
      // 而不是 import() 的 promise，pump 会立刻把它当成“已成功”，
      // 包里的顶层 throw 就这么静默没了（实测踩过）。
      const imported = vm.evalCode(`import(${JSON.stringify(pack.entry)})`, 'sandbox-entry.js');
      if (imported.error) {
        fail(`包 ${pack.id} 编译失败：${vm.dump(imported.error)?.message ?? 'unknown'}`);
        imported.error.dispose();
      } else {
        const errorText = pumpUntilSettled(vm, runtime, imported.value);
        imported.value.dispose();
        if (errorText !== null) fail(`包 ${pack.id} 求值失败：${errorText}`);
      }
    } catch (error) {
      fail(`包 ${pack.id} 求值失败：${error?.message ?? String(error)}`);
    }
    // 模块解析错误会先以“Could not find export …”的形式报出来，那句话对作者
    // 没用；真正的原因是“他 import 了包外的东西”，所以这里用更准的那句顶掉它。
    if (loaderError !== null) {
      record.failed = true;
      record.failureReason = loaderError;
    }
    if (record.interrupted) fail(`包 ${pack.id} 加载超过 ${loadBudgetMs}ms 被打断`);
    record.deadline = Number.POSITIVE_INFINITY;
    record.collectRef = collectRef;

    installed.set(pack.id, record);
    return record;
  }

  /** 标记失效并向外报一次（重复失败不刷屏）。 */
  function markDead(record, reason) {
    if (record.failed) return;
    record.failed = true;
    record.failureReason = reason;
    try {
      onPackFailure(record.pack.id, reason);
    } catch {
      /* 上报通道自身是坏的，不能因此再影响游戏 */
    }
  }

  /**
   * 把 VM 函数包成宿主可调的 JS 函数。
   * 两种签名按内容类型选：技能是 (ctx, self, targets)，
   * 商店/事件是 (state, ops) —— 后者拿不到 ctx，因为它不在战斗里。
   */
  function bindFunction(record, index, listName = 'skills') {
    const { vm } = record;
    const isOpsShape = listName === 'shopItems' || listName === 'events';
    const isGenShape = listName === 'mapGenerators';
    return (...args) => {
      if (record.disposed) return undefined;
      // 失效的包一律空转。**不把异常抛进战斗**：一个第三方包把整局弄崩，
      // 惩罚会落在玩家头上而不是作者头上。第一次失败已经经 onPackFailure
      // 报给 UI，所以这不是静默失败。
      if (record.failed) return undefined;
      const handle = record.functions.get(index);
      if (handle === undefined) return undefined;
      // 两条形状分开接线：技能递 ctx，商店/事件递 ops
      if (isOpsShape) {
        record.currentOps = args[1];
      } else if (!isGenShape) {
        record.currentContext = args[0];
      }
      const argsJson = vm.newString(
        isOpsShape
          ? JSON.stringify(snapshotEntity(args[0]))
          : isGenShape
            ? JSON.stringify(args[0] ?? {})
            : JSON.stringify([snapshotEntity(args[1]), (args[2] ?? []).map(snapshotEntity)]),
      );
      // 真跑过包代码的 runtime 一律不 free（对象表是否干净无从判断），改 park
      record.dirty = true;
      enter(record);
      try {
        // 两条桥的参数顺序故意不同（技能先递 ctx、ops 先递 state），所以调用处也要分开：
        // 统一成一种形状就会把 ctx 当 JSON 传进去，现场只会看到"技能安静地没效果"
        let result;
        if (isOpsShape) {
          result = vm.callFunction(record.opFn, vm.undefined, handle, argsJson, record.opsHandle);
        } else if (isGenShape) {
          // 生成器只拿一个参数对象：argsJson 里存的就是 { seed, floorNumber }
          result = vm.callFunction(record.genFn, vm.undefined, handle, argsJson);
        } else {
          result = vm.callFunction(record.applyFn, vm.undefined, handle, record.ctxHandle, argsJson);
        }
        if (result.error) {
          const dumped = vm.dump(result.error);
          result.error.dispose();
          const message = typeof dumped === 'object' ? (dumped?.message ?? JSON.stringify(dumped)) : String(dumped);
          // 中断在 QuickJS 里是以异常形式冒出来的（message 就是 "interrupted"），
          // 不认这个标记的话死循环会被报成"技能抛错"，排查的人会往逻辑里找半天
          const wasInterrupt = record.interrupted || /interrupt/i.test(message);
          markDead(
            record,
            wasInterrupt
              ? `执行超过 ${budgetMs}ms 被打断（疑似死循环）`
              : `${isOpsShape ? 'apply' : '技能'}执行抛错：${message}`,
          );
          return undefined;
        }
        const value = vm.dump(result.value);
        result.value.dispose();
        return value;
      } catch (error) {
        // 被打断过（死循环/超内存/栈溢出）就摘掉这个包：VM 里已是一片废墟，
        // 继续跑会把脏状态写进存档
        markDead(
          record,
          record.interrupted
            ? `执行超过 ${budgetMs}ms 被打断（疑似死循环）`
            : `执行失败：${error?.message ?? String(error)}`,
        );
        return undefined;
      } finally {
        argsJson.dispose();
        exit(record);
        record.currentContext = null;
        record.currentOps = null;
      }
    };
  }

  /** 钩子跨界调用：签名 (ctx, state)。state 传快照 —— 钩子该清的是自己的记忆，不是战场 */
  function bindHook(record, index) {
    const { vm } = record;
    return (context, state) => {
      if (record.disposed || record.failed) return undefined;
      const handle = record.functions.get(index);
      if (handle === undefined) return undefined;
      record.currentContext = context;
      const stateJson = vm.newString(JSON.stringify(snapshotEntity(state)));
      record.dirty = true;
      enter(record);
      try {
        const result = vm.callFunction(record.hookFn, vm.undefined, handle, record.ctxHandle, stateJson);
        if (result.error) {
          const dumped = vm.dump(result.error);
          result.error.dispose();
          const message = typeof dumped === 'object' ? (dumped?.message ?? JSON.stringify(dumped)) : String(dumped);
          markDead(record, `onBattleStart 抛错：${message}`);
        } else {
          result.value.dispose();
        }
      } catch (error) {
        markDead(
          record,
          record.interrupted ? 'onBattleStart 超时被打断' : `onBattleStart 失败：${String(error?.message ?? error)}`,
        );
      } finally {
        stateJson.dispose();
        exit(record);
        record.currentContext = null;
      }
      return undefined;
    };
  }

  /** 取某个包登记的钩子（已绑成宿主可调用的函数）。 */
  function drainHooks(record) {
    const out = { battleStart: [] };
    for (const hook of record.hooks) {
      if (out[hook.kind] !== undefined) out[hook.kind].push(bindHook(record, hook.index));
    }
    return out;
  }

  /**
   * 装包收尾：把注册数据里的函数索引换成真 JS 闭包，返回可以直接喂给
   * `mergeIntoPool` 的结果形状 `{ skills: [], buffs: [], ... }`。
   */
  function drainRegistrations(record) {
    // 形状从 SANDBOX_SUPPORTED_KINDS 推导，不手写清单 —— 手写那次加 shopItems/events
    // 就直接漏了（out[list] undefined，注册静默丢掉）
    const out = Object.fromEntries(SANDBOX_SUPPORTED_KINDS.map((kind) => [kind, []]));
    for (const reg of record.registrations) {
      const spec = { ...reg.data };
      for (const [prop, index] of Object.entries(reg.funcProps)) {
        const nested = /^(\w+)#(\d+)\.(\w+)$/.exec(prop);
        if (nested === null) {
          spec[prop] = bindFunction(record, index, reg.list);
        } else {
          const [, listKey, position, itemProp] = nested;
          const item = spec[listKey]?.[Number(position)];
          if (item !== undefined && item !== null) {
            item[itemProp] = bindFunction(record, index, reg.list);
          }
        }
      }
      spec.__sourcePack = record.pack.id;
      out[reg.list].push(spec);
    }
    return out;
  }

  return {
    installPack,
    unloadPack,
    drainRegistrations,
    drainHooks,
    getRecord: (id) => installed.get(id) ?? null,
    list: () =>
      [...installed.values()].map((r) => ({
        id: r.pack.id,
        version: r.pack.version,
        failed: r.failed,
        reason: r.failureReason,
        counts: r.registrations.reduce((acc, reg) => {
          acc[reg.list] = (acc[reg.list] ?? 0) + 1;
          return acc;
        }, {}),
      })),
    /** 被 park 的 runtime 数：> 0 说明有包出过事（UI 可提示“重启后彻底清理”） */
    quarantinedCount: () => quarantine.length,
    dispose() {
      disposed = true;
      for (const record of installed.values()) disposeRecord(record);
      installed.clear();
    },
  };
}
