import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionBindings } from '../state.js';
import { Bridge, Fault } from '../bridge.js';

test('Диалоги изолированы по протоколу и ID, ветки выбираются по истории', async () => {
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
  const second = await ask('OpenAI', 'A', same);
  const dialogue = [...same, second];
  // A request with only new input still continues the latest turn.
  await ask('OpenAI', 'A', [user('Incremental request')]);
  // Replacing a later question branches from the matching earlier response.
  await ask('OpenAI', 'A', [...first, reply, user('Replace the second question')]);
  // A fully edited transcript needs a new upstream conversation.
  await Promise.all([
    ask('OpenAI', 'A', [user('Edited first question'), reply, user('New question')]),
    ask('OpenAI', 'A', [user('Follow-up on the edited history')])
  ]);
  // Switch back to a saved branch even after creating the replacement conversation.
  await ask('OpenAI', 'A', [...dialogue, user('Return to the original history')]);
  assert.deepEqual(posts.map(p => [p.path, p.parent]), [
    [1, null], [2, null], [3, null], [3, 'reply-3'], [2, 'reply-2'], [1, 'reply-1'],
    [1, 'reply-6'], [1, 'reply-1'], [4, null], [4, 'reply-9'], [1, 'reply-6']
  ].map(([n, parent]) => ['/conversations/chat-' + n + '/messages', parent]));
  assert.match(posts[8].content, /Edited first question/);
  assert.match(posts[8].content, /New question/);
  await ask('OpenAI', undefined, same);
  await ask('OpenAI', undefined, same);
  assert.equal(created, 6);
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
  assert.deepEqual([saved.conversation, saved.parent, saved.clientNames, saved.serverDecisions],
    ['first-dialogue', 'second-answer', ['client_lookup'], []]);
  assert.equal(saved.checkpoints.length, 2);
  assert.equal(saved.checkpoints[0].parent, 'first-answer');
  assert.equal(saved.checkpoints[1].parent, 'second-answer');
  assert.ok(!readFileSync(file, 'utf8').includes(input.messages[0].content));
  const failed = service(key, () => { throw new Error('Поток оборвался'); });
  await assert.rejects(run(failed, input), /Поток оборвался/);
  const { recoveries, ...cursor } = new SessionBindings(profile, key).get(id);
  assert.deepEqual(cursor, saved);
  assert.equal(recoveries.length, 1);
  assert.equal(recoveries[0].posts[0].parent, saved.parent);
});

test('Запрос названия может прийти раньше чата и не сдвигает его курсор', async () => {
  const bridge = new Bridge();
  const posted = [];
  bridge.request = async (_key, path, body, _signal, _stream, method) => {
    posted.push({ path, body, method });
    if (path === '/conversations') return Response.json({ uuid: 'chat' });
    if (path.endsWith('/title')) return Response.json({ title: 'Title' });
    const event = { uuid: 'answer', role: 'assistant', finished: true, content: { content: 'Reply' } };
    return new Response('data: ' + JSON.stringify(event) + '\n\n');
  };
  const request = {
    protocol: 'Anthropic', sessionId: 'same',
    messages: [{ role: 'user', content: 'Question' }], tools: []
  };
  const ask = payload => bridge.generate('fixture', payload, new AbortController().signal, () => {});
  const title = ask({ ...request, titleRequest: true });
  await ask(request);
  assert.equal((await title).content, 'Title');
  assert.deepEqual(posted.map(item => item.path), [
    '/conversations', '/conversations/chat/messages', '/conversations/chat/title'
  ]);
  assert.equal(posted[2].method, 'POST');
  assert.equal(posted[2].body, undefined);
  await ask(request);
  assert.equal(posted.at(-1).body.parent_uuid, 'answer');
});

test('Запрос названия ждёт новый ответ после 424 и повторяет /title в том же диалоге', async () => {
  const bridge = new Bridge();
  const firstTitle = Promise.withResolvers();
  const posts = [];
  let turns = 0;
  let titleAttempts = 0;
  bridge.request = async (_key, path, body, _signal, _stream, method) => {
    posts.push({ path, body, method });
    if (path === '/conversations') return Response.json({ uuid: 'chat' });
    if (path.endsWith('/title')) {
      if (++titleAttempts === 1) {
        firstTitle.resolve();
        throw new Fault(424, 'insufficient_context', 'Need another turn');
      }
      assert.equal(turns, 2);
      return Response.json({ title: 'A title from 1C' });
    }
    const event = { uuid: 'answer-' + ++turns, role: 'assistant', finished: true, content: { content: 'Reply' } };
    return new Response('data: ' + JSON.stringify(event) + '\n\n');
  };
  const request = {
    protocol: 'Anthropic', sessionId: 'same',
    messages: [{ role: 'user', content: 'First' }], tools: []
  };
  const controller = new AbortController();
  const ask = payload => bridge.generate('fixture', payload, controller.signal, () => {});
  await ask(request);
  const title = ask({ ...request, titleRequest: true });
  title.catch(() => {});
  try {
    await firstTitle.promise;
    await ask({ ...request, messages: [{ role: 'user', content: 'Second' }] });
    assert.equal((await title).content, 'A title from 1C');
    assert.deepEqual(posts.filter(post => post.path.endsWith('/title')), [
      { path: '/conversations/chat/title', body: undefined, method: 'POST' },
      { path: '/conversations/chat/title', body: undefined, method: 'POST' }
    ]);
    assert.equal(bridge.sessions.get(JSON.stringify(['Anthropic', 'same'])).parent, 'answer-2');
  } finally {
    controller.abort();
  }
});

test('Ожидание первого ответа для названия прерывается отменой клиента', async () => {
  const bridge = new Bridge();
  const release = Promise.withResolvers();
  bridge.request = async (_key, path) => {
    if (path === '/conversations') return Response.json({ uuid: 'chat' });
    await release.promise;
    const event = { uuid: 'answer', role: 'assistant', finished: true, content: { content: 'Reply' } };
    return new Response('data: ' + JSON.stringify(event) + '\n\n');
  };
  const request = {
    protocol: 'Anthropic', sessionId: 'same',
    messages: [{ role: 'user', content: 'First' }], tools: []
  };
  const controller = new AbortController();
  const chat = bridge.generate('fixture', request, new AbortController().signal, () => {});
  let failure;
  const title = bridge.generate('fixture', { ...request, titleRequest: true }, controller.signal, () => {})
    .catch(error => { failure = error; });
  try {
    controller.abort();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(failure?.name, 'AbortError');
  } finally {
    release.resolve();
    await Promise.all([chat, title]);
  }
});

test('Завершённый ответ сохраняется при отключении клиента во время замера контекста', async () => {
  const bridge = new Bridge();
  const controller = new AbortController();
  bridge.request = async (_key, path) => {
    if (path === '/conversations') return Response.json({ uuid: 'chat' });
    if (path.includes('/context_tokens?')) {
      controller.abort();
      throw new Error('Cancelled optional metrics');
    }
    const event = { uuid: 'answer', role: 'assistant', finished: true, content: { content: 'Reply' } };
    return new Response('data: ' + JSON.stringify(event) + '\n\n');
  };
  const request = {
    protocol: 'OpenAI', sessionId: 'same',
    messages: [{ role: 'user', content: 'Question' }], tools: []
  };
  await bridge.generate('fixture', request, controller.signal, () => {}, () => {}, () => {});
  assert.equal(bridge.sessions.get(JSON.stringify(['OpenAI', 'same'])).parent, 'answer');
});
