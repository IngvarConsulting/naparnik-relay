import { startToolMonitor } from './tools.js';
const $ = (id) => document.getElementById(id);
let state,
  profile = 'zcode',
  toastTimer,
  pending = false;
function toast(message) {
  clearTimeout(toastTimer);
  $('toast').textContent = message;
  toastTimer = setTimeout(() => ($('toast').textContent = ''), 2500);
}
async function api(path, method = 'GET', data) {
  let res;
  try {
    res = await fetch('/panel/' + path, {
      method,
      headers: { 'X-Relay-Panel': '1', 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
  } catch {
    throw Error('Нет связи со шлюзом. Запустите программу ещё раз.');
  }
  const value = await res.json();
  if (!res.ok) throw Error(value.error?.message || 'Ошибка подключения.');
  return value;
}
function pick(p) {
  profile = p;
  const z = p === 'zcode';
  for (const name of ['zcode', 'dsh']) $(name).setAttribute('aria-pressed', String(name === p));
  $('url').textContent = (state?.origin || location.origin) + (z ? '/v1' : '');
}
function render(data) {
  state = data;
  const ok = data.configured && data.limits && !data.problem;
  const exhausted = ok && Object.values(data.limits).some((x) => x.used_percent >= 100);
  $('headline').textContent = data.problem ? 'Проверить связь' : exhausted ? 'Лимит исчерпан' :
    ok ? 'Подключено' : data.configured ? 'Проверяем…' : 'Подключить';
  $('home').classList.remove('offline');
  $('quota').hidden = false;
  $('subtitle').hidden = true;
  $('manage').disabled = false;
  $('manage').title = data.configured ? 'Настроить аккаунт' : 'Подключить аккаунт';
  $('manage').classList.toggle('ready', Boolean(ok && !exhausted));
  $('refresh').hidden = !data.configured;
  $('model').textContent = data.model;
  for (const button of document.querySelectorAll('.copy')) button.disabled = false;
  renderLimits(data.problem ? null : data.limits, data.configured);
  pick(profile);
}
function renderLimits(limits, configured) {
  const hint = [];
  for (const [id, field, label] of [['hours', 'sliding_5h', 'За 5 часов'], ['week', 'weekly', 'За неделю']]) {
    const limit = limits?.[field];
    const value = Number.isFinite(limit?.used_percent) ? limit.used_percent : null;
    const percent = value === null ? 0 : Math.max(0, Math.min(100, value));
    const display = value === null ? '—' : value.toLocaleString('ru-RU', { maximumFractionDigits: 1 }) + ' %';
    $(id + '-value').textContent = display;
    $(id + '-ring').setAttribute('stroke-dasharray', percent + ' ' + (100 - percent));
    $(id).value = percent;
    $(id + '-reset').textContent = limit?.resets_at ? 'Обновится ' +
      new Date(limit.resets_at).toLocaleString('ru-RU', {day:'numeric', month:'short',hour:'2-digit',minute:'2-digit'}) : '';
    hint.push(label + ': ' + display);
  }
  $('quota').querySelector('summary').title = hint.join(' · ');
  $('quota-note').textContent = limits ? '' : configured ? 'Лимиты временно недоступны.' : 'Подключите аккаунт, чтобы увидеть лимиты.';
}
function offline(e) {
  $('home').classList.add('offline');
  $('quota').open = false;
  $('quota').hidden = true;
  $('headline').textContent = 'Панель недоступна';
  $('subtitle').textContent = e.message;
  $('subtitle').hidden = false;
  $('manage').disabled = true;
  $('manage').classList.remove('ready');
  renderLimits(null, Boolean(state?.configured));
  for (const button of document.querySelectorAll('.copy')) button.disabled = true;
}
for (const name of ['zcode', 'dsh']) $(name).onclick = () => pick(name);
for (const button of document.querySelectorAll('.copy'))
  button.onclick = async () => {
    const id = button.dataset.copy;
    try {
      await navigator.clipboard.writeText(id === 'key' ? state.localKey : $(id).textContent);
      toast('Скопировано');
    } catch {
      toast('Браузер заблокировал буфер обмена. Разрешите копирование.');
    }
  };
function showPage() {
  const auth = location.hash === '#account' && Boolean(state);
  const tools = location.hash === '#tools' && Boolean(state);
  $('tools').hidden = !tools;
  $('home').hidden = auth || tools;
  $('auth').hidden = !auth;
  $('quota').open = false;
  $('account').reset();
  $('error').textContent = '';
  if (auth) {
    $('remember').checked = !state.configured || state.saved;
    $('auth-state').textContent = state.problem?.message || (state.configured ? 'Аккаунт подключён' : 'Подключите аккаунт по API-ключу.');
    $('unlink').hidden = !state.configured;
    $('secret').placeholder = state.configured ? 'Введите новый ключ' : 'Вставьте ключ';
    $('connect').textContent = state.configured ? 'Заменить ключ' : 'Подключить';
    $('auth-title').focus();
  } else if (tools) {
    $('tools-title').focus();
  } else {
    $('manage').focus({preventScroll:true});
  }
}
$('manage').onclick = () => { location.hash = 'account'; };
window.addEventListener('hashchange', showPage);
document.addEventListener('click', event => {
  if (!$('quota').contains(event.target)) $('quota').open = false;
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && $('quota').open) {
    $('quota').open = false;
    $('quota').querySelector('summary').focus();
  }
});
async function account(remove) {
  pending = true;
  $('connect').disabled = $('unlink').disabled = true;
  $('error').textContent = '';
  $('connect').textContent = remove ? 'Отключаем…' : 'Проверяем…';
  try {
    render(
      await api(
        'account',
        remove ? 'DELETE' : 'POST',
        remove ? undefined : { key: $('secret').value, remember: $('remember').checked }
      )
    );
    $('secret').value = '';
    location.hash = 'home';
    toast(remove ? 'Аккаунт отключён' : 'Аккаунт подключён');
  } catch (e) {
    $('error').textContent = e.message;
  } finally {
    pending = false;
    $('connect').disabled = $('unlink').disabled = false;
    $('connect').textContent = state?.configured ? 'Заменить ключ' : 'Подключить';
  }
}
$('account').onsubmit = (e) => {
  e.preventDefault();
  account(false);
};
$('unlink').onclick = () => account(true);
async function update(check = false) {
  if (pending) return;
  pending = true;
  $('refresh').disabled = true;
  $('refresh').textContent = 'Проверяем…';
  try {
    render(await api(check ? 'refresh' : 'state', check ? 'POST' : 'GET'));
  } catch (e) {
    offline(e);
  } finally {
    pending = false;
    $('refresh').textContent = 'Обновить';
    $('refresh').disabled = false;
  }
}
$('refresh').onclick = () => update(true);
pick(profile);

try {
  const token = location.hash.slice(1);
  if (token && token !== 'account' && token !== 'home' && token !== 'tools') {
    history.replaceState(null, '', location.pathname);
    await api('session', 'POST', { token });
  }
  startToolMonitor(api);
  await update(true);
  showPage();
  setInterval(() => {
    if (!document.hidden && $('auth').hidden)
      update(Boolean(state?.configured && Date.now() - new Date(state.checked).getTime() > 60000));
  }, 5000);
} catch (e) {
  offline(e);
}
