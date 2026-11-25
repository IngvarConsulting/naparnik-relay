import { createHash, createHmac, randomUUID } from 'node:crypto';
import { EventEmitter, once } from 'node:events';

export const MODEL = 'naparnik';
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

async function* packets(stream, signal) {
  const decoder = new TextDecoder();
  let buffer = '',
    lines = [];
  function parse() {
    const s = lines.join('\n');
    lines = [];
    if (!s || s === '[DONE]') return;
    try {
      return JSON.parse(s);
    } catch {
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
          if (data) yield data;
        } else if (line.startsWith('data:')) lines.push(line.slice(5).replace(/^ /, ''));
      }
    }
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof Fault) throw error;
    throw new Fault(502, 'incomplete_stream', 'Поток Напарника прерван при передаче.');
  }
  buffer += decoder.decode();
  if (lines.length || (buffer && !buffer.startsWith(':')))
    throw new Fault(502, 'incomplete_stream', 'Поток Напарника завершился посреди события.');
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

const longOperationMs = 600_000;
const maxCheckpoints = 128;
const maxToolCallbacks = 128;
const relayToolPrefix = 'call_relay_';
const noTitleContext = () => new Fault(424, 'insufficient_context', 'Для названия нужен ответ в этом диалоге.');

export class Bridge {
  constructor(base = 'https://code.1c.ai/public/v1', sessions = new Map(), conversationQueue = new Map()) {
    this.base = base;
    this.sessions = sessions;
    this.pending = new Map();
    this.conversationQueue = conversationQueue;
    this.toolCallbacks = new Map();
    this.sessionEvents = new EventEmitter().setMaxListeners(0);
  }
  async request(
    key, path, body, signal, stream = false, method = body === undefined ? 'GET' : 'POST',
    timeoutMs = stream ? longOperationMs : 20_000
  ) {
    const timeout = AbortSignal.timeout(timeoutMs);
    let response;
    try {
      response = await fetch(this.base + path, {
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
      throw new Fault(503, 'connection_error', 'Нет связи с Напарником. Проверьте сеть и повторите запрос.');
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
      return assistant(result.title.trim());
    }
  }

  async generate(key, payload, signal, onPart, onServerCall = () => {}, onMetrics) {
    const { protocol, sessionId, messages, titleRequest } = payload;
    const id = sessionId ? JSON.stringify([protocol, sessionId]) : null;
    if (titleRequest) {
      const reply = await this.generateTitle(key, id, signal);
      onPart(reply);
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
      let previous = stored;
      let from = 0;
      if (stored && lastAssistant >= 0) {
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
      const { reply, state } = await this.generateTurn(
        key, { ...payload, messages: messages.slice(from) }, previous, signal, onPart, onServerCall, onMetrics
      );
      if (id) {
        const [fingerprint] = transcriptFingerprints(key, [reply], fingerprints.at(-1));
        const checkpoint = sessionCheckpoint(fingerprint, state);
        const retained = checkpoints.filter(saved => saved.fingerprint !== fingerprint).slice(1 - maxCheckpoints);
        state.checkpoints = [...retained, checkpoint];
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
    let conversation = previous?.conversation;
    if (!conversation) {
      const created = await (
        await this.request(
          key,
          '/conversations',
          { ui_language: 'ru', programming_language: '1c', script_language: 'ru' },
          signal
        )
      ).json();
      if (typeof created?.uuid !== 'string' || !created.uuid)
        throw new Fault(502, 'missing_conversation', 'Напарник не вернул идентификатор диалога.');
      conversation = created.uuid;
    }
    payload.onConversation?.(conversation);
    return this.inConversation(conversation, signal, () =>
      this.generateInConversation(key, payload, previous, conversation, signal, onPart, onServerCall, onMetrics));
  }

  async generateInConversation(
    key, { messages, tools, publicCallId }, previous, conversation, signal, onPart, onServerCall, onMetrics
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
    const knownClientNames = new Set([...(previous?.clientNames ?? []), ...wireNames.keys()]);
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
      turns[0].content.push(...previous.serverDecisions);
    }
    const reviewed = new Set((previous?.serverDecisions ?? []).map((item) => item.tool_call_id));
    let serverDecisions = [];
    let lastAssistant, usage, context;
    let text = '',
      calls = [];
    for (const [i, turn] of turns.entries()) {
      signal.throwIfAborted();
      const last = i === turns.length - 1;
      const body = { ...turn, parent_uuid: turn.parent_uuid ?? parent, no_generate: !last };
      if (turn.role === 'user' && tools.length) body.tools = wireTools;
      const response = await this.request(
        key,
        '/conversations/' + encodeURIComponent(conversation) + '/messages',
        body,
        signal,
        true
      );
      const serverCalls = new Map();
      const clientCallParents = new Set();
      const unfinished = new Set();
      const runningTools = new Set();
      let received = false,
        answered = false;
      for await (const p of packets(response.body, signal)) {
        if (p.error_type || p.error)
          throw upstreamFault(
            upstreamErrorStatuses.get(p.error_type) ?? 502,
            p
          );
        if (!p.uuid) {
          const id = p.content_delta?.tool_call_id;
          if (!p.finished && typeof id === 'string' && id) runningTools.add(id);
          continue;
        }
        if (!p.finished) {
          if (p.content_delta && (p.role == null || p.role === 'assistant')) unfinished.add(p.uuid);
          continue;
        }
        received = true;
        parent = p.uuid;
        if (p.role === 'tool') {
          const results = Array.isArray(p.content) ? p.content : [p.content];
          for (const result of results) {
            const id = result?.tool_call_id ?? p.details?.tool_call_id;
            runningTools.delete(id);
            serverCalls.delete(id);
          }
        }
        if (p.role !== 'assistant' || !p.content) continue;
        unfinished.delete(p.uuid);
        if (!last) continue;
        answered = true;
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
          serverCalls.set(call.id, p.uuid);
          onServerCall(call.name);
        }
        part.calls = part.calls
          .filter((c) => wireNames.has(c.name))
          .map((c) => ({ ...c, id: publicCallId?.(c.id) ?? c.id, name: wireNames.get(c.name) }));
        if (text && part.content) part.content = '\n\n' + part.content;
        text += part.content;
        calls.push(...part.calls);
        if (part.content || part.calls.length) onPart(part);
      }
      if (unfinished.size || runningTools.size || !received || (last && !answered))
        throw new Fault(502, 'incomplete_stream', 'Поток Напарника завершился до ответа.');
      const toolParents = new Set([...serverCalls.values(), ...clientCallParents]);
      if (toolParents.size > 1)
        throw new Fault(502, 'incomplete_stream', 'Напарник оставил незавершённые вызовы инструментов в разных сообщениях.');
      const [toolParent] = toolParents;
      serverDecisions = [];
      for (const id of serverCalls.keys()) {
        if (reviewed.has(id))
          throw new Fault(502, 'repeated_tool_call', 'Напарник повторил уже рассмотренный вызов инструмента.');
        reviewed.add(id);
        serverDecisions.push({ tool_call_id: id, status: 'accepted', content: null });
      }
      if (serverDecisions.length && !calls.length) {
        turns.push({ role: 'tool', content: serverDecisions, parent_uuid: toolParent });
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
