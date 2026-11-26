import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../server.js';
import { ToolMonitor } from '../tool-monitor.js';

const user = content => ({ role: 'user', content });
const tool = name => ({ type: 'function', function: { name } });
const result = (tool_call_id, content) => ({ role: 'tool', tool_call_id, content });
const sessionId = 'zcode-fixture';

async function listen(t, server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  return 'http://127.0.0.1:' + server.address().port;
}

async function fixture(t) {
  const posts = [];
  let conversations = 0;
  const upstream = await listen(t, http.createServer(async (req, res) => {
    if (req.url === '/conversations') return res.end(JSON.stringify({ uuid: 'chat-' + ++conversations }));
    if (req.url.includes('/context_tokens?')) return res.end('{}');
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    posts.push({ path: req.url, body });
    const content = body.tools?.length ? {
      tool_calls: [{ id: 'tool-' + posts.length, function: { name: body.tools[0].name, arguments: '{}' } }]
    } : { content: 'Готово' };
    const event = { uuid: 'answer-' + posts.length, role: 'assistant', finished: true, content };
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('data: ' + JSON.stringify(event) + '\n\n');
  }));
  const profileDir = mkdtempSync(join(tmpdir(), 'relay-zcode-query-source-'));
  t.after(() => rmSync(profileDir, { recursive: true, force: true }));
  const monitor = new ToolMonitor();
  const base = await listen(t, createServer({ upstream, profileDir, monitor,
    connection: { admin: 'admin-fixture', localKey: 'local-fixture', upstream: 'key-fixture' }
  }));
  const post = async (path, input, source) => {
    const headers = { Authorization: 'Bearer local-fixture', 'Content-Type': 'application/json',
      'x-session-id': sessionId, 'x-zcode-session-type': 'main' };
    if (source !== undefined) headers['x-zcode-query-source'] = source;
    const response = await fetch(base + '/v1/' + path, {
      method: 'POST', headers, body: JSON.stringify({ model: 'naparnik', ...input })
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  const trace = async id => {
    const headers = { 'X-Relay-Panel': '1', 'Content-Type': 'application/json' };
    const auth = await fetch(base + '/panel/session', {
      method: 'POST', headers, body: JSON.stringify({ token: 'admin-fixture' })
    });
    assert.equal(auth.status, 200);
    headers.Cookie = auth.headers.get('set-cookie').split(';')[0];
    const response = await fetch(base + '/panel/trace?session=' + encodeURIComponent(id), { headers });
    assert.equal(response.status, 200);
    return response.json();
  };
  return { post, posts, trace, monitor };
}

test('Служебный запрос ZCode с общим ID не продолжает основной диалог', async t => {
  const { post, posts, trace, monitor } = await fixture(t);
  const reply = (await post('chat/completions', { messages: [user('Основной вопрос')], tools: [tool('lookup')] },
    'main_turn')).choices[0].message;
  assert.equal(reply.tool_calls[0].id, 'tool-1');

  const auxiliary = { messages: [user('Служебный запрос')], tools: [] };
  for (const source of ['web_fetch_processing', 'another_auxiliary_source', 'another_auxiliary_source']) {
    await post('chat/completions', auxiliary, source);
  }
  assert.equal(monitor.records.sessions.length, 1);
  assert.deepEqual(monitor.records.sessions[0].tools, ['lookup']);

  await post('chat/completions', { messages: [result(reply.tool_calls[0].id, 'Результат')] });
  assert.deepEqual(posts.map(({ path, body }) => [path, body.parent_uuid, body.role]), [
    ['/conversations/chat-1/messages', null, 'user'],
    ['/conversations/chat-2/messages', null, 'user'],
    ['/conversations/chat-3/messages', null, 'user'],
    ['/conversations/chat-4/messages', null, 'user'],
    ['/conversations/chat-1/messages', 'answer-1', 'tool']
  ]);
  const { sessions, exchanges } = await trace(JSON.stringify(['OpenAI', sessionId]));
  assert.equal(sessions.length, 4);
  assert.deepEqual(exchanges.map(exchange => exchange.conversation), ['chat-1', 'chat-1']);
});

test('Результат инструмента служебного запроса возвращается в его диалог', async t => {
  const { post, posts } = await fixture(t);
  const source = 'auxiliary_fixture';
  const reply = (await post('chat/completions', { messages: [user('Служебный запрос')], tools: [tool('lookup')] },
    source)).choices[0].message;
  assert.notEqual(reply.tool_calls[0].id, 'tool-1');
  await post('chat/completions', { messages: [result(reply.tool_calls[0].id, 'Результат')] }, source);
  assert.equal(posts[1].path, posts[0].path);
  assert.equal(posts[1].body.parent_uuid, 'answer-1');
  assert.deepEqual(posts[1].body.content, [{ tool_call_id: 'tool-1', content: 'Результат', status: 'ok' }]);
});

test('Заголовок ZCode не меняет маршрутизацию Anthropic Messages', async t => {
  const { post, posts } = await fixture(t);
  const source = 'auxiliary_fixture';
  await post('messages', { messages: [user('Первый вопрос')] }, source);
  await post('messages', { messages: [user('Следующий вопрос')] }, source);
  assert.equal(posts[1].path, posts[0].path);
  assert.equal(posts[1].body.parent_uuid, 'answer-1');
});
