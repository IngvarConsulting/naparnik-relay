import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createServer } from '../server.js';

test('Оба клиента, ключи, история, поток и ошибки', async (t) => {
  const received = [],
    accounts = [];
  let id = 0,
    breaking = false;
  const mock = http.createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer real-fixture');
    if (req.url === '/budget') {
      res.end(
        JSON.stringify({ limits: { sliding_5h: { used_percent: 12.5 }, weekly: { used_percent: 2 } } })
      );
      return;
    }
    if (req.url === '/conversations') {
      res.end(JSON.stringify({ uuid: 'chat-' + ++id }));
      return;
    }
    if (req.url.includes('/context_tokens?branch=')) {
      assert.match(req.url, /branch=answer$/);
      return res.end(JSON.stringify({token_count: 101, max_context_length: 384000}));
    }
    let raw = '';
    for await (const p of req) raw += p;
    const body = JSON.parse(raw);
    received.push({ body, url: req.url });
    res.setHeader('content-type', 'text/event-stream');
    const event = (obj) => res.write('data: ' + JSON.stringify(obj) + '\r\n\r\n');
    event({ uuid: 'echo', role: body.role, finished: true });
    event({ uuid: 'answer', role: null, finished: false, content_delta: { content: 'Черновик' } });
    if (breaking) {
      event({ error_type: 'budget_exceeded', error: 'limit' });
      res.end();
      return;
    }
    if (body.content === 'permission') {
      event({uuid:'permission-request', role:'assistant', finished:true, content:{tool_calls:[
        {id:'web', function:{name:'mcp__web__fetch', arguments:'{"url":"https://example.org"}'}}
      ]}});
      res.end();
      return;
    }
    const content =
      body.content === 'tool'
        ? { tool_calls: [{ id: 'call-1', function: { name: body.tools[0].name, arguments: '{"x":1}' } }] }
        : { content: 'Готово' };
    event({ uuid: 'answer', role: 'assistant', finished: true, content, usage: {prompt_tokens:90, cached_tokens:64, completion_tokens:10, total_tokens:100}, details:{max_context_length:384000} });
    res.end();
  });
  mock.listen(0, '127.0.0.1');
  await once(mock, 'listening');
  const profileDir = mkdtempSync(join(tmpdir(), 'relay-bridge-'));
  t.after(() => rmSync(profileDir, { recursive: true, force: true }));
  const app = createServer({
    profileDir,
    connection: { admin: 'panel-fixture', localKey: 'local-fixture', upstream: '' },
    persist: (data) => accounts.push(data),
    upstream: 'http://127.0.0.1:' + mock.address().port
  });
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  t.after(() => {
    app.close();
    mock.close();
  });
  const base = 'http://127.0.0.1:' + app.address().port;
  const request = (path, body, headers = {}, method) =>
    fetch(base + path, {
      method: method ?? (body ? 'POST' : 'GET'),
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body)
    });
  const header = { 'X-Relay-Panel': '1' };
  assert.equal((await request('/v1/models')).status, 401);
  assert.equal((await request('/panel/state', undefined, header)).status, 401);
  const auth = await request('/panel/session', { token: 'panel-fixture' }, header);
  header.Cookie = auth.headers.get('set-cookie').split(';')[0];
  const state = await (
    await request('/panel/account', { key: 'real-fixture', remember: false }, header)
  ).json();
  assert.equal(state.limits.weekly.used_percent, 2);
  assert.equal(accounts[0].upstream, '');
  assert.equal(
    (await request('/panel/state', undefined, { ...header, Origin: 'https://example.org' })).status,
    403
  );
  const oa = { Authorization: 'Bearer local-fixture' },
    an = { 'x-api-key': 'local-fixture' };
  const tools = [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }];
  const messages = [{ role: 'user', content: 'tool' }];
  const post = (path, body, headers) => request('/v1/' + path, { model: 'naparnik', ...body }, headers);
  const zcode = { ...oa, 'x-session-id': 'zcode-tools' };
  const deepseek = { ...an, 'x-deepseek-harness-session-id': 'deepseek-tools' };
  const result = await (await post('chat/completions', { messages, tools }, zcode)).json();
  assert.deepEqual(result.naparnik_context, {token_count:101,max_context_length:384000});
  assert.equal(result.usage.total_tokens,100);
  const reply = result.choices[0].message;
  assert.equal(result.choices[0].finish_reason, 'tool_calls');
  assert.equal(reply.tool_calls[0].function.name, 'lookup');
  assert.notEqual(received[0].body.tools[0].name, 'lookup');
  const next = await (
    await post(
      'chat/completions',
      {
        messages: [...messages, reply, { role: 'tool', tool_call_id: 'call-1', content: '42' }],
        tools,
        stream_options: {include_usage:true},
        stream: true
      },
      zcode
    )
  ).text();
  assert.match(next, /Готово/);
  assert.match(next, /"choices":\[\],"usage":\{"prompt_tokens":90/);
  assert.match(next, /\[DONE\]/);
  assert.doesNotMatch(next, /Черновик/);
  assert.equal(received[1].url, received[0].url);
  assert.equal(received[1].body.parent_uuid, 'answer');
  assert.deepEqual(received[1].body.content, [{ tool_call_id: 'call-1', content: '42', status: 'ok' }]);
  const aTools = [{ name: 'lookup', input_schema: { type: 'object' } }];
  const a = await (await post('messages', { messages, tools: aTools, max_tokens: 50 }, deepseek)).json();
  assert.deepEqual(a.usage, {input_tokens:26, cache_read_input_tokens:64, output_tokens:10});
  assert.deepEqual(a.content, [{ type: 'tool_use', name: 'lookup', id: 'call-1', input: { x: 1 } }]);
  const s = await (
    await post(
      'messages',
      {
        messages: [
          ...messages,
          { role: 'assistant', content: a.content },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: '42' }] }
        ],
        tools: aTools,
        stream: true
      },
      deepseek
    )
  ).text();
  assert.match(s, /event: message_stop/);
  assert.match(s, /text_delta/);
  const events = s.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
  assert.deepEqual(events.find(event => event.type === 'message_delta').usage, a.usage);
  assert.equal(events.find(event => event.type === 'message_delta').naparnik_context.token_count, 101);
  const models = await (await request('/v1/models', undefined, oa)).json();
  assert.equal(models.data[0].context_length, 384000);
  assert.equal(received.at(-1).body.role, 'tool');
  assert.equal(received.at(-1).url, received.at(-2).url);
  const inventory = await (await request('/panel/tools', undefined, header)).json();
  assert.deepEqual(inventory.sessions.map(s => s.tools), [['lookup'], ['lookup']]);
  assert.equal((await request('/panel/tools', undefined, oa)).status, 403);
  for (const [path, headers] of [['messages', an], ['chat/completions', oa]]) {
    const final = post(path, {messages:[{role:'user', content:'permission'}], stream:true}, headers);
    assert.match(await (await final).text(), /Готово/);
    assert.equal(received.at(-1).body.parent_uuid, 'permission-request');
    assert.deepEqual(received.at(-1).body.content, [{tool_call_id:'web', status:'accepted', content:null}]);
  }
  const log = await (await request('/panel/tools', undefined, header)).json();
  assert.deepEqual(log.history.map(row => [row.protocol, row.name]), [
    ['OpenAI','mcp__web__fetch'], ['Anthropic','mcp__web__fetch']
  ]);
  const sessionHeaders = { ...oa, 'x-session-id': 'chat-A' };
  const chat = [{role: 'user', content: 'permission'}];
  await Promise.all([
    post('chat/completions', {messages: chat, tools}, sessionHeaders),
    post('messages', {messages: chat, tools: aTools}, {...an, 'x-deepseek-harness-session-id': 'chat-A'}),
    post('chat/completions', {messages: chat, tools}, {...oa, 'x-session-id': 'chat-B'})
  ]);
  assert.equal((await post('messages', {messages: [{role:'user', content:'title'}]}, {...an, 'x-deepseek-harness-session-id': 'chat-A'})).status, 200);
  assert.equal((await post('chat/completions', {messages: [{role:'user', content:'now empty'}], tools: []}, sessionHeaders)).status, 200);
  const grouped = await (await request('/panel/tools', undefined, header)).json();
  assert.equal(grouped.sessions.length, 5);
  assert.deepEqual(grouped.sessions.find(s => s.id === 'chat-A' && s.protocol === 'OpenAI').tools, []);
  const harness = grouped.sessions.find(s => s.id === 'chat-A' && s.protocol === 'Anthropic');
  assert.deepEqual(harness.tools, ['lookup']);
  assert.equal(harness.lastRequestDeclaredTools, false);
  assert.deepEqual(grouped.sessions.find(s => s.id === 'chat-B').tools, ['lookup']);
  for (const session of grouped.sessions.filter(s => s.id.startsWith('chat-'))) {
    assert.deepEqual(session.history.map(h => [h.protocol, h.name]), [[session.protocol, 'mcp__web__fetch']]);
  }
  assert.deepEqual(grouped.history, log.history);
  breaking = true;
  const bad = await post('messages', { messages }, an);
  assert.equal(bad.status, 402);
  assert.match(await bad.text(), /Лимит/);
  const image = await post('messages', { messages: [{ role: 'user', content: [{ type: 'image' }] }] }, an);
  assert.equal(image.status, 400);
  const disconnected = await (await request('/panel/account', undefined, header, 'DELETE')).json();
  assert.equal(disconnected.configured, false);
  assert.equal((await post('messages', { messages }, an)).status, 503);
});

test('ToolContent сохраняет статусы и детали результатов DeepSeek Harness', async () => {
  const { normalize } = await import('../bridge.js');
  const sessionId = 'harness-fixture';
  const callId = 'tool-read-1';
  const details = { path: '/tmp/example.txt', lines: [{ number: 1, text: 'строка' }] };
  const error = { name: 'FsError', code: 'FS_NOT_FOUND' };
  const log = {
    session: { id: sessionId },
    events: [
      { type: 'tool/result', data: { message: { role: 'tool', toolCallId: callId }, meta: details } },
      { type: 'tool/result', data: { message: { role: 'tool', toolCallId: 'tool-read-2' }, error } }
    ]
  };
  const result = normalize({
    model: 'naparnik',
    dsh_session_log: log,
    messages: [{ role: 'user', content: [
      { type: 'tool_result', tool_use_id: callId, content: [{ type: 'text', text: 'содержимое' }] },
      { type: 'tool_result', tool_use_id: 'tool-read-2', content: [{ type: 'text', text: 'не найдено' }], is_error: true }
    ] }]
  }, true, sessionId);
  assert.deepEqual(result.messages, [
    { role: 'tool', id: callId, status: 'ok', content: 'содержимое', details },
    { role: 'tool', id: 'tool-read-2', status: 'error', content: 'не найдено', details: { error } }
  ]);
});

test('ToolContent для ZCode получает стандартный статус по схеме OpenAI', async () => {
  const { normalize } = await import('../bridge.js');
  const result = normalize({
    model: 'naparnik',
    messages: [
      { role: 'assistant', tool_calls: [{ id: 'tool-read-1', function: { name: 'Read', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'tool-read-1', content: 'не найдено' }
    ]
  }, false);
  assert.deepEqual(result.messages.at(-1), {
    role: 'tool', id: 'tool-read-1', status: 'ok', content: 'не найдено'
  });
});
