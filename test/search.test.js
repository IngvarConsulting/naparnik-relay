import test from 'node:test';
import assert from 'node:assert/strict';
import { Bridge } from '../bridge.js';

const search = 'mcp__knowledge-hub__Search_ITS';
const call = (id, name = search) => ({ id, function: { name, arguments: '{}' } });
const answer = (uuid, content, tool_calls) => ({
  role: 'assistant',
  finished: true,
  uuid,
  content: { content, tool_calls }
});
const delta = (uuid, content_delta) => ({ uuid, parent_uuid: null, role: null, finished: false, content: null, content_delta });
const accepted = (id) => ({ tool_call_id: id, status: 'accepted', content: null });
const result = (uuid, parent_uuid, id) => ({ uuid, parent_uuid, role: 'tool', finished: true, content: accepted(id), content_delta: null });
const echo = (uuid, parent_uuid) => ({ uuid, parent_uuid, role: 'user', content: null, finished: true });
const saved = ({ uuid, role, content }, parent_uuid) => ({ uuid, parent_uuid, role, content, create_time: '2026-08-25T10:00:00Z' });
const event = (packet) => 'data: ' + JSON.stringify(packet) + '\n\n';
const query = { messages: [{ role: 'user', content: 'Проверь по ИТС' }], tools: [] };
function service(rounds, history = []) {
  const bridge = new Bridge();
  const posts = [];
  bridge.request = async (_key, path, body) => {
    if (path === '/conversations') return Response.json({ uuid: 'session' });
    if (path === '/conversations/session') {
      assert.equal(body, undefined);
      return Response.json({ uuid: 'session', messages: history });
    }
    assert.equal(path, '/conversations/session/messages');
    posts.push(body);
    const events = rounds.shift();
    assert.ok(events, 'unexpected additional request');
    return new Response(typeof events === 'string' ? events : events.map(event).join(''));
  };
  return { bridge, posts };
}
const run = (bridge, body = query, controller = new AbortController(), part = () => {}, onServerCall) =>
  bridge.generate('fixture', { ...body, protocol: 'OpenAI', sessionId: 'search' }, controller.signal, part, onServerCall);

test('Поиск ИТС: групповые и повторные запросы остаются в одном диалоге', async () => {
  const { bridge, posts } = service([
    [answer('a', 'Проверю.', [call('1'), call('2')])],
    [{ uuid: '', finished: false }, answer('b', '', [call('3')])],
    [answer('c', 'Результат.', [])]
  ]);
  const parts = [];
  const reply = await run(bridge, query, new AbortController(), (p) => parts.push(p));
  assert.equal(reply.content, 'Проверю.\n\nРезультат.');
  assert.deepEqual(reply.calls, []);
  assert.equal(parts.map((p) => p.content).join(''), reply.content);
  assert.deepEqual(posts.slice(1), [
    { role: 'tool', parent_uuid: 'a', no_generate: false, content: [accepted('1'), accepted('2')] },
    { role: 'tool', parent_uuid: 'b', no_generate: false, content: [accepted('3')] }
  ]);
});

test('Совместный запрос клиентского инструмента и поиска подтверждается одной группой', async () => {
  const { bridge, posts } = service([
    [answer('a', '', [call('s'), call('c', 'client_lookup')]), answer('b', 'Жду результат.', [])],
    [answer('done', 'Готово', [])]
  ]);
  const tools = [{ name: 'lookup', description: '', parameters: { type: 'object' } }];
  const reply = await run(bridge, { ...query, tools });
  assert.deepEqual(reply.calls, [{ id: 'c', name: 'lookup', args: '{}' }]);
  assert.equal(posts.length, 1);
  await run(bridge, {
    tools,
    messages: [...query.messages, reply, { role: 'tool', id: 'c', content: '42', status: 'ok' }]
  });
  assert.equal(posts[1].parent_uuid, 'a');
  assert.deepEqual(posts[1].content, [{ tool_call_id: 'c', content: '42', status: 'ok' }, accepted('s')]);
});

test('Готовый результат в том же потоке не требует повторного подтверждения', async () => {
  const { bridge, posts } = service([[
    answer('a', '', [call('s')]),
    delta('', { tool_call_id: 's', name: search }),
    answer('b', 'Ищу.', []),
    result('tool-s', 'a', 's'),
    answer('c', 'Нашёл.', [])
  ]]);
  assert.equal((await run(bridge)).content, 'Ищу.\n\nНашёл.');
  assert.equal(posts.length, 1);
});

test('Подтверждение поиска следует UUID вызова после другого финала ассистента', async () => {
  const { bridge, posts } = service([
    [answer('a', '', [call('s')]), answer('b', '', [])],
    [result('tool-s', 'a', 's'), answer('c', 'Нашёл.', [])]
  ]);
  assert.equal((await run(bridge)).content, 'Нашёл.');
  assert.deepEqual(posts[1], { role: 'tool', parent_uuid: 'a', no_generate: false, content: [accepted('s')] });
});

test('После обрыва второго ответа история дополняет SSE без повтора первого ответа', async () => {
  const first = answer('first', 'Первая часть.', []);
  const second = answer('second', 'Вторая часть.', []);
  const { bridge, posts } = service([
    [answer('previous', 'Готово.', [])],
    [echo('question', 'previous'), first, delta('second', { content: 'Незавершённая часть.' })],
    [answer('next', 'Готово.', [])]
  ], [
    saved({ uuid: 'initial', role: 'user', content: query.messages[0].content }, null),
    saved(answer('previous', 'Готово.', []), 'initial'),
    saved({ uuid: 'question', role: 'user', content: 'Продолжай' }, 'previous'),
    saved(first, 'question'),
    saved(second, 'first')
  ]);
  const previous = await run(bridge);
  const next = { ...query, messages: [...query.messages, previous, { role: 'user', content: 'Продолжай' }] };
  const parts = [];
  const recovered = await run(bridge, next, new AbortController(), part => parts.push(part.content));
  assert.deepEqual(parts, ['Первая часть.', '\n\nВторая часть.']);
  assert.equal(recovered.content, parts.join(''));
  await run(bridge, { ...query, messages: [{ role: 'user', content: 'Дальше' }] });
  assert.deepEqual(posts.slice(1).map(post => post.parent_uuid), ['previous', 'second']);
});

test('Финал без завершающей пустой строки считается оборванным SSE-событием', async () => {
  const partial = event(echo('question', null)) + event(answer('first', 'Ответ.', [])).slice(0, -1);
  const { bridge } = service([partial], [
    saved({ uuid: 'question', role: 'user', content: query.messages[0].content }, null)
  ]);
  await assert.rejects(run(bridge), { status: 409, code: 'recovery_pending' });
});

test('Обрыв потока во время поиска сохраняет курсор до появления результата в истории', async () => {
  const requested = answer('requested', '', [call('s')]);
  const history = [
    saved({ uuid: 'initial', role: 'user', content: query.messages[0].content }, null),
    saved(answer('prior', 'Earlier answer', []), 'initial'),
    saved({ uuid: 'question', role: 'user', content: 'Проверь по ИТС' }, 'prior'),
    saved(requested, 'question')
  ];
  const { bridge, posts } = service([
    [answer('prior', 'Earlier answer', [])],
    [
      echo('question', 'prior'),
      requested,
      { uuid: '', finished: false, content: null, content_delta: { tool_call_id: 's', name: search } }
    ]
  ], history);
  await run(bridge);
  await assert.rejects(run(bridge), { status: 409, code: 'recovery_pending' });
  assert.equal(bridge.sessions.get(JSON.stringify(['OpenAI', 'search'])).parent, 'prior');
  history.push(saved(result('tool-s', 'requested', 's'), 'requested'));
  history.push(saved(answer('ready', 'Готовый результат.', []), 'tool-s'));
  assert.equal((await run(bridge)).content, 'Готовый результат.');
  assert.equal(posts.length, 2);
});

test('Ошибка передачи SSE возвращается как незавершённый ответ', async () => {
  const bridge = new Bridge();
  let historyAttempts = 0;
  bridge.request = async (_key, path) => {
    if (path === '/conversations') return Response.json({ uuid: 'chat' });
    if (path === '/conversations/chat') {
      historyAttempts++;
      throw new Error('История недоступна');
    }
    const stream = new ReadableStream({
      pull(controller) { controller.error(new TypeError('Connection reset')); }
    });
    return new Response(stream);
  };
  await assert.rejects(run(bridge), { status: 502, code: 'incomplete_stream' });
  assert.equal(historyAttempts, 1);
  assert.equal(bridge.sessions.get(JSON.stringify(['OpenAI', 'search'])).parent, null);
});

test('Отмена и повтор идентификатора прерывают поиск', async () => {
  const { bridge, posts } = service([[answer('a', 'Проверю', [call('s')])]]);
  const controller = new AbortController();
  await assert.rejects(
    run(bridge, query, controller, () => controller.abort()),
    { name: 'AbortError' }
  );
  assert.equal(posts.length, 1);
  const repeated = service([[answer('a', '', [call('s')])], [answer('b', '', [call('s')])]]);
  await assert.rejects(run(repeated.bridge), { code: 'repeated_tool_call' });
});

test('Серверные инструменты подтверждаются автоматически, клиентский mcp__ остаётся у агента', async () => {
  const name = 'mcp__web__fetch';
  const {bridge, posts} = service([
    [answer('a', '', [call('x', name), call('y'), call('client', 'client_' + name)])],
    [answer('b', 'Завершено', [])]
  ]);
  const tools = [{name, parameters:{type:'object'}}];
  const seen = [];
  const reply = await run(bridge, {...query, tools}, new AbortController(), () => {}, (name) => seen.push(name));
  assert.deepEqual(seen, [name, search]);
  assert.deepEqual(reply.calls, [{id:'client', name, args:'{}'}]);
  await run(bridge, { tools, messages:[...query.messages, reply, {role:'tool', id:'client', content:'result', status:'ok'}] });
  assert.deepEqual(posts[1].content, [
    { tool_call_id:'client', content:'result', status:'ok' },
    accepted('x'),
    accepted('y')
  ]);
});

test('Серверное имя с client_ разрешается, ранее объявленный клиентский вызов не подтверждается', async () => {
  const mock = service([
    [answer('a', '', [call('s', 'client_remote')])],
    [answer('b', 'Готово', [])],
    [answer('c', '', [call('c', 'client_lookup')])]
  ]);
  const tools = [{name:'lookup', parameters:{type:'object'}}];
  const reply = await run(mock.bridge, {...query, tools});
  assert.deepEqual(mock.posts[1].content, [accepted('s')]);
  await assert.rejects(run(mock.bridge, {messages:[...query.messages, reply, {role:'user', content:'Ещё'}], tools:[]}),
    {code:'unknown_client_tool'});
  assert.equal(mock.posts.length, 3);
});
