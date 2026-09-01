/**
 * 自动熔炼过滤器（P2 / P2b）。
 *
 * 一句话：把「背包满了才被迫折碎片」换成「按玩家定的规则，拾取瞬间就决定留不留」。
 *
 * ## 为什么这不破坏确定性（方案文档「待决 A 已撤销」的那条，落成代码理由）
 *
 * 1. **不碰随机数**：掉落早就由 `loot.js` 的 `${nodeId}:loot` 独立子流 roll 完了，
 *    过滤器看到的是一件**已经存在**的装备。本模块没有任何 `rng` 参数 ——
 *    以后谁想把过滤逻辑塞进 `rollEquipment` 里"顺手重 roll"，
 *    `equipment.test.js` 与 `lootfilter.test.js` 的指纹对拍会一起报红。
 * 2. **它与今天的手动分解同类，属于"玩家决策"**：本作从来不是"只看种子"——
 *    走哪条路线、商店买什么、穿哪件拆哪件都是决策。
 * 3. 它是第一个会改变一局结果的**设置**，所以存档与战绩各留一个 `filterHash`。
 *
 * ## 规则模型（P2b 对齐参考项目 Idle_Game_ui_zero/js/engine.js:64，并加了两类条件）
 *
 * 优先级 **逐槽 > 部位组 > 全局**；每层只覆盖"自己显式设过"的字段
 * （`minRarity: -1` / 空数组 / 空 map 都算"未设"，会往下继承而不是覆盖成零）——
 * 这条是 P2b 修的真 bug：旧模型里"槽只设词条"会把组的品质门槛静默清零。
 *
 * 单条规则的形状：
 *   { minRarity: -1..8,            // -1 = 不设品质门槛
 *     requiredAffixes: [id],       // 必须**同时**带这些词条（值 > 0）
 *     minAffixValues: {id: n},     // 每条词条独立的数值下限
 *     minScore: n,                 // 0 = 不设；评分下限（挂机游戏常见条件）
 *     meltAffixes: [id] }          // 带这些词条**就熔**：硬否决，排在最前
 */

import { AFFIXES, EQUIP_SLOTS, RARITIES } from './constants.js';
import { salvageValue, slotKind } from './equipment.js';
import { fnv1a } from './prng.js';

/** 部位组：与 `slotKind()` 同一套分类，不是第二份真相。 */
export const FILTER_GROUPS = Object.freeze(['weapon', 'armor', 'accessory']);

export const MAX_RARITY_INDEX = RARITIES.length - 1;

const AFFIX_IDS = Object.freeze(AFFIXES.map((affix) => affix.id));

/** 不设品质门槛的哨兵值（与参考项目同语义：`minRarity: -1`）。 */
export const NO_MIN_RARITY = -1;

const EMPTY_RULE = Object.freeze({
  minRarity: NO_MIN_RARITY,
  requiredAffixes: Object.freeze([]),
  minAffixValues: Object.freeze({}),
  minScore: 0,
  meltAffixes: Object.freeze([]),
});

/**
 * 预设。`off` 是**默认值**：现状行为不变 —— 自动熔炼是玩家主动开启的东西。
 * 预设只负责"填表"，改任何一个控件就变成 `custom`（派生值，不是存的字段）。
 */
export const LOOT_FILTER_PRESETS = Object.freeze([
  Object.freeze({
    id: 'off',
    name: '不自动熔炼',
    note: '掉落全部进背包（背包满了才折成碎片）—— 与老版本行为一致',
    filter: Object.freeze({}),
  }),
  Object.freeze({
    id: 'junk',
    name: '熔掉破损与普通',
    note: '等于把装备屏那个「分解破损与普通」按钮搬到拾取瞬间，不用回来点',
    filter: Object.freeze({ enabled: true, minRarity: 2 }),
  }),
  Object.freeze({
    id: 'epic_up',
    name: '只留史诗以上',
    note: '激进：前中期会很少见到新装备，但碎片收入暴涨（强化与商店的钱从这来）',
    filter: Object.freeze({ enabled: true, minRarity: 4 }),
  }),
  Object.freeze({
    id: 'crit_jewelry',
    name: '首饰要暴击',
    note: '全局留精良以上，但项链/戒指/遗物额外要求暴击 ≥0.5% —— 暴击流的典型规则',
    filter: Object.freeze({
      enabled: true,
      minRarity: 2,
      slots: Object.freeze({
        pendant: Object.freeze({ minRarity: 4, requiredAffixes: ['crit'], minAffixValues: { crit: 5 } }),
        ring: Object.freeze({ minRarity: 4, requiredAffixes: ['crit'], minAffixValues: { crit: 5 } }),
        trinket: Object.freeze({ minRarity: 4, requiredAffixes: ['crit'], minAffixValues: { crit: 5 } }),
      }),
    }),
  }),
]);

export function presetById(id) {
  return LOOT_FILTER_PRESETS.find((preset) => preset.id === id) ?? null;
}

/** 关闭状态的过滤器（新局的默认值）。 */
export function defaultLootFilter() {
  return {
    enabled: false,
    ...EMPTY_RULE,
    groups: {},
    slots: {},
    keepIfBetterThanEquipped: true,
  };
}

function clampInt(value, min, max, fallback) {
  const n = Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Math.min(max, Math.max(min, n));
}

/** 词条 id 列表：去重、丢弃不认识的 id（手改存档/旧版本字段都走这里）。 */
function affixList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((id) => AFFIX_IDS.includes(id)))];
}

/**
 * 洗一条规则。返回 `null` 表示"这一层什么都没设"（于是往下继承，不覆盖）。
 *
 * 兼容旧字段：`requireAffix` + `minAffixValue`（P2 单条版）自动迁到
 * `requiredAffixes` / `minAffixValues` —— 老档不改也能跑，但新格式是唯一的真相。
 */
function normalizeRule(raw) {
  if (raw === null || raw === undefined || typeof raw !== 'object') return null;

  const required = affixList(raw.requiredAffixes ?? (raw.requireAffix ? [raw.requireAffix] : []));
  const values = {};
  const rawValues = raw.minAffixValues ?? null;
  if (rawValues !== null && typeof rawValues === 'object') {
    for (const id of AFFIX_IDS) {
      const value = Number(rawValues[id]);
      if (Number.isFinite(value) && value > 0) values[id] = Math.trunc(value);
    }
  }
  // 旧单条字段：requireAffix 有值而 minAffixValues 里没它时，把 minAffixValue 搬进去
  if (raw.requireAffix && AFFIX_IDS.includes(raw.requireAffix) && values[raw.requireAffix] === undefined) {
    const legacy = Number(raw.minAffixValue);
    if (Number.isFinite(legacy) && legacy > 0) values[raw.requireAffix] = Math.trunc(legacy);
  }
  // 只勾了"必需词条"却没给下限的，下限不进 map（值 > 0 就是它的全部要求）
  for (const id of required) {
    if (values[id] !== undefined && values[id] <= 0) delete values[id];
  }

  const rule = {
    minRarity: clampInt(raw.minRarity, NO_MIN_RARITY, MAX_RARITY_INDEX, NO_MIN_RARITY),
    requiredAffixes: required,
    minAffixValues: values,
    minScore: clampInt(raw.minScore, 0, Number.MAX_SAFE_INTEGER, 0),
    meltAffixes: affixList(raw.meltAffixes),
  };
  const empty =
    rule.minRarity === NO_MIN_RARITY &&
    rule.requiredAffixes.length === 0 &&
    Object.keys(rule.minAffixValues).length === 0 &&
    rule.minScore === 0 &&
    rule.meltAffixes.length === 0;
  return empty ? null : rule;
}

/**
 * 把任意来源的对象洗成合法过滤器。
 * 读档、手改进档、模组写状态都走这里 —— 不信任输入，但也不报错：
 * 洗不动的字段按兜底值处理，保证"规则坏了"不会变成"游戏开不了"。
 */
export function normalizeLootFilter(raw) {
  const out = defaultLootFilter();
  if (raw === null || raw === undefined || typeof raw !== 'object') return out;

  out.enabled = raw.enabled === true;
  out.keepIfBetterThanEquipped = raw.keepIfBetterThanEquipped !== false;

  const { minRarity, requiredAffixes, minAffixValues, minScore, meltAffixes } =
    normalizeRule(raw) ?? EMPTY_RULE;
  out.minRarity = minRarity;
  out.requiredAffixes = requiredAffixes;
  out.minAffixValues = minAffixValues;
  out.minScore = minScore;
  out.meltAffixes = meltAffixes;

  out.groups = {};
  for (const group of FILTER_GROUPS) {
    const rule = normalizeRule(raw.groups?.[group]);
    if (rule !== null) out.groups[group] = rule;
  }
  out.slots = {};
  for (const slot of EQUIP_SLOTS) {
    const rule = normalizeRule(raw.slots?.[slot]);
    if (rule !== null) out.slots[slot] = rule;
  }
  return out;
}

/** 应用预设（整体替换，不是叠加 —— 叠加会留下上个预设的碎片）。 */
export function filterFromPreset(presetId) {
  const preset = presetById(presetId);
  if (preset === null) return null;
  return normalizeLootFilter({ ...defaultLootFilter(), ...preset.filter });
}

function ruleText(rule) {
  if (rule === null || rule === undefined) return '';
  return [
    rule.minRarity,
    rule.requiredAffixes.join(','),
    AFFIX_IDS.map((id) => `${id}=${rule.minAffixValues[id] ?? ''}`).join(','),
    rule.minScore,
    rule.meltAffixes.join(','),
  ].join(':');
}

/** 稳定序列化（键序固定）—— `presetKeyOf` 与 `filterHashOf` 都靠它，不各写一份。 */
function canonicalFilter(filter) {
  const n = normalizeLootFilter(filter);
  const parts = [
    `e=${n.enabled ? 1 : 0}`,
    `b=${n.keepIfBetterThanEquipped ? 1 : 0}`,
    `g=${ruleText(n)}`,
  ];
  for (const group of FILTER_GROUPS) parts.push(`${group}:${ruleText(n.groups[group] ?? null)}`);
  for (const slot of EQUIP_SLOTS) parts.push(`${slot}:${ruleText(n.slots[slot] ?? null)}`);
  return parts.join('|');
}

/**
 * 当前值是"恰好等于某个预设"还是"玩家自己改过"（`custom`）。
 * 派生值，不是存的字段 —— 存名字就会与内容漂走（改了一个控件忘了改名）。
 */
export function presetKeyOf(filter) {
  const canonical = canonicalFilter(filter);
  for (const preset of LOOT_FILTER_PRESETS) {
    if (canonicalFilter({ ...defaultLootFilter(), ...preset.filter }) === canonical) return preset.id;
  }
  return 'custom';
}

/** 合并：只覆盖"显式设过"的字段，其余往下继承（P2b 修的就是这条）。 */
function mergeRule(base, override) {
  if (override === null || override === undefined) return { ...base };
  return {
    minRarity: override.minRarity !== NO_MIN_RARITY ? override.minRarity : base.minRarity,
    requiredAffixes:
      override.requiredAffixes.length > 0 ? override.requiredAffixes : base.requiredAffixes,
    minAffixValues:
      Object.keys(override.minAffixValues).length > 0
        ? override.minAffixValues
        : base.minAffixValues,
    minScore: override.minScore > 0 ? override.minScore : base.minScore,
    meltAffixes: override.meltAffixes.length > 0 ? override.meltAffixes : base.meltAffixes,
  };
}

/** 取生效规则：逐槽 > 部位组 > 全局。 */
export function ruleForGear(gear, filter) {
  return ruleForGearNormalized(gear, normalizeLootFilter(filter));
}

function ruleForGearNormalized(gear, normalized) {
  let rule = {
    minRarity: normalized.minRarity,
    requiredAffixes: normalized.requiredAffixes,
    minAffixValues: normalized.minAffixValues,
    minScore: normalized.minScore,
    meltAffixes: normalized.meltAffixes,
  };
  let from = '全局';
  const group = slotKind(gear.slot);
  if (normalized.groups[group] !== undefined) {
    rule = mergeRule(rule, normalized.groups[group]);
    from = `组 ${group}`;
  }
  if (normalized.slots[gear.slot] !== undefined) {
    rule = mergeRule(rule, normalized.slots[gear.slot]);
    from = `槽 ${gear.slot}`;
  }
  return { ...rule, from };
}

/**
 * 这一件留不留。
 *
 * 顺序是设计决定，不是随手排的：
 *   1. `meltAffixes` —— 玩家说"带这条就滚"，这是**硬否决**，比"分数高就留"更大
 *   2. `keepIfBetterThanEquipped` —— 过渡装保护，排在品质阈值之前
 *      （纯阈值会熔掉"卓越但比身上强"的件，那是玩家会骂的地方）
 *   3. 品质 → 必需词条 → 词条下限 → 评分下限
 *
 * @param {object} gear
 * @param {{filter: object, equipment?: object}} options
 *   equipment 传进来才能判断"比身上好吗"；不传则该条自动跳过（不假装生效）
 */
export function gearVerdict(gear, { filter, equipment = null } = {}) {
  const normalized = normalizeLootFilter(filter);
  if (!normalized.enabled) return { keep: true, reason: 'off', rule: ruleForGearNormalized(gear, normalized) };

  const meltHit = normalized.meltAffixes.length
    ? normalized.meltAffixes
    : ruleForGearNormalized(gear, normalized).meltAffixes;
  for (const id of meltHit ?? []) {
    if (Number(gear.stats?.[id]) > 0) return { keep: false, reason: 'meltAffix', rule: { meltAffixes: meltHit } };
  }

  const rule = ruleForGearNormalized(gear, normalized);

  if (normalized.keepIfBetterThanEquipped && equipment !== null && equipment !== undefined) {
    const current = equipment[gear.slot];
    if (current !== null && current !== undefined && gear.score > current.score) {
      return { keep: true, reason: 'betterThanEquipped', rule };
    }
  }
  if (rule.minRarity !== NO_MIN_RARITY && gear.rarityIndex < rule.minRarity) {
    return { keep: false, reason: 'belowMinRarity', rule };
  }
  for (const id of rule.requiredAffixes) {
    if (!(Number(gear.stats?.[id]) > 0)) return { keep: false, reason: 'missingAffix', rule };
  }
  for (const [id, min] of Object.entries(rule.minAffixValues)) {
    if (Number(gear.stats?.[id]) < min) return { keep: false, reason: 'affixTooLow', rule };
  }
  if (rule.minScore > 0 && Number(gear.score) < rule.minScore) {
    return { keep: false, reason: 'belowMinScore', rule };
  }
  return { keep: true, reason: 'pass', rule };
}

/** 品质下标 → 名字（摘要要说人话，不能说"≥4"）。 */
const rarityName = (index) => RARITIES[Math.min(MAX_RARITY_INDEX, Math.max(0, index))]?.name ?? '?';
const affixName = (id) => AFFIXES.find((a) => a.id === id)?.name ?? id;

/** 一条规则的人话描述。 */
export function rulePhrase(rule) {
  if (rule === null || rule === undefined) return '不设限';
  const bits = [];
  if (rule.meltAffixes?.length) bits.push(`带${rule.meltAffixes.map(affixName).join('/')}则熔`);
  if (rule.minRarity !== NO_MIN_RARITY && rule.minRarity > 0) bits.push(`≥${rarityName(rule.minRarity)}`);
  if (rule.requiredAffixes?.length) bits.push(`须带${rule.requiredAffixes.map(affixName).join('/')}`);
  for (const [id, min] of Object.entries(rule.minAffixValues ?? {})) {
    bits.push(rule.requiredAffixes?.includes(id) ? `${affixName(id)}≥${min}` : `${affixName(id)}≥${min}`);
  }
  if (rule.minScore > 0) bits.push(`评分≥${rule.minScore}`);
  return bits.length === 0 ? '不设限' : bits.join('、');
}

const GROUP_LABELS = Object.freeze({ weapon: '武器', armor: '防具', accessory: '首饰' });

/** 一行话说明当前规则（日志、面板、战绩共用同一句措辞，不各写一份）。 */
export function filterSummary(filter) {
  const n = normalizeLootFilter(filter);
  if (!n.enabled) return '不自动熔炼';
  const parts = [`全局 ${rulePhrase(n)}`];
  for (const group of FILTER_GROUPS) {
    if (n.groups[group] !== undefined) parts.push(`${GROUP_LABELS[group]} ${rulePhrase(n.groups[group])}`);
  }
  for (const slot of EQUIP_SLOTS) {
    if (n.slots[slot] !== undefined) parts.push(`${slot} ${rulePhrase(n.slots[slot])}`);
  }
  if (n.keepIfBetterThanEquipped) parts.push('比身上好的必留');
  return parts.join(' · ');
}

/**
 * 规则指纹（8 位十六进制）。存档、战绩、面板显示都用它。
 * 用 fnv1a 而不是 sha256：这不是安全凭据，只是"同一条规则的两人能认出彼此"。
 */
export function filterHashOf(filter) {
  return fnv1a(canonicalFilter(filter)).toString(16).padStart(8, '0');
}

/**
 * 只读试算：这批装备按当前规则会留下几件、熔掉几件、回收多少碎片。
 * 纯函数：不写状态、不消费随机数。
 */
export function dryRunFilter(filter, { inventory = [], equipment = null } = {}) {
  const kept = [];
  const melted = [];
  let shards = 0;
  for (const gear of inventory) {
    const verdict = gearVerdict(gear, { filter, equipment });
    if (verdict.keep) kept.push(gear);
    else {
      const gain = salvageValue(gear);
      shards += gain;
      melted.push({ gear, shards: gain, reason: verdict.reason });
    }
  }
  return { kept, melted, shards };
}

/** 清空全部规则（回到"不自动熔炼"）。预设按钮里那个 reset 用它。 */
export function clearedFilter() {
  return defaultLootFilter();
}
