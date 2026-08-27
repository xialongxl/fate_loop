/** 战斗日志视图（规格 10.3）。滚动到底、aria-live 播报最新条目。 */

export function createLogView(container) {
  container.className = 'panel panel-log';
  container.innerHTML = `
    <h2 class="panel-title">战斗日志</h2>
    <ol class="log-list" data-slot="list" aria-live="polite" aria-atomic="false"></ol>
  `;

  const list = container.querySelector('[data-slot="list"]');
  let lastLength = 0;

  function render(snapshot) {
    const entries = snapshot.log;
    if (entries.length === lastLength) return;
    lastLength = entries.length;

    list.replaceChildren();
    for (const entry of entries) {
      const li = document.createElement('li');
      li.className = 'log-entry';
      li.innerHTML = `<span class="log-time">${(entry.t / 1000).toFixed(2)}s</span><span class="log-msg"></span>`;
      li.querySelector('.log-msg').textContent = entry.message;
      list.append(li);
    }
    list.scrollTop = list.scrollHeight;
  }

  return { render };
}
