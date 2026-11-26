import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bridge, Fault } from '../bridge.js';
import { SessionBindings } from '../state.js';

const key = 'fixture';
const conversation = '2db53f18-c7fa-4a06-b486-da294fc8d2b9';
const historyPath = '/conversations/' + conversation;
const messagePath = historyPath + '/messages';
const user = content => ({ role: 'user', content });

function message(uuid, parent_uuid, role, content) {
  return { uuid, parent_uuid, role, content, create_time: '2026-08-25T10:00:00Z' };
}

function reply(uuid, parent, content) {
  return message(uuid, parent, 'assistant', { content });
}

function echo(uuid, parent) {
  return { uuid, parent_uuid: parent, role: 'user', content: null, content_delta: null, finished: true };
}

function draft(uuid) {
  return { uuid, parent_uuid: null, role: null, content: null, content_delta: { content: 'Черновик.' }, finished: false };
}

function sse(...packets) {
  return new Response(packets.map(packet => 'data: ' + JSON.stringify(packet) + '\n\n').join(''));
}

function fixture() {
  const posts = [];
  const requests = [];
  let history = [];
  const connect = (bindings, { tools = [], onDraft, serverToolEnabled } = {}) => {
    const bridge = new Bridge(undefined, bindings, undefined, serverToolEnabled);
    bridge.request = async (_key, path, body, _signal, _stream, method = body === undefined ? 'GET' : 'POST') => {
      requests.push([method, path]);
      if (method === 'POST' && path === '/conversations') return Response.json({ uuid: conversation });
      if (method === 'GET' && path === historyPath) {
        if (history instanceof Error) throw history;
        return Response.json({ uuid: conversation, details: {}, messages: history });
      }
      assert.equal(path, messagePath);
      assert.equal(method, 'POST');
      posts.push(body);
      const respond = service.responses.shift();
      assert.ok(respond, 'Лишняя отправка сообщения в Напарник');
      return typeof respond === 'function' ? respond() : respond;
    };
    return (messages, onPart = () => {}, signal = new AbortController().signal) => bridge.generate(
      key, { protocol: 'OpenAI', sessionId: 'recovery', messages, tools, onDraft }, signal, onPart
    );
  };
  const service = {
    posts, requests, responses: [], connect,
    setHistory(messages) { history = messages; }
  };
  return service;
}

test('После обрыва подтверждённый UUID выбирает нужную ветку и восстанавливает курсор', async () => {
  const service = fixture();
  const ask = service.connect();
  const text = 'Продолжай';
  service.setHistory([
    message('request', null, 'user', text),
    reply('saved-answer', 'request', 'Сохранённый ответ.'),
    message('other-request', null, 'user', text),
    reply('other-answer', 'other-request', 'Ответ из другой ветки.')
  ]);
  service.responses.push(
    sse(echo('request', null), draft('saved-answer')),
    sse(echo('next', 'saved-answer'), { ...reply('next-answer', 'next', 'Следующий ответ.'), finished: true })
  );
  const parts = [];
  const answer = await ask([user(text)], part => parts.push(part.content));
  assert.equal(answer.content, 'Сохранённый ответ.');
  assert.deepEqual(parts, ['Сохранённый ответ.']);
  assert.deepEqual(service.requests, [
    ['POST', '/conversations'], ['POST', messagePath], ['GET', historyPath]
  ]);
  await ask([user(text), answer, user('Дальше')]);
  assert.deepEqual(service.posts.map(post => post.parent_uuid), [null, 'saved-answer']);
});

test('После обрыва без эха запись ищется по родителю и содержимому запроса', async () => {
  const service = fixture();
  const ask = service.connect();
  const question = user('Вопрос');
  const followup = user('Уточнение');
  service.responses.push(
    sse(echo('first-question', null), { ...reply('first-answer', 'first-question', 'Ответ.'), finished: true }),
    sse(draft('saved-answer'))
  );
  const first = await ask([question]);
  service.setHistory([
    message('first-question', null, 'user', question.content),
    reply('first-answer', 'first-question', first.content),
    message('saved-question', 'first-answer', 'user', followup.content),
    reply('saved-answer', 'saved-question', 'Найденный ответ.'),
    message('unrelated-question', null, 'user', followup.content),
    reply('unrelated-answer', 'unrelated-question', 'Ответ из другой ветки.')
  ]);
  assert.equal((await ask([question, first, followup])).content, 'Найденный ответ.');
  assert.deepEqual(service.posts.map(post => post.parent_uuid), [null, 'first-answer']);
  assert.deepEqual(service.requests.at(-1), ['GET', historyPath]);
});

test('Повтор принятого первого сообщения после перезапуска читает сохранённый ответ', async t => {
  const profile = mkdtempSync(join(tmpdir(), 'relay-recovery-'));
  t.after(() => rmSync(profile, { recursive: true, force: true }));
  const service = fixture();
  const request = message('request', null, 'user', 'Первый вопрос');
  service.setHistory([request]);
  service.responses.push(sse(echo('request', null), draft('answer')));
  const ask = service.connect(new SessionBindings(profile, key));
  await assert.rejects(ask([user(request.content)]), { status: 409 });

  const afterRestart = service.connect(new SessionBindings(profile, key));
  await assert.rejects(afterRestart([user(request.content)]), { status: 409 });
  service.setHistory([request, reply('answer', 'request', 'Готовый ответ.')]);
  assert.equal((await afterRestart([user(request.content)])).content, 'Готовый ответ.');
  assert.equal(service.posts.length, 1);
  assert.equal(service.requests.filter(([method]) => method === 'GET').length, 3);
});

test('Повтор с обновлённой системной инструкцией сначала проверяет сохранённую попытку', async () => {
  const service = fixture();
  const ask = service.connect();
  const request = message('request', null, 'user', 'Первый вопрос');
  const input = (content) => [{ role: 'system', content }, user(request.content)];
  service.setHistory([request]);
  service.responses.push(sse(echo(request.uuid, null), draft('answer')));
  await assert.rejects(ask(input('Исходная инструкция')), { code: 'recovery_pending' });

  service.setHistory([request, reply('answer', request.uuid, 'Готовый ответ.')]);
  assert.equal((await ask(input('Обновлённая инструкция'))).content, 'Готовый ответ.');
  assert.deepEqual(service.requests.at(-1), ['GET', historyPath]);
  assert.equal(service.posts.length, 1);
});

test('Перед отправкой и после эха сохраняется попытка для восстановления после аварийного завершения', async t => {
  const profile = mkdtempSync(join(tmpdir(), 'relay-recovery-'));
  t.after(() => rmSync(profile, { recursive: true, force: true }));
  const service = fixture();
  const bindings = new SessionBindings(profile, key);
  const id = JSON.stringify(['OpenAI', 'recovery']);
  const request = message('request', null, 'user', 'Первый вопрос');
  const started = Promise.withResolvers();
  const ask = service.connect(bindings, { onDraft: () => started.resolve() });
  let stream;
  service.responses.push(() => {
    const attempt = bindings.get(id)?.recoveries?.[0];
    assert.equal(attempt?.origin.conversation, conversation);
    assert.equal(attempt.posts.length, 1);
    assert.deepEqual(attempt.posts[0].acks, []);
    return new Response(new ReadableStream({
      start(controller) {
        stream = controller;
        const encoder = new TextEncoder();
        for (const packet of [echo(request.uuid, null), draft('answer')])
          controller.enqueue(encoder.encode('data: ' + JSON.stringify(packet) + '\n\n'));
      }
    }));
  });

  const active = ask([user(request.content)]);
  try {
    await Promise.race([started.promise, active.then(() => assert.fail('Первая генерация ещё идёт'))]);
    const [attempt] = bindings.get(id).recoveries[0].posts;
    assert.deepEqual(attempt.acks, [request.uuid]);
    assert.deepEqual(attempt.drafts, ['answer']);
    service.setHistory([request, reply('answer', request.uuid, 'Готовый ответ.')]);
    const restarted = service.connect(new SessionBindings(profile, key));
    assert.equal((await restarted([user(request.content)])).content, 'Готовый ответ.');
    assert.equal(service.posts.length, 1);
  } finally {
    stream?.close();
    await active.catch(() => {});
  }
});

test('Ответ шлюза 504 до SSE оставляет возможность восстановить сохранённое сообщение', async () => {
  const service = fixture();
  const ask = service.connect();
  const request = message('request', null, 'user', 'Первый вопрос');
  service.responses.push(() => { throw new Fault(504, 'upstream_error', 'Тайм-аут шлюза'); });
  await assert.rejects(ask([user(request.content)]), { status: 504 });

  service.setHistory([request, reply('answer', request.uuid, 'Готовый ответ.')]);
  assert.equal((await ask([user(request.content)])).content, 'Готовый ответ.');
  assert.equal(service.posts.length, 1);
  assert.deepEqual(service.requests.at(-1), ['GET', historyPath]);
});

test('Подтверждённый отказ до SSE очищает запись о неотправленном сообщении', async () => {
  const service = fixture();
  const bindings = new Map();
  const ask = service.connect(bindings);
  service.responses.push(() => { throw new Fault(402, 'budget_exceeded', 'Лимит исчерпан'); });
  await assert.rejects(ask([user('Первый вопрос')]), { code: 'budget_exceeded' });
  assert.equal(bindings.size, 0);
});

test('Повтор смешанного вызова сохраняет фактически отправленное решение', async t => {
  const profile = mkdtempSync(join(tmpdir(), 'relay-recovery-'));
  t.after(() => rmSync(profile, { recursive: true, force: true }));
  const service = fixture();
  let enabled = true;
  const options = {
    tools: [{ name: 'read', parameters: {} }], serverToolEnabled: () => enabled
  };
  const ask = service.connect(new SessionBindings(profile, key), options);
  const question = user('Найди и проверь');
  const request = message('request', null, 'user', question.content);
  const call = message('call', request.uuid, 'assistant', { tool_calls: [
    { id: 'local', function: { name: 'client_read', arguments: '{}' } },
    { id: 'search', function: { name: 'Search_ITS', arguments: '{}' } }
  ] });
  service.responses.push(sse(echo(request.uuid, null), { ...call, finished: true }));
  const first = await ask([question]);
  enabled = false;
  const input = [question, first, { role: 'tool', id: 'local', status: 'ok', content: 'Прочитано' }];
  service.setHistory([request, call]);
  service.responses.push(sse());
  await assert.rejects(ask(input), { code: 'incomplete_stream' });
  assert.deepEqual(service.posts[1].content.at(-1), { tool_call_id: 'search', status: 'rejected', content: null });

  const result = message('result', call.uuid, 'tool', service.posts[1].content);
  service.responses.push(sse({ ...result, finished: true }, { ...reply('done', result.uuid, 'Готово.'), finished: true }));
  const restarted = service.connect(new SessionBindings(profile, key), options);
  assert.equal((await restarted(input)).content, 'Готово.');
  assert.deepEqual(service.posts[2], service.posts[1]);
});

test('В истории без эха нельзя принять другой результат с тем же ID инструмента', async () => {
  const service = fixture();
  const ask = service.connect(undefined, { tools: [{ name: 'read', parameters: {} }] });
  const question = user('Прочитай');
  const request = message('request', null, 'user', question.content);
  const call = message('call', request.uuid, 'assistant', { tool_calls: [
    { id: 'local', function: { name: 'client_read', arguments: '{}' } }
  ] });
  service.responses.push(sse(echo(request.uuid, null), { ...call, finished: true }));
  const first = await ask([question]);
  const historyResult = message('result-a', call.uuid, 'tool', {
    tool_call_id: 'local', status: 'ok', content: 'Первая версия', structured_content: null, details: null
  });
  const historyAnswer = reply('answer-a', historyResult.uuid, 'Прочитана первая версия.');
  service.responses.push(sse({ ...historyResult, finished: true }, { ...historyAnswer, finished: true }));
  const input = content => [question, first, { role: 'tool', id: 'local', status: 'ok', content }];
  await ask(input(historyResult.content.content));

  service.setHistory([request, call, historyResult, historyAnswer]);
  service.responses.push(sse());
  await assert.rejects(ask(input('Вторая версия')), { code: 'recovery_pending' });
  assert.equal(service.posts.length, 3);
});

test('Восстановленный клиентский вызов остаётся клиентским после изменения списка инструментов', async () => {
  const service = fixture();
  const bindings = new Map();
  const question = user('Прочитай');
  const request = message('request', null, 'user', question.content);
  const call = message('answer', request.uuid, 'assistant', { tool_calls: [
    { id: 'local', function: { name: 'client_read', arguments: '{}' } }
  ] });
  service.responses.push(sse(echo(request.uuid, null), draft(call.uuid)));
  service.setHistory([request]);
  await assert.rejects(service.connect(bindings, { tools: [{ name: 'read' }] })([question]), { code: 'recovery_pending' });

  service.setHistory([request, call]);
  await assert.rejects(service.connect(bindings)([question]), { code: 'unknown_client_tool' });
  assert.equal(service.posts.length, 1);
});

async function reanchoredFixture(ignoredStatus = 'ignored') {
  const service = fixture();
  const bindings = new Map();
  const tools = [{ name: 'lookup' }, { name: 'run' }];
  const ask = service.connect(bindings, { tools });
  const question = user('Найди сведения');
  const original = message('original', null, 'user', question.content);
  const call = message('lookup', original.uuid, 'assistant', { tool_calls: [
    { id: 'lookup-id', function: { name: 'client_lookup', arguments: '{}' } }
  ] });
  service.responses.push(sse(echo(original.uuid, null), { ...call, finished: true }));
  const first = await ask([question]);

  const ignored = message('auto-result', call.uuid, 'tool', {
    tool_call_id: 'lookup-id', content: 'Вызов пропущен.', status: ignoredStatus
  });
  const auxiliary = message('auxiliary', ignored.uuid, 'user', 'Обработай извлечённый текст');
  const auxAnswer = message('auxiliary-answer', auxiliary.uuid, 'assistant', { tool_calls: [
    { id: 'run-id', function: { name: 'client_run', arguments: '{}' } }
  ] });
  const history = [original, call, ignored, auxiliary, auxAnswer];
  service.setHistory(history);
  service.responses.push(sse({ ...ignored, finished: true }, echo(auxiliary.uuid, ignored.uuid), { ...auxAnswer, finished: true }));
  await assert.rejects(service.connect(bindings)([user(auxiliary.content)]), { code: 'unknown_client_tool' });

  const result = { role: 'tool', id: 'lookup-id', status: 'ok', content: 'Фактический результат' };
  return { service, ask, bindings, history, call, result, input: [question, first, result] };
}

test('Клиентский результат продолжает исходный вызов после служебной ветки с ignored', async () => {
  const { service, ask, bindings, history, call, result, input } = await reanchoredFixture();
  const savedResult = message('main-result', call.uuid, 'tool', {
    tool_call_id: result.id, status: result.status, content: result.content
  });
  const answer = reply('main-answer', savedResult.uuid, 'Готово в основном диалоге.');
  service.responses.push(() => {
    service.setHistory([...history, savedResult]);
    return sse({ ...savedResult, finished: true });
  });
  service.responses.push(() => {
    const next = message('next', savedResult.uuid, 'user', service.posts.at(-1).content);
    service.setHistory([...history, savedResult, next, { ...answer, parent_uuid: next.uuid }]);
    return sse(echo(next.uuid, savedResult.uuid), draft(answer.uuid));
  });

  assert.equal((await ask(input)).content, answer.content.content);
  assert.deepEqual(service.posts.map(({ role, parent_uuid }) => [role, parent_uuid]), [
    ['user', null], ['user', call.uuid], ['tool', call.uuid], ['user', savedResult.uuid]
  ]);
  const cursor = bindings.get(JSON.stringify(['OpenAI', 'recovery']));
  assert.equal(cursor.parent, answer.uuid);
  assert.equal(cursor.recoveries, undefined);
});

test('При перепривязке через подтверждённый результат Relay сохраняет 409', async () => {
  const { service, ask, input } = await reanchoredFixture('rejected');
  await assert.rejects(ask(input), { status: 409, code: 'recovery_pending' });
  assert.equal(service.posts.length, 2);
});

test('После сохранения результата с no_generate повтор отправляет только следующее сообщение', async () => {
  const { service, bindings, history, call, result, input } = await reanchoredFixture();
  const savedResult = message('main-result', call.uuid, 'tool', {
    tool_call_id: result.id, status: result.status, content: result.content
  });
  const followup = user('Уточнение после результата');
  const request = [...input, followup];
  const stop = new AbortController();
  const save = bindings.set.bind(bindings);
  bindings.set = (id, value) => {
    save(id, value);
    const post = value.recoveries?.at(-1)?.posts[0];
    if (post?.role === 'tool' && post.complete) stop.abort();
  };
  service.responses.push(sse({ ...savedResult, finished: true }));
  await assert.rejects(service.connect(bindings)(request, () => {}, stop.signal), { name: 'AbortError' });
  assert.equal(service.posts.at(-1).no_generate, true);

  service.setHistory([...history, savedResult]);
  const next = message('next', savedResult.uuid, 'user', followup.content);
  const answer = reply('new-answer', next.uuid, 'Ответ на уточнение.');
  service.responses.push(sse(echo(next.uuid, savedResult.uuid), { ...answer, finished: true }));
  assert.equal((await service.connect(bindings)(request)).content, answer.content.content);
  assert.deepEqual(service.posts.map(({ role, parent_uuid }) => [role, parent_uuid]), [
    ['user', null], ['user', call.uuid], ['tool', call.uuid], ['user', savedResult.uuid]
  ]);
});

test('Новое сообщение после восстановления ignored продолжает сохранённый результат без дублей', async () => {
  const { service, bindings, history, call, result, input } = await reanchoredFixture();
  const ignored = history.find(row => row.role === 'tool');
  const request = [...input, user('Следующее сообщение')];
  const stop = new AbortController();
  const save = bindings.set.bind(bindings);
  bindings.set = (id, value) => {
    save(id, value);
    const posts = value.recoveries?.at(-1)?.posts;
    if (posts?.length === 2 && posts[1].complete) stop.abort();
  };
  let restored;
  service.responses.push(sse({ ...ignored, finished: true }), () => {
    const post = service.posts.at(-1);
    assert.equal(post.no_generate, true);
    assert.ok(post.content.includes(result.content));
    restored = message('restored', ignored.uuid, 'user', post.content);
    return sse(echo(restored.uuid, ignored.uuid));
  });
  await assert.rejects(service.connect(bindings)(request, () => {}, stop.signal), { name: 'AbortError' });
  service.setHistory([...history, restored]);
  const extra = user('Продолжай');
  const changed = [...input.slice(0, -1), { ...result, content: 'Другой результат' }, request.at(-1), extra];
  await assert.rejects(service.connect(bindings)(changed), { code: 'recovery_pending' });
  assert.equal(service.posts.length, 4);
  const answer = reply('main-after-ignored', 'next', 'Готово.');
  service.responses.push(sse(echo('next', restored.uuid), { ...answer, finished: true }));
  assert.equal((await service.connect(bindings)([...request, extra])).content, answer.content.content);
  assert.deepEqual(service.posts.map(({ role, parent_uuid }) => [role, parent_uuid]), [
    ['user', null], ['user', call.uuid], ['tool', call.uuid], ['user', ignored.uuid], ['user', restored.uuid]
  ]);
  assert.equal(service.posts.at(-1).content, request.at(-1).content + '\n\n' + extra.content);
});

test('Дополнение после обрыва проходит от сохранённого вопроса и переживает повторный обрыв', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-appended-recovery-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const service = fixture();
  const bindings = () => new SessionBindings(dir, key);
  const tools = [{ name: 'lookup' }];
  const calls = ids => ({ tool_calls: ids.map(id => ({ id, function: { name: 'client_lookup', arguments: '{}' } })) });
  const question = user('Первый вопрос');
  const first = message('first', null, 'user', question.content);
  const lookup = message('calls', first.uuid, 'assistant', calls(['a', 'b']));
  service.responses.push(sse(echo(first.uuid, null), { ...lookup, finished: true }));
  const prior = await service.connect(bindings(), { tools })([question]);
  const result = id => ({ role: 'tool', id, status: 'ok', content: 'Результат ' + id });
  const saved = (id, parent, toolId) => message(id, parent, 'tool', {
    tool_call_id: toolId, status: 'ok', content: result(toolId).content
  });
  const a = saved('saved-a', lookup.uuid, 'a');
  const b = saved('saved-b', a.uuid, 'b');
  const oldInput = [question, prior, result('a'), result('b'), user('Сохранённый вопрос')];
  const oldUser = message('old-user', b.uuid, 'user', 'Сервер сохранил нормализованный текст');
  const undelivered = message('old-answer', oldUser.uuid, 'assistant', calls(['c']));
  const cancel = new AbortController();
  service.responses.push(sse({ ...a, finished: true }, { ...b, finished: true }),
    sse(echo(oldUser.uuid, b.uuid), draft(undelivered.uuid)));
  await assert.rejects(service.connect(bindings(), { tools, onDraft: () => cancel.abort() })(oldInput, () => {}, cancel.signal));
  const history = [first, lookup, a, b, oldUser, undelivered];
  service.setHistory(history);

  const extra = user('Новое уточнение');
  const input = [...oldInput, extra];
  const id = JSON.stringify(['OpenAI', 'recovery']);
  const state = bindings().get(id);
  const delivered = structuredClone(state);
  delivered.recoveries[0].posts[1].finalIds.push(undelivered.uuid);
  bindings().set(id, delivered);
  await assert.rejects(service.connect(bindings(), { tools })(input), { code: 'recovery_pending' });
  assert.equal(service.posts.length, 3);
  bindings().set(id, state);

  const newUser = message('new-user', oldUser.uuid, 'user', extra.content);
  const answer = reply('new-answer', newUser.uuid, 'Итоговый ответ');
  const abortAgain = new AbortController();
  service.responses.push(sse(echo(newUser.uuid, oldUser.uuid), draft(answer.uuid)));
  await assert.rejects(service.connect(bindings(), { tools, onDraft: () => abortAgain.abort() })(input, () => {}, abortAgain.signal),
    { code: 'incomplete_stream' });
  assert.equal(abortAgain.signal.aborted, true);
  assert.deepEqual(service.posts.map(post => [post.role, post.parent_uuid]), [
    ['user', null], ['tool', lookup.uuid], ['user', b.uuid], ['user', oldUser.uuid]
  ]);
  assert.equal(service.posts.at(-1).content, extra.content);

  service.setHistory([...history, newUser, answer]);
  assert.equal((await service.connect(bindings(), { tools })(input)).content, answer.content.content);
  assert.equal(service.posts.length, 4);
});

test('Новое сообщение продолжает сохранённый вопрос без ответа', async () => {
  const service = fixture();
  const ask = service.connect();
  const request = message('request', null, 'user', 'Первый вопрос');
  service.setHistory([request]);
  service.responses.push(
    sse(echo('request', null), draft('interrupted')),
    sse(echo('next', 'request'), { ...reply('answer', 'next', 'Ответ на уточнение.'), finished: true })
  );
  await assert.rejects(ask([user(request.content)]), { status: 409 });
  assert.equal((await ask([user('Более точный вопрос')])).content, 'Ответ на уточнение.');
  assert.deepEqual(service.posts.map(post => [post.parent_uuid, post.content]), [
    [null, request.content], ['request', 'Более точный вопрос']
  ]);
});

test('Последовательные обрывы продолжают цепочку сохранённых вопросов после последнего ответа', async () => {
  const service = fixture();
  const ask = service.connect();
  const first = user('Начало');
  const firstRow = message('first', null, 'user', first.content);
  const initialAnswer = reply('initial', firstRow.uuid, 'Начальный ответ.');
  const q1 = message('q1', initialAnswer.uuid, 'user', 'Первое уточнение');
  const q2 = message('q2', q1.uuid, 'user', 'Второе уточнение');
  service.responses.push(
    sse(echo(firstRow.uuid, null), { ...initialAnswer, finished: true }),
    sse(echo(q1.uuid, initialAnswer.uuid), draft('missing-1')),
    sse(echo(q2.uuid, q1.uuid), draft('missing-2')),
    sse(echo('last', q2.uuid), { ...reply('done', 'last', 'Готово.'), finished: true })
  );
  await ask([first]);
  service.setHistory([firstRow, initialAnswer, q1]);
  await assert.rejects(ask([user(q1.content)]), { status: 409 });
  service.setHistory([firstRow, initialAnswer, q1, q2]);
  await assert.rejects(ask([user(q2.content)]), { status: 409 });
  await ask([user('Третье уточнение')]);
  assert.deepEqual(service.posts.map(post => post.parent_uuid), [null, initialAnswer.uuid, q1.uuid, q2.uuid]);
});

test('Успешный запрос в соседней ветке сохраняет проверку прерванного запроса', async () => {
  const service = fixture();
  const ask = service.connect();
  const initial = user('Начало');
  const first = message('first', null, 'user', initial.content);
  const a0 = reply('a0', first.uuid, 'Начальный ответ.');
  const left = message('left', a0.uuid, 'user', 'Левая ветка');
  const a1 = reply('a1', left.uuid, 'Левый ответ.');
  const pending = message('pending', a1.uuid, 'user', 'Незавершённый запрос');
  service.responses.push(
    sse(echo(first.uuid, null), { ...a0, finished: true }),
    sse(echo(left.uuid, a0.uuid), { ...a1, finished: true }),
    sse(echo(pending.uuid, a1.uuid), draft('saved')),
    sse(echo('right', a0.uuid), { ...reply('a2', 'right', 'Ответ соседней ветки.'), finished: true })
  );

  const firstAnswer = await ask([initial]);
  const leftAnswer = await ask([initial, firstAnswer, user(left.content)]);
  const original = [initial, firstAnswer, user(left.content), leftAnswer, user(pending.content)];
  service.setHistory([first, a0, left, a1, pending]);
  await assert.rejects(ask(original), { status: 409 });
  await ask([initial, firstAnswer, user('Правая ветка')]);
  service.setHistory([first, a0, left, a1, pending, reply('saved', pending.uuid, 'Восстановленный ответ.')]);
  assert.equal((await ask(original)).content, 'Восстановленный ответ.');
  assert.deepEqual(service.posts.map(post => post.parent_uuid), [null, a0.uuid, a1.uuid, a0.uuid]);
});

test('Недоступная история запрещает повтор отправки до подтверждения отсутствия записи', async () => {
  const service = fixture();
  const ask = service.connect();
  const request = [user('Первый вопрос')];
  service.setHistory(new Fault(503, 'connection', 'История недоступна'));
  service.responses.push(
    sse(draft('interrupted')),
    sse(echo('request', null), { ...reply('answer', 'request', 'Ответ после повтора.'), finished: true })
  );
  await assert.rejects(ask(request));
  await assert.rejects(ask(request));
  assert.equal(service.posts.length, 1);
  service.setHistory([]);
  assert.equal((await ask(request)).content, 'Ответ после повтора.');
  assert.deepEqual(service.posts.map(post => post.parent_uuid), [null, null]);
});

test('Сохранённое подтверждение серверного инструмента сверяется вместе с исходным вопросом', async () => {
  const service = fixture();
  const ask = service.connect();
  const question = user('Найди статью');
  const request = message('request', null, 'user', question.content);
  const toolCall = message('call', request.uuid, 'assistant', {
    tool_calls: [{ id: 'search', function: { name: 'Search_ITS', arguments: '{}' } }]
  });
  const toolResult = message('result', toolCall.uuid, 'tool', {
    tool_call_id: 'search', content: null, status: 'accepted'
  });
  service.setHistory([request, toolCall, toolResult]);
  service.responses.push(
    sse(echo(request.uuid, null), { ...toolCall, finished: true }),
    sse({ ...toolResult, finished: true }, draft('answer'))
  );
  await assert.rejects(ask([question]), { status: 409, code: 'recovery_pending' });

  service.setHistory([request, toolCall, toolResult, reply('answer', toolResult.uuid, 'Статья найдена.')]);
  assert.equal((await ask([question])).content, 'Статья найдена.');
  assert.deepEqual(service.posts.map(post => [post.role, post.parent_uuid]), [
    ['user', null], ['tool', toolCall.uuid]
  ]);
});

test('Оборванное событие за готовым текстом требует ещё одного финала в истории', async () => {
  const service = fixture();
  const ask = service.connect();
  const question = user('Первый вопрос');
  const request = message('request', null, 'user', question.content);
  const first = reply('first', request.uuid, 'Первая часть.');
  const second = reply('second', first.uuid, 'Последняя часть.');
  const partial = 'data: ' + JSON.stringify({ ...second, finished: true }).slice(0, 30);
  const beginning = await sse(echo(request.uuid, null), { ...first, finished: true }).text();
  service.responses.push(new Response(beginning + partial));

  service.setHistory([request, first]);
  await assert.rejects(ask([question]), { code: 'recovery_pending' });
  await assert.rejects(ask([question]), { code: 'recovery_pending' });
  service.setHistory([request, first, second]);
  assert.equal((await ask([question])).content, 'Первая часть.\n\nПоследняя часть.');
  assert.equal(service.posts.length, 1);
});

test('Два одинаковых запроса от одного родителя без подтверждения не выбираются по времени', async () => {
  const service = fixture();
  const ask = service.connect();
  const question = user('Одинаковый текст');
  service.responses.push(sse(draft('unconfirmed')));
  service.setHistory([
    message('one', null, 'user', question.content),
    reply('answer-one', 'one', 'Ответ первой ветки'),
    message('two', null, 'user', question.content),
    reply('answer-two', 'two', 'Ответ второй ветки')
  ]);
  await assert.rejects(ask([question]), { code: 'recovery_pending' });
  await assert.rejects(ask([question]), { code: 'recovery_pending' });
  assert.equal(service.posts.length, 1);
});

test('После обрыва до первого пакета старый ответ на тот же текст не принимается за новый', async () => {
  const service = fixture();
  const ask = service.connect();
  const question = user('Начало');
  const first = message('first', null, 'user', question.content);
  const base = reply('base', first.uuid, 'Начальный ответ.');
  service.responses.push(sse(echo(first.uuid, null), { ...base, finished: true }), sse());
  await ask([question]);

  const repeat = user('Уточнение');
  service.setHistory([first, base, message('old', base.uuid, 'user', repeat.content),
    reply('old-answer', 'old', 'Старый ответ.')]);
  await assert.rejects(ask([repeat]), { code: 'recovery_pending' });
  await assert.rejects(ask([repeat]), { code: 'recovery_pending' });
  assert.equal(service.posts.length, 2);
});
