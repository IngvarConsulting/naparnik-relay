import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionBindings } from '../state.js';
import { Bridge } from '../bridge.js';

test('Одинаковые истории разделяются по протоколу и ID, продолжение следует последнему ответу сессии', async () => {
  const bridge = new Bridge();
  let created = 0;
  const posts = [];
  bridge.request = async (_key, path, body) => {
    if (path === '/conversations') return Response.json({ uuid: 'chat-' + ++created });
    const uuid = 'reply-' + (posts.length + 1);
    posts.push({ path, parent: body.parent_uuid, content: body.content, uuid });
    const event = { uuid, finished: true, role: 'assistant', content: { content: 'Одинаковый ответ' } };
    return new Response('data: ' + JSON.stringify(event) + '\n\n');
  };
  const ask = (protocol, sessionId, messages) => bridge.generate('fixture',
    { protocol, sessionId, messages, tools: [] }, new AbortController().signal, () => {});
  const user = content => ({ role: 'user', content });
  const first = [user('Привет')];
  const reply = await ask('OpenAI', 'A', first);
  await ask('OpenAI', 'B', first);
  await ask('Anthropic', 'A', first);
  const same = [...first, reply, user('Продолжай')];
  await ask('Anthropic', 'A', same);
  await ask('OpenAI', 'B', same);
  await ask('OpenAI', 'A', same);
  // Edited history and a single-message request use the same cursor.
  await Promise.all([
    ask('OpenAI', 'A', [user('Другая история'), reply, user('Новый вопрос')]),
    ask('OpenAI', 'A', [user('Ещё один')])
  ]);
  assert.deepEqual(posts.map(p => [p.path, p.parent]), [
    [1, null], [2, null], [3, null], [3, 'reply-3'], [2, 'reply-2'], [1, 'reply-1'],
    [1, 'reply-6'], [1, 'reply-7']
  ].map(([n, parent]) => ['/conversations/chat-' + n + '/messages', parent]));
  assert.equal(posts[6].content, 'Новый вопрос');
  // Harness shares its ID with the separate request to generate the title.
  await ask('Anthropic', 'A', [user('Придумай название чата')]);
  const title = posts.at(-1);
  assert.equal(title.path, posts[3].path);
  assert.equal(title.parent, posts[3].uuid);
  await ask('Anthropic', 'A', same);
  assert.equal(posts.at(-1).parent, title.uuid);
  assert.equal(posts.at(-1).path, title.path);
  await ask('OpenAI', undefined, same);
  await ask('OpenAI', undefined, same);
  assert.equal(created, 5);
  assert.equal(posts.at(-1).parent, null);
  assert.notEqual(posts.at(-1).path, posts.at(-2).path);
});

test('После перезапуска результат инструмента продолжает сохранённый диалог своего ключа', async t => {
  const profile = mkdtempSync(join(tmpdir(), 'relay-restart-'));
  t.after(() => rmSync(profile, { recursive: true, force: true }));
  const key = 'private-test-key';
  const clientCall = { id: 'local', function: { name: 'client_lookup', arguments: '{}' } };
  const serverCall = { id: 'remote', function: { name: 'search_its', arguments: '{}' } };
  const input = {
    protocol: 'Anthropic', sessionId: 'session-A',
    messages: [{ role: 'user', content: 'Частный вопрос' }], tools: [{ name: 'lookup' }]
  };
  const service = (nextKey, respond) => {
    const bridge = new Bridge(undefined, new SessionBindings(profile, nextKey));
    bridge.request = async (_key, path, body) => {
      if (path === '/conversations') return Response.json({ uuid: 'first-dialogue' });
      const packet = respond(path, body);
      return new Response('data: ' + JSON.stringify({ role: 'assistant', finished: true, ...packet }) + '\n\n');
    };
    return bridge;
  };
  const run = (bridge, payload) => bridge.generate(key, payload, new AbortController().signal, () => {});
  const first = service(key, (_path, body) => {
    assert.equal(body.parent_uuid, null);
    return { uuid: 'first-answer', content: { tool_calls: [clientCall, serverCall] } };
  });
  const reply = await run(first, input);
  const directory = join(profile, 'sessions');
  const files = readdirSync(directory);
  assert.equal(files.length, 1);
  const file = join(directory, files[0]);
  const raw = readFileSync(file, 'utf8');
  assert.ok(!raw.includes(input.messages[0].content) && !raw.includes(key));
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
  const id = JSON.stringify([input.protocol, input.sessionId]);
  assert.equal(new SessionBindings(profile, 'other-key').get(id), undefined);
  const resumed = service(key, (path, body) => {
    assert.equal(path, '/conversations/first-dialogue/messages');
    assert.equal(body.parent_uuid, 'first-answer');
    assert.equal(body.role, 'tool');
    assert.deepEqual(body.content, [
      { tool_call_id: 'local', content: '42', status: 'ok' },
      { tool_call_id: 'remote', content: null, status: 'accepted' }
    ]);
    return { uuid: 'second-answer', content: { content: 'Готово' } };
  });
  await run(resumed, { ...input, messages: [...input.messages, reply, { role: 'tool', id: 'local', content: '42', status: 'ok' }] });
  const saved = new SessionBindings(profile, key).get(id);
  assert.deepEqual(saved, {
    conversation: 'first-dialogue', parent: 'second-answer', clientNames: ['client_lookup'], serverDecisions: []
  });
  const failed = service(key, () => { throw new Error('Поток оборвался'); });
  await assert.rejects(run(failed, input), /Поток оборвался/);
  assert.deepEqual(new SessionBindings(profile, key).get(id), saved);
});
