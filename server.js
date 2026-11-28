import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Bridge, Fault, MODEL, defaultConversationSettings, normalize, requireInput, sessionBusy } from './bridge.js';
import { completion } from './formats.js';
import { join } from 'node:path';
import { SessionTitles } from './session-titles.js';
import { ToolMonitor } from './tool-monitor.js';
import { serverToolEnabled, serverToolOptions } from './server-tools.js';
import { redactTraceText, runTrace, TraceStore } from './trace-store.js';
import { load, save, port, origin, dir, SessionBindings } from './state.js';

const assets = new Map([
  ['/', ['index.html', 'text/html']],
  ['/app.js', ['app.js', 'text/javascript']],
  ['/panel.js', ['panel.js', 'text/javascript']],
  ['/before-sign-in.html', ['before-sign-in.html', 'text/html']],
  ['/auth-diagnostics.html', ['auth-diagnostics.html', 'text/html']],
  ['/auth-diagnostics.js', ['auth-diagnostics.js', 'text/javascript']],
  ['/tools.html', ['tools.html', 'text/html']],
  ['/tools.js', ['tools.js', 'text/javascript']],
  ['/trace.html', ['trace.html', 'text/html']],
  ['/trace.js', ['trace.js', 'text/javascript']],
  ['/trace-links.js', ['trace-links.js', 'text/javascript']],
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
const uuid = '[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}';
const compactRoute = new RegExp('^/v1/conversations/(' + uuid + ')/compact$');
const deleteConversationRoute = new RegExp('^/v1/conversations/(' + uuid + ')$');

function conversationSettings(value, defaults) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.keys(value).length) return;
  if (defaults) value = { ...defaults, ...value };
  if (Object.keys(value).length !== 3) return;
  const { ui_language, programming_language, script_language } = value;
  if (!['ru', 'en'].includes(ui_language) || !['ru', 'en'].includes(script_language) ||
      typeof programming_language !== 'string') return;
  const language = programming_language.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_.+#-]{0,31}$/.test(language)) return;
  return { ui_language, programming_language: language, script_language };
}

export function createServer({ connection = load(), upstream, persist = save, monitor = new ToolMonitor(), profileDir = dir,
  mode = 'standalone' } = {}) {
  const sessionTitles = new SessionTitles();
  const conversationQueue = new Map();
  const traces = new TraceStore();
  const traceConversations = new Map();
  const authorizationDiagnostics = new Map();
  function newBridge(key) {
    return new Bridge(upstream, key ? new SessionBindings(profileDir, key) : undefined, conversationQueue,
      name => serverToolEnabled(connection.serverTools, name));
  }
  let key = connection.upstream,
    bridge = newBridge(key),
    busy = false,
    deleting,
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
    message: e.message,
    ...(e.diagnosticId && { diagnosticId: e.diagnosticId })
  });
  async function checkAuthorization(candidate) {
    const secrets = [candidate, connection.localKey, connection.admin, key, cookie.split('=')[1]]
      .filter(value => typeof value === 'string' && value.length).sort((a, b) => b.length - a.length);
    const capture = new TraceStore({ maxPacketBytes: 16 * 1024, maxSideBytes: 36 * 1024 });
    const exchange = capture.begin({ authorization: true, secrets });
    try {
      requireInput(candidate.length && !/\s/.test(candidate), 'Введите API-ключ без пробелов.');
      return await runTrace(exchange, () => bridge.budget(candidate));
    } catch (e) {
      const failure = e instanceof Fault ? e : new Fault(500, 'internal_error', 'Не удалось проверить API-ключ.');
      const status = failure.status;
      const code = redactTraceText(String(failure.code), secrets).slice(0, 128);
      const message = redactTraceText(failure.message, secrets).slice(0, 512);
      const id = exchange.sessionId;
      const { time, upstream: packets } = capture.snapshot(id).exchanges[0];
      authorizationDiagnostics.set(id, { time, error: { status, code, message }, packets });
      if (authorizationDiagnostics.size > 12) authorizationDiagnostics.delete(authorizationDiagnostics.keys().next().value);
      throw Object.assign(new Fault(status, code, message), { diagnosticId: id });
    }
  }
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
        const value = await checkAuthorization(key);
        if (revision === generation) {
          limits = value;
          problem = null;
        }
      } catch (e) {
        if (revision === generation) problem = authProblem(e);
      } finally {
        if (revision === generation) {
          checked = new Date();
          refresh = null;
        }
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
    const nativeCompact = method === 'POST' && path?.match(compactRoute);
    const nativeDelete = method === 'DELETE' && path?.match(deleteConversationRoute);
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
      if (path === '/health' && method === 'GET') return send({ service: 'naparnik-relay', ready: true, mode });
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
          if (mode === 'desktop')
            throw new Fault(409, 'desktop_service', 'Завершите настольный Напарник через меню значка в трее.');
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
          if (method === 'PUT' || method === 'PATCH') {
            const value = await body(req);
            const input = conversationSettings(value, method === 'PATCH' ? conversationDefaults() : undefined);
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
        if (path === '/panel/auth-diagnostics' && method === 'GET') {
          const id = new URLSearchParams(req.url.slice(path.length)).get('attempt');
          const diagnostic = authorizationDiagnostics.get(id);
          if (!diagnostic) throw new Fault(404, 'not_found', 'Запись проверки авторизации недоступна.');
          return send(diagnostic);
        }
        if (path === '/panel/state' && method === 'GET') return send(status());
        if (path === '/panel/refresh' && method === 'POST') {
          await check();
          return send(status());
        }
        if (path === '/panel/account' && ['POST', 'DELETE'].includes(method)) {
          if (deleting) throw sessionBusy();
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
              const value = await checkAuthorization(candidate);
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
        if (nativeDelete) {
          if (!key) throw new Fault(503, 'account_required', 'Подключите 1С:Напарник в панели шлюза.');
          if (busy) throw sessionBusy();
          const conversation = nativeDelete[1].toLowerCase();
          // The tool journal retains raw client IDs even after the in-memory trace has expired.
          const sessionIds = new Set(monitor.records.sessions.map(({ protocol, id }) => JSON.stringify([protocol, id])));
          const sessionId = req.headers['x-session-id']?.trim();
          const harnessId = req.headers['x-deepseek-harness-session-id']?.trim();
          if (sessionId) {
            for (const protocol of ['OpenAI', 'Anthropic']) sessionIds.add(JSON.stringify([protocol, sessionId]));
          }
          if (harnessId) sessionIds.add(JSON.stringify(['Anthropic', harnessId]));
          const bindings = bridge.bindingsAfterDeletion(conversation, sessionIds);
          busy = true;
          deleting = { conversation, bindings };
          try {
            await bridge.deleteConversation(key, conversation, bindings);
            traces.deleteConversation(conversation);
            traceConversations.delete(conversation);
            if (!res.destroyed) send({ id: conversation, object: 'conversation.deleted', deleted: true });
          } finally {
            deleting = undefined;
            busy = false;
          }
          return;
        }
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
          if (deleting?.conversation === conversation) throw sessionBusy();
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
          const querySource = !anthropic && req.headers['x-zcode-query-source']?.trim();
          // ZCode's auxiliary completions can share the main turn's session ID.
          const sessionId = querySource && querySource !== 'main_turn'
            ? undefined : harnessId || req.headers['x-session-id']?.trim();
          const traceSessionId = sessionId ? JSON.stringify([protocol, sessionId]) : undefined;
          if (deleting?.bindings.has(traceSessionId)) throw sessionBusy();
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
            : !anthropic && (querySource || req.headers['x-zcode-session-type']) ? 'ZCode' : undefined;
          const session = monitor.observe(protocol, declared, sessionId, agent);
          const stream = input.stream === true;
          const format = completion(res, anthropic, stream, input.stream_options?.include_usage === true, trace, key);
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
              completeHistory: !harnessId && querySource !== 'main_turn' && req.headers['x-relay-input'] !== 'delta',
              onDraft: stream ? format.waiting : undefined,
              onConversation: id => {
                res.setHeader('X-Relay-Conversation-Id', id);
                if (revision === generation) {
                  trace.conversation(id);
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
        error = { error: { message: msg, type: code, code, ...(e.diagnosticId && { diagnosticId: e.diagnosticId }) } };
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
