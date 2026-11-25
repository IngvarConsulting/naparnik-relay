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
function draw(connected) {
  const ctx = $('cable').getContext('2d');
  ctx.resetTransform();
  ctx.clearRect(0, 0, 960, 420);
  ctx.scale(2, 2);
  ctx.translate(244, 103);
  ctx.rotate(-0.27);
  // Machined collars and two exposed contacts move together when the link is live.
  function metal(x, y, w, h, colors, r = 4) {
    const grad = ctx.createLinearGradient(0, y, 0, y + h);
    colors.forEach(([p, c]) => grad.addColorStop(p, c));
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
    ctx.fillStyle = grad;
    ctx.fill();
  }
  const rubber = [
    [0, '#1b3430'],
    [0.13, '#6b8375'],
    [0.35, '#38594b'],
    [0.64, '#243f35'],
    [1, '#0e2721']
  ];
  const body = [
    [0, '#accb9c'],
    [0.07, '#e0f0b5'],
    [0.23, '#d7eab2'],
    [0.45, '#bfd59e'],
    [0.52, '#a8c18a'],
    [0.85, '#91ac77'],
    [1, '#718e65']
  ];
  const steel = [
    [0, '#719180'],
    [0.17, '#e0eade'],
    [0.35, '#f1f3de'],
    [0.44, '#addebd'],
    [0.66, '#788d7c'],
    [1, '#405c51']
  ];
  const gold = [
    [0, '#ab9558'],
    [0.22, '#fff0ac'],
    [0.39, '#efd991'],
    [0.72, '#b79b5e'],
    [1, '#716948']
  ];
  function end(female) {
    ctx.save();
    if (female) ctx.scale(-1, 1);
    ctx.translate(connected ? 18 : -12, 0);
    metal(-350, -11, 247, 22, rubber, 7);
    metal(-154, -19, 52, 38, rubber, 7);
    for (let i = 0; i < 5; i++) metal(-151 + i * 8, -18 - i * 0.5, 4, 36 + i, rubber, 1);
    metal(-118, -29, 66, 58, body, 8);
    metal(-65, -32, 37, 64, body, 5);
    for (let i = 0; i < 6; i++)
      metal(
        -62 + i * 5,
        -30,
        2,
        60,
        [
          [0, '#c7ddaa'],
          [0.55, '#94aa80'],
          [1, '#6c8668']
        ],
        1
      );
    if (female) metal(-29, -25, 12, 50, rubber, 3);
    else {
      metal(-29, -20, 22, 40, steel, 2);
      metal(-8, -11, 22, 22, gold, 2);
      metal(7, -11, 2, 22, rubber, 1);
    }
    ctx.restore();
  }
  end(false);
  end(true);
}
function pick(p) {
  profile = p;
  const z = p === 'zcode';
  for (const name of ['zcode', 'dsh']) $(name).setAttribute('aria-pressed', String(name === p));
  $('guide').textContent = z
    ? 'Model settings → Add provider → Create custom provider. Выберите формат Chat Completions.'
    : 'Settings → Models → DeepSeek → Customized settings. Вставьте Base URL и локальный ключ, затем нажмите Add model.';
  $('tip').textContent = z
    ? 'Добавьте модель по её ID и нажмите Test model.'
    : 'Укажите naparnik в поле ID, любое название во втором поле. Нажмите Apply и выберите эту модель в сессии.';
  $('url').textContent = (state?.origin || location.origin) + (z ? '/v1' : '');
}
function render(data) {
  state = data;
  const ok = data.configured && data.limits && !data.problem;
  const exhausted = ok && Object.values(data.limits).some((x) => x.used_percent >= 100);
  $('headline').textContent = data.problem
    ? 'Нужна проверка'
    : exhausted
      ? 'Лимит исчерпан'
      : ok
        ? 'Аккаунт подключён'
        : data.configured
          ? 'Проверяем аккаунт'
          : 'Подключите Напарника';
  $('subtitle').textContent =
    data.problem?.message ||
    (exhausted
      ? 'Дождитесь обновления лимита.'
      : ok
        ? 'Шлюз готов принимать запросы от ваших ИИ-клиентов.'
        : data.configured
          ? 'Запрашиваем состояние лимитов.'
          : 'Введите API-ключ, чтобы использовать модель в своём ИИ-клиенте.');
  $('local').textContent = 'Шлюз запущен';
  $('local').classList.remove('off');
  $('actions').hidden = false;
  $('manage').textContent = data.configured ? 'Настроить аккаунт' : 'Подключить аккаунт';
  $('refresh').hidden = !data.configured;
  $('signal').classList.toggle('on', Boolean(ok && !exhausted));
  $('model').textContent = data.model;
  for (const button of document.querySelectorAll('.copy')) button.disabled = false;
  for (const [id, field] of [
    ['hours', 'sliding_5h'],
    ['week', 'weekly']
  ]) {
    const limit = data.limits?.[field];
    $(id + '-value').textContent = limit
      ? limit.used_percent.toLocaleString('ru-RU', { maximumFractionDigits: 1 }) + ' %'
      : '—';
    $(id).value = limit?.used_percent || 0;
    $(id + '-reset').textContent = limit?.resets_at
      ? 'Обновится ' +
        new Date(limit.resets_at).toLocaleString('ru-RU', {
          day: 'numeric',
          month: 'short',
          hour: '2-digit',
          minute: '2-digit'
        })
      : '';
  }
  $('checked').textContent = data.checked
    ? 'Проверено в ' + new Date(data.checked).toLocaleTimeString('ru-RU') + ' · Использованная доля лимита'
    : 'Лимиты появятся после подключения аккаунта.';
  $('empty').hidden = Boolean(data.recent.length);
  $('counter').textContent = data.recent.length ? String(data.recent.length) : '';
  $('rows').replaceChildren(
    ...data.recent.map((r) => {
      const li = document.createElement('li');
      for (const text of [
        new Date(r.time).toLocaleTimeString('ru-RU'),
        r.protocol,
        r.outcome,
        (r.duration / 1000).toFixed(1) + ' с'
      ]) {
        const span = document.createElement('span');
        span.textContent = text;
        li.append(span);
      }
      return li;
    })
  );
  draw(Boolean(ok && !exhausted));
  pick(profile);
}
function offline(e) {
  $('headline').textContent = 'Панель недоступна';
  $('subtitle').textContent = e.message;
  $('local').textContent = 'Нет подключения';
  $('local').classList.add('off');
  $('actions').hidden = true;
  $('signal').classList.remove('on');
  draw(false);
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
$('manage').onclick = () => {
  $('account').reset();
  $('error').textContent = '';
  $('remember').checked = state.saved;
  $('modal-title').textContent = state.configured ? 'Настроить аккаунт' : 'Подключить аккаунт';
  $('unlink').hidden = !state.configured;
  $('dialog').showModal();
  $('secret').focus();
};
$('close').onclick = () => $('dialog').close();
$('dialog').onclose = () => {
  $('secret').value = '';
};
async function account(remove) {
  pending = true;
  $('connect').disabled = $('unlink').disabled = true;
  $('error').textContent = '';
  $('connect').textContent = 'Проверяем…';
  try {
    render(
      await api(
        'account',
        remove ? 'DELETE' : 'POST',
        remove ? undefined : { key: $('secret').value, remember: $('remember').checked }
      )
    );
    $('dialog').close();
    toast(remove ? 'Аккаунт отключён' : 'Аккаунт подключён');
  } catch (e) {
    $('error').textContent = e.message;
  } finally {
    pending = false;
    $('connect').disabled = $('unlink').disabled = false;
    $('connect').textContent = 'Проверить и подключить';
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
draw(false);
try {
  const token = location.hash.slice(1);
  if (token) {
    history.replaceState(null, '', location.pathname);
    await api('session', 'POST', { token });
  }
  await update(true);
  setInterval(() => {
    if (!document.hidden && !$('dialog').open)
      update(Boolean(state?.configured && Date.now() - new Date(state.checked).getTime() > 60000));
  }, 5000);
} catch (e) {
  offline(e);
}
