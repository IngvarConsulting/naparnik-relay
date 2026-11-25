import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../server.js';

const user = content => ({ role: 'user', content });
const openaiTool = { type: 'function', function: { name: 'lookup' } };
const anthropicTool = { name: 'lookup', input_schema: { type: 'object' } };
const openaiResult = (tool_call_id, content) => ({ role: 'tool', tool_call_id, content });

async function fixture(t) {
  const posted = [];
  let chats = 0;
  const listen = async server => {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return 'http://127.0.0.1:' + server.address().port;
  };
  const upstream = http.createServer(async (req, res) => {
    if (req.url === '/conversations') return res.end(JSON.stringify({ uuid: 'chat-' + ++chats }));
    if (req.url.includes('/context_tokens?')) return res.end('{}');
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    posted.push({ path: req.url, body });
    const toolCalls = typeof body.content === 'string' && body.content.startsWith('ask:');
    const content = toolCalls ? {
      tool_calls: ['mcp-1', 'mcp-2'].map((id, i) => ({
        id,
        function: { name: body.tools[0].name, arguments: JSON.stringify({ index: i }) }
      }))
    } : { content: 'Завершено' };
    const event = { uuid: 'answer-' + posted.length, role: 'assistant', finished: true, content };
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('data: ' + JSON.stringify(event) + '\n\n');
  });
  const upstreamUrl = await listen(upstream);
  t.after(() => upstream.close());
  const profileDir = mkdtempSync(join(tmpdir(), 'relay-headerless-'));
  t.after(() => rmSync(profileDir, { recursive: true, force: true }));
  async function app() {
    const server = createServer({
      profileDir, upstream: upstreamUrl,
      connection: { admin: 'admin-fixture', localKey: 'local-fixture', upstream: 'key-fixture' }
    });
    const base = await listen(server);
    t.after(() => server.close());
    return (path, input) => fetch(base + '/v1/' + path, {
      method: 'POST',
      headers: { Authorization: 'Bearer local-fixture', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'naparnik', ...input })
    });
  }
  return { post: await app(), posted, app };
}

test('OpenAI без ID сессии отправляет результаты в ветку исходных вызовов', async t => {
  const { post, posted } = await fixture(t);
  const tools = [openaiTool];
  const messages = [user('ask: first')];
  const response = await post('chat/completions', { messages, tools });
  assert.equal(response.status, 200);
  const reply = (await response.json()).choices[0].message;
  const newer = await post('chat/completions', { messages: [user('ask: second')], tools, stream: true });
  const chunks = (await newer.text()).split('\n')
    .filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6)));
  const newerIds = chunks.find(chunk => chunk.choices[0].delta.tool_calls).choices[0].delta.tool_calls.map(call => call.id);
  assert.ok(newerIds.every(id => !reply.tool_calls.some(call => call.id === id)));

  const result = await post('chat/completions', { tools, messages: [
    ...messages, reply, openaiResult(reply.tool_calls[1].id, 'second'), openaiResult(reply.tool_calls[0].id, 'first')
  ] });
  assert.equal(result.status, 200);
  assert.equal((await result.json()).choices[0].message.content, 'Завершено');
  assert.equal(posted.at(-1).path, '/conversations/chat-1/messages');
  assert.equal(posted.at(-1).body.parent_uuid, 'answer-1');
  assert.equal(posted.at(-1).body.role, 'tool');
  assert.deepEqual(posted.at(-1).body.content, [
    { tool_call_id: 'mcp-2', content: 'second', status: 'ok' },
    { tool_call_id: 'mcp-1', content: 'first', status: 'ok' }
  ]);
});

test('Anthropic без ID сессии восстанавливает ветку по одним результатам', async t => {
  const { post, posted } = await fixture(t);
  const tools = [anthropicTool];
  const reply = await (await post('messages', { messages: [user('ask: anthro')], tools })).json();
  const content = reply.content.map(call => ({ type: 'tool_result', tool_use_id: call.id, content: 'error', is_error: true }));
  const result = await post('messages', { system: 'System instructions', tools, messages: [user(content)] });
  assert.equal(result.status, 200);
  await result.json();
  assert.equal(posted.at(-1).path, '/conversations/chat-1/messages');
  assert.equal(posted.at(-1).body.parent_uuid, 'answer-1');
  assert.deepEqual(posted.at(-1).body.content, [
    { tool_call_id: 'mcp-1', content: 'error', status: 'error' },
    { tool_call_id: 'mcp-2', content: 'error', status: 'error' }
  ]);
});

test('ID вызовов без сессии изолированы по протоколу и процессу', async t => {
  const { post, posted, app } = await fixture(t);
  const tools = [openaiTool];
  const reply = await (await post('chat/completions', { messages: [user('ask: first')], tools })).json();
  const ids = reply.choices[0].message.tool_calls.map(call => call.id);
  const other = await (await post('chat/completions', { messages: [user('ask: another')], tools })).json();
  const mixed = [ids[0], other.choices[0].message.tool_calls[1].id];
  const mixedResult = await post('chat/completions', { messages: mixed.map(id => openaiResult(id, 'done')) });
  assert.equal(mixedResult.status, 400);
  await mixedResult.json();
  const content = ids.map(id => ({ type: 'tool_result', tool_use_id: id, content: 'done' }));
  const wrongProtocol = await post('messages', { messages: [user(content)] });
  assert.equal(wrongProtocol.status, 400);
  await wrongProtocol.json();
  const restarted = await app();
  const expired = await restarted('chat/completions', { messages: ids.map(id => openaiResult(id, 'done')) });
  assert.equal(expired.status, 400);
  await expired.json();
  assert.equal(posted.length, 2);
});
