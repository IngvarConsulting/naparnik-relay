import { createHmac, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { Fault, MODEL } from './bridge.js';

function toolCall(c) {
  return { id: c.id, type: 'function', function: { name: c.name, arguments: c.args } };
}
function blocks(part, thinkingSignature) {
  const result = [];
  if (part.reasoning) result.push({ type: 'thinking', thinking: part.reasoning,
    signature: thinkingSignature(part.reasoning) });
  if (part.content) result.push({ type: 'text', text: part.content });
  for (const c of part.calls) {
    let input;
    try {
      input = JSON.parse(c.args);
    } catch {
      throw new Fault(502, 'bad_tool_input', 'Напарник вернул неполные аргументы инструмента.');
    }
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw new Fault(502, 'bad_tool_input', 'Напарник вернул аргументы инструмента в неподдерживаемом формате.');
    result.push({ type: 'tool_use', id: c.id, name: c.name, input });
  }
  return result;
}
export function completion(res, anthropic, stream, includeUsage, trace, key) {
  const id = (anthropic ? 'msg_' : 'chatcmpl-') + randomUUID();
  const base = { id, model: MODEL };
  const created = Math.floor(Date.now() / 1000);
  let started = false,
    index = 0,
    callIndex = 0,
    timer;
  let usage, context;
  // Relay issues its own opaque signature so clients can preserve the typed block.
  const thinkingSignature = thinking => createHmac('sha256', key)
    .update(JSON.stringify(['thinking', id, index, thinking])).digest('base64');
  const sources = trace && new Set();
  const contextField = () => context ? { naparnik_context: context } : {};
  const anthropicUsage = () => {
    const cached = usage?.prompt_tokens_details?.cached_tokens ?? 0;
    return {
      input_tokens: usage ? usage.prompt_tokens - cached : 0,
      cache_read_input_tokens: cached,
      output_tokens: usage?.completion_tokens ?? 0
    };
  };
  const frame = (data, source) => {
    trace?.record('client', { kind: 'sse', event: anthropic ? data.type : undefined, body: data, source });
    return res.write((anthropic ? 'event: ' + data.type + '\n' : '') + 'data: ' + JSON.stringify(data) + '\n\n');
  };
  const chunk = (delta, finish_reason = null, source) =>
    frame({
      ...base,
      created,
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta, logprobs: null, finish_reason }],
      ...(includeUsage ? { usage: null } : {}),
      ...(finish_reason ? contextField() : {})
    }, source);
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
  function start(source) {
    if (started) return;
    started = true;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no'
    });
    trace?.record('client', { kind: 'response', status: 200 });
    if (anthropic) frame({ type: 'message_start', message: message([], null, true) }, source);
    else chunk({ role: 'assistant', content: '' }, null, source);
    timer = setInterval(() => res.write(': ping\n\n'), 15000);
    res.once('close', () => clearInterval(timer));
  }
  async function flush(writable, signal) {
    if (!writable) await once(res, 'drain', { signal });
  }
  return {
    metrics(providerUsage, branchContext) { usage = providerUsage; context = branchContext; },
    waiting(source) { if (stream) start(source); },
    async part(part, signal, source) {
      if (source) sources?.add(source);
      const contentBlocks = anthropic ? blocks(part, thinkingSignature) : undefined;
      if (!stream) return;
      start(source);
      if (anthropic) {
        let toolIndex = 0;
        for (const block of contentBlocks) {
          let content_block, delta;
          if (block.type === 'thinking') {
            content_block = { ...block, thinking: '', signature: '' };
            delta = { type: 'thinking_delta', thinking: block.thinking };
          } else if (block.type === 'text') {
            content_block = { type: 'text', text: '' };
            delta = { type: 'text_delta', text: block.text };
          } else {
            content_block = { ...block, input: {} };
            delta = { type: 'input_json_delta', partial_json: part.calls[toolIndex++].args };
          }
          await flush(frame({ type: 'content_block_start', index, content_block }, source), signal);
          await flush(frame({ type: 'content_block_delta', index, delta }, source), signal);
          if (block.type === 'thinking') {
            await flush(frame({ type: 'content_block_delta', index,
              delta: { type: 'signature_delta', signature: block.signature } }, source), signal);
          }
          await flush(frame({ type: 'content_block_stop', index: index++ }, source), signal);
        }
      } else {
        if (part.reasoning) await flush(chunk({ reasoning_content: part.reasoning }, null, source), signal);
        if (part.content) await flush(chunk({ content: part.content }, null, source), signal);
        if (part.calls.length) {
          const tool_calls = part.calls.map(call => ({ index: callIndex++, ...toolCall(call) }));
          await flush(chunk({ tool_calls }, null, source), signal);
        }
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
          trace?.record('client', { kind: 'sse', body: '[DONE]' });
          res.write('data: [DONE]\n\n');
        }
        clearInterval(timer);
        res.end();
        return;
      }
      const result = anthropic
        ? message(blocks(reply, thinkingSignature), reason)
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
                logprobs: null,
                message: {
                  role: 'assistant',
                  content: reply.content || (tools ? null : ''),
                  ...(reply.reasoning && { reasoning_content: reply.reasoning }),
                  ...(tools ? { tool_calls: reply.calls.map(toolCall) } : {})
                }
              }
            ]
          };
      trace?.record('client', { kind: 'response', status: 200, body: result,
        source: sources?.size === 1 ? sources.values().next().value : undefined });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    }
  };
}
