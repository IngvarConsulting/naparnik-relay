import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Bridge, Fault, MODEL, normalize, requireInput } from './bridge.js';
import { completion } from './formats.js';
import { load, save, port, origin } from './state.js';

const assets = new Map([
  ['/', ['index.html', 'text/html']],
  ['/app.js', ['app.js', 'text/javascript']],
  ['/style.css', ['style.css', 'text/css']],
  ['/icon.svg', ['icon.svg', 'image/svg+xml']],
  ['/naparnik.svg', ['naparnik.svg', 'image/svg+xml']],
  ['/ingvar-consulting.png', ['ingvar-consulting.png', 'image/png']]
]);
async function body(req) {
  let size = 0;
  const parts = [];
  for await (const part of req) {
    size += part.length;
    if (size > 16 * 1024 * 1024) throw new Fault(413, 'request_too_large', 'Запрос превышает 16 МБ.');
    parts.push(part);
  }
  try {
    return JSON.parse(Buffer.concat(parts).toString());
  } catch {
    throw new Fault(400, 'invalid_json', 'Ожидается JSON.');
  }
}
export function createServer({ connection = load(), upstream, persist = save } = {}) {
  let bridge = new Bridge(upstream),
    key = connection.upstream,
    busy = false,
    revision = 0;
  let limits = null,
    checked = null,
    problem = null,
    recent = [],
    refresh;
  const cookie = 'relay_session=' + randomBytes(32).toString('hex');
  const authProblem = (e) => ({
    status: e.status || 503,
    code: e.code || 'connection_error',
    message: e.message
  });
  function reset() {
    revision++;
    bridge = new Bridge(upstream);
    limits = checked = problem = refresh = null;
    recent = [];
  }
  async function check() {
    if (!key) return;
    if (refresh) return refresh;
    const generation = revision;
    refresh = (async () => {
      try {
        const value = await bridge.budget(key);
        if (revision === generation) {
          limits = value;
          checked = new Date();
          problem = null;
        }
      } catch (e) {
        if (revision === generation) {
          problem = authProblem(e);
          limits = null;
          checked = new Date();
        }
      } finally {
        if (revision === generation) refresh = null;
      }
    })();
    return refresh;
  }
  function status() {
    return {
      configured: Boolean(key),
      saved: Boolean(connection.upstream),
      limits,
      checked,
      problem,
      recent,
      origin,
      model: MODEL,
      localKey: connection.localKey
    };
  }
  const server = http.createServer(async (req, res) => {
    const path = req.url?.split('?')[0],
      method = req.method;
    const anthropic = path === '/v1/messages';
    const send = (data, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'"
    );
    try {
      if (
        req.headers.host !== '127.0.0.1:' + req.socket.localPort ||
        (req.headers.origin && req.headers.origin !== 'http://' + req.headers.host)
      )
        throw new Fault(403, 'forbidden', 'Доступ разрешён с локального адреса шлюза.');
      if (method === 'GET' && assets.has(path)) {
        const [file, type] = assets.get(path);
        const data = await readFile(new URL('./public/' + file, import.meta.url));
        res.writeHead(200, { 'Content-Type': type + '; charset=utf-8' });
        res.end(data);
        return;
      }
      if (path === '/health' && method === 'GET') return send({ service: 'naparnik-relay', ready: true });
      if (path.startsWith('/panel/')) {
        if (req.headers['x-relay-panel'] !== '1')
          throw new Fault(403, 'forbidden', 'Откройте панель через программу запуска.');
        if (path === '/panel/session' && method === 'POST' && (await body(req))?.token === connection.admin) {
          res.setHeader('Set-Cookie', cookie + '; HttpOnly; SameSite=Strict; Path=/panel');
          return send({ ok: true });
        }
        if (!req.headers.cookie?.split(/;\s*/).includes(cookie))
          throw new Fault(
            401,
            'panel_login',
            'Откройте панель через «Запустить Напарник.command» или npm start.'
          );
        if (path === '/panel/stop' && method === 'POST') {
          send({ stopping: true });
          server.close();
          return;
        }
        if (path === '/panel/state' && method === 'GET') return send(status());
        if (path === '/panel/refresh' && method === 'POST') {
          await check();
          return send(status());
        }
        if (path === '/panel/account' && ['POST', 'DELETE'].includes(method)) {
          if (busy) throw new Fault(409, 'busy', 'Изменение подключения уже выполняется.');
          busy = true;
          try {
            if (method === 'DELETE') {
              const next = { ...connection, upstream: '' };
              persist(next);
              connection = next;
              key = '';
              reset();
            } else {
              const input = await body(req),
                candidate = typeof input?.key === 'string' ? input.key.trim() : '';
              requireInput(
                typeof candidate === 'string' && candidate.length && !/\s/.test(candidate),
                'Введите API-ключ без пробелов.'
              );
              const value = await bridge.budget(candidate);
              const next = { ...connection, upstream: input.remember ? candidate : '' };
              persist(next);
              connection = next;
              key = candidate;
              reset();
              limits = value;
              checked = new Date();
            }
            return send(status());
          } finally {
            busy = false;
          }
        }
      }
      if (path.startsWith('/v1/')) {
        if (
          !(
            req.headers.authorization === 'Bearer ' + connection.localKey ||
            req.headers['x-api-key'] === connection.localKey
          )
        )
          throw new Fault(401, 'authentication_error', 'Скопируйте локальный API key из панели.');
        if (path === '/v1/models' && method === 'GET')
          return send({
            object: 'list',
            data: [{ id: MODEL, object: 'model', created: 0, owned_by: 'naparnik-relay' }]
          });
        if ((anthropic || path === '/v1/chat/completions') && method === 'POST') {
          if (!key) throw new Fault(503, 'account_required', 'Подключите 1С:Напарник в панели шлюза.');
          const input = await body(req),
            payload = normalize(input, anthropic);
          const format = completion(res, anthropic, input.stream === true, payload.messages);
          const abort = new AbortController();
          res.on('close', () => {
            if (!res.writableEnded) abort.abort();
          });
          const start = Date.now(),
            generation = revision;
          let outcome = 'Готово';
          try {
            const answer = await bridge.generate(key, payload, abort.signal, format.part);
            format.finish(answer);
          } catch (e) {
            outcome = abort.signal.aborted ? 'Отменён' : e.message;
            if (generation === revision && [401, 402, 403, 503].includes(e.status)) {
              problem = authProblem(e);
              checked = new Date();
            }
            throw e;
          } finally {
            if (generation === revision) {
              recent.unshift({
                time: new Date(),
                protocol: anthropic ? 'Anthropic' : 'OpenAI',
                duration: Date.now() - start,
                outcome
              });
              recent.length = Math.min(12, recent.length);
            }
          }
          return;
        }
      }
      throw new Fault(404, 'not_found', 'Маршрут не найден.');
    } catch (e) {
      if (res.destroyed || res.writableEnded) return;
      const status = e.status || 500,
        code = e.code || 'internal_error';
      const msg = e instanceof Fault ? e.message : 'Не удалось обработать запрос.';
      const error = anthropic
        ? {
            type: 'error',
            error: {
              type:
                {
                  400: 'invalid_request_error',
                  401: 'authentication_error',
                  403: 'permission_error',
                  429: 'rate_limit_error'
                }[status] || 'api_error',
              message: msg
            }
          }
        : { error: { message: msg, type: code, code } };
      if (res.headersSent) {
        res.end((anthropic ? 'event: error\n' : '') + 'data: ' + JSON.stringify(error) + '\n\n');
      } else send(error, status);
    }
  });
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createServer()
    .on('error', (e) => {
      console.error('Ошибка запуска:', e.message);
      process.exitCode = 1;
    })
    .listen(port, '127.0.0.1', () => console.log('Напарник · ' + origin));
}
