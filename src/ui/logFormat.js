/**
 * 战斗日志的**显示层**：结构化条目 → 一或多行可渲染内容。
 *
 * 语法照参考图：
 *   ★ 咏唱【裂隙】 → 骤雷哨卫 造成 312 伤害 （暴击！）
 *   ⌁ 【骤雷哨卫】雷鸣 击中你！造成 199 伤害
 *   ✚ [虹吸] 序列编织者 回复 60 点生命
 *   ✧ 骤雷哨卫 被施加 [虚空印记×1]
 *   ▸ 战斗胜利，获得 30 枚命运碎片与 54 点经验      ← 叙事行原样显示
 *
 * 三条规矩：
 * 1. **名字在这里查，不在写入时拼**。日志条目只存 id，所以改文案不会改变
 *    战斗指纹（`battleFingerprint` 只看结构化字段），也不会让旧日志变成错话。
 * 2. **括号分工**：技能与单位名用全角【】（它们是"名字"），状态用半角[]（它是
 *    "附注"），说明性后缀用全角（）。混用会让人分不清哪一段是名字。
 * 3. **视角跟着主语走**。敌方行上的 buff 是敌人自己攒的，写成"获得"会让人以为
 *    玩家拿到；同一个模板不能两边共用。
 *
 * 输出是 `segments`（带 class 的文字片段）而不是 HTML 字符串：调用方用
 * textContent 落 DOM，就不存在忘记转义而注入标记的可能。
 */

/** 每类事件的图标。用单色符号：彩色 emoji 在 Windows 下宽度不一，会破坏对齐。 */
export const LOG_ICONS = Object.freeze({
  damage: '★',
  crit: '◆',
  heal: '✚',
  buff: '✦',
  debuff: '✧',
  text: '▸',
});

/** ≥1e4 才缩写：本作伤害量级是 100~400，写成 0.20万 反而更难读。 */
export function formatAmount(n) {
  const v = Math.round(n);
  if (v >= 1e8) return `${(v / 1e8).toFixed(2)}亿`;
  if (v >= 1e4) return `${(v / 1e4).toFixed(2)}万`;
  return v.toLocaleString('zh-CN');
}

/**
 * @param {object} entry 日志条目（见 contracts/defaults/log.js）
 * @param {{unitName?:Function, skillName?:Function, buffName?:Function, isPlayer?:Function}} resolve
 * @returns {Array<{kind:string, icon:string, segments:Array<{cls:string,text:string}>}>}
 *   一条事件可能展开成多行（治疗/状态在参考图里就是独立成行）
 */
export function logRows(entry, resolve = {}) {
  const unitName = resolve.unitName ?? ((id) => String(id ?? ''));
  const skillName = resolve.skillName ?? ((id) => String(id ?? ''));
  const buffName = resolve.buffName ?? ((id) => String(id ?? ''));
  const isPlayer = resolve.isPlayer ?? (() => false);
  const seg = (cls, text) => ({ cls, text });

  // 叙事行：game.js 的 18 处与第三方包的 ctx.log('…') 都走这里
  if (entry.kind === undefined || entry.kind === null) {
    return [{ kind: 'text', icon: LOG_ICONS.text, segments: [seg('narr', String(entry.text ?? ''))] }];
  }

  const skillLabel = entry.skillId ? skillName(entry.skillId) : '';
  const target = unitName(entry.targetId);

  switch (entry.kind) {
    case 'damage':
    case 'crit': {
      const crit = entry.kind === 'crit' || entry.crit === true;
      // 敌方攻击我方时主语换成单位名 —— "谁在打我"才是玩家要读的信息，
      // 而我方攻击时技能名比单位名有用（玩家认得技能，认不住六种怪的名字）
      const fromFoe = entry.actorId !== null && !isPlayer(entry.actorId);
      const segments = fromFoe
        ? [seg('unit', `【${entry.actorId ? unitName(entry.actorId) : '未知'}】`), seg('skill', skillLabel)]
        : [seg('cast', '咏唱'), seg('skill', skillLabel ? `【${skillLabel}】` : '')];
      segments.push(seg('verb', fromFoe ? '击中你！造成' : `→ ${target} 造成`));
      segments.push(seg('amount', formatAmount(entry.amount)));
      segments.push(seg('unit-word', '伤害'));
      if (crit) segments.push(seg('sfx', '（暴击！）'));
      if (entry.lethal === true) segments.push(seg('sfx', '（击杀）'));
      return [{ kind: crit ? 'crit' : 'damage', icon: crit ? LOG_ICONS.crit : LOG_ICONS.damage, segments }];
    }

    case 'heal': {
      const who = entry.self === true || entry.actorId === entry.targetId ? target : `${unitName(entry.actorId)} 为 ${target}`;
      return [
        {
          kind: 'heal',
          icon: LOG_ICONS.heal,
          segments: [
            entry.skillId ? seg('sfx', `[${skillLabel}]`) : seg('sfx', ''),
            seg('unit', who),
            seg('verb', '回复'),
            seg('amount', formatAmount(entry.amount)),
            seg('unit-word', '点生命'),
          ],
        },
      ];
    }

    case 'buff':
    case 'debuff': {
      const isDebuff = entry.kind === 'debuff';
      // 视角跟着主语走：给敌人挂的减益写"被施加"，敌人自己攒的增益写"蓄起"
      const verb = isDebuff ? '被施加' : isPlayer(entry.targetId) ? '获得' : '蓄起';
      const stacks = Number(entry.stacks) > 1 ? `×${String(entry.stacks)}` : '';
      return [
        {
          kind: entry.kind,
          icon: isDebuff ? LOG_ICONS.debuff : LOG_ICONS.buff,
          segments: [
            seg('unit', target),
            seg('verb', verb),
            seg('sfx', `[${buffName(entry.buffId)}${stacks}]`),
          ],
        },
      ];
    }

    default:
      return [{ kind: 'text', icon: LOG_ICONS.text, segments: [seg('narr', String(entry.text ?? ''))] }];
  }
}

/**
 * 造一个"按当前战场解析名字"的 resolver 工厂。
 * 两个屏幕共用它 —— 各自写一份的话，早晚会一边能查到技能名一边查不到。
 */
export function createLogResolver({ getSkills = null, getBuffs = null } = {}) {
  return (snapshot) => {
    const names = new Map();
    if (snapshot.player) names.set(snapshot.player.id, snapshot.player.name);
    for (const m of snapshot.monsters ?? []) names.set(m.id, m.name);
    const skills = getSkills?.() ?? null;
    const buffs = getBuffs?.() ?? null;
    return {
      unitName: (id) => names.get(id) ?? String(id ?? '未知'),
      skillName: (id) => skills?.get(id)?.name ?? String(id ?? ''),
      buffName: (id) => buffs?.get(id)?.name ?? String(id ?? ''),
      isPlayer: (id) => id === snapshot.player?.id,
    };
  };
}

/** 纯文本版：给地图屏、aria-live 与测试断言用。 */
export function logText(entry, resolve = {}) {
  return logRows(entry, resolve)
    .map((row) => row.segments.map((s) => s.text).filter((t) => t !== '').join(' '))
    .join(' ');
}

/**
 * 战斗指纹用的**稳定序列化**。
 *
 * 刻意不包含任何措辞与名字：措辞是显示层的事，改一个字都不应该让"同种子同结果"
 * 的对拍变红。以前指纹直接存整句文本，等于把 UI 文案锁进了确定性契约。
 */
export function logEntryDigest(entry) {
  const e = entry;
  return [
    e.t,
    e.kind ?? 'text',
    e.actorId ?? '',
    e.targetId ?? '',
    e.skillId ?? '',
    e.buffId ?? '',
    e.amount ?? '',
    e.crit ? 1 : 0,
    e.lethal ? 1 : 0,
    e.self ? 1 : 0,
    e.stacks ?? '',
    // 叙事行没有结构化字段，只能按原文对比（它本身就是文本契约的一部分）
    e.kind === undefined || e.kind === null ? `|${e.text ?? ''}` : '',
  ].join('\u0001');
}
