import { createHash } from 'node:crypto';

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
function textContent(value) {
  if (typeof value === 'string') return value;
  requireInput(
    Array.isArray(value) && value.every((b) => b?.type === 'text' && typeof b.text === 'string'),
    'Шлюз принимает текстовые сообщения и клиентские инструменты.'
  );
  return value.map((b) => b.text).join('\n');
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

export function normalize(body, anthropic, harnessSessionId) {
  requireInput(body && typeof body === 'object' && body.model === MODEL, 'Укажите модель naparnik.');
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
            textContent(blocks.filter((b) => b.type === 'text')),
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
  return { messages, tools };
}

async function* packets(stream) {
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
  buffer += decoder.decode();
  if (buffer.startsWith('data:')) lines.push(buffer.slice(5).trimStart());
  const last = parse();
  if (last) yield last;
}
const errorMessages = {
  invalid_token: 'Напарник отклонил API-ключ.',
  no_token: 'Напарнику нужен API-ключ.',
  token_not_found: 'API-ключ не найден.',
  budget_exceeded: 'Лимит Напарника исчерпан.',
  no_active_tariff: 'Для ключа нет активного тарифа.',
  rate_limit_exceeded: 'Слишком много запросов. Повторите позже.',
  conflict: 'Напарник ещё обрабатывает запрос в этом диалоге.',
  access_denied: 'Для ключа закрыт доступ к операции.'
};
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
export class Bridge {
  constructor(base = 'https://code.1c.ai/public/v1', sessions = new Map()) {
    this.base = base;
    this.sessions = sessions;
    this.pending = new Map();
  }
  async request(key, path, body, signal, stream = false) {
    const timeout = AbortSignal.timeout(stream ? 600000 : 20000);
    let response;
    try {
      response = await fetch(this.base + path, {
        method: body === undefined ? 'GET' : 'POST',
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
  async generate(key, payload, signal, onPart, onServerCall = () => {}, onMetrics) {
    const { protocol, sessionId } = payload;
    const id = sessionId ? JSON.stringify([protocol, sessionId]) : null;
    const run = async () => {
      signal.throwIfAborted();
      const previous = id && this.sessions.get(id);
      const { reply, state } = await this.generateTurn(key, payload, previous, signal, onPart, onServerCall, onMetrics);
      if (id) this.sessions.set(id, state);
      return reply;
    };
    if (!id) return run();
    // Read the cursor only after the preceding turn has finished.
    const turn = (this.pending.get(id) ?? Promise.resolve()).then(run);
    const settled = turn.catch(() => {});
    this.pending.set(id, settled);
    try {
      return await turn;
    } finally {
      if (this.pending.get(id) === settled) this.pending.delete(id);
    }
  }
  async generateTurn(key, { messages, tools }, previous, signal, onPart, onServerCall, onMetrics) {
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
    // Clients resend the transcript. Only send the new inputs to an existing dialogue.
    const tail = previous ? messages.slice(messages.findLastIndex(msg => msg.role === 'assistant') + 1) : messages;
    let conversation = previous?.conversation,
      parent = previous?.parent ?? null;
    if (!conversation) {
      const created = await (
        await this.request(
          key,
          '/conversations',
          { ui_language: 'ru', programming_language: '1c', script_language: 'ru' },
          signal
        )
      ).json();
      if (!created.uuid)
        throw new Fault(502, 'missing_conversation', 'Напарник не вернул идентификатор диалога.');
      conversation = created.uuid;
    }
    const turns = [];
    for (const msg of tail) {
      if (previous && msg.role === 'tool') {
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
      const body = { ...turn, parent_uuid: parent, no_generate: !last };
      if (turn.role === 'user' && tools.length) body.tools = wireTools;
      const response = await this.request(
        key,
        '/conversations/' + encodeURIComponent(conversation) + '/messages',
        body,
        signal,
        true
      );
      const serverCalls = new Map();
      let received = false,
        answered = false;
      for await (const p of packets(response.body)) {
        if (p.error_type || p.error)
          throw upstreamFault(
            { budget_exceeded: 402, invalid_token: 401, rate_limit_exceeded: 429 }[p.error_type] || 502,
            p
          );
        if (!p.finished || !p.uuid) continue;
        received = true;
        parent = p.uuid;
        if (p.role === 'tool') serverCalls.delete(p.content?.tool_call_id ?? p.details?.tool_call_id);
        if (!last || p.role !== 'assistant' || !p.content) continue;
        answered = true;
        lastAssistant = p.uuid;
        usage = providerUsage(p.usage);
        const capacity = p.details?.max_context_length;
        context = usage && tokenCount(capacity) && capacity > 0
          ? { token_count: usage.total_tokens, max_context_length: capacity } : null;
        onMetrics?.(usage, context);
        const part = assistant(p.content.content, p.content.tool_calls ?? []);
        // A later assistant message in the same stream supersedes the earlier tool request.
        serverCalls.clear();
        for (const call of part.calls) {
          if (wireNames.has(call.name)) continue;
          if (knownClientNames.has(call.name))
            throw new Fault(502, 'unknown_client_tool', 'Напарник запросил клиентский инструмент вне текущего списка.');
          serverCalls.set(call.id, call);
          onServerCall(call.name);
        }
        part.calls = part.calls
          .filter((c) => wireNames.has(c.name))
          .map((c) => ({ ...c, name: wireNames.get(c.name) }));
        if (text && part.content) part.content = '\n\n' + part.content;
        text += part.content;
        calls.push(...part.calls);
        if (part.content || part.calls.length) onPart(part);
      }
      if (!received || (last && !answered))
        throw new Fault(502, 'incomplete_stream', 'Поток Напарника завершился до ответа.');
      serverDecisions = [];
      for (const call of serverCalls.values()) {
        if (reviewed.has(call.id))
          throw new Fault(502, 'repeated_tool_call', 'Напарник повторил уже рассмотренный вызов инструмента.');
        reviewed.add(call.id);
        serverDecisions.push({ tool_call_id: call.id, status: 'accepted', content: null });
      }
      if (serverDecisions.length && !calls.length) {
        turns.push({ role: 'tool', content: serverDecisions });
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
        signal.throwIfAborted(); // Optional statistics must not discard an otherwise complete answer.
      }
      if (context) this.contextWindow = context.max_context_length;
      onMetrics(usage, context);
    }
    const reply = { role: 'assistant', content: text, calls };
    return { reply, state: { conversation, parent, serverDecisions, clientNames: knownClientNames } };
  }
}
