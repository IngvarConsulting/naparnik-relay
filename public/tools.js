const $ = id => document.getElementById(id);

export function startToolMonitor(api) {
  let snapshot, listPage = 0, polling = false;
  function list() {
    const source = $('tool-source').value;
    const items = source === 'server' ? snapshot?.history ?? [] : snapshot?.clients?.[source] ?? [];
    const count = Math.max(1, Math.ceil(items.length / 2));
    listPage = Math.min(listPage, count - 1);
    const rows = items.slice(listPage * 2, listPage * 2 + 2).map(item => {
      const row = document.createElement('li');
      row.textContent = item.name ?? item;
      if (item.time) {
        const detail = document.createElement('small');
        detail.textContent = [item.protocol, new Date(item.time).toLocaleTimeString('ru-RU')].join(' · ');
        row.append(detail);
      }
      return row;
    });
    $('tool-list').replaceChildren(...rows);
    $('list-prev').disabled = listPage === 0;
    $('list-next').disabled = listPage + 1 >= count;
    $('list-page').textContent = items.length ? (listPage + 1) + ' / ' + count + ' · Всего ' + items.length :
      source === 'server' ? 'Пока нет серверных вызовов' : 'Клиент пока не объявлял инструменты';
  }
  async function poll() {
    if (polling || document.hidden || location.hash !== '#tools') return;
    polling = true;
    try {
      snapshot = await api('tools');
      list();
    } catch (e) {
      $('list-page').textContent = e.message;
    } finally { polling = false; }
  }
  $('tool-source').onchange = () => { listPage = 0; list(); };
  $('list-prev').onclick = () => { listPage--; list(); };
  $('list-next').onclick = () => { listPage++; list(); };
  window.addEventListener('hashchange', poll);
  window.addEventListener('focus', poll);
  document.addEventListener('visibilitychange', poll);
  setInterval(poll, 5000);
  void poll();
}
