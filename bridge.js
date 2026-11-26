import { createHash, createHmac, randomUUID } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { currentTrace } from './trace-store.js';

export const MODEL = 'naparnik';
export const defaultConversationSettings = Object.freeze({
  ui_language: 'ru', programming_language: '1c', script_language: 'ru'
});
export class Fault extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
export function requireInput(ok, message) {
  if (!ok) throw new Fault(400, 'invalid_request_error', message);
}
function textContent(value, separator = '\n') {
  if (typeof value === 'string') return value;
  requireInput(
    Array.isArray(value) && value.every((b) => b?.type === 'text' && typeof b.text === 'string'),
    'Шлюз принимает текстовые сообщения и клиентские инструменты.'
  );
  return value.map((b) => b.text).join(separator);
}
function assistant(content, calls = []) {
  requireInput(
    Array.isArray(calls) &&
      calls.every((c) => c?.id && c.function?.name && typeof c.function.arguments === 'string'),
    'Некорректный вызов инструмента.'
  );
  return {
    role: 'assistant',
    content: content || '',
    calls: calls.map((c) => ({ id: c.id, name: c.function.name, args: c.function.arguments }))
  };
}
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const clientStatuses = new Set(['ok', 'error', 'timeout', 'rejected', 'ignored']);

function harnessResults(log, sessionId) {
  const results = new Map();
  if (!sessionId || log?.session?.id !== sessionId || !Array.isArray(log.events)) return results;
  for (const event of log.events) {
    const message = event?.data?.message;
    if (event?.type === 'tool/result' && message?.role === 'tool' && typeof message.toolCallId === 'string')
      results.set(message.toolCallId, event.data);
  }
  return results;
}

function clientResult(id, result, event) {
  requireInput(typeof id === 'string' && id.length, 'Отсутствует ID вызова инструмента.');
  const message = event?.message;
  const status = result.status ?? message?.status ?? ((result.is_error ?? message?.isError) ? 'error' : 'ok');
  requireInput(clientStatuses.has(status), 'Неизвестный статус результата клиентского инструмента.');
  const nullable = status === 'ignored' || status === 'rejected';
  const content = nullable && result.content == null ? null : textContent(result.content ?? '');
  requireInput(status !== 'ignored' || content === null || content === '', 'Статус ignored предполагает пустой результат.');

  const structured = result.structured_content ?? result.structuredContent ??
    message?.structured_content ?? message?.structuredContent;
  let details = result.details ?? message?.details;
  if (details == null && (isObject(event?.meta) || isObject(event?.error))) {
    details = { ...event.meta };
    if (isObject(event.error)) details.error = event.error;
  }
  requireInput(structured == null || isObject(structured), 'Поле structured_content должно быть объектом.');
  requireInput(details == null || isObject(details), 'Поле details должно быть объектом.');
  return {
    role: 'tool', id, status, content: status === 'ignored' ? null : content,
    ...(structured != null && { structured_content: structured }),
    ...(details != null && { details })
  };
}

// Harness sends this title prompt through /v1/messages with its usual session header.
const titleInstruction = 'Create a concise title for an AI coding-assistant session from the supplied human messages.\n';
const titleInputPrefix = 'Generate the session title from this JSON array of human messages:\n';
const titleUpdatePrefix = 'Update the session title from this JSON object:\n';

function isHarnessTitleRequest(body, sessionId) {
  if (!sessionId || typeof body.system !== 'string' ||
      !body.system.startsWith(titleInstruction) || body.tools?.length ||
      body.messages.length !== 1 || body.messages[0].role !== 'user') return false;
  const content = body.messages[0].content;
  const text = typeof content === 'string' ? content :
    Array.isArray(content) && content.length === 1 && content[0]?.type === 'text' ? content[0].text : undefined;
  if (typeof text !== 'string') return false;
  const prefix = [titleInputPrefix, titleUpdatePrefix].find(value => text.startsWith(value));
  if (!prefix) return false;
  try {
    const input = JSON.parse(text.slice(prefix.length));
    const messages = prefix === titleInputPrefix ? input :
      typeof input?.currentTitle === 'string' ? input.messages : undefined;
    return Array.isArray(messages) && messages.length > 0 && messages.every(
      message => Number.isSafeInteger(message?.seq) && typeof message.text === 'string'
    );
  } catch {
    return false;
  }
}

export function normalize(body, anthropic, harnessSessionId) {
  requireInput(body && typeof body === 'object' && body.model === MODEL, 'Укажите модель naparnik.');
  if (anthropic) {
    const edits = body.context_management?.edits;
    requireInput((body.compaction === undefined || body.compaction === null) &&
      !(Array.isArray(edits) && edits.some(edit => edit?.type === 'compact_20260112')),
    'Компактизация Anthropic beta требует резюме. Для серверного сжатия используйте метод компактизации 1С.');
  }
  requireInput(Array.isArray(body.messages) && body.messages.length, 'Нужен массив messages.');
  requireInput(!body.n || body.n === 1, 'Поддерживается один ответ на запрос.');
  requireInput(
    !body.response_format || body.response_format.type === 'text',
    'Поддерживается текстовый формат ответа.'
  );
  const choice = body.tool_choice?.type ?? body.tool_choice;
  requireInput(
    !choice || ['none', 'auto'].includes(choice),
    'Доступен автоматический выбор инструмента или none.'
  );
  const events = harnessResults(body.dsh_session_log, anthropic && harnessSessionId);
  const messages = [];
  if (body.system) messages.push({ role: 'system', content: textContent(body.system) });
  for (const msg of body.messages) {
    requireInput(
      msg && ['user', 'assistant', 'system', 'developer', 'tool'].includes(msg.role),
      'Неизвестная роль сообщения.'
    );
    if (anthropic && Array.isArray(msg.content)) {
      if (msg.role === 'assistant') {
        const blocks = msg.content;
        requireInput(
          blocks.every((b) => ['text', 'tool_use', 'thinking', 'redacted_thinking'].includes(b?.type)),
          'Неизвестный блок ответа.'
        );
        messages.push(
          assistant(
            textContent(blocks.filter((b) => b.type === 'text'), ''),
            blocks
              .filter((b) => b.type === 'tool_use')
              .map((b) => ({ id: b.id, function: { name: b.name, arguments: JSON.stringify(b.input) } }))
          )
        );
      } else {
        for (const block of msg.content) {
          if (block?.type === 'tool_result') {
            messages.push(clientResult(block.tool_use_id, block, events.get(block.tool_use_id)));
          } else messages.push({ role: msg.role, content: textContent([block]) });
        }
      }
    } else if (msg.role === 'assistant')
      messages.push(assistant(textContent(msg.content ?? ''), msg.tool_calls));
    else if (msg.role === 'tool') {
      messages.push(clientResult(msg.tool_call_id, msg));
    } else messages.push({ role: msg.role, content: textContent(msg.content) });
  }
  requireInput(
    ['user', 'tool'].includes(messages.at(-1)?.role),
    'Завершите историю запросом пользователя или результатом инструмента.'
  );
  const supplied = choice === 'none' ? [] : (body.tools ?? []);
  requireInput(Array.isArray(supplied), 'Ожидается список инструментов.');
  const tools = supplied.map((t) => {
    const f = anthropic ? t : t?.function;
    requireInput(f && typeof f.name === 'string' && f.name.length, 'Инструменту нужно имя функции.');
    return {
      name: f.name,
      description: f.description || '',
      parameters: (anthropic ? f.input_schema : f.parameters) ?? { type: 'object', properties: {} }
    };
  });
  return { messages, tools, ...(isHarnessTitleRequest(body, anthropic && harnessSessionId) && { titleRequest: true }) };
}

const responseTraces = new WeakMap();
const packetSources = new WeakMap();

async function* packets(stream, signal, trace, clientToolNames) {
  const decoder = new TextDecoder();
  const done = Symbol();
  let buffer = '',
    lines = [];
  function parse() {
    const s = lines.join('\n');
    lines = [];
    if (!s) return;
    if (s === '[DONE]') {
      trace?.exchange.record('upstream', { kind: 'sse', body: s, call: trace.call });
      return done;
    }
    try {
      const packet = JSON.parse(s);
      if (trace) {
        const calls = packet?.finished === true && packet.role === 'assistant' ? packet.content?.tool_calls : undefined;
        let toolScope, serverToolIds;
        if (clientToolNames && Array.isArray(calls) && calls.length && calls.every(call => call?.function?.name)) {
          const serverCalls = calls.filter(call => !clientToolNames.has(call.function.name));
          toolScope = serverCalls.length === calls.length ? 'server' : serverCalls.length ? 'mixed' : 'client';
          serverToolIds = serverCalls.map(call => call.id).filter(id => typeof id === 'string' && id);
        }
        const id = trace.exchange.record('upstream', { kind: 'sse', body: packet, call: trace.call, toolScope, serverToolIds });
        if (isObject(packet) && id) packetSources.set(packet, id);
      }
      return packet;
    } catch {
      trace?.exchange.record('upstream', { kind: 'error', body: s, call: trace.call });
      throw new Fault(502, 'bad_stream', 'Напарник вернул повреждённое событие.');
    }
  }
  try {
    for await (const chunk of stream) {
      buffer += decoder.decode(chunk, { stream: true });
      let i;
      while ((i = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, i).replace(/\r$/, '');
        buffer = buffer.slice(i + 1);
        if (!line) {
          const data = parse();
          if (data === done) return;
          if (data) yield data;
        } else if (line.startsWith('data:')) lines.push(line.slice(5).replace(/^ /, ''));
      }
    }
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof Fault) throw error;
    throw Object.assign(new Fault(502, 'incomplete_stream', 'Поток Напарника прерван при передаче.'),
      { unreadEvent: Boolean(lines.length || (buffer && !buffer.startsWith(':'))) });
  }
  buffer += decoder.decode();
  if (lines.length || (buffer && !buffer.startsWith(':')))
    throw Object.assign(new Fault(502, 'incomplete_stream', 'Поток Напарника завершился посреди события.'),
      { unreadEvent: true });
}
const errorMessages = {
  invalid_token: 'Напарник отклонил API-ключ.',
  no_token: 'Напарнику нужен API-ключ.',
  token_not_found: 'API-ключ не найден.',
  budget_exceeded: 'Лимит Напарника исчерпан.',
  no_active_tariff: 'Для ключа нет активного тарифа.',
  rate_limit_exceeded: 'Слишком много запросов. Повторите позже.',
  conflict: 'Напарник ещё обрабатывает запрос в этом диалоге.',
  access_denied: 'Для ключа закрыт доступ к операции.',
  insufficient_context: 'Для названия пока недостаточно контекста.'
};
const upstreamErrorStatuses = new Map([
  ['no_token', 401], ['invalid_token', 401], ['token_not_found', 401],
  ['budget_exceeded', 402], ['no_active_tariff', 402],
  ['access_denied', 403], ['user_conversation_conflict', 403],
  ['resource_not_found', 404], ['conflict', 409], ['validation', 422],
  ['insufficient_context', 424], ['rate_limit_exceeded', 429],
  ['internal', 500], ['connection', 500], ['database', 500], ['llm', 500]
]);
function upstreamFault(status, data) {
  const code = data?.error_type || 'upstream_error';
  return new Fault(status, code, errorMessages[code] || 'Ошибка Напарника (' + code + ').');
}
const tokenCount = n => Number.isSafeInteger(n) && n >= 0;
function providerUsage(value) {
  if (!value || ![value.prompt_tokens, value.completion_tokens, value.total_tokens].every(tokenCount)) return null;
  const { prompt_tokens, completion_tokens, total_tokens, cached_tokens, reasoning_tokens } = value;
  return {
    prompt_tokens, completion_tokens, total_tokens,
    ...(tokenCount(cached_tokens) && cached_tokens <= prompt_tokens
      ? { prompt_tokens_details: { cached_tokens } } : {}),
    ...(tokenCount(reasoning_tokens) && reasoning_tokens <= completion_tokens
      ? { completion_tokens_details: { reasoning_tokens } } : {})
  };
}
function stableJson(value) {
  return JSON.stringify(value, (_key, item) => isObject(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]]))
    : item);
}

function canonicalArguments(args) {
  try {
    return stableJson(JSON.parse(args));
  } catch {
    return args;
  }
}

// Fingerprints let us match a replayed transcript without storing message text.
function transcriptFingerprints(key, messages, seed = '') {
  return messages.map(message => {
    // Harness may refresh the system prompt and omit old tool log metadata on replay.
    if (message.role === 'system' || message.role === 'developer') return seed;
    let normalized = message;
    if (message.role === 'tool') {
      normalized = { role: message.role, id: message.id, content: message.content ?? '' };
    } else if (message.role === 'assistant' && message.calls?.length) {
      normalized = { ...message, calls: message.calls.map(call => ({ ...call, args: canonicalArguments(call.args) })) };
    }
    seed = createHmac('sha256', key).update(seed).update(stableJson(normalized)).digest('hex');
    return seed;
  });
}

function sessionCheckpoint(fingerprint, { conversation, parent, serverDecisions, clientNames }) {
  return { fingerprint, conversation, parent, serverDecisions, clientNames: [...clientNames] };
}

function toolDecision(tool_call_id, enabled) {
  return { tool_call_id, status: enabled ? 'accepted' : 'rejected', content: null };
}

const recoveryPending = () => new Fault(409, 'recovery_pending',
  'Напарник мог сохранить сообщение. Повторите запрос, чтобы проверить наличие ответа.');
const recoveryUnavailable = () => new Fault(503, 'recovery_unavailable',
  'Не удалось сверить сообщение с историей Напарника. Повторите запрос позже.');
const digest = (key, value) => createHmac('sha256', key).update(stableJson(value)).digest('hex');
const inputDigest = (key, messages) => digest(key, messages.filter(message =>
  !['system', 'developer'].includes(message.role)));
const toolResults = content => Array.isArray(content) ? content : [content];
const savedToolContent = ({ tool_call_id, content, status, structured_content, details }) => ({
  tool_call_id, content: content ?? null, status,
  ...(structured_content != null && { structured_content }),
  ...(details != null && { details })
});
const interrupted = error => ['incomplete_stream', 'bad_stream', 'connection_error'].includes(error?.code);

function ignoredBeforeEcho(key, attempt, echo, byId, siblings) {
  const parent = byId.get(attempt.parent);
  const calls = parent?.role === 'assistant' && parent.content?.tool_calls;
  if (attempt.acks.length !== 1 || attempt.acks[0] !== echo.uuid || typeof echo.content !== 'string' ||
      digest(key, echo.content) !== attempt.content || !Array.isArray(calls)) throw recoveryPending();
  const callIds = new Set(calls.map(call => call?.id).filter(id => typeof id === 'string' && id));
  const ignoredIds = new Set();
  const ignoredRows = [];
  const seen = new Set([echo.uuid]);
  let id = echo.parent_uuid;
  while (id !== attempt.parent) {
    const row = byId.get(id);
    if (row?.role !== 'tool' || seen.has(id)) throw recoveryPending();
    const results = toolResults(row.content);
    if (!results.length) throw recoveryPending();
    for (const result of results) {
      const toolId = result?.tool_call_id;
      if (result?.status !== 'ignored' || !callIds.has(toolId) || ignoredIds.has(toolId))
        throw recoveryPending();
      ignoredIds.add(toolId);
    }
    ignoredRows.push(row);
    seen.add(id);
    id = row.parent_uuid;
  }
  ignoredRows.reverse();
  const observed = [...ignoredRows.map(row => row.uuid), echo.uuid];
  if (!observed.every((uuid, index) => attempt.finalIds[index] === uuid)) throw recoveryPending();
  const otherResults = siblings.filter(row => row.role === 'tool' && !seen.has(row.uuid));
  const otherToolIds = new Set(otherResults.flatMap(row => toolResults(row.content).map(result => result?.tool_call_id)));
  return { ignoredRows, ignoredIds, callIds, otherToolIds };
}

function resumesIgnoredCalls(messages, previous, attempt, reanchor) {
  if (!previous || previous.parent !== attempt.parent || messages[0]?.role !== 'tool') return false;
  const firstNonTool = messages.findIndex(message => message.role !== 'tool');
  const results = firstNonTool < 0 ? messages : messages.slice(0, firstNonTool);
  const returned = [...results.map(result => result.id), ...(previous.serverDecisions ?? []).map(item => item.tool_call_id)];
  const ids = new Set(returned);
  return ids.size === returned.length && returned.every(id => reanchor.callIds.has(id) && !reanchor.otherToolIds.has(id)) &&
    [...reanchor.ignoredIds].every(id => ids.has(id));
}

function extendsIgnoredRecovery(key, input, previous, recovery) {
  const [tool, restored] = recovery.posts;
  if (previous.conversation !== recovery.origin.conversation || previous.parent !== recovery.origin.parent ||
      recovery.posts.length !== 2 || tool.role !== 'tool' || !tool.ignoredToolRows?.length || restored.role !== 'user' ||
      !recovery.posts.every(post => post.complete && post.noGenerate) || input[0]?.role !== 'tool') return false;
  // ZCode can append a new user message to the original turn after the recovery was saved.
  for (let i = input.length - 1; i > 0 && input[i].role === 'user'; i--) {
    if (inputDigest(key, input.slice(0, i)) === recovery.fingerprint) return true;
  }
  return false;
}

function savedBranch(key, messages, attempt) {
  const byId = new Map();
  const children = new Map();
  for (const message of messages) {
    if (!message || typeof message.uuid !== 'string' || !message.uuid || byId.has(message.uuid) ||
        !(message.parent_uuid === null || typeof message.parent_uuid === 'string')) throw recoveryUnavailable();
    byId.set(message.uuid, message);
    const siblings = children.get(message.parent_uuid) ?? [];
    siblings.push(message);
    children.set(message.parent_uuid, siblings);
  }
  if (attempt.parent !== null && !byId.has(attempt.parent)) throw recoveryPending();
  const siblings = children.get(attempt.parent) ?? [];
  let roots;
  if (attempt.role === 'user') {
    roots = attempt.acks.length ? attempt.acks.map(id => byId.get(id)) : siblings.filter(
      row => row.role === 'user' && typeof row.content === 'string' && digest(key, row.content) === attempt.content
    );
  } else {
    roots = siblings.filter(row => row.role === 'tool' && toolResults(row.content).some(
      result => attempt.toolIds.includes(result?.tool_call_id) && (result.status !== 'ignored' ||
        !attempt.ignoredToolRows?.includes(row.uuid) || attempt.acks.includes(row.uuid))
    ));
    if (roots.length) {
      const results = roots.flatMap(row => toolResults(row.content));
      const byToolId = new Map(results.map(result => [result?.tool_call_id, result]));
      if (results.length !== attempt.toolIds.length || byToolId.size !== results.length ||
          !attempt.toolIds.every(id => byToolId.has(id))) throw recoveryPending();
      if (roots.some(row => !attempt.acks.includes(row.uuid))) {
        const content = attempt.toolIds.map(id => savedToolContent(byToolId.get(id)));
        if (digest(key, content) !== attempt.content) throw recoveryPending();
      }
    }
  }
  if (!roots.length) {
    if (attempt.acks.length || attempt.finalIds.length) throw recoveryPending();
    return null;
  }
  if (roots.some(row => row?.role !== attempt.role) ||
      (attempt.role === 'user' && roots.length !== 1) ||
      attempt.acks.some(id => !roots.some(row => row.uuid === id))) throw recoveryPending();
  let reanchor;
  if (roots.some(row => row.parent_uuid !== attempt.parent)) {
    if (attempt.role !== 'user') throw recoveryPending();
    reanchor = ignoredBeforeEcho(key, attempt, roots[0], byId, siblings);
  }
  if (attempt.role === 'user' && attempt.parent !== null && !attempt.acks.length &&
      !attempt.finalIds.length && !attempt.drafts.length) throw recoveryPending();

  const branch = [...(reanchor?.ignoredRows ?? []), ...roots];
  const seen = new Set(branch.map(row => row.uuid));
  let frontier = roots;
  while (!attempt.complete && !attempt.noGenerate) {
    const next = frontier.flatMap(row => children.get(row.uuid) ?? []).filter(row => row.role !== 'user');
    if (!next.length) break;
    if ((next.length > 1 && !next.every(row => row.role === 'tool')) || next.some(row => seen.has(row.uuid)))
      throw recoveryPending();
    for (const row of next) seen.add(row.uuid);
    branch.push(...next);
    frontier = next;
  }
  if (attempt.complete) {
    branch.push(...attempt.finalIds.filter(id => !seen.has(id)).map(id => {
      const row = byId.get(id);
      if (!row || row.role === 'user' || !seen.has(row.parent_uuid)) throw recoveryPending();
      seen.add(id);
      return row;
    }));
  }
  if (attempt.finalIds.some(id => !seen.has(id))) throw recoveryPending();
  return { rows: branch, reanchor };
}

const longOperationMs = 600_000;
const maxCheckpoints = 128;
const maxToolCallbacks = 128;
const relayToolPrefix = 'call_relay_';
const noTitleContext = () => new Fault(424, 'insufficient_context', 'Для названия нужен ответ в этом диалоге.');

export class Bridge {
  constructor(base = 'https://code.1c.ai/public/v1', sessions = new Map(), conversationQueue = new Map(),
    serverToolEnabled = () => true) {
    this.base = base;
    this.sessions = sessions;
    this.pending = new Map();
    this.conversationQueue = conversationQueue;
    this.serverToolEnabled = serverToolEnabled;
    this.toolCallbacks = new Map();
    this.sessionEvents = new EventEmitter().setMaxListeners(0);
  }
  async request(
    key, path, body, signal, stream = false, method = body === undefined ? 'GET' : 'POST',
    timeoutMs = stream ? longOperationMs : 20_000
  ) {
    const timeout = AbortSignal.timeout(timeoutMs);
    const exchange = currentTrace();
    let call;
    let response;
    try {
      const url = new URL(this.base + path);
      call = exchange?.record('upstream', {
        kind: 'request', method, path: url.pathname + url.search, body, source: exchange.requestId
      });
      response = await fetch(url, {
        method,
        redirect: 'error',
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        headers: {
          Authorization: 'Bearer ' + key,
          'Content-Type': 'application/json',
          Accept: stream ? 'text/event-stream' : 'application/json'
        },
        body: JSON.stringify(body)
      });
    } catch {
      exchange?.record('upstream', { kind: 'error', call, body: 'Нет связи с Напарником.' });
      throw new Fault(503, 'connection_error', 'Нет связи с Напарником. Проверьте сеть и повторите запрос.');
    }
    if (exchange) {
      const trace = { exchange, call };
      responseTraces.set(response, trace);
      if (stream && response.ok) {
        trace.response = exchange.record('upstream', { kind: 'response', call, status: response.status });
      } else {
        const json = response.json.bind(response);
        response.json = async () => {
          try {
            const data = await json();
            trace.response = exchange.record('upstream', { kind: 'response', call, status: response.status, body: data });
            return data;
          } catch (error) {
            exchange.record('upstream', { kind: 'error', call, status: response.status, body: 'Не удалось прочитать ответ JSON.' });
            throw error;
          }
        };
      }
    }
    if (!response.ok) throw upstreamFault(response.status, await response.json().catch(() => ({})));
    return response;
  }
  async budget(key, signal) {
    const { limits } = await (await this.request(key, '/budget', undefined, signal)).json();
    if (![limits?.sliding_5h, limits?.weekly].every((x) => Number.isFinite(x?.used_percent)))
      throw new Fault(502, 'bad_budget', 'Напарник вернул неизвестный формат лимитов.');
    return limits;
  }
  async inConversation(conversation, signal, run) {
    const id = conversation.toLowerCase();
    const operation = (this.conversationQueue.get(id) ?? Promise.resolve()).then(() => {
      signal.throwIfAborted();
      return run();
    });
    const settled = operation.catch(() => {});
    this.conversationQueue.set(id, settled);
    try {
      return await operation;
    } finally {
      if (this.conversationQueue.get(id) === settled) this.conversationQueue.delete(id);
    }
  }

  async compact(key, conversation, input, signal) {
    return this.inConversation(conversation, signal, async () => {
      const path = '/conversations/' + encodeURIComponent(conversation) + '/compact';
      // Once sent, compaction can still be running in 1C after the caller disconnects.
      const unknown = () => new Fault(503, 'compaction_outcome_unknown',
        'Связь с Напарником прервалась. Результат компактизации неизвестен.');
      let response;
      try {
        response = await this.request(key, path, input, undefined, false, 'POST', longOperationMs);
      } catch (error) {
        if (error.code === 'connection_error') throw unknown();
        throw error;
      }
      let result;
      try {
        result = await response.json();
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw unknown();
      }
      const status = result?.result?.status;
      if (result?.success !== true || !['compact_finished', 'compact_limited'].includes(status)) {
        throw new Fault(502, 'bad_compaction', 'Напарник вернул неизвестный результат компактизации.');
      }
      return { success: true, result: { status } };
    });
  }

  async generateTitle(key, id, signal) {
    if (!id) throw noTitleContext();
    // The built-in Harness provider allows 60 seconds for a title request.
    const deadline = AbortSignal.timeout(55_000);
    const titleSignal = AbortSignal.any([signal, deadline]);
    if (!this.pending.has(id) && !this.sessions.get(id)) {
      // Harness can launch the title request before the first chat request reaches us.
      const arrival = AbortSignal.any([titleSignal, AbortSignal.timeout(5000)]);
      try {
        await once(this.sessionEvents, 'started:' + id, { signal: arrival });
      } catch (error) {
        signal.throwIfAborted();
        if (arrival.aborted) throw noTitleContext();
        throw error;
      }
    }
    if (this.pending.has(id)) {
      try {
        await once(this.sessionEvents, 'settled:' + id, { signal: titleSignal });
      } catch (error) {
        signal.throwIfAborted();
        if (deadline.aborted) throw noTitleContext();
        throw error;
      }
    }
    let binding = this.sessions.get(id);
    if (!binding) throw noTitleContext();
    for (;;) {
      signal.throwIfAborted();
      if (deadline.aborted) throw noTitleContext();
      const path = '/conversations/' + encodeURIComponent(binding.conversation) + '/title';
      let response;
      try {
        response = await this.request(key, path, undefined, titleSignal, false, 'POST');
      } catch (error) {
        signal.throwIfAborted();
        if (error.status !== 424 || error.code !== 'insufficient_context') throw error;
        const latest = this.sessions.get(id);
        if (latest?.conversation === binding.conversation && latest.parent === binding.parent) {
          // Keep the original Harness request available to receive the retry's result.
          try {
            await once(this.sessionEvents, 'saved:' + id, { signal: titleSignal });
          } catch (waitError) {
            signal.throwIfAborted();
            if (deadline.aborted) throw error;
            throw waitError;
          }
        }
        binding = this.sessions.get(id);
        if (!binding) throw error;
        continue;
      }
      const result = await response.json().catch(() => null);
      if (typeof result?.title !== 'string' || !result.title.trim())
        throw new Fault(502, 'bad_title', 'Напарник не вернул название диалога.');
      const title = assistant(result.title.trim());
      const source = responseTraces.get(response)?.response;
      if (source) packetSources.set(title, source);
      return title;
    }
  }

  async generate(key, payload, signal, onPart, onServerCall = () => {}, onMetrics) {
    const { protocol, sessionId, messages, titleRequest } = payload;
    const id = sessionId ? JSON.stringify([protocol, sessionId]) : null;
    if (titleRequest) {
      const reply = await this.generateTitle(key, id, signal);
      await onPart(reply, signal, packetSources.get(reply));
      return reply;
    }
    if (!id) return this.generateWithoutSession(key, payload, signal, onPart, onServerCall, onMetrics);
    const run = async () => {
      signal.throwIfAborted();
      const stored = id && this.sessions.get(id);
      const checkpoints = stored?.checkpoints ?? [];
      const lastAssistant = messages.findLastIndex(message => message.role === 'assistant');
      const seed = lastAssistant < 0 ? checkpoints.at(-1)?.fingerprint : undefined;
      const fingerprints = id ? transcriptFingerprints(key, messages, seed) : [];
      let previous = stored?.parent ? stored : undefined;
      let from = 0;
      if (previous && lastAssistant >= 0) {
        if (stored.checkpoints === undefined) {
          // The old profile has a cursor but no fingerprints. Learn its history from the first replay.
          checkpoints.push(sessionCheckpoint(fingerprints[lastAssistant], stored));
          from = lastAssistant + 1;
        } else {
          const byFingerprint = new Map(checkpoints.map(checkpoint => [checkpoint.fingerprint, checkpoint]));
          const index = messages.findLastIndex((message, i) =>
            message.role === 'assistant' && byFingerprint.has(fingerprints[i]));
          previous = index < 0 ? undefined : { ...stored, ...byFingerprint.get(fingerprints[index]) };
          from = index + 1;
        }
      }
      const input = messages.slice(from);
      const recoveries = stored?.recoveries ?? [];
      const fingerprint = recoveries.length ? inputDigest(key, input) : undefined;
      const reference = previous ?? (stored?.parent === null ? stored : undefined);
      const candidates = recoveries.filter(item => reference
        ? item.base.conversation === reference.conversation && item.base.parent === reference.parent
        : item.fingerprint === fingerprint);
      if (!reference && candidates.length > 1) throw recoveryPending();
      const exact = candidates.find(item => item.fingerprint === fingerprint);
      const extensions = !exact && previous ? candidates.filter(item => extendsIgnoredRecovery(key, input, previous, item)) : [];
      if (extensions.length > 1) throw recoveryPending();
      const recovery = exact ?? extensions[0] ?? candidates[0];
      const retry = Boolean(exact || extensions.length);
      const otherRecoveries = recoveries.filter(item => item !== recovery);
      const recoveryFingerprint = fingerprint ?? inputDigest(key, input);
      const onRecovery = (origin, posts) => {
        if (!posts.length) {
          if (stored) this.sessions.set(id, stored);
          else this.sessions.delete(id);
          return;
        }
        this.sessions.set(id, {
          ...(stored ?? origin), recoveries: [...otherRecoveries, {
            fingerprint: recoveryFingerprint, origin, posts: structuredClone(posts),
            base: recovery?.base ?? { conversation: origin.conversation, parent: reference?.parent ?? null }
          }]
        });
      };
      const { reply, state } = await this.generateTurn(key, {
        ...payload, messages: input, recovery, retry, onRecovery
      }, previous, signal, onPart, onServerCall, onMetrics);
      if (id) {
        const [fingerprint] = transcriptFingerprints(key, [reply], fingerprints.at(-1));
        const checkpoint = sessionCheckpoint(fingerprint, state);
        const retained = checkpoints.filter(saved => saved.fingerprint !== fingerprint).slice(1 - maxCheckpoints);
        state.checkpoints = [...retained, checkpoint];
        if (otherRecoveries.length) state.recoveries = otherRecoveries;
        this.sessions.set(id, state);
        this.sessionEvents.emit('saved:' + id);
      }
      return reply;
    };
    // Read the cursor only after the preceding turn has finished.
    const turn = (this.pending.get(id) ?? Promise.resolve()).then(run);
    const settled = turn.catch(() => {});
    this.pending.set(id, settled);
    this.sessionEvents.emit('started:' + id);
    try {
      return await turn;
    } finally {
      if (this.pending.get(id) === settled) {
        this.pending.delete(id);
        this.sessionEvents.emit('settled:' + id);
      }
    }
  }

  async generateWithoutSession(key, payload, signal, onPart, onServerCall, onMetrics) {
    const { messages, protocol } = payload;
    const account = createHash('sha256').update(key).digest('hex');
    const lastAssistant = messages.findLastIndex(message => message.role === 'assistant');
    const start = lastAssistant >= 0 ? lastAssistant + 1 :
      messages.findIndex(message => message.role !== 'system' && message.role !== 'developer');
    const tail = messages.slice(start);
    const publicResult = tail.find(message => message.role === 'tool' && message.id.startsWith(relayToolPrefix));
    let callback, input = messages;
    if (publicResult) {
      const group = publicResult.id.slice(0, publicResult.id.lastIndexOf('_'));
      callback = this.toolCallbacks.get(group);
      requireInput(callback?.account === account && callback.protocol === protocol,
        'Не найден исходный вызов инструмента для этого запроса.');
      const results = tail.filter(message => message.role === 'tool');
      requireInput(results.length === callback.ids.size && new Set(results.map(message => message.id)).size === results.length &&
        results.every((message, i) => message === tail[i] && callback.ids.has(message.id)),
        'Передайте результаты всех инструментов из одного ответа сразу после вызовов.');
      requireInput(lastAssistant < 0 ||
        transcriptFingerprints(key, [messages[lastAssistant]])[0] === callback.fingerprint,
        'Результаты инструментов не соответствуют сообщению ассистента.');
      input = [...results.map(message => ({ ...message, id: callback.ids.get(message.id) })), ...tail.slice(results.length)];
    }

    const group = relayToolPrefix + randomUUID();
    const ids = new Map();
    const publicCallId = upstreamId => {
      const id = group + '_' + ids.size;
      ids.set(id, upstreamId);
      return id;
    };
    const { reply, state } = await this.generateTurn(
      key, { ...payload, messages: input, publicCallId }, callback?.state, signal, onPart, onServerCall, onMetrics
    );
    if (ids.size) {
      const [fingerprint] = transcriptFingerprints(key, [reply]);
      this.toolCallbacks.set(group, { account, protocol, state, ids, fingerprint });
      if (this.toolCallbacks.size > maxToolCallbacks) this.toolCallbacks.delete(this.toolCallbacks.keys().next().value);
    }
    return reply;
  }

  async generateTurn(key, payload, previous, signal, onPart, onServerCall, onMetrics) {
    signal = AbortSignal.any([signal, AbortSignal.timeout(longOperationMs)]);
    const { recovery, retry, onRecovery } = payload;
    const matchedPrevious = previous;
    if (recovery && (retry || !previous)) previous = recovery.origin;
    let conversation = previous?.conversation;
    if (!conversation) {
      const created = await (
        await this.request(
          key,
          '/conversations',
          payload.conversationDefaults ?? defaultConversationSettings,
          signal
        )
      ).json();
      if (typeof created?.uuid !== 'string' || !created.uuid)
        throw new Fault(502, 'missing_conversation', 'Напарник не вернул идентификатор диалога.');
      conversation = created.uuid;
    }
    payload.onConversation?.(conversation);
    return this.inConversation(conversation, signal, async () => {
      let ignoredToolRows;
      if (recovery && !retry) {
        // Resolve the outstanding write before a different message can extend the branch.
        for (const attempt of [...recovery.posts].reverse()) {
          const saved = await this.readSavedBranch(key, conversation, signal, attempt);
          if (!saved) continue;
          if (saved.reanchor) {
            if (recovery.posts.length !== 1 || attempt.complete || attempt.noGenerate ||
                !resumesIgnoredCalls(payload.messages, matchedPrevious, attempt, saved.reanchor)) throw recoveryPending();
            // The ignored results belong to the auxiliary user branch. Continue at the original tool call.
            ignoredToolRows = saved.reanchor.ignoredRows.map(row => row.uuid);
            break;
          }
          const last = saved.rows.at(-1);
          if (last.role === 'tool' || last.content?.tool_calls?.length || payload.messages[0]?.role === 'tool')
            throw recoveryPending();
          previous = { ...recovery.origin, parent: last.uuid, serverDecisions: [] };
          const prefix = payload.messages.findIndex((_message, index) =>
            inputDigest(key, payload.messages.slice(0, index + 1)) === recovery.fingerprint);
          if (prefix >= 0) payload = { ...payload, messages: payload.messages.slice(prefix + 1) };
          break;
        }
      }
      const origin = {
        conversation, parent: previous?.parent ?? null, serverDecisions: previous?.serverDecisions ?? [],
        clientNames: [...(previous?.clientNames ?? [])]
      };
      const posts = retry ? structuredClone(recovery.posts) : [];
      const trackPosts = onRecovery && (() => onRecovery(origin, posts));
      return this.generateInConversation(key, { ...payload, trackPosts, ignoredToolRows }, previous, conversation, signal,
        onPart, onServerCall, onMetrics, posts);
    });
  }

  async readSavedBranch(key, conversation, signal, attempt) {
    let history, source;
    try {
      const response = await this.request(key, '/conversations/' + encodeURIComponent(conversation),
        undefined, signal, false, 'GET', 5000);
      history = await response.json();
      source = responseTraces.get(response)?.response;
    } catch {
      signal.throwIfAborted();
      throw recoveryUnavailable();
    }
    if (history?.uuid !== conversation || !Array.isArray(history.messages)) throw recoveryUnavailable();
    const saved = savedBranch(key, history.messages, attempt);
    if (source) for (const row of saved?.rows ?? []) packetSources.set(row, source);
    return saved;
  }

  async *messagePackets(key, conversation, body, signal, {
    posts, index, clientToolNames, serverDecisions, trackPosts, ignoredToolRows
  }) {
    const signature = digest(key, body);
    const previous = posts[index];
    const recovered = async attempt => {
      const branch = (await this.readSavedBranch(key, conversation, signal, attempt))?.rows;
      if (!branch) return null;
      const last = branch.at(-1);
      const completed = new Set(branch.map(row => row.uuid));
      const toolIds = new Set(branch.filter(row => row.role === 'tool').flatMap(
        row => toolResults(row.content).map(result => result?.tool_call_id)
      ));
      if (!attempt.complete && !attempt.noGenerate && (last.role !== 'assistant' || !isObject(last.content) ||
          (!last.content.content && !last.content.tool_calls?.length) ||
          (attempt.unreadEvent && attempt.finalIds.includes(last.uuid)) ||
          attempt.drafts.some(id => !completed.has(id)) || attempt.running.some(id => !toolIds.has(id))))
        throw recoveryPending();
      return branch.map(row => {
        const packet = { ...row, finished: true };
        const source = packetSources.get(row);
        if (source) packetSources.set(packet, source);
        return packet;
      });
    };
    if (previous) {
      if (previous.role !== body.role || previous.parent !== body.parent_uuid || previous.noGenerate !== body.no_generate)
        throw recoveryPending();
      const rows = await recovered(previous);
      if (rows) {
        // Older recovery records did not retain what the user POST declared as client tools.
        if (previous.role === 'user' && previous.clientNames === undefined && previous.signature !== signature &&
            rows.some(row => row.role === 'assistant' && row.content?.tool_calls?.length)) throw recoveryPending();
        previous.complete = true;
        previous.finalIds = rows.map(row => row.uuid);
        trackPosts?.();
        yield* rows;
        return;
      }
      if (previous.signature !== signature) throw recoveryPending();
    }

    signal.throwIfAborted();
    const excluded = previous?.ignoredToolRows ?? ignoredToolRows;
    const attempt = posts[index] = {
      signature, role: body.role, parent: body.parent_uuid, noGenerate: body.no_generate,
      content: digest(key, body.content), toolIds: body.role === 'tool' ? body.content.map(item => item.tool_call_id) : [],
      acks: [], finalIds: [], drafts: [], running: [], unreadEvent: false, sent: true, complete: false,
      ...(body.role === 'user' && { clientNames: (body.tools ?? []).map(tool => tool.name) }),
      ...(excluded?.length && { ignoredToolRows: excluded }),
      ...(serverDecisions?.length && { serverDecisions })
    };
    // A crash during POST leaves an ambiguous write. Record it before entering fetch.
    trackPosts?.();
    const drafts = new Set();
    const running = new Set();
    const finalizedAnswers = new Map();
    const saveProgress = () => {
      attempt.drafts = [...drafts];
      attempt.running = [...running];
      trackPosts?.();
    };
    let answered = false, received = false;
    try {
      const response = await this.request(key, '/conversations/' + encodeURIComponent(conversation) + '/messages',
        body, signal, true);
      received = true;
      for await (const packet of packets(response.body, signal, responseTraces.get(response), clientToolNames)) {
        if (packet.error_type || packet.error)
          throw upstreamFault(upstreamErrorStatuses.get(packet.error_type) ?? 502, packet);
        if (!packet.uuid) {
          const id = packet.content_delta?.tool_call_id;
          if (!packet.finished && typeof id === 'string' && id && !running.has(id)) {
            running.add(id);
            saveProgress();
          }
        } else if (!packet.finished) {
          if (packet.content_delta && (packet.role == null || packet.role === 'assistant') && !drafts.has(packet.uuid)) {
            drafts.add(packet.uuid);
            saveProgress();
          }
        } else {
          attempt.finalIds.push(packet.uuid);
          if (!answered && packet.role === body.role && (body.role === 'user' ||
              toolResults(packet.content).some(result => attempt.toolIds.includes(
                result?.tool_call_id ?? packet.details?.tool_call_id)))) attempt.acks.push(packet.uuid);
          if (packet.role === 'tool') {
            for (const result of toolResults(packet.content)) running.delete(result?.tool_call_id ?? packet.details?.tool_call_id);
          }
          if (packet.role === 'assistant' && packet.content) {
            drafts.delete(packet.uuid);
            answered = true;
            finalizedAnswers.set(packet.uuid, digest(key, [packet.content.content || '', packet.content.tool_calls ?? []]));
          }
          saveProgress();
        }
        yield packet;
      }
      if (drafts.size || running.size || !attempt.finalIds.length || (!body.no_generate && !answered))
        throw new Fault(502, 'incomplete_stream', 'Поток Напарника завершился до ответа.');
      attempt.complete = true;
      saveProgress();
    } catch (error) {
      const rejectionStatus = upstreamErrorStatuses.get(error?.code);
      if (!received && !signal.aborted && rejectionStatus === error?.status && rejectionStatus < 500) {
        // A documented HTTP rejection before SSE did not create this message.
        if (previous) posts[index] = previous;
        else posts.splice(index, 1);
        trackPosts?.();
        throw error;
      }
      if (signal.aborted || interrupted(error)) {
        attempt.unreadEvent = error.unreadEvent === true || error.code === 'bad_stream';
        saveProgress();
      }
      if (signal.aborted || !interrupted(error)) throw error;
      let rows;
      try {
        rows = await recovered(attempt);
      } catch (historyError) {
        if (historyError.code !== 'recovery_unavailable') throw historyError;
      }
      if (!rows) throw error;
      const delivered = new Set(attempt.finalIds);
      const lastDelivered = rows.findLastIndex(row => delivered.has(row.uuid));
      const prefix = rows.slice(0, lastDelivered + 1);
      if (prefix.some(row => row.role === 'assistant' && (!delivered.has(row.uuid) ||
          finalizedAnswers.get(row.uuid) !== digest(key, [row.content?.content || '', row.content?.tool_calls ?? []]))) ||
          prefix.filter(row => delivered.has(row.uuid)).some((row, position) => row.uuid !== attempt.finalIds[position]))
        throw recoveryPending();
      attempt.complete = true;
      attempt.finalIds = rows.map(row => row.uuid);
      drafts.clear();
      running.clear();
      saveProgress();
      yield* rows.slice(lastDelivered + 1);
    }
  }

  async generateInConversation(
    key, { messages, tools, publicCallId, onDraft, trackPosts, ignoredToolRows }, previous, conversation, signal,
    onPart, onServerCall, onMetrics, posts
  ) {
    // The provider reserves tool names (including ZCode's TodoWrite). Give
    // client tools their own wire names and restore them in public responses.
    signal = AbortSignal.any([signal, AbortSignal.timeout(600000)]);
    const wireNames = new Map();
    const wireTools = tools.map((tool) => {
      const digest = createHash('sha256').update(tool.name).digest('hex').slice(0, 12);
      const shortName = tool.name.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 44);
      const wireName = /^[A-Za-z0-9_-]{1,55}$/.test(tool.name)
        ? 'client_' + tool.name
        : 'cx_' + shortName + '_' + digest;
      wireNames.set(wireName, tool.name);
      return { ...tool, name: wireName };
    });
    const knownClientNames = new Set([...(previous?.clientNames ?? []), ...wireNames.keys(),
      ...posts.flatMap(post => post.clientNames ?? [])]);
    let parent = previous?.parent ?? null;
    const turns = [];
    for (const msg of messages) {
      // Only results immediately after the matched response have a matching upstream call.
      if (previous && msg.role === 'tool' && (!turns.length || turns.at(-1)?.role === 'tool')) {
        const { role, id, ...result } = msg;
        const item = { tool_call_id: id, ...result };
        if (turns.at(-1)?.role === 'tool') turns.at(-1).content.push(item);
        else turns.push({ role: 'tool', content: [item] });
      } else {
        const chunk = msg.role === 'user' ? msg.content : JSON.stringify(msg);
        if (turns.at(-1)?.role === 'user') turns.at(-1).content += '\n\n' + chunk;
        else turns.push({ role: 'user', content: chunk });
      }
    }
    if (previous?.serverDecisions?.length && turns[0]?.role === 'tool') {
      turns[0].serverDecisions = previous.serverDecisions.map(({ name, ...decision }) =>
        name ? toolDecision(decision.tool_call_id, this.serverToolEnabled(name)) : decision);
    }
    const reviewed = new Set((previous?.serverDecisions ?? []).map((item) => item.tool_call_id));
    let serverDecisions = [];
    let lastAssistant, usage, context;
    let text = '',
      calls = [];
    for (const [i, { serverDecisions: proposed, ...turn }] of turns.entries()) {
      signal.throwIfAborted();
      const last = i === turns.length - 1;
      const priorIgnored = !i && turn.role === 'tool' ? posts[i]?.ignoredToolRows ?? ignoredToolRows : undefined;
      const body = { ...turn, parent_uuid: turn.parent_uuid ?? parent, no_generate: !last || Boolean(priorIgnored?.length) };
      const decisions = proposed && (posts[i]?.serverDecisions ?? proposed);
      if (decisions) body.content = [...turn.content, ...decisions];
      if (turn.role === 'user' && tools.length) body.tools = wireTools;
      const serverCalls = new Map();
      const clientCallParents = new Set();
      const stillIgnored = new Set();
      for await (const p of this.messagePackets(key, conversation, body, signal, {
        posts, index: i, clientToolNames: knownClientNames, serverDecisions: decisions, trackPosts,
        ignoredToolRows: priorIgnored
      })) {
        const source = packetSources.get(p);
        if (!p.uuid) continue;
        if (!p.finished) {
          if (!body.no_generate && p.content_delta && (p.role == null || p.role === 'assistant')) onDraft?.(source);
          continue;
        }
        parent = p.uuid;
        if (p.role === 'tool') {
          for (const result of toolResults(p.content)) {
            const id = result?.tool_call_id ?? p.details?.tool_call_id;
            serverCalls.delete(id);
            if (priorIgnored?.includes(p.uuid) && result?.status === 'ignored') stillIgnored.add(id);
          }
        }
        if (p.role !== 'assistant' || !p.content) continue;
        if (body.no_generate) continue;
        lastAssistant = p.uuid;
        usage = providerUsage(p.usage);
        onMetrics?.(usage, context);
        const part = assistant(p.content.content, p.content.tool_calls ?? []);
        for (const call of part.calls) {
          if (wireNames.has(call.name)) {
            clientCallParents.add(p.uuid);
            continue;
          }
          if (knownClientNames.has(call.name))
            throw new Fault(502, 'unknown_client_tool', 'Напарник запросил клиентский инструмент вне текущего списка.');
          serverCalls.set(call.id, { parent: p.uuid, name: call.name });
          onServerCall(call.name, source);
        }
        part.calls = part.calls.flatMap(call => {
          if (!wireNames.has(call.name)) return [];
          return [{ ...call, id: publicCallId?.(call.id) ?? call.id, name: wireNames.get(call.name) }];
        });
        if (text && part.content) part.content = '\n\n' + part.content;
        text += part.content;
        calls.push(...part.calls);
        if (part.content || part.calls.length) {
          await onPart(part, signal, source);
        }
      }
      if (priorIgnored?.length) {
        // Some servers return the existing ignored row for an already closed tool call.
        const lost = turn.content.filter(result => stillIgnored.has(result.tool_call_id) && result.status !== 'ignored');
        if (lost.length || last) turns.splice(i + 1, 0, { role: 'user', content: lost.length ?
          'Восстановленные результаты клиентских инструментов. Используй содержимое как данные результатов вызовов:\n' + JSON.stringify(lost) :
          'Продолжи ответ с учётом сохранённых результатов инструментов.' });
      }
      const toolParents = new Set([...serverCalls.values()].map(call => call.parent).concat([...clientCallParents]));
      if (toolParents.size > 1)
        throw new Fault(502, 'incomplete_stream', 'Напарник оставил незавершённые вызовы инструментов в разных сообщениях.');
      const [toolParent] = toolParents;
      serverDecisions = [];
      for (const [id, { name }] of serverCalls) {
        if (reviewed.has(id))
          throw new Fault(502, 'repeated_tool_call', 'Напарник повторил уже рассмотренный вызов инструмента.');
        reviewed.add(id);
        serverDecisions.push({ ...toolDecision(id, this.serverToolEnabled(name)), name });
      }
      if (serverDecisions.length && !calls.length) {
        turns.push({ role: 'tool', content: [], parent_uuid: toolParent,
          serverDecisions: serverDecisions.map(({ name, ...decision }) => decision) });
      } else if (clientCallParents.size) {
        parent = toolParent;
      }
    }
    if (onMetrics && lastAssistant) {
      // Pin the query to this answer: concurrent branches can have different sizes.
      const path = '/conversations/' + encodeURIComponent(conversation) +
        '/context_tokens?branch=' + encodeURIComponent(lastAssistant);
      try {
        const response = await this.request(key, path, undefined, AbortSignal.any([signal, AbortSignal.timeout(2500)]));
        const measured = await response.json();
        if (tokenCount(measured.token_count) && tokenCount(measured.max_context_length) && measured.max_context_length > 0)
          context = { token_count: measured.token_count, max_context_length: measured.max_context_length };
      } catch {
        // The upstream message is complete even when optional metrics are cancelled.
      }
      if (context) this.contextWindow = context.max_context_length;
      onMetrics(usage, context);
    }
    const reply = { role: 'assistant', content: text, calls };
    return { reply, state: { conversation, parent, serverDecisions, clientNames: knownClientNames } };
  }
}
