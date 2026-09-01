/**
 * 自动熔炼过滤器（P2）。
 *
 * 一句话：把「背包满了才被迫折碎片」换成「按玩家定的规则，拾取瞬间就决定留不留」。
 *
 * ## 为什么这不破坏确定性（方案文档「待决 A 已撤销」的那条，这里落成代码理由）
 *
 * 1. **不碰随机数**：掉落早就由 `loot.js` 的 `${nodeId}:loot` 独立子流 roll 完了，
 *    过滤器看到的是一件**已经存在**的装备。本模块没有任何 `rng` 参数 ——
 *    以后谁想把过滤逻辑塞进 `rollEquipment` 里"顺手重roll"，`equipment.test.js`
 *    与这里的 fingerprint 对拍会一起报红。
 * 2. **它与今天的手动分解同类，属于"玩家决策"**：本作从来不是"只看种子"——
 *    走哪条路线、商店买什么、穿哪件拆哪件都是决策，而游戏不录操作日志。
 *    「分享种子」的语义一直是「同种子 + 同玩法决策」。
 * 3. 唯一新事实：它是第一个会改变一局结果的**设置**。所以存档里顺手记一个
 *    `filterHash`（见 `filterSummary` / `filterHashOf`），两人对战绩对不上时有个解释。
 *
 * ## 规则模型
 *
 * 优先级 **逐槽覆盖 > 部位组 > 全局**（与参考项目 `shouldKeep()` 的次序一致）：
 *
 *   { enabled, minRarity, requireAffix, minAffixValue,
 *     groups: { weapon?, armor?, accessory? },   // 组 = slotKind() 的三类
 *     slots:  { ring?, pendant?, ... },          // 结构预留：UI 暂只做组
 *     keepIfBetterThanEquipped }
 *
 * 为什么以「组」为主：一件装备的数值形状由 `slotKind(slot)` 决定（武器只给攻击、
 * 防具给防御+生命、首饰双属性），所以同组内不同槽**在数值上是同一族东西**，
 * 逐槽阈值能调出来的差别只有"我愿不愿意为这个部位多留一件"。
 * 但结构上留了逐槽口子：将来开 UI 不用改存档格式。
 */

import { AFFIXES, EQUIP_SLOTS, RARITIES } from './constants.js';
import { salvageValue, slotKind } from './equipment.js';
import { fnv1a } from './prng.js';

/** 部位组：与 `slotKind()` 同一套分类，不是第二份真相。 */
export const FILTER_GROUPS = Object.freeze(['weapon', 'armor', 'accessory']);

export const MAX_RARITY_INDEX = RARITIES.length - 1;

const AFFIX_IDS = Object.freeze(AFFIXES.map((affix) => affix.id));

/** 单条规则的字段（组/槽/全局共用同一个形状）。 */
const RULE_DEFAULTS = Object.freeze({
  minRarity: 0,
  requireAffix: null,
  minAffixValue: 0,
});

/**
 * 预设。注意 `off` 是**默认值**：现状行为不变 —— 自动熔炼是玩家主动开启的东西，
 * 不是新版本的既成事实。
 *
 * 预设只负责"填表"，填完之后玩家改任何一个控件就变成 `custom`
 * （所以这里不给 `custom` 条目：它不是一个可选项，是一个状态）。
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
      groups: Object.freeze({
        accessory: Object.freeze({ minRarity: 4, requireAffix: 'crit', minAffixValue: 5 }),
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
    ...RULE_DEFAULTS,
    groups: {},
    slots: {},
    keepIfBetterThanEquipped: true,
  };
}

function clampInt(value, min, max, fallback) {
  const n = Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Math.min(max, Math.max(min, n));
}

/** 规范化一条规则（undefined 表示"这一层不设规则"）。 */
function normalizeRule(raw) {
  if (raw === null || raw === undefined || typeof raw !== 'object') return null;
  const rule = {
    minRarity: clampInt(raw.minRarity, 0, MAX_RARITY_INDEX, RULE_DEFAULTS.minRarity),
    requireAffix: AFFIX_IDS.includes(raw.requireAffix) ? raw.requireAffix : null,
    minAffixValue: clampInt(raw.minAffixValue, 0, 100_000, RULE_DEFAULTS.minAffixValue),
  };
  if (!AFFIX_IDS.includes(raw.requireAffix)) rule.minAffixValue = 0;
  return rule;
}

/** 这条规则是否"什么都不要求"（用来判断组是否算存在，以及摘要怎么写）。 */
function isEmptyRule(rule) {
  return (
    rule !== null && rule.minRarity === 0 && rule.requireAffix === null && rule.minAffixValue === 0
  );
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
  const global = normalizeRule(raw) ?? { ...RULE_DEFAULTS };
  out.minRarity = global.minRarity;
  out.requireAffix = global.requireAffix;
  out.minAffixValue = global.minAffixValue;

  out.groups = {};
  for (const group of FILTER_GROUPS) {
    const rule = normalizeRule(raw.groups?.[group]);
    if (rule !== null && !isEmptyRule(rule)) out.groups[group] = rule;
  }

  out.slots = {};
  for (const slot of EQUIP_SLOTS) {
    const rule = normalizeRule(raw.slots?.[slot]);
    if (rule !== null && !isEmptyRule(rule)) out.slots[slot] = rule;
  }

  return out;
}

/** 应用预设（返回全新的过滤器）。 */
export function filterFromPreset(presetId) {
  const preset = presetById(presetId);
  if (preset === null) return null;
  // 先铺默认再叠预设：预设只写它关心的字段（`junk` 只改 minRarity），
  // 不写的那些得从 defaults 来，不能靠 `undefined` 穿透到 normalizeRule。
  return normalizeLootFilter({ ...defaultLootFilter(), ...preset.filter });
}

/**
 * 当前值是"恰好等于某个预设"还是"玩家自己改过"（`custom`）。
 *
 * 注意它是**派生**的，不是存的字段：存一个 `preset` 名字就会与字段漂走
 * （改了一个控件忘了改名字 —— 那是"看着有其实没有"的老毛病）。
 */
export function presetKeyOf(filter) {
  const canonical = canonicalFilter(filter);
  for (const preset of LOOT_FILTER_PRESETS) {
    if (canonicalFilter({ ...defaultLootFilter(), ...preset.filter }) === canonical) return preset.id;
  }
  return 'custom';
}

/** 稳定序列化（键序固定）—— `presetKeyOf` 与 `filterHashOf` 都靠它，不能各写一份。 */
function canonicalFilter(filter) {
  const normalized = normalizeLootFilter(filter);
  const ruleText = (rule) =>
    rule === undefined || rule === null
      ? ''
      : `${rule.minRarity}/${rule.requireAffix ?? '-'}/${rule.minAffixValue}`;
  const parts = [
    `e=${normalized.enabled ? 1 : 0}`,
    `b=${normalized.keepIfBetterThanEquipped ? 1 : 0}`,
    `g=${ruleText(normalized)}`,
  ];
  for (const group of FILTER_GROUPS) parts.push(`${group}:${ruleText(normalized.groups[group])}`);
  for (const slot of EQUIP_SLOTS) parts.push(`${slot}:${ruleText(normalized.slots[slot])}`);
  return parts.join('|');
}

/**
 * 取生效规则：逐槽 > 部位组 > 全局。
 * @returns {{minRarity:number, requireAffix:string|null, minAffixValue:number, from:string}}
 */
export function ruleForGear(gear, filter) {
  return ruleForGearNormalized(gear, normalizeLootFilter(filter));
}

/** 已洗过的表才能走这条（gearVerdict 内部用，避开每件装备重洗一遍表）。 */
function ruleForGearNormalized(gear, normalized) {
  const from = { key: 'global', label: '全局' };
  let rule = {
    minRarity: normalized.minRarity,
    requireAffix: normalized.requireAffix,
    minAffixValue: normalized.minAffixValue,
  };

  const group = slotKind(gear.slot);
  if (normalized.groups[group] !== undefined) {
    rule = { ...rule, ...normalized.groups[group] };
    from.key = `group:${group}`;
    from.label = `部位组 ${group}`;
  }
  if (normalized.slots[gear.slot] !== undefined) {
    rule = { ...rule, ...normalized.slots[gear.slot] };
    from.key = `slot:${gear.slot}`;
    from.label = `槽位 ${gear.slot}`;
  }
  return { ...rule, from: from.label };
}

/**
 * 这一件留不留。
 *
 * 「评分高于同部位已装备就无条件保留」排在品质之前：纯品质阈值会熔掉
 * 一件"卓越但分数比现在身上高"的过渡装，那是玩家会骂的地方 ——
 * 过滤器的目的是省事，不是替他做决定。
 *
 * @param {object} gear
 * @param {{filter: object, equipment?: object}} options
 *   equipment 传进来才能判断"比身上好吗"；不传则该条规则自动跳过（不假装生效）
 * @returns {{keep: boolean, reason: string, rule: object}}
 */
export function gearVerdict(gear, { filter, equipment = null } = {}) {
  const normalized = normalizeLootFilter(filter);
  const rule = ruleForGearNormalized(gear, normalized);
  if (!normalized.enabled) return { keep: true, reason: 'off', rule };

  if (normalized.keepIfBetterThanEquipped && equipment !== null && equipment !== undefined) {
    const current = equipment[gear.slot];
    if (current !== null && current !== undefined && gear.score > current.score) {
      return { keep: true, reason: 'betterThanEquipped', rule };
    }
  }

  if (gear.rarityIndex < rule.minRarity) return { keep: false, reason: 'belowMinRarity', rule };

  if (rule.requireAffix !== null) {
    const value = Number.isFinite(gear.stats?.[rule.requireAffix]) ? gear.stats[rule.requireAffix] : 0;
    if (value < rule.minAffixValue) return { keep: false, reason: 'affixTooLow', rule };
  }

  return { keep: true, reason: 'pass', rule };
}

/** 品质下标 → 名字（摘要里要说人话，不能说"≥4"）。 */
const rarityName = (index) => RARITIES[Math.min(MAX_RARITY_INDEX, Math.max(0, index))]?.name ?? '?';

const GROUP_LABELS = Object.freeze({ weapon: '武器', armor: '防具', accessory: '首饰' });

function rulePhrase(rule) {
  const bits = [];
  if (rule.minRarity > 0) bits.push(`≥${rarityName(rule.minRarity)}`);
  if (rule.requireAffix !== null) {
    const affix = AFFIXES.find((a) => a.id === rule.requireAffix);
    const shown =
      rule.requireAffix === 'crit'
        ? `${(rule.minAffixValue / 10).toFixed(1)}%`
        : String(rule.minAffixValue);
    bits.push(`${affix?.name ?? rule.requireAffix} ${shown}`);
  }
  return bits.length === 0 ? '不设限' : bits.join('、');
}

/**
 * 一行话说明当前规则（日志、面板、战绩三处共用同一句 —— 不各写一份措辞）。
 */
export function filterSummary(filter) {
  const normalized = normalizeLootFilter(filter);
  if (!normalized.enabled) return '不自动熔炼';
  const parts = [`全局 ${rulePhrase(normalized)}`];
  for (const group of FILTER_GROUPS) {
    if (normalized.groups[group] !== undefined) {
      parts.push(`${GROUP_LABELS[group]} ${rulePhrase(normalized.groups[group])}`);
    }
  }
  for (const slot of EQUIP_SLOTS) {
    if (normalized.slots[slot] !== undefined) {
      parts.push(`仅 ${slot} ${rulePhrase(normalized.slots[slot])}`);
    }
  }
  if (normalized.keepIfBetterThanEquipped) parts.push('比身上好的必留');
  return parts.join(' · ');
}

/**
 * 规则指纹（8 位十六进制）。存档、历史、面板显示都用它。
 * 用 fnv1a 而不是 sha256：这不是安全凭据，只是"同一条规则的双方能认出彼此"。
 */
export function filterHashOf(filter) {
  return fnv1a(canonicalFilter(filter)).toString(16).padStart(8, '0');
}

/**
 * 只读试算：这批装备按当前规则会留下几件、熔掉几件、回收多少碎片。
 *
 * 装备屏那个「试算」按钮用它 —— 熔炼是不可逆的（件数一旦折成碎片就回不去），
 * 所以在玩家改规则的那一刻给他看一眼后果，比事后弹窗道歉便宜。
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
