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
const accepted = (id) => ({ tool_call_id: id, status: 'accepted', content: null });
const query = { messages: [{ role: 'user', content: 'Проверь по ИТС' }], tools: [] };
function service(rounds) {
  const bridge = new Bridge();
  const posts = [];
  bridge.request = async (_key, path, body) => {
    if (path === '/conversations') return Response.json({ uuid: 'session' });
    assert.equal(path, '/conversations/session/messages');
    posts.push(body);
    const events = rounds.shift();
    assert.ok(events, 'unexpected additional request');
    return new Response(events.map((p) => 'data: ' + JSON.stringify(p) + '\n\n').join(''));
  };
  return { bridge, posts };
}
const run = (bridge, body = query, controller = new AbortController(), part = () => {}) =>
  bridge.generate('fixture', body, controller.signal, part);

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
    [answer('a', '', [call('s'), call('c', 'client_lookup')])],
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
  assert.deepEqual(posts[1].content, [{ tool_call_id: 'c', content: '42', status: 'ok' }, accepted('s')]);
});

test('Готовый результат в том же потоке не требует повторного подтверждения', async () => {
  const { bridge, posts } = service([[answer('a', '', [call('s')]), answer('b', 'Нашёл.', [])]]);
  assert.equal((await run(bridge)).content, 'Нашёл.');
  assert.equal(posts.length, 1);
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
  const unknown = service([[answer('a', '', [call('x', 'other_tool')])]]);
  await assert.rejects(run(unknown.bridge), { code: 'unsupported_server_tool' });
});
