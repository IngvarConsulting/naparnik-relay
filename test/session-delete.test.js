import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../server.js';
import { SessionBindings } from '../state.js';
import { ToolMonitor } from '../tool-monitor.js';

const key = 'test-upstream-key';
const sessionId = id => JSON.stringify(['OpenAI', id]);
const question = content => ({ role: 'user', content });
const uuid = index => 'd382d748-c476-4477-a09a-' + String(index).padStart(12, '0');

async function fixture(t) {
  const profileDir = mkdtempSync(join(tmpdir(), 'relay-session-delete-'));
  const historyFile = join(profileDir, 'tools.json');
  const bindings = new SessionBindings(profileDir, key);
  const deletes = [];
  let conversation = 0;
  let answer = 0;
  let handleNextMessage, handleDeletion;
  const listen = async server => {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => { server.close(); server.closeAllConnections(); });
    return 'http://127.0.0.1:' + server.address().port;
  };
  const upstream = await listen(http.createServer(async (req, res) => {
    if (req.method === 'DELETE') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      deletes.push({ url: req.url, authorization: req.headers.authorization, body: Buffer.concat(chunks).toString() });
      return handleDeletion ? handleDeletion(res) : res.writeHead(204).end();
    }
    if (req.url === '/conversations') return res.end(JSON.stringify({ uuid: uuid(++conversation) }));
    if (req.url.includes('/context_tokens?')) return res.end('{}');
    let content;
    if (handleNextMessage) {
      const wait = handleNextMessage;
      handleNextMessage = undefined;
      content = await wait();
    }
    const packet = { uuid: 'answer-' + ++answer, role: 'assistant', finished: true, content: content ?? { content: 'Ответ' } };
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('data: ' + JSON.stringify(packet) + '\n\n');
  }));
  const relayServer = () => createServer({ upstream, profileDir, monitor: new ToolMonitor(historyFile),
    connection: { upstream: key, localKey: 'test-local-key', admin: 'test-admin-key' } });
  let server = relayServer();
  let relay = await listen(server);
  t.after(() => rmSync(profileDir, { recursive: true, force: true }));

  const headers = { 'X-Relay-Panel': '1', 'Content-Type': 'application/json' };
  const auth = await fetch(relay + '/panel/session', { method: 'POST', headers, body: '{"token":"test-admin-key"}' });
  assert.equal(auth.status, 200);
  await auth.json();
  const panel = { ...headers, Cookie: auth.headers.get('set-cookie').split(';')[0] };
  const trace = id => relay + '/panel/trace?' + new URLSearchParams({ session: id });
  const ask = (id, messages, tools, { anthropic = false, delta = false } = {}) => {
    const headers = anthropic ? { 'X-API-Key': 'test-local-key', 'Anthropic-Version': '2023-06-01',
      'X-DeepSeek-Harness-Session-Id': id } : { Authorization: 'Bearer test-local-key', ...(id && { 'X-Session-Id': id }) };
    if (delta) headers['x-relay-input'] = 'delta';
    return fetch(relay + (anthropic ? '/v1/messages' : '/v1/chat/completions'), {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'naparnik', messages, tools })
    });
  };
  return { ask, bindings, deletes, profileDir,
    async snapshot(id) { return (await fetch(trace(id), { headers: panel })).json(); },
    remove(cid, headers = { Authorization: 'Bearer test-local-key' }) {
      return fetch(relay + '/v1/conversations/' + encodeURIComponent(cid), { method: 'DELETE', headers });
    },
    deleteTrace(id) { return fetch(trace(id), { method: 'DELETE', headers: panel }); },
    async restart() {
      server.close();
      server.closeAllConnections();
      server = relayServer();
      relay = await listen(server);
    },
    onNextMessage(run) { handleNextMessage = run; },
    onDeletion(run) { handleDeletion = run; }
  };
}

test('Клиент удаляет диалог и привязку по UUID из заголовка ответа', async t => {
  const service = await fixture(t);
  const id = sessionId('first');
  for (const client of ['first', 'second']) assert.equal((await service.ask(client, [question(client)])).status, 200);
  assert.equal((await service.snapshot(id)).exchanges[0].conversation, uuid(1));
  assert.equal(service.bindings.get(id).conversation, uuid(1));

  assert.equal((await service.remove(uuid(1), {})).status, 401);
  assert.equal((await service.remove('not-a-uuid')).status, 404);
  assert.equal((await service.deleteTrace(id)).status, 404);
  assert.equal(service.deletes.length, 0);
  const removed = await service.remove(uuid(1));
  assert.equal(removed.status, 200);
  assert.deepEqual(await removed.json(), { id: uuid(1), object: 'conversation.deleted', deleted: true });
  assert.deepEqual(service.deletes, [{ url: '/conversations/' + uuid(1), authorization: 'Bearer ' + key, body: '' }]);
  assert.equal(service.bindings.get(id), undefined);
  assert.equal(service.bindings.get(sessionId('second')).conversation, uuid(2));
  const after = await service.snapshot(id);
  assert.deepEqual(after.sessions.map(session => session.id), [sessionId('second')]);
  assert.deepEqual(after.exchanges, []);
  assert.equal((await service.ask('first', [question('Новый диалог')])).headers.get('X-Relay-Conversation-Id'), uuid(3));
});

test('Сохраняет привязку при ошибке 1С и удаляет её, если 1С подтверждает отсутствие диалога', async t => {
  const service = await fixture(t);
  const id = sessionId('first');
  assert.equal((await service.ask('first', [question('Первое сообщение')])).status, 200);
  service.onDeletion(res => res.writeHead(403).end('{"error_type":"access_denied"}'));
  assert.equal((await service.remove(uuid(1))).status, 403);
  assert.equal(service.bindings.get(id).conversation, uuid(1));
  assert.equal((await service.snapshot(id)).sessions.length, 1);

  service.onDeletion(res => res.writeHead(404).end('{}'));
  assert.equal((await service.remove(uuid(1))).status, 404);
  assert.equal(service.bindings.get(id).conversation, uuid(1));

  service.onDeletion(res => res.writeHead(404).end('{"error_type":"resource_not_found"}'));
  assert.equal((await service.remove(uuid(1))).status, 200);
  assert.equal(service.bindings.get(id), undefined);
  assert.deepEqual((await service.snapshot(id)).sessions, []);
});

test('Удаление точного UUID сохраняет другой диалог той же сессии', async t => {
  const service = await fixture(t);
  const id = sessionId('first');
  const first = await (await service.ask('first', [question('Первое сообщение')])).json();
  const oldAnswer = first.choices[0].message;
  await service.ask('first', [question('История изменена'), oldAnswer, question('Продолжай')]);
  assert.equal(service.bindings.get(id).conversation, uuid(2));
  assert.equal((await service.remove(uuid(2))).status, 200);
  assert.deepEqual(service.deletes.map(item => item.url), ['/conversations/' + uuid(2)]);
  assert.equal(service.bindings.get(id).conversation, uuid(1));
  assert.deepEqual(service.bindings.get(id).checkpoints.map(checkpoint => checkpoint.conversation), [uuid(1)]);
  const resumed = await service.ask('first', [question('Продолжение')], undefined, { delta: true });
  assert.equal(resumed.headers.get('X-Relay-Conversation-Id'), uuid(1));
});

test('После перезапуска находит привязки обоих протоколов в пределах текущего ключа', async t => {
  const service = await fixture(t);
  const id = sessionId('first');
  assert.equal((await service.ask('first', [question('Первое сообщение')])).status, 200);
  assert.equal((await service.ask('first', [question('Сообщение Anthropic')], undefined, { anthropic: true })).status, 200);
  const harness = JSON.stringify(['Anthropic', 'first']);
  const other = new SessionBindings(service.profileDir, 'other-account-key');
  other.set(id, service.bindings.get(id));
  await service.restart();
  assert.equal((await service.remove(uuid(1), { 'X-API-Key': 'test-local-key' })).status, 200);
  assert.equal(service.bindings.get(id), undefined);
  assert.equal(service.bindings.get(harness).conversation, uuid(2));
  assert.equal((await service.remove(uuid(2))).status, 200);
  assert.equal(service.bindings.get(harness), undefined);
  assert.equal(other.get(id).conversation, uuid(1));
});

test('После удаления диалога без ID сессии отклоняет поздний результат клиентского инструмента', async t => {
  const service = await fixture(t);
  const tool = { type: 'function', function: { name: 'lookup' } };
  service.onNextMessage(() => ({ tool_calls: [{ id: 'lookup-id', function: { name: 'client_lookup', arguments: '{}' } }] }));
  const answer = await (await service.ask(undefined, [question('Первое сообщение')], [tool])).json();
  const assistant = answer.choices[0].message;
  const lookup = assistant.tool_calls[0];
  const { id } = (await service.snapshot('')).sessions[0];
  assert.equal((await service.remove(uuid(1))).status, 200);

  const input = [assistant, { role: 'tool', tool_call_id: lookup.id, content: 'Результат' }];
  const late = await service.ask(undefined, input, [tool]);
  assert.equal(late.status, 400);
  assert.equal((await late.json()).error.code, 'invalid_request_error');
  assert.deepEqual((await service.snapshot(id)).exchanges, []);
});

test('Удаление и генерация для одной сессии не выполняются одновременно', async t => {
  const service = await fixture(t);
  const id = sessionId('first');
  assert.equal((await service.ask('first', [question('Первое сообщение')])).status, 200);
  const arrived = Promise.withResolvers();
  const resume = Promise.withResolvers();
  service.onNextMessage(async () => { arrived.resolve(); await resume.promise; });
  const running = service.ask('first', [question('Продолжение')], undefined, { delta: true });
  await arrived.promise;
  try {
    assert.equal((await service.remove(uuid(1))).status, 409);
    assert.deepEqual(service.deletes, []);
  } finally { resume.resolve(); }
  assert.equal((await running).status, 200);

  const deleting = Promise.withResolvers();
  const finish = Promise.withResolvers();
  service.onDeletion(async res => { deleting.resolve(); await finish.promise; res.writeHead(204).end(); });
  const request = service.remove(uuid(1));
  await deleting.promise;
  try {
    assert.equal(service.bindings.get(id).conversation, uuid(1));
    assert.equal((await service.ask('first', [question('Новое сообщение')])).status, 409);
  } finally { finish.resolve(); }
  assert.equal((await request).status, 200);
  assert.equal(service.bindings.get(id), undefined);
});
