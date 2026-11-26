import test from 'node:test';
import assert from 'node:assert/strict';
import { currentTrace, runTrace, TraceStore } from '../trace-store.js';

test('Трассировка разделяет параллельные сессии и связывает пакеты', async () => {
  const traces = new TraceStore();
  const openAi = traces.begin({ sessionId: 'openai:S', title: 'Первое название', protocol: 'OpenAI' });
  const anthropic = traces.begin({ sessionId: 'anthropic:S', protocol: 'Anthropic' });
  assert.equal(anthropic.sessionId, 'anthropic:S');
  anthropic.initialTitle('Новая сессия');
  anthropic.initialTitle('Другой начальный заголовок');
  await Promise.all([openAi, anthropic].map(exchange => runTrace(exchange, async () => {
    await Promise.resolve();
    assert.equal(currentTrace(), exchange);
    exchange.record('client', { kind: 'request', method: 'POST', path: '/v1/messages', body: { model: 'naparnik' } });
    const call = exchange.record('upstream', { kind: 'request', method: 'POST', path: '/conversations/C/messages' });
    const source = exchange.record('upstream', { kind: 'sse', call, body: { uuid: 'M', finished: true } });
    exchange.record('client', { kind: 'response', status: 200, source });
  })));
  assert.equal(currentTrace(), undefined);
  traces.begin({ sessionId: 'openai:S', title: 'Другой заголовок клиента' });
  assert.equal(traces.snapshot().sessions.find(session => session.id === 'openai:S').title, 'Первое название');
  openAi.rename('Название ответа');
  const { sessions, exchanges } = traces.snapshot('openai:S');
  assert.deepEqual(sessions.map(session => session.protocol).sort(), ['Anthropic', 'OpenAI']);
  assert.equal(sessions.find(session => session.id === 'anthropic:S').title, 'Новая сессия');
  assert.equal(sessions.find(session => session.id === 'openai:S').title, 'Название ответа');
  assert.equal(exchanges[0].id, openAi.id);
  assert.equal(exchanges[0].upstream[1].call, exchanges[0].upstream[0].id);
  assert.equal(exchanges[0].client[1].source, exchanges[0].upstream[1].id);
  exchanges[0].client[0].body.model = 'подмена';
  assert.equal(traces.snapshot('openai:S').exchanges[0].client[0].body.model, 'naparnik');
});

test('Подтверждённый диалог объединяет только обмены без ID сессии того же протокола', () => {
  const traces = new TraceStore({ maxExchangesPerSession: 2 });
  const start = traces.begin({ protocol: 'OpenAI', title: 'Первый запрос' });
  const startId = start.sessionId;
  start.conversation('Chat-1');
  const next = traces.begin({ protocol: 'OpenAI', title: 'Продолжение' });
  const provisionalId = next.sessionId;
  assert.notEqual(provisionalId, startId);
  const sent = next.record('client', { kind: 'request' });
  next.conversation('chat-1');
  next.record('upstream', { kind: 'request', source: sent });
  assert.equal(next.sessionId, startId);
  assert.deepEqual(traces.snapshot(provisionalId).exchanges, []);
  const merged = traces.snapshot(startId);
  assert.deepEqual(merged.exchanges.map(exchange => [exchange.id, exchange.conversation]), [
    [start.id, 'chat-1'], [next.id, 'chat-1']
  ]);
  assert.equal(merged.sessions.find(session => session.id === startId).title, 'Первый запрос');
  assert.equal(merged.exchanges[1].upstream[0].source, sent);

  const otherProtocol = traces.begin({ protocol: 'Anthropic' });
  otherProtocol.conversation('chat-1');
  assert.notEqual(otherProtocol.sessionId, startId);
  const named = traces.begin({ protocol: 'OpenAI', sessionId: 'custom-client-session' });
  named.conversation('chat-1');
  assert.equal(named.sessionId, 'custom-client-session');
  assert.equal(traces.snapshot(named.sessionId).exchanges[0].conversation, 'chat-1');

  const more = traces.begin({ protocol: 'OpenAI' });
  more.conversation('chat-1');
  assert.deepEqual(traces.snapshot(startId).exchanges.map(exchange => exchange.id), [next.id, more.id]);
  traces.clear();
  more.conversation('chat-1');
  assert.deepEqual(traces.snapshot(startId), { sessions: [], exchanges: [] });
});

test('Имена событий и терминатор SSE сохраняются вместе с источником', () => {
  const traces = new TraceStore();
  const exchange = traces.begin({ sessionId: 'S' });
  exchange.record('client', { kind: 'sse', event: 'content_block_delta', body: { text: 'Привет' }, source: 'provider:7' });
  exchange.record('client', { kind: 'sse', body: '[DONE]' });
  exchange.record('client', { kind: 'response', status: 200, body: undefined });
  const { client } = traces.snapshot('S').exchanges[0];
  assert.deepEqual(client.map(packet => packet.body), [{ text: 'Привет' }, '[DONE]', undefined]);
  assert.equal(client[0].source, 'provider:7');
  assert.equal(client[0].event, 'content_block_delta');
  assert.equal(Object.hasOwn(client[2], 'body'), false);
});

test('Ключи и поля учётных данных скрываются в JSON, аргументах инструмента и SSE', () => {
  const traces = new TraceStore();
  const secret = 'actual-local-key';
  const exchange = traces.begin({ sessionId: 'S', title: 'Заголовок ' + secret, secrets: [secret] });
  exchange.record('client', {
    kind: 'request', path: '/conversation?token=from-url',
    body: { payload: 'обычные данные ' + secret, apiKey: 'unknown-api-key',
      extra: { authorization: 'credentials', nested: '{"password":"nested-password","count":42}' } }
  });
  exchange.record('upstream', { kind: 'sse', event: 'message', body: {
    text: 'Bearer from-bearer', access_token: 'from-token', plain: 'чисто'
  } });
  exchange.record('upstream', { kind: 'error', body: '{"authorization":"broken-password"' });
  const snapshot = traces.snapshot('S');
  const encoded = JSON.stringify(snapshot);
  for (const hidden of [secret, 'from-url', 'unknown-api-key', 'credentials', 'nested-password',
    'from-bearer', 'from-token', 'broken-password']) assert.ok(!encoded.includes(hidden));
  assert.match(encoded, /чисто/);
  assert.equal(JSON.parse(snapshot.exchanges[0].client[0].body.extra.nested).count, 42);
  assert.match(encoded, /скрыто/);
});

test('Лимиты ограничивают трассировку и оставляют отметку об усечении', () => {
  const traces = new TraceStore({ maxSessions: 2, maxPacketsPerSide: 3, maxPacketBytes: 320 });
  const old = traces.begin({ sessionId: 'old' });
  const exchange = traces.begin({ sessionId: 'active' });
  exchange.record('client', { kind: 'sse', body: { text: 'x'.repeat(900) } });
  exchange.record('client', { kind: 'sse', body: '[DONE]' });
  for (let i = 0; i < 5; i++) exchange.record('client', { kind: 'sse', body: 'new' });
  const { client } = traces.snapshot('active').exchanges[0];
  assert.equal(client.length, 3);
  assert.equal(client[0].truncated, true);
  assert.equal(client[1].body, '[DONE]');
  assert.equal(client[2].kind, 'limit');
  traces.begin({ sessionId: 'new' });
  assert.equal(old.record('client', { kind: 'response' }), undefined);
  assert.deepEqual(traces.snapshot('old').exchanges, []);
  traces.clear();
  assert.equal(exchange.record('client', { kind: 'response' }), undefined);
  assert.deepEqual(traces.snapshot('active'), { sessions: [], exchanges: [] });
});
