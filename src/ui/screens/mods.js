/**
 * 模组管理屏（S3）。
 *
 * 这个屏的存在理由只有一条：**没有它，前面所有沙箱工作都只对开发者可用**。
 * 界面上必须回答玩家的四个问题：
 *   1. 我现在装了什么（含哈希，因为哈希才是"到底是哪一版"的唯一答案）
 *   2. 它改动了官方内容吗（覆盖必须显式列出，不能悄悄生效）
 *   3. 有没有包没装上（失败原因要原样给出来，否则玩家只会说"没效果"）
 *   4. 改动什么时候生效（**不做热重载**：内容池冻结、解锁表开局算完、
 *      各屏持有池引用 —— 热重载会留一堆半新半旧的状态，比不重载更糟）
 *
 * 分三段显示，因为这三类东西**性质不同**，混在一张列表里会让人去点
 * 那些对本类无意义的按钮：
 *   核心包  官方内容，构建期打进产物 ⇒ 不可启停、不可卸载
 *   示例包  仓库自带的教学包，同样是构建期 ⇒ 同上，但它演示了第三方写法
 *   第三方包 玩家自己装的，跑在 QuickJS 沙箱里 ⇒ 可装、可停、可卸、可看源码
 */

import { escapeHtml } from '../format.js';

/** 内容类型 → 界面用的人话名称（顺序即展示顺序）。 */
const KIND_LABELS = [
  ['families', '流派'],
  ['skills', '技能'],
  ['buffs', 'Buff'],
  ['monsters', '怪物'],
  ['encounters', '遭遇'],
  ['shopItems', '商品'],
  ['events', '事件'],
  ['mapGenerators', '地图生成器'],
];

const countsText = (counts) =>
  KIND_LABELS.filter(([kind]) => (counts?.[kind] ?? 0) > 0)
    .map(([kind, label]) => `${String(counts[kind])} ${label}`)
    .join(' · ') || '（无内容）';

export function createModsScreen({
  listPacks,
  listOfficialPacks,
  getReport,
  onInstallFile,
  onToggle,
  onRemove,
  onViewSource,
  onReload,
  onBack,
}) {
  const element = document.createElement('section');
  element.className = 'screen-mods';
  element.innerHTML = `
    <header class="screen-head">
      <h2 tabindex="-1">模组</h2>
      <button type="button" class="btn-ghost" data-act="back">← 返回</button>
    </header>

    <div class="transfer-bar">
      <label class="visually-hidden" for="mod-install-file">选择包文件</label>
      <input id="mod-install-file" type="file" accept=".js,.zip,text/javascript,application/javascript" data-slot="file" hidden />
      <button type="button" class="btn-ghost" data-act="install">安装本地包…</button>
      <span class="transfer-hint" data-slot="hint">支持单个 .js 文件，或多文件包压成 .zip（入口 main.js，可带 pack.json）</span>
    </div>

    <p class="screen-hint">
      游戏内容全部由模组提供。下面三段的区别不是分类好看，而是
      <strong>能不能改</strong>：核心包与示例包在构建期就打进了产物，
      <strong>不能启停也不能卸载</strong>；只有第三方包跑在沙箱里，可以随时装卸。
      装了第三方包之后存档会写入<strong>独立命名空间</strong>，卸掉后回到原来的存档区。
    </p>

    <div class="mod-alerts" data-slot="alerts" hidden></div>

    <section class="mod-section" data-slot="section-core">
      <h3 class="mod-section-title">核心内容包<span class="mod-section-note">构建期 · 不可启停</span></h3>
      <ul class="mod-list" data-slot="core-list"></ul>
    </section>

    <section class="mod-section" data-slot="section-dev">
      <h3 class="mod-section-title">示例包<span class="mod-section-note">构建期 · 教学用</span></h3>
      <ul class="mod-list" data-slot="dev-list"></ul>
    </section>

    <section class="mod-section" data-slot="section-third">
      <h3 class="mod-section-title">第三方包<span class="mod-section-note" data-slot="third-note">沙箱执行 · 可装卸</span></h3>
      <ul class="mod-list" data-slot="list"></ul>
    </section>

    <div class="mod-reload" data-slot="reload" hidden>
      <p>有改动尚未生效。内容池在启动时冻结，<strong>不做热重载</strong>。</p>
      <button type="button" class="btn-primary" data-act="reload">立即重载页面</button>
    </div>
  `;

  const slots = {
    file: element.querySelector('[data-slot="file"]'),
    list: element.querySelector('[data-slot="list"]'),
    coreList: element.querySelector('[data-slot="core-list"]'),
    devList: element.querySelector('[data-slot="dev-list"]'),
    thirdNote: element.querySelector('[data-slot="third-note"]'),
    sectionDev: element.querySelector('[data-slot="section-dev"]'),
    alerts: element.querySelector('[data-slot="alerts"]'),
    reload: element.querySelector('[data-slot="reload"]'),
  };
  let dirty = false;

  element.addEventListener('click', async (event) => {
    const act = event.target.closest?.('[data-act]')?.getAttribute('data-act');
    if (act === null || act === undefined) return;
    if (act === 'back') {
      onBack();
      return;
    }
    if (act === 'install') {
      slots.file.click();
      return;
    }
    if (act === 'reload') {
      onReload();
      return;
    }
    const id = event.target.closest?.('[data-id]')?.getAttribute('data-id');
    if (id === null || id === undefined) return;
    if (act === 'toggle') {
      const enabled = event.target.getAttribute('data-enabled') !== 'true';
      await onToggle(id, enabled);
      dirty = true;
      await render();
    } else if (act === 'remove') {
      await onRemove(id);
      dirty = true;
      await render();
    } else if (act === 'source') {
      await onViewSource(id);
    }
  });

  slots.file.addEventListener('change', async () => {
    const file = slots.file.files?.[0];
    slots.file.value = '';
    if (file === undefined || file === null) return;
    await onInstallFile(file);
    dirty = true;
    await render();
  });

  const fmtBytes = (n) => (n > 1024 ? `${(n / 1024).toFixed(1)}KB` : `${n}B`);

  /** 官方包卡片：没有按钮，因为启停/卸载对它无意义（构建期就定死了）。 */
  function officialCard(row) {
    return `
      <li class="mod-card is-official" data-id="${escapeHtml(row.id)}">
        <div class="mod-head">
          <span class="mod-title">${escapeHtml(row.title ?? row.id)}</span>
          <span class="mod-state is-locked">构建期</span>
        </div>
        <p class="mod-meta">
          <span>${escapeHtml(row.id)}</span>
          <span>v${escapeHtml(row.version ?? '0')}</span>
        </p>
        <p class="mod-contents">${escapeHtml(countsText(row.counts))}</p>
      </li>`;
  }

  function thirdCard(row) {
    return `
      <li class="mod-card" data-id="${escapeHtml(row.id)}">
        <div class="mod-head">
          <span class="mod-title">${escapeHtml(row.title ?? row.id)}</span>
          <span class="mod-state ${row.stateCls}">${row.stateText}</span>
        </div>
        <p class="mod-meta">
          <span>${escapeHtml(row.id)}</span>
          <span>v${escapeHtml(row.version)}</span>
          <span>${escapeHtml(row.author ?? '未知')}</span>
          <span>${String(row.files)} 文件 · ${fmtBytes(row.bytes ?? 0)}</span>
        </p>
        <p class="mod-hash" title="包内容哈希：存档与内容指纹记的就是它">
          ${escapeHtml(row.hash?.algo ?? 'sha256')}:<code>${escapeHtml(row.hash?.hex ?? '—')}</code>
        </p>
        <div class="mod-actions">
          <button type="button" class="btn-ghost" data-act="toggle" data-enabled="${row.enabled === true ? 'true' : 'false'}">
            ${row.enabled === true ? '停用' : '启用'}
          </button>
          <button type="button" class="btn-ghost" data-act="source">看源码</button>
          <button type="button" class="btn-danger" data-act="remove">卸载</button>
        </div>
      </li>`;
  }

  async function render() {
    const [official, rows] = await Promise.all([
      listOfficialPacks ? listOfficialPacks() : [],
      listPacks(),
    ]);
    const report = getReport?.() ?? { ok: [], failed: [], overrides: [], broken: [] };
    const loadedIds = new Set((report.ok ?? []).map((r) => r.id));

    // ---- 顶部告警：装不上、读不回、覆盖了官方内容，三件事各说一条 ----
    const alerts = [];
    for (const failure of report.failed ?? []) {
      alerts.push({
        kind: 'danger',
        text: `包 ${escapeHtml(failure.id)} 没能加载：${escapeHtml(failure.reason ?? '未知原因')}`,
      });
    }
    if ((report.broken ?? []).length > 0) {
      alerts.push({
        kind: 'danger',
        text: `${report.broken.length} 个包的源文件读不回来（${report.broken.map(escapeHtml).join('、')}），建议卸载后重装`,
      });
    }
    if ((report.overrides ?? []).length > 0) {
      const detail = report.overrides
        .map((o) => `${o.kind} ${escapeHtml(o.id)}（原属 ${escapeHtml(o.was)}）`)
        .join('、');
      alerts.push({ kind: 'warn', text: `以下官方内容被包覆盖：${detail}` });
    }
    slots.alerts.innerHTML = alerts
      .map((a) => `<p class="mod-alert is-${a.kind}">${a.text}</p>`)
      .join('');
    // 没告警就整块收起：留个空的可见容器会在版面上撑出一道看不见的缝。
    // （别写 el.toggle() —— 那是 classList 的方法，Element 上没有。）
    slots.alerts.hidden = alerts.length === 0;

    // ---- 三段列表 ----
    // 按 id 排：加载顺序是拓扑排序的结果（地图生成器排在最前就是它决定的），
    // 那是实现细节，不该变成界面上"为什么每次版本不同顺序不同"的困惑来源
    const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const core = official.filter((row) => row.group === 'core').sort(byId);
    const dev = official.filter((row) => row.group !== 'core').sort(byId);
    slots.coreList.innerHTML = core.length > 0 ? core.map(officialCard).join('') : '<li class="mod-card is-empty">没有核心包</li>';
    // 没有示例包就整段藏起来：那只是"这份构建带不带教学包"的差异，
    // 留个空盒子反而让玩家以为坏了
    slots.sectionDev.hidden = dev.length === 0;
    if (dev.length > 0) slots.devList.innerHTML = dev.map(officialCard).join('');

    const third = rows.map((row) => ({
      ...row,
      enabled: row.enabled === true,
      stateText: row.enabled !== true ? '已停用' : loadedIds.has(row.id) ? '已生效' : '未生效',
      stateCls: row.enabled !== true ? 'is-off' : loadedIds.has(row.id) ? 'is-live' : 'is-warn',
    }));
    slots.thirdNote.textContent =
      third.length === 0 ? '沙箱执行 · 可装卸 · 当前 0 个' : `沙箱执行 · 可装卸 · 共 ${String(third.length)} 个`;
    slots.list.innerHTML =
      third.length > 0
        ? third.map(thirdCard).join('')
        : '<li class="mod-card is-empty">还没有安装任何第三方包。上面两段是游戏自带的官方内容，它们不能装卸。</li>';

    slots.reload.hidden = !dirty;
  }

  return {
    element,
    render,
    markDirty() {
      dirty = true;
      slots.reload.hidden = false;
    },
    onEnter() {
      void render();
    },
  };
}
