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
    accounts = [],
    historyRequests = [],
    titleRequests = [];
  let id = 0,
    breaking = null,
    missingContext = false,
    toolArguments = '{ "x" : 1 }';
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
    if (req.method === 'GET' && /^\/conversations\/chat-\d+$/.test(req.url)) {
      historyRequests.push(req.url);
      const { body } = received.at(-1);
      const create_time = '2026-08-25T10:00:00Z';
      return res.end(JSON.stringify({
        uuid: req.url.split('/').at(-1),
        messages: [
          { uuid: 'echo', parent_uuid: body.parent_uuid, role: 'user', content: body.content, create_time },
          {
            uuid: 'answer', parent_uuid: 'echo', role: 'assistant', create_time,
            content: {
              tool_calls: [{ id: 'call-1', function: { name: body.tools[0].name, arguments: toolArguments } }]
            }
          }
        ]
      }));
    }
    if (req.url.includes('/context_tokens?branch=')) {
      assert.match(req.url, /branch=answer$/);
      if (missingContext) {
        res.statusCode = 503;
        return res.end('{}');
      }
      return res.end(JSON.stringify({token_count: 101, max_context_length: 384000}));
    }
    let raw = '';
    for await (const p of req) raw += p;
    if (req.url.endsWith('/title')) {
      titleRequests.push({ path: req.url, method: req.method, body: raw });
      return res.end(JSON.stringify({ title: 'A generated title' }));
    }
    const body = JSON.parse(raw);
    received.push({ body, url: req.url });
    res.setHeader('content-type', 'text/event-stream');
    const event = (obj) => res.write('data: ' + JSON.stringify(obj) + '\r\n\r\n');
    event({ uuid: 'echo', role: body.role, finished: true });
    event({ uuid: body.content === 'permission' ? 'permission-request' : 'answer', role: null, finished: false, content_delta: { content: 'Черновик' } });
    if (breaking) {
      event({ error_type: breaking, error: 'fixture error' });
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
        ? { tool_calls: [{ id: 'call-1', function: { name: body.tools[0].name, arguments: toolArguments } }] }
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
  const claudeHeaders = { ...an, 'anthropic-version': '2023-06-01' };
  const modelList = await (await request('/v1/models', undefined, claudeHeaders)).json();
  assert.deepEqual([modelList.first_id, modelList.last_id, modelList.has_more], ['naparnik', 'naparnik', false]);
  assert.equal(modelList.data[0].type, 'model');
  assert.deepEqual(
    await (await request('/v1/models/naparnik', undefined, claudeHeaders)).json(),
    modelList.data[0]
  );
  const nextPage = await (await request('/v1/models?after_id=naparnik', undefined, claudeHeaders)).json();
  assert.deepEqual(nextPage, { data: [], first_id: null, last_id: null, has_more: false });
  const openAIModel = await (await request('/v1/models/naparnik', undefined, oa)).json();
  assert.equal(openAIModel.object, 'model');
  assert.equal(openAIModel.id, 'naparnik');
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
        system: 'Harness refreshed its system prompt during the tool call.',
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
  const inventory = await (await request('/panel/tool-history', undefined, header)).json();
  assert.deepEqual(inventory.sessions.map(s => s.tools), [['lookup'], ['lookup']]);
  assert.equal((await request('/panel/tools', undefined, oa)).status, 403);
  assert.equal((await request('/panel/trace', undefined, oa)).status, 403);
  const options = await (await request('/panel/tools', undefined, header)).json();
  assert.deepEqual(options.tools.filter(tool => !tool.enabled).map(tool => tool.id), ['mcp__web__fetch']);
  for (const [path, headers, enabled] of [['messages', an, false], ['chat/completions', oa, true]]) {
    if (enabled) {
      const result = await request('/panel/tools', { id: 'mcp__web__fetch', enabled }, header, 'PUT');
      assert.equal(result.status, 200);
      assert.equal((await result.json()).tools.find(tool => tool.id === 'mcp__web__fetch').enabled, true);
      assert.equal(accounts.at(-1).serverTools['mcp__web__fetch'], true);
    }
    const final = post(path, {messages:[{role:'user', content:'permission'}], stream:true}, headers);
    assert.match(await (await final).text(), /Готово/);
    assert.equal(received.at(-1).body.parent_uuid, 'permission-request');
    assert.deepEqual(received.at(-1).body.content, [{tool_call_id:'web', status: enabled ? 'accepted' : 'rejected', content:null}]);
  }
  const log = await (await request('/panel/tool-history', undefined, header)).json();
  assert.deepEqual(log.history.map(row => [row.protocol, row.name]), [
    ['OpenAI','mcp__web__fetch'], ['Anthropic','mcp__web__fetch']
  ]);
  const sessionHeaders = { ...oa, 'x-session-id': 'chat-A' };
  const chat = [{role: 'user', content: 'permission'}];
  const harnessHeaders = {...an, 'x-deepseek-harness-session-id': 'chat-A'};
  await post('chat/completions', {messages: chat, tools}, sessionHeaders);
  await post('messages', {messages: chat, tools: aTools}, harnessHeaders);
  const previousChat = received.at(-1);
  await post('chat/completions', {messages: chat, tools}, {...oa, 'x-session-id': 'chat-B'});
  const titleInput = {
    system: 'Create a concise title for an AI coding-assistant session from the supplied human messages.\n' +
      'Return only the title on one line, **in plain text of natural language**, with no quotes, prefix, explanation, Markdown, XML, or terminal control codes. No code is allowed.\n' +
      'Use the language of the messages.\n' +
      'Aim for about 5 words in non-CJK languages or 10 CJK characters.\n' +
      'If the messages give little to name, still return a short best-effort title, such as Greeting, instead of explaining.',
    messages: [{role: 'user', content: [{type: 'text',
      text: 'Generate the session title from this JSON array of human messages:\n' +
        JSON.stringify([{ seq: 5, text: 'permission' }])
    }]}],
    stream: true
  };
  const postsBeforeTitle = received.length;
  const titleResponse = await post('messages', titleInput, harnessHeaders);
  assert.equal(titleResponse.status, 200);
  assert.match(await titleResponse.text(), /A generated title/);
  assert.equal(received.length, postsBeforeTitle);
  assert.equal(titleRequests.length, 1);
  assert.deepEqual(titleRequests[0], {
    path: previousChat.url.replace('/messages', '/title'), method: 'POST', body: ''
  });
  const updateResponse = await post('messages', {
    ...titleInput,
    messages: [{role: 'user', content: [{type: 'text',
      text: 'Update the session title from this JSON object:\n' +
        JSON.stringify({ currentTitle: 'A generated title', messages: [
          { seq: 5, text: 'permission' }, { seq: 8, text: 'follow-up' }
        ] })
    }]}]
  }, harnessHeaders);
  assert.equal(updateResponse.status, 200);
  assert.match(await updateResponse.text(), /A generated title/);
  assert.equal(received.length, postsBeforeTitle);
  assert.deepEqual(titleRequests[1], titleRequests[0]);
  await post('messages', {messages: [{role: 'user', content: 'A normal question about titles'}]}, harnessHeaders);
  assert.equal(received.at(-1).url, previousChat.url);
  assert.equal(received.at(-1).body.parent_uuid, 'answer');
  assert.equal(titleRequests.length, 2);
  assert.equal((await post('chat/completions', {messages: [{role:'user', content:'now empty'}], tools: []}, sessionHeaders)).status, 200);
  const grouped = await (await request('/panel/tool-history', undefined, header)).json();
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
  const traceIndex = await (await request('/panel/trace', undefined, header)).json();
  for (const [protocol, id, toolScope] of [
    ['Anthropic', 'chat-A', 'server'], ['OpenAI', 'chat-A', 'server'],
    ['Anthropic', 'deepseek-tools', 'client'], ['OpenAI', 'zcode-tools', 'client']
  ]) {
    const session = encodeURIComponent(JSON.stringify([protocol, id]));
    const { exchanges } = await (await request('/panel/trace?session=' + session, undefined, header)).json();
    const calls = exchanges.flatMap(exchange => exchange.upstream).filter(packet => packet.body?.content?.tool_calls?.length);
    assert.ok(calls.length);
    assert.ok(calls.every(packet => packet.toolScope === toolScope));
  }
  const traceSession = traceIndex.sessions.find(session => session.id === JSON.stringify(['Anthropic', 'chat-A']));
  assert.equal(traceSession.title, 'A generated title');
  const trace = await (await request('/panel/trace?session=' + encodeURIComponent(traceSession.id), undefined, header)).json();
  const titleTrace = trace.exchanges.find(exchange => exchange.upstream.some(packet => packet.path?.endsWith('/title')));
  const titleRequest = titleTrace.upstream.find(packet => packet.path?.endsWith('/title'));
  const titleResult = titleTrace.upstream.find(packet => packet.call === titleRequest.id && packet.kind === 'response');
  assert.equal(titleRequest.source, titleTrace.client[0].id);
  assert.equal(titleResult.body.title, 'A generated title');
  assert.ok(titleTrace.client.some(packet => packet.source === titleResult.id && packet.body?.delta?.text === 'A generated title'));
  assert.doesNotMatch(JSON.stringify(trace), /real-fixture|local-fixture|panel-fixture/);
  missingContext = true;
  const unmeasured = await (await post('chat/completions', { messages, tools }, zcode)).json();
  assert.equal(unmeasured.usage.total_tokens, 100);
  assert.equal(unmeasured.naparnik_context, undefined);
  missingContext = false;
  breaking = 'budget_exceeded';
  const bad = await post('messages', { messages }, an);
  assert.equal(bad.status, 402);
  const billing = await bad.json();
  assert.equal(billing.error.type, 'billing_error');
  assert.match(billing.error.message, /Лимит/);
  const quota = await post('chat/completions', { messages }, oa);
  assert.equal(quota.status, 429);
  assert.equal((await quota.json()).error.code, 'insufficient_quota');
  breaking = 'validation';
  const invalid = await post('messages', { messages }, an);
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error.type, 'invalid_request_error');
  breaking = 'conflict';
  const conflict = await post('messages', { messages }, an);
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error.type, 'conflict_error');
  const image = await post('messages', { messages: [{ role: 'user', content: [{ type: 'image' }] }] }, an);
  assert.equal(image.status, 400);
  breaking = null;
  const count = await post('messages/count_tokens', { messages }, an);
  assert.equal(count.status, 404);
  assert.equal((await count.json()).error.type, 'not_found_error');
  const malformedSession = { ...an, 'x-session-id': 'malformed-anthropic' };
  toolArguments = '[]';
  const malformed = await post('messages', { messages, tools: aTools }, malformedSession);
  assert.equal(malformed.status, 502);
  const originalPosts = received.length;
  toolArguments = '{ "x" : 1 }';
  assert.equal((await post('messages', { messages, tools: aTools }, malformedSession)).status, 200);
  assert.equal(received.length, originalPosts);
  assert.deepEqual(historyRequests, [received.at(-1).url.replace(/\/messages$/, '')]);
  assert.equal(received.at(-1).body.parent_uuid, null);
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
