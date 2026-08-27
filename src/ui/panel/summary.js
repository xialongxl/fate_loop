/** 结算面板与对话框（规格 11.1）。 */

export function createDialog(container) {
  container.className = 'app-dialog';

  function open(html, { onClose = null } = {}) {
    container.hidden = false;
    container.innerHTML = `<div class="dialog-box" role="dialog" aria-modal="true">${html}</div>`;
    const box = container.querySelector('.dialog-box');
    const closeBtn = box.querySelector('[data-action="close"]');
    closeBtn?.focus();
    closeBtn?.addEventListener('click', () => {
      close();
      onClose?.();
    });
    return box;
  }

  function close() {
    container.hidden = true;
    container.innerHTML = '';
  }

  /** 结算面板（规格 11.1 完整字段）。 */
  function openSummary(snapshot, { outcome }) {
    const won = outcome === 'victory';
    return open(`
      <h2>${won ? '通关结算' : '探索结束'}</h2>
      <dl class="summary-list">
        <div><dt>到达层数</dt><dd>第 ${snapshot.floorNumber} 层</dd></div>
        <div><dt>总逻辑耗时</dt><dd>${(snapshot.virtualTime / 1000).toFixed(2)} 秒</dd></div>
        <div><dt>总输出伤害</dt><dd>${snapshot.metadata.totalDamage}</dd></div>
        <div><dt>总治疗量</dt><dd>${snapshot.metadata.totalHeal}</dd></div>
        <div><dt>清理节点</dt><dd>${snapshot.clearedNodeIds.size} / ${snapshot.metadata.nodesVisited} 已访问</dd></div>
        <div><dt>获得碎片</dt><dd>${snapshot.metadata.shardsEarned}</dd></div>
        <div><dt>使用种子</dt><dd><code>${snapshot.seed}</code></dd></div>
        <div><dt>胜负</dt><dd>${won ? '通关' : '阵亡'}</dd></div>
      </dl>
      <h3>技能序列摘要</h3>
      <p class="summary-seq">${snapshot.player.gcdSequence.join(' → ') || '（空）'}</p>
      <p class="summary-seq">oGCD：${snapshot.player.ogcdSlots.map((s) => s.skillId).join('、') || '（空）'}</p>
      <div class="dialog-actions">
        <button type="button" data-action="close" class="btn-primary">开始新的轮回</button>
      </div>
    `);
  }

  return { open, close, openSummary };
}
