/**
 * 沙箱包 → 内容池 的装配层。
 *
 * 与官方模组的差别只在"从哪拿内容"：拿回来之后走的是**同一套** normalize /
 * 引用校验 / 合并代码（`../loader.js`），所以沙箱内容不可能绕过形状校验 ——
 * 这是设计上最重要的一条：沙箱管的是"代码能不能为所欲为"，
 * 而"内容合不合法"仍由官方那道关管。
 *
 * 失败隔离的做法：先合并进**候选池**（各 Map 浅拷贝，冻结的 spec 值可共享），
 * 校验通过才提交到真池。不通过就丢弃候选、卸载该包、继续装下一个 ——
 * 官方模组那边"任一模组抛错整体失败"的规矩在这里**故意不沿用**，
 * 因为第三方包不该有让游戏开不了机的权力。
 */

import { createSandboxHost } from './host.js';
import { mergeIntoPool, validatePoolReferences, createContentPool } from '../loader.js';
import { createPack, hashPack } from './pack.js';
import { SANDBOX_SUPPORTED_KINDS } from './host.js';
import { validateMapGenerator } from './generatorCheck.js';

function clonePool(pool) {
  const copy = createContentPool();
  for (const kind of Object.keys(copy)) {
    copy[kind] = new Map(pool[kind]);
  }
  return copy;
}

function indexSources(pool) {
  const map = new Map();
  for (const kind of Object.keys(pool)) {
    for (const [id, spec] of pool[kind]) {
      map.set(`${kind}:${id}`, spec?.source ?? 'unknown');
    }
  }
  return map;
}

/**
 * @param {{
 *   entries: Array<{pack: ReturnType<createPack>, sha256?: string}>,
 *   pool: object,
 *   clock: () => number,
 *   host?: ReturnType<Awaited<ReturnType<typeof createSandboxHost>>>,
 *   engine?: { registerHook: (phase: string, fn: Function) => unknown },
 * }} options
 *   engine 传进来是为了把包的 fate.onBattleStart 接到开战钩子上 ——
 *   不传也能跑（钩子被收集但不会被调用），测试里常常不需要引擎。
 * @returns {Promise<{host, ok: Array, failed: Array, overrides: Array, loaded: Array}>}
 */
export async function installSandboxPacks({ entries, pool, clock, host: existingHost, engine } = {}) {
  const host = existingHost ?? (await createSandboxHost({ clock }));
  const ok = [];
  const failed = [];
  const overrides = [];
  const loaded = [];

  for (const entry of entries ?? []) {
    const pack = entry?.pack;
    const label = pack?.id ?? '(未知包)';
    let record = null;
    try {
      record = await host.installPack(pack);
      if (record.failed) {
        failed.push({ id: label, version: pack?.version, reason: record.failureReason });
        host.unloadPack(label);
        continue;
      }
      const specs = host.drainRegistrations(record);

      // 合并进候选池再验引用：这个包造成的悬空不该牵连其它包与官方内容
      const candidate = clonePool(pool);
      mergeIntoPool(candidate, specs, pack.id);
      validatePoolReferences(candidate);

      /**
       * 地图生成器要单独跑一遍准入：地图结构坏了玩家会卡在**已存档**的一局里，
       * 而包代码不过 lint 也不过测试 —— 装包这一刻是唯一的拦截点。
       * 校验含确定性与结构不变量，见 generatorCheck.js。
       */
      for (const generator of specs.mapGenerators ?? []) {
        validateMapGenerator(generator, { source: pack.id });
      }

      const before = indexSources(pool);
      mergeIntoPool(pool, specs, pack.id);
      // 计数从支持清单推导 —— 手写清单在开放 shopItem/event/mapGenerator 时
      // 就会静默漏掉三类（UI 显示"这包什么都没带"）
      const provided = Object.fromEntries(SANDBOX_SUPPORTED_KINDS.map((kind) => [kind, 0]));
      for (const kind of Object.keys(provided)) {
        for (const spec of specs[kind] ?? []) {
          provided[kind] += 1;
          const key = `${kind}:${spec.id}`;
          const previous = before.get(key);
          if (previous !== undefined && previous !== pack.id) {
            overrides.push({ id: spec.id, kind, was: previous, by: pack.id });
          }
        }
      }
      const hash = entry.sha256 ?? (await hashPack(pack));
      // 钩子按包注册顺序挂上（装包顺序本身是按 id 排过序的）：
      // 钩子顺续会影响状态，所以它必须是确定的，不能取决于 Map 迭代巧合
      if (engine !== null && engine !== undefined) {
        const hooks = host.drainHooks(record);
        for (const fn of hooks.battleStart) engine.registerHook('battleStart', fn);
      }
      ok.push({ id: pack.id, version: pack.version, hash, provided, manifest: record.manifest });
      loaded.push({ id: pack.id, version: pack.version, sha256: hash?.hex ?? null, algo: hash?.algo ?? null });
    } catch (error) {
      failed.push({ id: label, version: pack?.version, reason: error?.message ?? String(error) });
      if (record !== null) host.unloadPack(label);
    }
  }

  return { host, ok, failed, overrides, loaded };
}

export { createSandboxHost, createPack, hashPack };
export * from './pack.js';
