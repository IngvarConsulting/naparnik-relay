import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { createServer } from '../server.js';

const uuid = 'stream-answer';
const conversation = '141f1fc8-3d60-4597-ae5c-61b3ca352f04';
const finalText = 'clean-answer';
const finalArguments = '{"ready": "right"}';
const provisional = /draft|secret|wrong|reasoning_content|relay_preview/;

async function fixture(t, { waitForFinal = Promise.resolve(), complete = true } = {}) {
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
    const { tools } = JSON.parse(raw);
    const wireName = tools[0].name;
    const send = data => res.write('data: ' + JSON.stringify(data) + '\n\n');
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
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
        content: finalText, reasoning_content: 'confirmed reasoning', tool_calls: [
          { id: 'final-id', function: { name: wireName, arguments: finalArguments } }
        ]
      } });
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
  return (anthropic, stream = true) => fetch(base + (anthropic ? '/v1/messages' : '/v1/chat/completions'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer local-fixture' },
    body: JSON.stringify({
      model: 'naparnik', stream, messages: [{ role: 'user', content: 'Question' }],
      tools: anthropic ? [{ name: 'lookup', input_schema: { type: 'object' } }] :
        [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }]
    })
  });
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
  const tool = starts.find(frame => frame.content_block.type === 'tool_use');
  assert.ok(tool.content_block.id);
  assert.notEqual(tool.content_block.id, 'draft-id');
  assert.equal(tool.content_block.name, 'lookup');
  assert.deepEqual(tool.content_block.input, {});
  const deltas = events.filter(frame => frame.event === 'content_block_delta').map(frame => frame.data);
  assert.deepEqual(deltas.filter(frame => frame.delta.type === 'text_delta').map(frame => frame.delta.text), [finalText]);
  assert.deepEqual(deltas.filter(frame => frame.delta.type === 'input_json_delta'), [{
    type: 'content_block_delta', index: tool.index, delta: { type: 'input_json_delta', partial_json: finalArguments }
  }]);
  assert.equal(events.find(frame => frame.event === 'message_delta').data.delta.stop_reason, 'tool_use');
  assert.equal(events.at(-1).event, 'message_stop');
}

for (const [name, anthropic] of [['OpenAI', false], ['Anthropic', true]]) {
  test(`${name} открывает SSE до финала 1С и передаёт подтверждённые текст и аргументы целыми дельтами`, async t => {
    const release = Promise.withResolvers();
    const post = await fixture(t, { waitForFinal: release.promise });
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
    const post = await fixture(t, { complete: false });
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
  const post = await fixture(t);
  for (const anthropic of [false, true]) {
    const response = await post(anthropic, false);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^application\/json\b/);
    const data = await response.json();
    if (anthropic) {
      assert.deepEqual(data.content[0], { type: 'text', text: finalText });
      assert.deepEqual(data.content[1].input, { ready: 'right' });
    } else {
      const message = data.choices[0].message;
      assert.equal(message.content, finalText);
      assert.equal(message.tool_calls[0].function.arguments, finalArguments);
    }
    assert.doesNotMatch(JSON.stringify(data), provisional);
  }
});
