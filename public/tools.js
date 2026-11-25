const $ = id => document.getElementById(id);
const labels = new Map([
  ['mcp__syntax-checker__validate', 'Проверка синтаксиса'],
  ['mcp__knowledge-hub__Search_Documentation', 'Поиск по документации'],
  ['mcp__knowledge-hub__Fetch_Documentation', 'Чтение документации'],
  ['mcp__web__fetch', 'Чтение веб-страницы'],
  ['RenameChat', 'Переименование чата']
]);

function toolRow(name, call) {
  const row = document.createElement('li');
  const identity = document.createElement('div');
  const title = document.createElement('strong');
  const parts = name.split('__');
  const shortName = parts.length >= 3 && parts[0] === 'mcp' ? parts.slice(2).join('__') : name;
  title.textContent = labels.get(name) || shortName;
  identity.append(title);
  if (title.textContent !== name) {
    const id = document.createElement('code');
    id.textContent = name;
    identity.append(id);
  }
  identity.title = name;
  row.append(identity);
  if (call) {
    const meta = document.createElement('div');
    meta.className = 'tool-meta';
    const date = new Date(call.time);
    const time = document.createElement('time');
    time.dateTime = call.time;
    time.title = date.toLocaleString('ru-RU');
    const today = new Date().toDateString() === date.toDateString();
    time.textContent = today ? date.toLocaleTimeString('ru-RU') : date.toLocaleDateString('ru-RU');
    const protocol = document.createElement('span');
    protocol.textContent = call.protocol;
    meta.append(time, protocol);
    row.append(meta);
  }
  return row;
}

export function startToolMonitor(api) {
  const sources = [...document.querySelectorAll('.tool-sources button')];
  const list = $('tool-list');
  let previousItems;
  let snapshot, source = 'server', polling = false, failed = false;

  function render() {
    const server = source === 'server';
    const items = (server ? snapshot?.history : snapshot?.clients?.[source]) ?? [];
    $('tool-kind').textContent = server ? 'Вызовы на сервере' : 'Инструменты, объявленные агентом';
    $('tool-total').textContent = snapshot ? String(items.length) : '';
    list.hidden = failed || !items.length;
    const signature = JSON.stringify(items);
    if (signature !== previousItems) {
      // Keep the first visible item in place when new calls arrive above it.
      const offset = list.scrollTop;
      const anchor = offset > 0 && [...list.children].find(row => row.offsetTop + row.offsetHeight > offset);
      const inset = anchor ? offset - anchor.offsetTop : 0;
      const rows = items.map(item => {
        const row = server ? toolRow(item.name, item) : toolRow(item);
        row.dataset.key = server ? JSON.stringify([item.name, item.protocol, item.time]) : item;
        return row;
      });
      list.replaceChildren(...rows);
      const match = anchor && rows.find(row => row.dataset.key === anchor.dataset.key);
      if (match) list.scrollTop = match.offsetTop + inset;
      previousItems = signature;
    }
    const feedback = $('tool-feedback');
    feedback.hidden = Boolean(items.length) && !failed;
    if (failed) feedback.textContent = 'Не удалось обновить список. Повторяем запрос…';
    else if (!snapshot) feedback.textContent = 'Загружаем инструменты…';
    else if (!items.length) feedback.textContent = server ? 'Серверных вызовов пока нет.' : 'Агент пока не передавал инструменты по этому протоколу.';
  }
  async function poll() {
    if (polling || document.hidden || location.hash !== '#tools') return;
    polling = true;
    try {
      snapshot = await api('tools');
      failed = false;
    } catch { failed = true; }
    finally { polling = false; }
    render();
  }
  for (const button of sources) button.onclick = () => {
    if (source === button.dataset.source) return;
    source = button.dataset.source;
    for (const tab of sources) tab.setAttribute('aria-pressed', String(tab === button));
    list.scrollTop = 0;
    previousItems = undefined;
    render();
  };
  window.addEventListener('hashchange', poll);
  window.addEventListener('focus', poll);
  document.addEventListener('visibilitychange', poll);
  setInterval(poll, 5000);
  void poll();
}
