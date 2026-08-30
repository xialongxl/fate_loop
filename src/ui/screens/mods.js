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
 */

import { escapeHtml } from '../format.js';

export function createModsScreen({
  listPacks,
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
      <input id="mod-install-file" type="file" accept=".js,text/javascript,application/javascript" data-slot="file" hidden />
      <button type="button" class="btn-ghost" data-act="install">安装本地包…</button>
      <span class="transfer-hint" data-slot="hint">支持单个 .js 包文件；多文件包请压成 zip（尚未开放）</span>
    </div>

    <p class="screen-hint">
      第三方包在沙箱里执行，只能注册
      <strong>流派 / 技能 / Buff / 怪物 / 遭遇</strong>，且只能用
      <code>ctx.damage</code> 这类官方操作产生效果。
      <strong>装了包之后存档写入独立命名空间</strong>，卸载包后会回到原来的存档区。
    </p>

    <div class="mod-alerts" data-slot="alerts" hidden></div>

    <ul class="mod-list" data-slot="list"></ul>

    <div class="mod-reload" data-slot="reload" hidden>
      <p>有改动尚未生效。内容池在启动时冻结，<strong>不做热重载</strong>。</p>
      <button type="button" class="btn-primary" data-act="reload">立即重载页面</button>
    </div>
  `;

  const slots = {
    file: element.querySelector('[data-slot="file"]'),
    list: element.querySelector('[data-slot="list"]'),
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

  async function render() {
    const rows = (await listPacks()) ?? [];
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

    // ---- 包列表 ----
    if (rows.length === 0 && (report.ok ?? []).length === 0) {
      slots.list.innerHTML = `<li class="mod-card is-empty">还没有安装任何第三方包。</li>`;
      slots.reload.hidden = true;
      return;
    }
    slots.list.innerHTML = rows
      .map((row) => {
        const live = loadedIds.has(row.id);
        const state = row.enabled !== true ? '已停用' : live ? '已生效' : '未生效';
        const stateCls = row.enabled !== true ? 'is-off' : live ? 'is-live' : 'is-warn';
        return `
        <li class="mod-card" data-id="${escapeHtml(row.id)}">
          <div class="mod-head">
            <span class="mod-title">${escapeHtml(row.title ?? row.id)}</span>
            <span class="mod-state ${stateCls}">${state}</span>
          </div>
          <p class="mod-meta">
            <span>${escapeHtml(row.id)}</span>
            <span>v${escapeHtml(row.version)}</span>
            <span>${escapeHtml(row.author ?? '?')}</span>
            <span>${row.files} 文件 · ${fmtBytes(row.bytes ?? 0)}</span>
          </p>
          <p class="mod-hash" title="包内容哈希：存档与指纹记的就是它">
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
      })
      .join('');

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
