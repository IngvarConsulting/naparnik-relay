// Private startup channel between the native window and its child process.
import { createServer } from './server.js';
import { load, origin, port } from './state.js';

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
