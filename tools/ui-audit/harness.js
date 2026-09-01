/**
 * UI 体检的浏览器侧：把应用驱动到指定界面，然后量 DOM。
 *
 * 为什么需要它：jsdom 没有布局引擎，CSS 是"闭眼写的"也照样测试全绿。
 * 这里用真浏览器把溢出、零高度、文本裁切、遮挡、对比度这些**只有排版才会暴露**
 * 的缺陷变成机器可读的结论，配合 run.mjs 一条命令回归。
 *
 * 用法（一般由 npm run ui:audit 代跑）：
 *   /tools/ui-audit/audit-page.html?screen=map
 * 界面名见 SCREENS。结果写进 <script id="audit-json" type="application/json">。
 */

import { createApp } from '/src/main.js';
import { NODE_TYPE, SCREEN, SPEED_MODES, VICTORY_FLOOR } from '/src/core/constants.js';
import { rollEquipment } from '/src/core/equipment.js';
import { mulberry32 } from '/src/core/prng.js';
import { totalExpForLevel } from '/src/core/progression.js';
import { recalcPlayer } from '/src/core/derived.js';

const params = new URLSearchParams(location.search);
const target = params.get('screen') ?? 'menu';
const seed = Number(params.get('seed') ?? 20240101);

/** 界面清单单一来源在 screenList.js（两边各写一份时，加屏幕会“体检悄悄少量一屏”）。 */
import { AUDIT_SCREENS as SCREENS } from './screenList.js';

export { SCREENS };

const app = await createApp({ root: document.querySelector('#app'), seed });
const store = app.store;
const stand = (node) => store.update((d) => { d.currentNodeId = node.id; });

/** 造一点真实数据：打过仗、有装备、有碎片、升过级 —— 空状态量不出问题。 */
async function buildProgress() {
  app.startNewRun(seed);
  const combat = app
    .snapshot()
    .mapNodes.filter((n) => n.type === NODE_TYPE.COMBAT || n.type === NODE_TYPE.ELITE)
    .slice(0, 2);
  for (const node of combat) {
    stand(node);
    app.flow.startBattle();
    app.engine.runToEnd();
    app.flow.finishBattle();
  }
  const mk = (idSuffix, slot, rarity) =>
    rollEquipment({
      rng: mulberry32(rarity * 13 + slot.length),
      floorNumber: 4,
      idSuffix,
      forceSlot: slot,
      forceRarity: rarity,
    });
  store.update((d) => {
    d.player.inventory.push(mk('au.1', 'weapon', 4), mk('au.2', 'chest', 2), mk('au.3', 'ring', 5), mk('au.4', 'feet', 0));
  });
  const chest = app.snapshot().player.inventory.find((g) => g.slot === 'chest');
  if (chest !== undefined) app.flow.equip(chest.id);
  store.update((d) => {
    d.fateShards = 420;
    d.player.exp = totalExpForLevel(14);
    recalcPlayer(d.player);
    d.player.hp = Math.floor(d.player.maxHp * 0.45);
  });
}

function firstNode(type) {
  return app.snapshot().mapNodes.find((n) => n.type === type);
}

/**
 * 真的走过去（而不是改 currentNodeId 传送）。
 *
 * 为什么要走：揭示是 moveTo 的副作用，传送过去的"当前位置"周围全是雾，
 * 于是量出来 reachable=0 —— 看着像缺陷，其实是脚手架造了个游戏里到不了的状态。
 * 路上撞到战斗就当场打完，保持地图屏是干净的可交互态。
 */
function walkTo(target) {
  const state = app.snapshot();
  if (state.currentNodeId === target.id) return;
  const previous = new Map([[state.currentNodeId, null]]);
  const queue = [state.currentNodeId];
  while (queue.length > 0) {
    const id = queue.shift();
    if (id === target.id) break;
    for (const next of state.mapAdjacency[id] ?? []) {
      if (previous.has(next)) continue;
      previous.set(next, id);
      queue.push(next);
    }
  }
  if (!previous.has(target.id)) return; // 图上不连通（不该发生），跳过步行

  const path = [];
  for (let at = target.id; at !== null && at !== undefined; at = previous.get(at)) path.unshift(at);
  for (const id of path) {
    const result = app.flow.moveTo(id);
    if (result.triggeredBattle === true) {
      app.flow.startBattle();
      app.engine.runToEnd();
      app.flow.finishBattle();
      if (app.snapshot().status === 'finished') return; // 阵亡了，别再走
    }
  }
}

// 用例本体包进函数 + try：脚手架自己抛错（createApp 起不来等）必须写成一条**结果**，
// 不能让它变成“没拿到 JSON”然被当成环境问题放过 —— 那是漏报，比假报更坏。
async function runCase() {
switch (target) {
  case 'menu':
    break;
  case 'battle': {
    await buildProgress();
    const node = firstNode(NODE_TYPE.COMBAT);
    stand(node);
    app.beginBattle();
    for (let i = 0; i < 40 && app.snapshot().status === 'battling'; i += 1) {
      app.engine.runFrame(SPEED_MODES.X1);
    }
    app.renderAll();
    break;
  }
  case 'victory': {
    // 第 50 层的怪会当场打死 14 级的体检角色 —— 步行过去只会量到"阵亡后的地图"，
    // 通关面板根本不出现（而且体检会以为自己验过了）。这里直接落位到出口：
    // 体检要量的是面板与地图的排版，不是通关可达性（那个由 vitest 管）。
    await buildProgress();
    app.flow.enterFloor(VICTORY_FLOOR);
    stand(app.snapshot().mapNodes.find((n) => n.id === app.snapshot().exitNodeId));
    app.router.go(SCREEN.MAP);
    app.renderAll();
    document
      .querySelector('[data-screen="map"] [data-action="descend"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    break;
  }
  case 'shop': {
    await buildProgress();
    walkTo(firstNode(NODE_TYPE.SHOP));
    app.openShopDialog();
    break;
  }
  case 'event': {
    await buildProgress();
    walkTo(firstNode(NODE_TYPE.EVENT));
    app.openEventDialog();
    break;
  }
  case 'map': {
    await buildProgress();
    walkTo(firstNode(NODE_TYPE.REST));
    app.router.go(SCREEN.MAP);
    app.renderAll();
    break;
  }
  default: {
    await buildProgress();
    // 模组屏要量的是**满载态**：长标题、三条告警、重载横幅。空屏量不出排版问题。
    // 注意这里只写库与报告对象，不重启应用 —— 体检要的是画面，不是真装包。
    if (target === 'mods') {
      const { PackService } = await import('/src/persistence/packs.js');
      const packService = app.packs ?? (await new PackService().init());
      await packService.install({
        id: 'audit.long-title-pack',
        version: '10.2.1',
        title: '一个长得会撞破布局的模组名字 · 附赠中文与英文混排',
        author: 'audit-fixture',
        files: { 'main.js': 'import { begin } from "fate"; begin({ id: "audit.long-title-pack", version: "10.2.1" });' },
      });
      await packService.install({
        id: 'audit.small',
        version: '0.1.0',
        title: '小包',
        files: { 'main.js': 'import { begin } from "fate"; begin({ id: "audit.small" });' },
      });
      app.packReport.failed.push({ id: 'audit.broken', reason: '执行超过 400ms 被打断（疑似死循环）' });
      app.packReport.overrides.push({
        id: 'blade.jab',
        kind: 'skills',
        was: 'official.core-skills',
        by: 'audit.long-title-pack',
      });
    }
    const screen = SCREEN[target.toUpperCase()];
    if (screen === undefined) throw new Error(`未知界面：${target}`);
    app.router.go(screen);
  }
}
}

try {
  await runCase();
} catch (error) {
  emitResult({
    ok: false,
    problems: [`用例脚手架抛错（下面的量测不可信）：${String(error?.message ?? error)}`],
    metrics: {},
  });
  throw error;
}

// ============================================================
// 体检
// ============================================================

const problems = [];
const metrics = {};

/**
 * 每个用例的**前置断言**：量之前先确认自己真的在要量的状态上。
 * 没有这层，"victory 用例其实阵亡在地图上"这种事会安静地报成 ✓。
 */
const PRECONDITIONS = {
  battle: () => ['battling', 'paused', 'finished'].includes(app.snapshot().status),
  shop: () => document.querySelector('.app-dialog')?.hidden === false,
  event: () => document.querySelector('.app-dialog')?.hidden === false,
  victory: () => document.querySelector('.dialog-box')?.textContent.includes('通关结算') === true,
  menu: () => document.querySelector('.screen-menu:not([hidden])') !== null,
};
const expected = {
  battle: '战斗状态（进行中/暂停/已结束）',
  shop: '商店对话框已打开',
  event: '事件对话框已打开',
  victory: '通关结算面板已打开',
  menu: '停在主菜单',
};
if (PRECONDITIONS[target] !== undefined && !PRECONDITIONS[target]()) {
  problems.push(`用例没进到预期状态（${expected[target]}），下面的量测不可信`);
}

// 异步渲染的屏幕（存档屏、模组屏要读 IndexedDB）必须先 await 再量。
// ⚠️ 靠 setTimeout 轮询是**等不到**的：体检跑在 --virtual-time-budget 下，
// 3 秒虚拟时间只对应几毫秒真实时间，而 IDB 读的是真实时钟。
// 所以直接 await 屏幕自己的 render()（它返回 promise）。
{
  const current = app.router.current;
  const screen = app.screens?.[current];

  if (typeof screen?.render === 'function') {
    try {
      await screen.render();
    } catch (error) {
      problems.push(`屏幕 ${current} 的 render 抛错，量测不可信：${String(error?.message ?? error)}`);
    }
  }
}

const vw = innerWidth;
const vh = innerHeight;
const doc = document.documentElement;
const isSvg = (el) => el.namespaceURI === 'http://www.w3.org/2000/svg';
const cls = (el) => (el.getAttribute('class') || '·').split(' ')[0];
const tag = (el) => `${el.tagName.toLowerCase()}.${cls(el)}`;

const visible = [...doc.querySelectorAll('.app-shell *')].filter((el) => {
  const cs = getComputedStyle(el);
  return cs.display !== 'none' && cs.visibility !== 'hidden' && !el.closest('[hidden]');
});

if (doc.scrollWidth > vw + 1) problems.push(`横向溢出：文档宽 ${doc.scrollWidth} > 视口 ${vw}`);

const shell = doc.querySelector('.app-shell');
if (shell !== null && Math.abs(shell.getBoundingClientRect().height - vh) > 2) {
  problems.push(`外壳高度 ${Math.round(shell.getBoundingClientRect().height)} ≠ 视口 ${vh}`);
}

/**
 * 能吞下溢出的容器（这些里面的元素超出视口不算问题）。
 *
 * ⚠️ 这份名单必须跟着真实滚动容器走。`.dialog-box` 一度不在里面，
 * 于是商店对话框变高之后，「离开」按钮被报成“超出视口且无滚动容器”——
 * 它确实 `overflow-y:auto` 能滚到，不算排版缺陷，但工具当时说不出这句话。
 * 反过来说：它**先于肉眼发现了商店变高了**，这条报错本身是有用的信号，
 * 所以同时给 `.dialog-actions` 加了 sticky bottom（长对话框里动作钮不该靠滚）。
 */
const SCROLLER = '.screen, .map-canvas, .bag-list, .log-list, .library-list, .codex-list, .history-list, .battle-enemies, .seq-column, .dialog-box, [style]';

for (const el of visible) {
  const r = el.getBoundingClientRect();
  // SVG 内部的几何盒不算溢出：外层 <svg> 会裁掉画布外的内容，玩家根本看不到。
  // 真出问题的话 fog/reachable 那两条会报。
  const clippedBySvg = el.closest('svg') !== null;
  if (r.width > 0 && r.height === 0 && !isSvg(el)) problems.push(`零高度可见元素：${tag(el)}`);
  if (!clippedBySvg && (r.right > vw + 1 || r.left < -1)) {
    problems.push(`超出视口横向：${tag(el)} (${Math.round(r.left)}..${Math.round(r.right)})`);
  }
  if (r.bottom > vh + 1 && !isSvg(el) && !clippedBySvg) {
    const parent = el.parentElement;
    const overflowY = parent === null ? 'visible' : getComputedStyle(parent).overflowY;
    if (el.closest(SCROLLER) === null && overflowY !== 'auto' && overflowY !== 'scroll' && overflowY !== 'hidden') {
      problems.push(`超出视口纵向且无滚动容器：${tag(el)}`);
    }
  }
  if (el.children.length === 0 && el.textContent.trim().length > 0 && el.scrollWidth > el.clientWidth + 2) {
    const cs = getComputedStyle(el);
    if (cs.textOverflow !== 'ellipsis' && cs.overflow !== 'hidden' && cs.whiteSpace !== 'nowrap' && !isSvg(el)) {
      problems.push(`文本溢出未处理：${tag(el)} "${el.textContent.trim().slice(0, 14)}" (${el.scrollWidth}>${el.clientWidth})`);
    }
  }
}

const modalOpen = doc.querySelector('.app-dialog')?.hidden === false;
if (!modalOpen) {
  for (const el of visible.filter(
    (x) => x.classList.contains('panel') || x.classList.contains('map-pane') || x.classList.contains('screen-head'),
  )) {
    const r = el.getBoundingClientRect();
    if (r.width < 20 || r.height < 20) continue;
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(r.height / 2, 40));
    if (hit !== null && !el.contains(hit) && !hit.contains(el)) {
      problems.push(`面板中心被遮挡：${cls(el)} 命中了 ${tag(hit)}`);
    }
  }
}

// ---- 对比度（WCAG 相对亮度） ----
const lum = (css) => {
  const parts = (css.match(/\d+/g) ?? [0, 0, 0]).map(Number);
  const [r, g, b] = parts.slice(0, 3).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
/** 拆 rgba() → {rgb:'r,g,b', a:0..1}。不带 alpha 的按 1 算。 */
const splitAlpha = (css) => {
  const nums = (css.match(/[\d.]+/g) ?? ['0', '0', '0', '1']).map(Number);
  return { rgb: `${nums[0]},${nums[1]},${nums[2]}`, a: nums.length >= 4 ? nums[3] : 1 };
};
/**
 * 背景色：必须**把半透明层合成下去**再算亮度。
 *
 * 旧写法直接拿第一个非透明背景（只排除了 rgba(0,0,0,0)），于是
 * `rgba(115,214,220,.14)` 这种选中态薄底被当成**不透明**青色去算，
 * 实测报出“对比度 1.5”—— 而屏幕上它是“深底 + 14% 青”，浅字对它是 8:1 以上。
 * 假报比不报更坏：它会让人去改一个根本没问题的颜色。
 */
const bgOf = (el) => {
  const stack = [];
  let node = el;
  while (node !== null && node !== document) {
    const c = getComputedStyle(node).backgroundColor;
    if (c && c !== 'transparent') {
      const { rgb, a } = splitAlpha(c);
      stack.push({ rgb, a });
      if (a >= 1) break;
    }
    node = node.parentElement;
  }
  // 从下往上合成（先底层、后上层）
  let base = { r: 13, g: 17, b: 23 }; // 页面底色，堆栈到底时兼作最终底色
  const layers = stack.reverse();
  if (layers.length > 0) {
    const bottom = splitAlpha(`rgba(${layers[0].rgb},1)`);
    const [br, bg, bb] = bottom.rgb.split(',').map(Number);
    base = { r: br, g: bg, b: bb };
    for (let i = 1; i < layers.length; i += 1) {
      const [lr, lg, lb] = layers[i].rgb.split(',').map(Number);
      const a = Math.max(0, Math.min(1, layers[i].a));
      base = {
        r: base.r * (1 - a) + lr * a,
        g: base.g * (1 - a) + lg * a,
        b: base.b * (1 - a) + lb * a,
      };
    }
  }
  return `rgb(${Math.round(base.r)}, ${Math.round(base.g)}, ${Math.round(base.b)})`;
};
const low = [];
for (const el of visible.filter((x) => x.children.length === 0 && x.textContent.trim().length > 1 && !isSvg(x))) {
  const cs = getComputedStyle(el);
  const ratio = (Math.max(lum(cs.color), lum(bgOf(el))) + 0.05) / (Math.min(lum(cs.color), lum(bgOf(el))) + 0.05);
  if (ratio < 4.5) low.push(`${tag(el)} ${ratio.toFixed(1)} "${el.textContent.trim().slice(0, 10)}"`);
}
if (low.length > 0) problems.push(`对比度 <4.5:1 共 ${low.length} 处：${low.slice(0, 5).join(' | ')}`);

// ---- 两条通用不变量（都是这次漏掉的） ----

// 1) 按钮文字换行 = 十有八九是缺 white-space:nowrap，窄列里会竖排成"卸/下"
for (const btn of visible.filter(
  (x) => x.tagName === 'BUTTON' && x.children.length === 0 && x.textContent.trim().length > 0,
)) {
  // 只管"纯文字标签按钮"：背包条目那种内含多块结构的按钮（children > 0）本就该换行
  const cs = getComputedStyle(btn);
  if (cs.whiteSpace === 'nowrap' || cs.height !== 'auto') continue; // 显式定高的（图标方块）不比
  const fontSize = Number.parseFloat(cs.fontSize) || 14;
  const lineHeight = cs.lineHeight === 'normal' ? fontSize * 1.2 : Number.parseFloat(cs.lineHeight);
  const box =
    lineHeight +
    (Number.parseFloat(cs.paddingTop) || 0) +
    (Number.parseFloat(cs.paddingBottom) || 0) +
    (Number.parseFloat(cs.borderTopWidth) || 0) +
    (Number.parseFloat(cs.borderBottomWidth) || 0);
  const r = btn.getBoundingClientRect();
  if (r.height > box + 4) {
    problems.push(`按钮文字换行（多半缺 nowrap）：${tag(btn)} "${btn.textContent.trim().slice(0, 8)}" 高 ${Math.round(r.height)} > 单行 ${Math.round(box)}`);
  }
}

// 2) <dt> 与紧跟的 <dd> 必须同一行：不同行说明这个 dl 根本没套样式，
//    会塌成一列"一行一个词"（装备栏底部的等级/生命/攻击… 就是这么坏的）
for (const dt of visible.filter((x) => x.tagName === 'DT')) {
  const dd = dt.nextElementSibling;
  if (dd === null || dd === undefined || dd.tagName !== 'DD') continue;
  const a = dt.getBoundingClientRect();
  const b = dd.getBoundingClientRect();
  if (a.width === 0 || b.width === 0) continue;
  if (Math.abs(a.top - b.top) > 3) {
    problems.push(`dt/dd 不在同一行（dl 缺样式？）：${dt.textContent.trim().slice(0, 6)} / ${dd.textContent.trim().slice(0, 8)}`);
  }
}

// 3) 被 ellipsis 藏起来的文字也是缺陷：截断要分场合，槽位名"靴…"就是截错了地方
for (const el of visible.filter(
  (x) => x.children.length === 0 && x.textContent.trim().length > 1 && getComputedStyle(x).textOverflow === 'ellipsis',
)) {
  if (el.scrollWidth > el.clientWidth + 1) {
    problems.push(`ellipsis 把文字截断了：${tag(el)} "${el.textContent.trim().slice(0, 10)}"（需要 ${el.scrollWidth}px，只给 ${el.clientWidth}px）`);
  }
}

// ---- 界面专属断言 ----
const screen = doc.querySelector('.screen:not([hidden])');
if (screen !== null && screen !== undefined) {
  const rect = screen.getBoundingClientRect();
  metrics.screenHeightPct = Math.round((rect.height / vh) * 100);
  const chars = screen.textContent.replace(/\s+/g, '').length;
  const interactive = screen.querySelectorAll('button, li, input, select, td').length;
  if (interactive < 2 && chars < 40) problems.push(`当前屏几乎是空的：交互元素 ${interactive}、文本 ${chars} 字`);
  metrics.nodes = doc.querySelectorAll('.map-node').length;
  metrics.fog = doc.querySelectorAll('.map-fog').length;
  metrics.reachable = doc.querySelectorAll('.map-node.is-reachable').length;
  metrics.cards = doc.querySelectorAll('.entity-card').length;
  metrics.rows = screen.querySelectorAll('li').length;

  const nav = doc.querySelector('.app-nav');
  if (nav !== null && nav.hidden === false) {
    const buttons = [...nav.querySelectorAll('[data-nav]')];
    if (buttons.length !== 6) problems.push(`导航按钮 ${buttons.length} 个，应为 6 个`);
    const pressed = buttons.filter((b) => b.getAttribute('aria-pressed') === 'true');
    if (pressed.length !== 1) problems.push(`aria-pressed=true 的导航按钮有 ${pressed.length} 个`);
  }
  if (screen.dataset.screen === 'map') {
    const current = app.snapshot().mapNodes.find((n) => n.id === app.snapshot().currentNodeId);
    const revealedNeighbors = current === undefined ? 0 : (app.snapshot().mapAdjacency[current.id] ?? []).filter(
      (id) => app.snapshot().mapNodes.find((n) => n.id === id)?.isRevealed === true,
    ).length;
    // 只有"已揭示的邻居存在却没一个可点"才是缺陷；传送态没揭示邻居不算
    if (revealedNeighbors > 0 && metrics.reachable === 0) {
      problems.push(`有 ${revealedNeighbors} 个已揭示邻居，却没有一个可点击`);
    }
    const unrevealed = app.snapshot().mapNodes.filter((n) => !n.isRevealed).length;
    if (unrevealed > 0 && metrics.fog === 0) problems.push(`有 ${unrevealed} 个未揭示节点却没画雾点（开局像坏图）`);
  }
  if (screen.dataset.screen === 'battle' && metrics.cards < 2) problems.push(`战斗屏实体卡只有 ${metrics.cards} 张`);
}

emitResult({
  screen: target,
  viewport: `${vw}x${vh}`,
  ok: problems.length === 0,
  problems,
  metrics,
});

/** 把结果写进页面。两处调用：正常走完体检，与脚手架抛错时提前交卷。 */
function emitResult(value) {
  const out = document.createElement('script');
  out.type = 'application/json';
  out.id = 'audit-json';
  out.textContent = JSON.stringify(value).replace(/</g, '\u003c');
  document.body.append(out);
  window.__audit = value;
}
