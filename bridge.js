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
export function normalize(body, anthropic) {
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
            requireInput(typeof block.tool_use_id === 'string', 'Отсутствует tool_use_id.');
            messages.push({
              role: 'tool',
              id: block.tool_use_id,
              content: textContent(block.content ?? ''),
              status: block.is_error ? 'error' : 'ok'
            });
          } else messages.push({ role: msg.role, content: textContent([block]) });
        }
      }
    } else if (msg.role === 'assistant')
      messages.push(assistant(textContent(msg.content ?? ''), msg.tool_calls));
    else if (msg.role === 'tool') {
      requireInput(typeof msg.tool_call_id === 'string', 'Отсутствует tool_call_id.');
      messages.push({ role: 'tool', id: msg.tool_call_id, content: textContent(msg.content), status: 'ok' });
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

function fingerprint(messages) {
  // Clients may reserialize the JSON arguments between turns.
  const canonical = JSON.stringify(messages, (k, v) => {
    if (k === 'args') {
      try {
        return JSON.parse(v);
      } catch {
        return v;
      }
    }
    return v;
  });
  return createHash('sha256').update(canonical).digest('hex');
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
export class Bridge {
  constructor(base = 'https://code.1c.ai/public/v1') {
    this.base = base;
    this.history = new Map();
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
  async generate(key, { messages, tools }, signal, onPart) {
    // The provider reserves tool names (including ZCode's TodoWrite). Give
    // client tools their own wire names and restore them in public responses.
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
    let split = messages.length;
    while (split && messages[split - 1].role !== 'assistant') split--;
    const previous = split && this.history.get(fingerprint(messages.slice(0, split)));
    const tail = previous ? messages.slice(split) : messages;
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
        const item = { tool_call_id: msg.id, content: msg.content, status: msg.status };
        if (turns.at(-1)?.role === 'tool') turns.at(-1).content.push(item);
        else turns.push({ role: 'tool', content: [item] });
      } else {
        const chunk = msg.role === 'user' ? msg.content : JSON.stringify(msg);
        if (turns.at(-1)?.role === 'user') turns.at(-1).content += '\n\n' + chunk;
        else turns.push({ role: 'user', content: chunk });
      }
    }
    let text = '',
      calls = [];
    for (const [i, turn] of turns.entries()) {
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
        if (!last || p.role !== 'assistant' || !p.content) continue;
        answered = true;
        const part = assistant(p.content.content, p.content.tool_calls ?? []);
        // Server tools run upstream. Forward only functions declared by this client.
        part.calls = part.calls
          .filter((c) => wireNames.has(c.name))
          .map((c) => ({ ...c, name: wireNames.get(c.name) }));
        text += part.content;
        calls.push(...part.calls);
        if (part.content || part.calls.length) onPart(part);
      }
      if (!received || (last && !answered))
        throw new Fault(502, 'incomplete_stream', 'Поток Напарника завершился до ответа.');
    }
    const reply = { role: 'assistant', content: text, calls };
    this.history.set(fingerprint([...messages, reply]), { conversation, parent });
    if (this.history.size > 1024) this.history.delete(this.history.keys().next().value);
    return reply;
  }
}
