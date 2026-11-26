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
  const connect = bindings => {
    const bridge = new Bridge(undefined, bindings);
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
      return respond;
    };
    return (messages, onPart = () => {}) => bridge.generate(
      key, { protocol: 'OpenAI', sessionId: 'recovery', messages, tools: [] }, new AbortController().signal, onPart
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
