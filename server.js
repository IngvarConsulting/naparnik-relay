import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Bridge, Fault, MODEL, defaultConversationSettings, normalize, requireInput } from './bridge.js';
import { completion } from './formats.js';
import { join } from 'node:path';
import { SessionTitles } from './session-titles.js';
import { ToolMonitor } from './tool-monitor.js';
import { serverToolEnabled, serverToolOptions } from './server-tools.js';
import { runTrace, TraceStore } from './trace-store.js';
import { load, save, port, origin, dir, SessionBindings } from './state.js';

const assets = new Map([
  ['/', ['index.html', 'text/html']],
  ['/app.js', ['app.js', 'text/javascript']],
  ['/panel.js', ['panel.js', 'text/javascript']],
  ['/tools.html', ['tools.html', 'text/html']],
  ['/tools.js', ['tools.js', 'text/javascript']],
  ['/trace.html', ['trace.html', 'text/html']],
  ['/trace.js', ['trace.js', 'text/javascript']],
  ['/trace-scroll.js', ['trace-scroll.js', 'text/javascript']],
  ['/trace-syntax.js', ['trace-syntax.js', 'text/javascript']],
  ['/style.css', ['style.css', 'text/css']],
  ['/icon.svg', ['icon.svg', 'image/svg+xml']],
  ['/naparnik.svg', ['naparnik.svg', 'image/svg+xml']],
  ['/ingvar-consulting.png', ['ingvar-consulting.png', 'image/png']]
]);
async function body(req, allowEmpty = false) {
  let size = 0;
  const parts = [];
  for await (const part of req) {
    size += part.length;
    if (size > 16 * 1024 * 1024) throw new Fault(413, 'request_too_large', 'Запрос превышает 16 МБ.');
    parts.push(part);
  }
  if (allowEmpty && size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(parts).toString());
  } catch {
    throw new Fault(400, 'invalid_json', 'Ожидается JSON.');
  }
}
const anthropicErrorTypes = new Map([
  [400, 'invalid_request_error'], [401, 'authentication_error'], [402, 'billing_error'],
  [403, 'permission_error'], [404, 'not_found_error'], [409, 'conflict_error'],
  [413, 'request_too_large'], [429, 'rate_limit_error'], [529, 'overloaded_error']
]);

function conversationSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 3) return;
  const { ui_language, programming_language, script_language } = value;
  if (!['ru', 'en'].includes(ui_language) || !['ru', 'en'].includes(script_language) ||
      typeof programming_language !== 'string') return;
  const language = programming_language.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_.+#-]{0,31}$/.test(language)) return;
  return { ui_language, programming_language: language, script_language };
}

export function createServer({ connection = load(), upstream, persist = save, monitor = new ToolMonitor(), profileDir = dir } = {}) {
  const sessionTitles = new SessionTitles();
  const conversationQueue = new Map();
  const traces = new TraceStore();
  const traceConversations = new Map();
  function newBridge(key) {
    return new Bridge(upstream, key ? new SessionBindings(profileDir, key) : undefined, conversationQueue,
      name => serverToolEnabled(connection.serverTools, name));
  }
  let key = connection.upstream,
    bridge = newBridge(key),
    busy = false,
    revision = 0,
    accountLifetime = new AbortController();
  let limits = null,
    checked = null,
    problem = null,
    recent = [],
    refresh;
  const cookie = 'relay_session=' + randomBytes(32).toString('hex');
  function beginTrace(protocol, sessionId, title) {
    return traces.begin({ protocol, sessionId, title,
      secrets: [connection.localKey, connection.admin, key, cookie.split('=')[1]] });
  }
  function toolOptions() {
    return { tools: serverToolOptions(connection.serverTools, monitor.records) };
  }
  const conversationDefaults = () => conversationSettings(connection.conversationDefaults) ?? defaultConversationSettings;
  const authProblem = (e) => ({
    status: e.status || 503,
    code: e.code || 'connection_error',
    message: e.message
  });
  function reset() {
    revision++;
    accountLifetime.abort();
    accountLifetime = new AbortController();
    bridge = newBridge(key);
    limits = checked = problem = refresh = null;
    recent = [];
    traces.clear();
    traceConversations.clear();
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
    const nativeCompact = method === 'POST' &&
      path?.match(/^\/v1\/conversations\/([0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12})\/compact$/);
    const models = path === '/v1/models' || path?.startsWith('/v1/models/');
    const anthropic = path === '/v1/messages' || path === '/v1/messages/count_tokens' ||
      (models && typeof req.headers['anthropic-version'] === 'string');
    let trace;
    const send = (data, status = 200) => {
      trace?.record('client', { kind: 'response', status, body: data });
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
        if (path === '/panel/tools') {
          if (method === 'GET') return send(toolOptions());
          if (method === 'PUT') {
            const input = await body(req);
            requireInput(typeof input?.enabled === 'boolean' && toolOptions().tools.some(tool => tool.id === input?.id),
              'Укажите серверный инструмент и состояние переключателя.');
            const next = { ...connection, serverTools: { ...connection.serverTools, [input.id]: input.enabled } };
            persist(next);
            connection = next;
            return send(toolOptions());
          }
        }
        if (path === '/panel/conversation-defaults') {
          if (method === 'GET') return send(conversationDefaults());
          if (method === 'PUT') {
            const input = conversationSettings(await body(req));
            requireInput(input, 'Выберите русский или английский язык и укажите код языка программирования.');
            const next = { ...connection, conversationDefaults: input };
            persist(next);
            connection = next;
            return send(input);
          }
        }
        if (path === '/panel/tool-history' && method === 'GET') return send(await sessionTitles.snapshot(monitor.records));
        if (path === '/panel/trace' && method === 'GET') {
          const selector = new URLSearchParams(req.url.slice(path.length)).get('session');
          return send(traces.snapshot(selector));
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
        const { localKey } = connection;
        if (typeof localKey !== 'string' || !localKey ||
            (req.headers.authorization !== 'Bearer ' + localKey && req.headers['x-api-key'] !== localKey))
          throw new Fault(401, 'authentication_error', 'Скопируйте локальный API key из панели.');
        if (nativeCompact) {
          const credential = key, activeBridge = bridge;
          if (!credential) throw new Fault(503, 'account_required', 'Подключите 1С:Напарник в панели шлюза.');
          const abort = new AbortController();
          const signal = AbortSignal.any([abort.signal, accountLifetime.signal]);
          res.once('close', () => {
            if (!res.writableEnded) abort.abort();
          });
          const input = await body(req, true);
          const conversation = nativeCompact[1].toLowerCase();
          const linked = traceConversations.get(conversation);
          trace = beginTrace(linked?.protocol ?? '1С', linked?.id ?? conversation, 'Компактизация');
          trace.requestId = trace.record('client', { kind: 'request', method, path, body: input });
          requireInput(input && typeof input === 'object' && !Array.isArray(input) &&
            Object.keys(input).every(name => name === 'instruction') &&
            (input.instruction === undefined || typeof input.instruction === 'string'),
          'Ожидается объект с необязательной строкой instruction.');
          const result = await runTrace(trace, () => activeBridge.compact(credential, conversation, input, signal));
          if (!res.destroyed) send(result);
          return;
        }
        if (models && method === 'GET') {
          const context = bridge.contextWindow ? { context_length: bridge.contextWindow } : {};
          const model = anthropic
            ? { id: MODEL, type: 'model', created_at: '1970-01-01T00:00:00Z', display_name: '1С:Напарник', ...context }
            : { id: MODEL, object: 'model', created: 0, owned_by: 'naparnik-relay', ...context };
          if (path === '/v1/models/' + MODEL) return send(model);
          if (path !== '/v1/models') throw new Fault(404, 'model_not_found', 'Модель не найдена.');
          if (!anthropic) return send({ object: 'list', data: [model] });

          const query = new URLSearchParams(req.url.slice(path.length));
          const before = query.get('before_id');
          const after = query.get('after_id');
          requireInput((before === null || after === null) &&
            (before ?? after ?? MODEL) === MODEL, 'Укажите корректный курсор списка моделей.');
          const empty = before !== null || after !== null;
          const cursor = empty ? null : MODEL;
          return send({ data: empty ? [] : [model], first_id: cursor, last_id: cursor, has_more: false });
        }
        if ((path === '/v1/messages' || path === '/v1/chat/completions') && method === 'POST') {
          if (!key) throw new Fault(503, 'account_required', 'Подключите 1С:Напарник в панели шлюза.');
          const harnessId = anthropic && req.headers['x-deepseek-harness-session-id']?.trim();
          const input = await body(req);
          const protocol = anthropic ? 'Anthropic' : 'OpenAI';
          const sessionId = harnessId || req.headers['x-session-id']?.trim();
          const traceSessionId = sessionId ? JSON.stringify([protocol, sessionId]) : undefined;
          trace = beginTrace(protocol, traceSessionId);
          trace.requestId = trace.record('client', { kind: 'request', method, path, body: input });
          const payload = normalize(input, anthropic, harnessId);
          if (!payload.titleRequest) {
            const text = payload.messages.find(message => message.role === 'user' && message.content.trim())?.content;
            if (text) trace.initialTitle(text.replace(/\s+/g, ' ').trim());
          }
          const declared = Array.isArray(input.tools)
            ? input.tools.map(t => (anthropic ? t : t?.function)?.name).filter(name => typeof name === 'string')
            : undefined;
          const agent = anthropic && req.headers['x-deepseek-harness-session-id'] ? 'DeepSeek Harness'
            : !anthropic && req.headers['x-zcode-session-type'] ? 'ZCode' : undefined;
          const session = monitor.observe(protocol, declared, sessionId, agent);
          const stream = input.stream === true;
          const format = completion(res, anthropic, stream, input.stream_options?.include_usage === true, trace);
          const abort = new AbortController();
          res.on('close', () => {
            if (!res.writableEnded) {
              trace.record('client', { kind: 'error', body: 'Клиент закрыл соединение.' });
              abort.abort();
            }
          });
          const start = Date.now(),
            generation = revision;
          let outcome = 'Готово';
          try {
            const signal = AbortSignal.any([abort.signal, accountLifetime.signal]);
            const answer = await runTrace(trace, () => bridge.generate(key, {
              ...payload, protocol, sessionId, conversationDefaults: conversationDefaults(),
              onDraft: stream ? format.waiting : undefined,
              onConversation: id => {
                res.setHeader('X-Relay-Conversation-Id', id);
                if (revision === generation) {
                  const conversation = id.toLowerCase();
                  traceConversations.delete(conversation);
                  traceConversations.set(conversation, { id: trace.sessionId, protocol });
                  if (traceConversations.size > 120) traceConversations.delete(traceConversations.keys().next().value);
                }
              }
            }, signal, format.part, (name, source) => {
              format.waiting(source);
              monitor.serverCall(protocol, name, session);
            }, format.metrics));
            if (payload.titleRequest) trace.rename(answer.content);
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
      const upstreamStatus = e.status || 500;
      const clientAPI = !nativeCompact && path?.startsWith('/v1/');
      const openAIQuota = clientAPI && !anthropic && upstreamStatus === 402;
      const status = openAIQuota ? 429 : clientAPI && upstreamStatus === 422 ? 400 : upstreamStatus;
      const code = openAIQuota ? 'insufficient_quota' : e.code || 'internal_error';
      const msg = e instanceof Fault ? e.message : 'Не удалось обработать запрос.';
      let error;
      if (nativeCompact) {
        error = { error: msg, error_type: code };
      } else if (anthropic) {
        error = { type: 'error', error: { type: anthropicErrorTypes.get(status) ?? 'api_error', message: msg } };
      } else if (clientAPI) {
        const type = openAIQuota ? 'insufficient_quota' :
          status >= 500 ? 'server_error' :
          status === 429 ? 'rate_limit_error' :
          status === 401 ? 'authentication_error' :
          status === 403 ? 'permission_error' : 'invalid_request_error';
        error = { error: { message: msg, type, param: null, code } };
      } else {
        error = { error: { message: msg, type: code, code } };
      }
      if (res.headersSent) {
        trace?.record('client', { kind: 'sse', event: anthropic ? 'error' : undefined, body: error });
        res.end((anthropic ? 'event: error\n' : '') + 'data: ' + JSON.stringify(error) + '\n\n');
      } else send(error, status);
    }
  });
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createServer({ monitor: new ToolMonitor(join(dir, 'tools.json')) })
    .on('error', (e) => {
      console.error('Ошибка запуска:', e.message);
      process.exitCode = 1;
    })
    .listen(port, '127.0.0.1', () => console.log('Напарник · ' + origin));
}
