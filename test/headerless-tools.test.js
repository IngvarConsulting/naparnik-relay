import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../server.js';
import { serverToolLinks } from '../public/trace-links.js';

const user = content => ({ role: 'user', content });
const openaiTool = { type: 'function', function: { name: 'lookup' } };
const anthropicTool = { name: 'lookup', input_schema: { type: 'object' } };
const openaiResult = (tool_call_id, content) => ({ role: 'tool', tool_call_id, content });

async function fixture(t, { interruptContinuation = false, toolCount = 2 } = {}) {
  const posted = [];
  const history = [], historyReads = [];
  let chats = 0;
  const listen = async server => {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return 'http://127.0.0.1:' + server.address().port;
  };
  const upstream = http.createServer(async (req, res) => {
    if (req.url === '/conversations') return res.end(JSON.stringify({ uuid: 'chat-' + ++chats }));
    if (req.url.includes('/context_tokens?')) return res.end('{}');
    if (interruptContinuation && req.method === 'GET' && req.url === '/conversations/chat-1') {
      historyReads.push(req.url);
      if (historyReads.length === 1) {
        res.writeHead(503);
        return res.end('{}');
      }
      return res.end(JSON.stringify({ uuid: 'chat-1', messages: history }));
    }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    posted.push({ path: req.url, body });
    const toolCalls = typeof body.content === 'string' && body.content.startsWith('ask:');
    const content = toolCalls ? {
      tool_calls: Array.from({ length: toolCount }, (_, i) => ({
        id: 'mcp-' + (i + 1),
        function: { name: body.tools[0].name, arguments: JSON.stringify({ index: i }) }
      }))
    } : { content: 'Завершено' };
    if (typeof body.content === 'string' && body.content.startsWith('ask: mixed')) {
      content.tool_calls.push({ id: 'server-1', function: { name: 'Search_ITS', arguments: '{}' } });
    }
    const event = { uuid: 'answer-' + posted.length, role: 'assistant', finished: true, content };
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (interruptContinuation) {
      const echo = { uuid: 'user-' + posted.length, parent_uuid: body.parent_uuid,
        role: 'user', content: body.content, finished: true };
      const interrupted = posted.length === 2;
      history.push(echo, { ...event, parent_uuid: echo.uuid,
        content: interrupted ? { content: 'Восстановлено' } : content });
      if (interrupted) return res.end('data: ' + JSON.stringify(echo) + '\n\n');
    }
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
    const post = (path, input, extraHeaders) => fetch(base + '/v1/' + path, {
      method: 'POST',
      headers: { Authorization: 'Bearer local-fixture', 'Content-Type': 'application/json', ...extraHeaders },
      body: JSON.stringify({ model: 'naparnik', ...input })
    });
    const trace = async sessionId => {
      const headers = { 'X-Relay-Panel': '1', 'Content-Type': 'application/json' };
      const auth = await fetch(base + '/panel/session', {
        method: 'POST', headers, body: JSON.stringify({ token: 'admin-fixture' })
      });
      headers.Cookie = auth.headers.get('set-cookie').split(';')[0];
      const query = sessionId ? '?session=' + encodeURIComponent(sessionId) : '';
      const result = await fetch(base + '/panel/trace' + query, { headers });
      assert.equal(result.status, 200);
      return result.json();
    };
    return { post, trace };
  }
  return { ...await app(), posted, app, historyReads };
}

test('Один ID сессии не объединяет независимые запросы с полной историей', async t => {
  const { post, posted } = await fixture(t);
  const headers = { 'x-session-id': 'shared' };
  await (await post('chat/completions', { messages: [user('Одноразовый служебный запрос')] }, headers)).json();
  const messages = [user('Основной диалог')];
  const first = await post('chat/completions', { messages }, headers);
  const reply = (await first.json()).choices[0].message;
  const next = await post('chat/completions', { messages: [...messages, reply, user('Продолжение')] }, headers);
  assert.equal(next.status, 200);
  await next.json();
  assert.deepEqual(posted.map(({ path, body }) => [path, body.content, body.parent_uuid]), [
    ['/conversations/chat-1/messages', 'Одноразовый служебный запрос', null],
    ['/conversations/chat-2/messages', 'Основной диалог', null],
    ['/conversations/chat-2/messages', 'Продолжение', 'answer-2']
  ]);
});

for (const path of ['messages', 'chat/completions']) {
  test(`${path} продолжает диалог по штатной истории даже после перезапуска Relay`, async t => {
    const { post, posted, app } = await fixture(t);
    const messages = [user('Первый вопрос')];
    const first = await post(path, { messages });
    assert.equal(first.status, 200);
    const data = await first.json();
    const reply = path === 'messages' ? { role: data.role, content: data.content } : data.choices[0].message;
    const restarted = await app();
    const second = await restarted.post(path, { messages: [...messages, reply, user('Следующий вопрос')] });
    assert.equal(second.status, 200);
    await second.json();
    assert.equal(second.headers.get('X-Relay-Conversation-Id'), first.headers.get('X-Relay-Conversation-Id'));
    assert.deepEqual(posted.slice(1), [{
      path: '/conversations/chat-1/messages',
      body: { role: 'user', content: 'Следующий вопрос', parent_uuid: 'answer-1', no_generate: false }
    }]);
  });
}

test('Одинаковые истории в разных диалогах не привязываются к одному из них', async t => {
  const { post, posted } = await fixture(t);
  const messages = [user('Одинаковый вопрос')];
  const reply = (await (await post('chat/completions', { messages })).json()).choices[0].message;
  await (await post('chat/completions', { messages })).json();
  await (await post('chat/completions', { messages: [...messages, reply, user('Продолжение')] })).json();
  assert.deepEqual(posted.map(({ path, body }) => [path, body.parent_uuid]), [
    ['/conversations/chat-1/messages', null], ['/conversations/chat-2/messages', null],
    ['/conversations/chat-3/messages', null]
  ]);
});

test('Повтор продолжения без ID после обрыва SSE читает сохранённый ответ без второго POST', async t => {
  const { post, posted, historyReads, app } = await fixture(t, { interruptContinuation: true });
  const messages = [user('Первый вопрос')];
  const first = await (await post('messages', { messages })).json();
  const input = { stream: true, messages: [
    ...messages, { role: first.role, content: first.content }, user('Следующий вопрос')
  ] };
  const interrupted = await post('messages', input);
  assert.equal(interrupted.status, 502);
  assert.match(await interrupted.text(), /Поток Напарника завершился до ответа/);
  assert.equal(posted.length, 2);
  assert.equal(posted[1].body.parent_uuid, 'answer-1');

  const restarted = await app();
  const retried = await restarted.post('messages', input);
  const result = await retried.text();
  assert.equal(posted.length, 2);
  assert.deepEqual(historyReads, ['/conversations/chat-1', '/conversations/chat-1']);
  assert.match(result, /Восстановлено/);
  assert.match(result, /event: message_stop/);
});

test('OpenAI без ID сессии отправляет результаты в ветку исходных вызовов', async t => {
  const { post, posted, trace } = await fixture(t);
  const tools = [openaiTool];
  const messages = [user('ask: first')];
  const response = await post('chat/completions', { messages, tools });
  assert.equal(response.status, 200);
  const reply = (await response.json()).choices[0].message;
  const originalTrace = (await trace()).sessions[0].id;
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
  const linked = await trace(originalTrace);
  assert.equal(linked.sessions.length, 2);
  assert.deepEqual(linked.exchanges.map(exchange => exchange.conversation), ['chat-1', 'chat-1']);
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

test('Пять параллельных результатов связываются по ID после переупорядочивания истории', async t => {
  const { post, posted } = await fixture(t, { toolCount: 5 });
  const tools = [openaiTool];
  const prompt = user('ask: parallel');
  const response = await post('chat/completions', { messages: [prompt], tools, stream: true });
  assert.equal(response.status, 200);
  const chunks = (await response.text()).split('\n')
    .filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6)));
  const calls = chunks.flatMap(chunk => chunk.choices[0].delta.tool_calls ?? []);
  assert.equal(calls.length, 5);
  const results = calls.toReversed().map(({ id }, i) => openaiResult(id, 'result-' + i));
  const replay = tool_calls => ({ role: 'assistant', content: ' ', tool_calls });

  const invalid = await post('chat/completions', { tools, messages: [
    prompt, replay([calls[0], ...calls.slice(0, -1)]), ...results
  ] });
  assert.equal(invalid.status, 400);
  assert.match(await invalid.text(), /не соответствуют сообщению ассистента/);
  assert.equal(posted.length, 1);

  const continued = await post('chat/completions', { tools, messages: [prompt, replay(calls.toReversed()), ...results] });
  assert.equal(continued.status, 200, await continued.clone().text());
  assert.equal((await continued.json()).choices[0].message.content, 'Завершено');
  assert.deepEqual(posted.slice(1), [{
    path: '/conversations/chat-1/messages',
    body: { role: 'tool', parent_uuid: 'answer-1', no_generate: false, content: results.map(({ content }, i) => ({
      tool_call_id: 'mcp-' + (5 - i), status: 'ok', content
    })) }
  }]);
});

test('Трасса объединяет смешанный серверный вызов с решением после клиентского результата', async t => {
  const { post, trace } = await fixture(t);
  const tools = [openaiTool];
  const response = await post('chat/completions', { messages: [user('ask: mixed')], tools });
  const reply = (await response.json()).choices[0].message;
  const sessionId = (await trace()).sessions[0].id;
  const result = await post('chat/completions', {
    tools, messages: reply.tool_calls.map(call => openaiResult(call.id, 'ok'))
  });
  assert.equal(result.status, 200);
  await result.json();
  const { exchanges } = await trace(sessionId);
  const [before, after] = exchanges;
  const call = before.upstream.find(packet => packet.toolScope === 'mixed');
  assert.deepEqual(call.serverToolIds, ['server-1']);
  const link = serverToolLinks(exchanges).get(after.id)[0];
  assert.equal(link.from, call.id);
  assert.equal(link.decisionOnly, false);
  const sent = after.upstream.find(packet => packet.id === link.to);
  assert.deepEqual(sent.body.content.map(item => [item.tool_call_id, item.status]), [
    ['mcp-1', 'ok'], ['mcp-2', 'ok'], ['server-1', 'accepted']
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
  const expired = await restarted.post('chat/completions', { messages: ids.map(id => openaiResult(id, 'done')) });
  assert.equal(expired.status, 400);
  await expired.json();
  assert.equal(posted.length, 2);
});
