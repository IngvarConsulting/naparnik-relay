import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { createServer } from '../server.js';

const uuid = '141f1fc8-3d60-4597-ae5c-61b3ca352f04';
const compactPath = `/conversations/${uuid}/compact`;
const user = content => ({ role: 'user', content });
const chat = (content, extra) => ({ model: 'naparnik', messages: [user(content)], ...extra });
const result = status => ({ success: true, result: { status } });

async function fixture(t, compact = async () => result('compact_finished')) {
  const received = [];
  let answers = 0;
  const listen = async server => {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return 'http://127.0.0.1:' + server.address().port;
  };
  const upstream = http.createServer(async (req, res) => {
    if (req.url.includes('/context_tokens?')) return res.end('{}');
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    received.push({ path: req.url, method: req.method, body });
    if (req.url === '/conversations') return res.end(JSON.stringify({ uuid }));
    if (req.url === compactPath) return res.end(JSON.stringify(await compact(body)));
    if (req.url !== `/conversations/${uuid}/messages`) {
      res.writeHead(404);
      return res.end('{}');
    }
    const message = { uuid: 'answer-' + ++answers, role: 'assistant', finished: true, content: { content: 'Готово' } };
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('data: ' + JSON.stringify(message) + '\n\n');
  });
  const upstreamUrl = await listen(upstream);
  const profileDir = mkdtempSync(join(tmpdir(), 'relay-compaction-'));
  const app = createServer({
    profileDir, upstream: upstreamUrl,
    connection: { admin: 'admin-fixture', localKey: 'local-fixture', upstream: 'key-fixture' }
  });
  const base = await listen(app);
  t.after(() => {
    app.close();
    app.closeAllConnections();
    upstream.close();
    upstream.closeAllConnections();
    rmSync(profileDir, { recursive: true, force: true });
  });
  const post = (path, body, headers, signal) => fetch(base + '/v1' + path, {
    method: 'POST', body: JSON.stringify(body), signal,
    headers: { authorization: 'Bearer local-fixture', 'content-type': 'application/json', ...headers }
  });
  return { app, post, received };
}

test('Возвращает UUID диалога в заголовке обычного и потокового ответа обоих протоколов', async t => {
  const { post } = await fixture(t);
  for (const path of ['/chat/completions', '/messages']) {
    for (const stream of [false, true]) {
      const response = await post(path, chat('Question', { stream }));
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('x-relay-conversation-id'), uuid, `${path}, stream=${stream}`);
      await response.text();
    }
  }
});

test('Проксирует инструкцию и проверяет ответ штатной компактизации', async t => {
  const instruction = 'Сохранить имена процедур';
  const { post, received } = await fixture(t, async body => body?.instruction === instruction
    ? result('compact_finished') : body?.instruction === 'bad upstream' ? result('unexpected') : result('compact_limited'));
  const complete = await post(compactPath, { instruction });
  assert.equal(complete.status, 200);
  assert.deepEqual(await complete.json(), result('compact_finished'));
  assert.deepEqual(received, [{ path: compactPath, method: 'POST', body: { instruction } }]);

  for (const empty of [undefined, {}]) {
    const limited = await post(compactPath, empty);
    assert.equal(limited.status, 200);
    assert.deepEqual(await limited.json(), result('compact_limited'));
  }
  assert.equal(received.length, 3);
  const invalid = await post(compactPath, { instruction: 'bad upstream' });
  assert.equal(invalid.status, 502);
  await invalid.json();
});

test('Компактизация требует ключ и отклоняет неподдерживаемые параметры до запроса к 1С', async t => {
  const { post, received } = await fixture(t);
  const unauthorized = await post(compactPath, {}, { authorization: '' });
  assert.equal(unauthorized.status, 401);
  await unauthorized.json();
  for (const input of [{ branch: 'answer-1' }, { instruction: 42 }, { instruction: null }]) {
    const invalid = await post(compactPath, input);
    assert.equal(invalid.status, 400);
    await invalid.json();
  }
  assert.deepEqual(received, []);
});

test('Компактизация удерживает очередь диалога и сохраняет родителя генерации', async t => {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const { app, post, received } = await fixture(t, async () => {
    entered.resolve();
    await release.promise;
    return result('compact_finished');
  });
  const session = { 'x-session-id': 'compact-fixture' };
  const initial = await post('/chat/completions', chat('before'), session);
  assert.equal(initial.status, 200);
  assert.equal((await initial.json()).choices[0].message.content, 'Готово');
  const compact = post(compactPath);
  let continued;
  try {
    assert.equal(await Promise.race([entered.promise, compact.then(response => response.status)]), undefined);
    const relayReceived = once(app, 'request');
    continued = post('/chat/completions', chat('after'), session);
    await relayReceived;
    await setTimeout(25);
    assert.deepEqual(received.map(({ path }) => path), ['/conversations', `/conversations/${uuid}/messages`, compactPath]);
    release.resolve();
    const compacted = await compact;
    assert.equal(compacted.status, 200);
    await compacted.json();
    const response = await continued;
    assert.equal(response.status, 200);
    await response.json();
    assert.equal(received.at(-1).body.parent_uuid, 'answer-1');
  } finally {
    release.resolve();
    await Promise.allSettled([compact, continued]);
  }
});

test('Не выдаёт результат компактизации Anthropic без поддержки этого протокола', async t => {
  const { post, received } = await fixture(t);
  for (const [beta, extra] of [
    ['compact-2026-09-04', { compaction: { type: 'summarize' } }],
    ['compact-2026-01-12', { context_management: { edits: [{ type: 'compact_20260112' }] } }],
    ['compact-2026-09-04', { messages: [
      { role: 'assistant', content: [{ type: 'compaction', content: 'Резюме', signature: 'opaque-fixture' }] }, user('Continue')
    ] }]
  ]) {
    const response = await post('/messages', chat('Question', extra), { 'anthropic-beta': beta });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.type, 'invalid_request_error');
  }
  assert.deepEqual(received, []);
});

test('Отключение клиента после начала компактизации не освобождает очередь досрочно', async t => {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const { app, post, received } = await fixture(t, async () => {
    entered.resolve();
    await release.promise;
    return result('compact_finished');
  });
  const controller = new AbortController();
  const cancelled = assert.rejects(post(compactPath, undefined, {}, controller.signal), { name: 'AbortError' });
  try {
    await entered.promise;
    controller.abort();
    await cancelled;
    const relayReceived = once(app, 'request');
    const continued = post('/chat/completions', chat('after'));
    await relayReceived;
    await setTimeout(25);
    assert.equal(received.some(({ path }) => path.endsWith('/messages')), false);
    release.resolve();
    assert.equal((await continued).status, 200);
  } finally {
    release.resolve();
  }
});

test('Пустая опция Anthropic beta не меняет обычный запрос', async t => {
  const { post } = await fixture(t);
  const response = await post('/messages', chat('Question', { compaction: null }), {
    'anthropic-beta': 'compact-2026-09-04'
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).stop_reason, 'end_turn');
});
