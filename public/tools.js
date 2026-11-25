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
  const picker = $('tool-session');
  let selected, previousOptions, previousItems;
  let snapshot, source = 'server', polling = false, failed = false;

  function render() {
    const sessions = snapshot?.sessions ?? [];
    const keyOf = s => JSON.stringify([s.protocol, s.id]);
    const options = sessions.map(s => {
      const id = s.id.length > 18 ? '…' + s.id.slice(-12) : s.id;
      const when = new Date(s.updated).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
      return [keyOf(s), s.protocol + ' · ' + when + ' · ' + id];
    });
    options.push(['', 'Без сессии']);
    const optionSignature = JSON.stringify(options);
    if (optionSignature !== previousOptions) {
      picker.replaceChildren(...options.map(([value, name]) => new Option(name, value)));
      previousOptions = optionSignature;
    }
    if (selected === undefined && sessions.length) selected = options[0][0];
    picker.value = selected ?? '';
    const session = sessions.find(s => keyOf(s) === picker.value);
    if (session && source !== 'server' && source !== session.protocol) source = session.protocol;
    for (const tab of sources) {
      tab.hidden = Boolean(session && tab.dataset.source !== 'server' && tab.dataset.source !== session.protocol);
      tab.setAttribute('aria-pressed', String(tab.dataset.source === source));
    }
    const server = source === 'server';
    const items = server ? (session?.history ?? snapshot?.history ?? [])
      : session ? session.tools : (snapshot?.clients?.[source] ?? []);
    $('tool-kind').textContent = server ? 'Вызовы на сервере' : session ? 'Последний объявленный набор' : 'Все объявленные инструменты';
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
    const omitted = !server && session?.lastRequestDeclaredTools === false;
    feedback.hidden = Boolean(items.length) && !failed && !omitted;
    if (failed) feedback.textContent = 'Не удалось обновить список. Повторяем запрос…';
    else if (!snapshot) feedback.textContent = 'Загружаем инструменты…';
    else if (omitted) feedback.textContent = 'В последнем запросе список инструментов не передан.';
    else if (!items.length) feedback.textContent = server ? 'Серверных вызовов пока нет.' : session
      ? 'В последнем запросе агент не объявил инструментов.' : 'Агент пока не передавал инструменты по этому протоколу.';
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
  picker.onchange = () => {
    selected = picker.value;
    list.scrollTop = 0;
    previousItems = undefined;
    render();
  };
  for (const button of sources) button.onclick = () => {
    if (source === button.dataset.source) return;
    source = button.dataset.source;
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
