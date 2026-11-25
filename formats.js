import { randomUUID } from 'node:crypto';
import { Fault, MODEL } from './bridge.js';

function toolCall(c) {
  return { id: c.id, type: 'function', function: { name: c.name, arguments: c.args } };
}
function blocks(part) {
  const result = part.content ? [{ type: 'text', text: part.content }] : [];
  for (const c of part.calls) {
    let input;
    try {
      input = JSON.parse(c.args);
    } catch {
      throw new Fault(502, 'bad_tool_input', 'Напарник вернул неполные аргументы инструмента.');
    }
    result.push({ type: 'tool_use', id: c.id, name: c.name, input });
  }
  return result;
}
export function completion(res, anthropic, stream, includeUsage) {
  const id = (anthropic ? 'msg_' : 'chatcmpl-') + randomUUID();
  const base = { id, model: MODEL };
  const created = Math.floor(Date.now() / 1000);
  let started = false,
    index = 0,
    callIndex = 0,
    timer;
  let usage, context;
  const contextField = () => context ? { naparnik_context: context } : {};
  const anthropicUsage = () => {
    const cached = usage?.prompt_tokens_details?.cached_tokens ?? 0;
    return {
      input_tokens: usage ? usage.prompt_tokens - cached : 0,
      cache_read_input_tokens: cached,
      output_tokens: usage?.completion_tokens ?? 0
    };
  };
  const frame = (data) =>
    res.write((anthropic ? 'event: ' + data.type + '\n' : '') + 'data: ' + JSON.stringify(data) + '\n\n');
  const chunk = (delta, finish_reason = null) =>
    frame({
      ...base,
      created,
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta, finish_reason }],
      ...(includeUsage ? { usage: null } : {}),
      ...(finish_reason ? contextField() : {})
    });
  const message = (content, stop_reason, starting = false) => ({
    ...base,
    type: 'message',
    role: 'assistant',
    content,
    stop_reason,
    stop_sequence: null,
    usage: { ...anthropicUsage(), ...(starting ? {output_tokens: 0} : {}) },
    ...contextField()
  });
  function start() {
    if (started) return;
    started = true;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no'
    });
    if (anthropic) frame({ type: 'message_start', message: message([], null, true) });
    else chunk({ role: 'assistant', content: '' });
    timer = setInterval(() => res.write(': ping\n\n'), 15000);
    res.once('close', () => clearInterval(timer));
  }
  return {
    metrics(providerUsage, branchContext) { usage = providerUsage; context = branchContext; },
    waiting() { if (stream) start(); },
    part(part) {
      if (!stream) return;
      start();
      if (anthropic) {
        for (const block of blocks(part)) {
          const content_block = block.type === 'text' ? { type: 'text', text: '' } : { ...block, input: {} };
          frame({ type: 'content_block_start', index, content_block });
          const delta =
            block.type === 'text'
              ? { type: 'text_delta', text: block.text }
              : { type: 'input_json_delta', partial_json: JSON.stringify(block.input) };
          frame({ type: 'content_block_delta', index, delta });
          frame({ type: 'content_block_stop', index: index++ });
        }
      } else {
        if (part.content) chunk({ content: part.content });
        if (part.calls.length)
          chunk({ tool_calls: part.calls.map((c) => ({ index: callIndex++, ...toolCall(c) })) });
      }
    },
    finish(reply) {
      const tools = reply.calls.length > 0;
      const reason = anthropic ? (tools ? 'tool_use' : 'end_turn') : tools ? 'tool_calls' : 'stop';
      if (stream) {
        start();
        if (anthropic) {
          frame({
            type: 'message_delta',
            delta: { stop_reason: reason, stop_sequence: null },
            usage: anthropicUsage(),
            ...contextField()
          });
          frame({ type: 'message_stop' });
        } else {
          chunk({}, reason);
          if (includeUsage && usage) frame({ ...base, created, object: 'chat.completion.chunk', choices: [], usage, ...contextField() });
          res.write('data: [DONE]\n\n');
        }
        clearInterval(timer);
        res.end();
        return;
      }
      const result = anthropic
        ? message(blocks(reply), reason)
        : {
            ...base,
            created,
            object: 'chat.completion',
            ...(usage ? {usage} : {}),
            ...contextField(),
            choices: [
              {
                index: 0,
                finish_reason: reason,
                message: {
                  role: 'assistant',
                  content: reply.content || (tools ? null : ''),
                  ...(tools ? { tool_calls: reply.calls.map(toolCall) } : {})
                }
              }
            ]
          };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    }
  };
}
