import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { createServer } from '../server.js';
import { draftStatus } from '../public/trace-links.js';

const uuid = 'stream-answer';
const conversation = '141f1fc8-3d60-4597-ae5c-61b3ca352f04';
const finalText = 'clean-answer';
const finalArguments = '{"ready": "right"}';
const finalReasoning = 'confirmed reasoning';
const provisional = /draft|secret|wrong|relay_preview/;

async function fixture(t, { waitForFinal = Promise.resolve(), complete = true, twoMessages = false } = {}) {
  const sent = [];
  const listen = async server => {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return 'http://127.0.0.1:' + server.address().port;
  };
  const upstream = http.createServer(async (req, res) => {
    if (req.url === '/conversations') return res.end(JSON.stringify({ uuid: conversation }));
    if (req.url.includes('/context_tokens?')) return res.end('{}');
    if (req.method === 'GET' && req.url === '/conversations/' + conversation)
      return res.end(JSON.stringify({
        uuid: conversation,
        messages: [{
          uuid: 'request', parent_uuid: null, role: 'user', content: 'Question', create_time: '2026-08-25T10:00:00Z'
        }]
      }));
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    sent.push(body);
    const send = data => res.write('data: ' + JSON.stringify(data) + '\n\n');
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (body.role === 'tool') {
      send({ uuid: 'tool-result', role: 'tool', finished: true, content: body.content[0] });
      send({ uuid: 'follow-up', role: 'assistant', finished: true, content: { content: 'Done' } });
      return res.end();
    }
    const wireName = body.tools[0].name;
    send({ uuid: 'request', role: 'user', finished: true });
    send({ uuid, role: null, finished: false, content_delta: {
      content: 'draft-', reasoning_content: 'draft reasoning', tool_calls: [
        { index: 0, id: 'draft-id', function: { name: wireName, arguments: '{"draft":"' } }
      ]
    } });
    send({ uuid, role: null, finished: false, content_delta: { content: 'secret', tool_calls: [
      { index: 0, function: { name: null, arguments: 'wrong!"}' } }
    ] } });
    await waitForFinal;
    if (complete) {
      send({ uuid, role: 'assistant', finished: true, content: {
        content: finalText, reasoning_content: finalReasoning, tool_calls: [
          { id: 'final-id', function: { name: wireName, arguments: finalArguments } }
        ]
      } });
    }
    if (twoMessages) {
      send({ uuid: 'second-answer', finished: false, content_delta: { content: 'draft' } });
      send({ uuid: 'second-answer', finished: false, content_delta: { content: 'draft again' } });
      send({ uuid: 'second-answer', role: 'assistant', finished: true, content: { content: 'Second' } });
    }
    res.end();
  });
  const upstreamUrl = await listen(upstream);
  const profileDir = mkdtempSync(join(tmpdir(), 'relay-streaming-'));
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
  const post = (anthropic, stream = true, { sessionId, messages = [{ role: 'user', content: 'Question' }] } = {}) =>
    fetch(base + (anthropic ? '/v1/messages' : '/v1/chat/completions'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer local-fixture',
        ...(sessionId && { 'X-Session-Id': sessionId }) },
      body: JSON.stringify({
        model: 'naparnik', stream, messages,
        tools: anthropic ? [{ name: 'lookup', input_schema: { type: 'object' } }] :
          [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }]
      })
    });
  const trace = async () => {
    const headers = { 'Content-Type': 'application/json', 'X-Relay-Panel': '1' };
    const auth = await fetch(base + '/panel/session', { method: 'POST', headers,
      body: JSON.stringify({ token: 'admin-fixture' }) });
    assert.equal(auth.status, 200);
    headers.Cookie = auth.headers.get('set-cookie').split(';')[0];
    const { sessions } = await (await fetch(base + '/panel/trace', { headers })).json();
    assert.equal(sessions.length, 1);
    const { exchanges } = await (await fetch(base + '/panel/trace?session=' + encodeURIComponent(sessions[0].id),
      { headers })).json();
    assert.equal(exchanges.length, 1);
    return exchanges[0];
  };
  return { post, sent, trace };
}

async function* frames(stream) {
  let pending = '';
  for await (const chunk of stream.pipeThrough(new TextDecoderStream())) {
    pending += chunk;
    let boundary;
    while ((boundary = pending.indexOf('\n\n')) >= 0) {
      const lines = pending.slice(0, boundary).split('\n');
      pending = pending.slice(boundary + 2);
      const event = lines.find(line => line.startsWith('event: '))?.slice(7);
      const data = lines.find(line => line.startsWith('data: '))?.slice(6);
      if (data) yield { event, data: data === '[DONE]' ? data : JSON.parse(data) };
    }
  }
}

function checkStart(frame, anthropic) {
  if (anthropic) {
    assert.equal(frame.event, 'message_start');
    assert.equal(frame.data.message.role, 'assistant');
    assert.deepEqual(frame.data.message.content, []);
  } else {
    assert.equal(frame.data.object, 'chat.completion.chunk');
    assert.equal(frame.data.choices[0].delta.role, 'assistant');
    assert.equal(frame.data.choices[0].delta.content ?? '', '');
    assert.equal(frame.data.choices[0].delta.tool_calls, undefined);
  }
}

function checkOpenAi(events) {
  const chunks = events.flatMap(frame => frame.data.choices ?? []);
  assert.deepEqual(chunks.flatMap(choice => choice.delta.reasoning_content ?? []), [finalReasoning]);
  assert.ok(chunks.findIndex(choice => choice.delta.reasoning_content) < chunks.findIndex(choice => choice.delta.content));
  const text = chunks.flatMap(choice => choice.delta.content || []);
  assert.deepEqual(text, [finalText]);
  const calls = chunks.flatMap(choice => choice.delta.tool_calls ?? []);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].id);
  assert.notEqual(calls[0].id, 'draft-id');
  assert.deepEqual(calls, [
    { index: 0, id: calls[0].id, type: 'function', function: { name: 'lookup', arguments: finalArguments } }
  ]);
  assert.equal(chunks.at(-1).finish_reason, 'tool_calls');
  assert.equal(events.at(-1).data, '[DONE]');
}

function checkAnthropic(events) {
  const starts = events.filter(frame => frame.event === 'content_block_start').map(frame => frame.data);
  const thinking = starts[0];
  assert.deepEqual(thinking.content_block, { type: 'thinking', thinking: '', signature: '' });
  const tool = starts.find(frame => frame.content_block.type === 'tool_use');
  assert.ok(tool.content_block.id);
  assert.notEqual(tool.content_block.id, 'draft-id');
  assert.equal(tool.content_block.name, 'lookup');
  assert.deepEqual(tool.content_block.input, {});
  const deltas = events.filter(frame => frame.event === 'content_block_delta').map(frame => frame.data);
  assert.deepEqual(deltas.filter(frame => frame.delta.type === 'thinking_delta'), [{
    type: 'content_block_delta', index: thinking.index, delta: { type: 'thinking_delta', thinking: finalReasoning }
  }]);
  const signature = events.findIndex(frame => frame.data?.delta?.type === 'signature_delta');
  assert.ok(signature > 0);
  assert.equal(events[signature].data.index, thinking.index);
  assert.match(events[signature].data.delta.signature, /^[A-Za-z0-9+/]{43}=$/);
  assert.equal(events[signature + 1].event, 'content_block_stop');
  assert.equal(events[signature + 1].data.index, thinking.index);
  assert.deepEqual(deltas.filter(frame => frame.delta.type === 'text_delta').map(frame => frame.delta.text), [finalText]);
  assert.deepEqual(deltas.filter(frame => frame.delta.type === 'input_json_delta'), [{
    type: 'content_block_delta', index: tool.index, delta: { type: 'input_json_delta', partial_json: finalArguments }
  }]);
  assert.equal(events.find(frame => frame.event === 'message_delta').data.delta.stop_reason, 'tool_use');
  assert.equal(events.at(-1).event, 'message_stop');
}

for (const [name, anthropic] of [['OpenAI', false], ['Anthropic', true]]) {
  test(`${name} открывает SSE до финала 1С и передаёт подтверждённый ответ и рассуждение`, async t => {
    const release = Promise.withResolvers();
    const { post } = await fixture(t, { waitForFinal: release.promise });
    const opening = (async () => {
      const response = await post(anthropic);
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type'), /^text\/event-stream\b/);
      const stream = frames(response.body);
      return { stream, first: (await stream.next()).value };
    })();
    let opened;
    try {
      opened = await Promise.race([opening, setTimeout(1000, undefined, { ref: false })]);
    } finally {
      release.resolve();
    }
    assert.ok(opened, 'Стандартное начальное SSE-событие должно прийти до финала 1С');
    checkStart(opened.first, anthropic);
    const events = [opened.first];
    for await (const frame of opened.stream) events.push(frame);
    assert.doesNotMatch(JSON.stringify(events), provisional);
    (anthropic ? checkAnthropic : checkOpenAi)(events);
  });

  test(`${name} завершает оборванный поток SSE-ошибкой и не отправляет черновик`, async t => {
    const { post } = await fixture(t, { complete: false });
    const response = await post(anthropic);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^text\/event-stream\b/);
    const events = [];
    for await (const frame of frames(response.body)) events.push(frame);
    assert.equal(events.length, 2);
    checkStart(events[0], anthropic);
    assert.equal(events[1].event, anthropic ? 'error' : undefined);
    assert.match(events[1].data.error.message, /мог сохранить сообщение/);
    assert.doesNotMatch(JSON.stringify(events), provisional);
  });
}

test('Без SSE оба протокола возвращают целиком подтверждённые текст и аргументы', async t => {
  const { post } = await fixture(t);
  for (const anthropic of [false, true]) {
    const response = await post(anthropic, false);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^application\/json\b/);
    const data = await response.json();
    if (anthropic) {
      assert.deepEqual(data.content[0], { type: 'thinking', thinking: finalReasoning, signature: data.content[0].signature });
      assert.match(data.content[0].signature, /^[A-Za-z0-9+/]{43}=$/);
      assert.deepEqual(data.content[1], { type: 'text', text: finalText });
      assert.deepEqual(data.content[2].input, { ready: 'right' });
    } else {
      const message = data.choices[0].message;
      assert.equal(message.content, finalText);
      assert.equal(message.reasoning_content, finalReasoning);
      assert.equal(message.tool_calls[0].function.arguments, finalArguments);
    }
    assert.doesNotMatch(JSON.stringify(data), provisional);
  }
});

test('Трассировка отличает контроль финала нового UUID от повторной дельты', async t => {
  const { post, trace } = await fixture(t, { twoMessages: true });
  const response = await post(true);
  assert.equal(response.status, 200);
  assert.doesNotMatch(await response.text(), provisional);
  const { client, upstream } = await trace();
  const drafts = upstream.filter(packet => packet.body?.content_delta);
  assert.deepEqual(drafts.map(packet => [packet.body.uuid, packet.draftTracked]), [
    [uuid, true], [uuid, false], ['second-answer', true], ['second-answer', false]
  ]);
  const source = client.find(packet => packet.event === 'message_start')?.source;
  assert.equal(source, drafts[0].id);
  assert.ok(drafts.slice(1).every(draft => !client.some(packet => packet.source === draft.id)));
  assert.deepEqual(drafts.map(packet => draftStatus(packet, source)), ['start', 'skip', 'tracked', 'skip']);
  assert.equal(draftStatus({ kind: 'sse', body: drafts[3].body }), 'draft');
});

test('В обоих протоколах возвращённое рассуждение не меняет ветку и отбрасывается при импорте истории', async t => {
  const { post, sent } = await fixture(t);
  for (const anthropic of [false, true]) {
    const sessionId = anthropic ? 'anthropic' : 'openai';
    const input = { role: 'user', content: 'Question' };
    const first = await (await post(anthropic, false, { sessionId, messages: [input] })).json();
    const assistant = anthropic ? { role: 'assistant', content: first.content } : first.choices[0].message;
    const id = anthropic ? assistant.content.find(block => block.type === 'tool_use').id : assistant.tool_calls[0].id;
    const result = anthropic ? { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: '42' }] } :
      { role: 'tool', tool_call_id: id, content: '42' };
    const next = await post(anthropic, false, { sessionId, messages: [input, assistant, result] });
    assert.equal(next.status, 200);
    assert.equal(sent.at(-1).parent_uuid, uuid);
    assert.deepEqual(sent.at(-1).content, [{ tool_call_id: id, status: 'ok', content: '42' }]);

    await post(anthropic, false, { sessionId: sessionId + '-new', messages: [input, assistant, { role: 'user', content: 'Next' }] });
    assert.equal(sent.at(-1).parent_uuid, null);
    assert.match(sent.at(-1).content, /clean-answer/);
    assert.doesNotMatch(sent.at(-1).content, /confirmed reasoning|reasoning_content|"type":"thinking"/);
  }
});
