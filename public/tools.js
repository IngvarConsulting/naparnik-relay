const $ = id => document.getElementById(id);
const pageSize = 3;
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
  const pager = document.querySelector('.tool-pager');
  let snapshot, source = 'server', page = 0, polling = false, failed = false;

  function render() {
    const server = source === 'server';
    const items = (server ? snapshot?.history : snapshot?.clients?.[source]) ?? [];
    const pages = Math.ceil(items.length / pageSize);
    page = Math.max(0, Math.min(page, pages - 1));
    const visible = items.slice(page * pageSize, (page + 1) * pageSize);
    $('tool-kind').textContent = server ? 'Вызовы на сервере' : 'Инструменты, объявленные агентом';
    $('tool-total').textContent = snapshot ? String(items.length) : '';
    $('tool-list').replaceChildren(...visible.map(item => server ? toolRow(item.name, item) : toolRow(item)));
    const feedback = $('tool-feedback');
    $('tool-list').hidden = failed;
    feedback.hidden = Boolean(items.length) && !failed;
    if (failed) feedback.textContent = 'Не удалось обновить список. Повторяем запрос…';
    else if (!snapshot) feedback.textContent = 'Загружаем инструменты…';
    else if (!items.length) feedback.textContent = server ? 'Серверных вызовов пока нет.' : 'Агент пока не передавал инструменты по этому протоколу.';
    pager.hidden = failed || pages <= 1;
    $('list-prev').disabled = page === 0;
    $('list-next').disabled = page + 1 >= pages;
    $('list-page').textContent = 'Страница ' + (page + 1) + ' из ' + pages;
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
    source = button.dataset.source;
    for (const tab of sources) tab.setAttribute('aria-pressed', String(tab === button));
    page = 0;
    render();
  };
  $('list-prev').onclick = () => { page--; render(); };
  $('list-next').onclick = () => { page++; render(); };
  window.addEventListener('hashchange', poll);
  window.addEventListener('focus', poll);
  document.addEventListener('visibilitychange', poll);
  setInterval(poll, 5000);
  void poll();
}
