// Private startup channel between the native window and its child process.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// A saved desktop profile keeps the same address and client key after a Finder
// launch or an update. Explicit overrides are reserved for isolated instances.
if (!process.env.RELAY_PORT && !process.env.RELAY_DATA_DIR) {
  const profile = join(homedir(), '.naparnik-relay', 'desktop');
  try {
    const port = readFileSync(join(profile, 'port'), 'utf8').trim();
    if (!/^[1-9][0-9]{0,4}$/.test(port) || Number(port) > 65535)
      throw Error('Некорректный порт в сохранённом профиле Naparnik Relay.');
    process.env.RELAY_PORT = port;
    process.env.RELAY_DATA_DIR = profile;
  } catch (error) {
    if (error.code !== 'ENOENT') {
      process.stdout.write(JSON.stringify({error: error.message}) + '\n');
      process.exit(1);
    }
  }
}

const { createServer } = await import('./server.js');
const { load, origin, port } = await import('./state.js');

const connection = load();
const server = createServer({connection});
server.once('error', error => {
  const message = error.code === 'EADDRINUSE'
    ? 'Порт ' + port + ' уже занят. Если запущена браузерная версия шлюза, остановите её командой npm stop и снова откройте приложение.'
    : 'Не удалось запустить локальный сервер: ' + error.message;
  process.stdout.write(JSON.stringify({error:message})+'\n');
  process.exitCode = 1;
});
server.listen(port,'127.0.0.1',() => {
  process.stdout.write(JSON.stringify({url:origin+'/#'+connection.admin})+'\n');
  // Quit even if the native process is killed without running its exit handler.
  process.stdin.resume();
  process.stdin.once('end',()=>{ server.close(); server.closeAllConnections(); });
});
