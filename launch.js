import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { load, origin } from './state.js';

async function running() {
  try {
    const response = await fetch(origin + '/health', { signal: AbortSignal.timeout(600) });
    const health = await response.json();
    return response.ok && health.service === 'naparnik-relay' ? health : null;
  } catch {
    return null;
  }
}
const state = load();
if (process.argv.includes('--stop')) {
  const health = await running();
  if (health?.mode === 'desktop') {
    console.error('Завершите настольный Напарник через меню значка в трее.');
    process.exit(1);
  }
  if (health) {
    const headers = { 'Content-Type': 'application/json', 'X-Relay-Panel': '1' };
    const auth = await fetch(origin + '/panel/session', {
      method: 'POST',
      headers,
      body: JSON.stringify({ token: state.admin })
    });
    if (!auth.ok) throw Error('Не удалось подтвердить доступ к шлюзу.');
    headers.Cookie = auth.headers.get('set-cookie').split(';')[0];
    const response = await fetch(origin + '/panel/stop', { method: 'POST', headers });
    if (!response.ok) throw Error('Не удалось остановить шлюз.');
  }
  console.log('Шлюз остановлен для новых подключений.');
  process.exit(0);
}
if (!(await running())) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./server.js', import.meta.url))], {
    detached: true,
    stdio: 'ignore'
  });
  child.unref();
  for (let i = 0; i < 35 && !(await running()); i++) await new Promise((resolve) => setTimeout(resolve, 100));
}
if (!(await running())) throw Error('Шлюз не запустился. Проверьте порт командой npm run serve.');
const url = origin + '/#' + state.admin;
const opener =
  process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'rundll32' : 'xdg-open';
const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
spawn(opener, args, { stdio: 'ignore' }).on('error', () => console.error('Не удалось открыть браузер.'));
console.log('Панель Напарника открыта · ' + origin);
