import test from 'node:test';
import assert from 'node:assert/strict';
import { exchangeLinks, serverToolLinks } from '../public/trace-links.js';

const decision = (tool_call_id, status = 'rejected') => ({ tool_call_id, status, content: null });
const post = (id, conversation, source, body, time) => ({
  id, kind: 'request', method: 'POST', path: '/public/v1/conversations/' + conversation + '/messages', source, body, time
});
const calls = (id, scope, serverToolIds, ids, time) => ({
  id, kind: 'sse', call: 'upstream:1', toolScope: scope, serverToolIds, time,
  body: { role: 'assistant', uuid: 'answer', finished: true, content: { tool_calls: ids.map(id => ({ id })) } }
});

test('Смешанные решения связываются с серверным вызовом из предыдущего обмена', () => {
  const before = {
    id: 'before', client: [{ id: 'client:1', kind: 'request' }], upstream: [
      post('upstream:1', 'first', 'client:1', { role: 'user' }, '01'),
      calls('assistant:1', 'mixed', ['server-a', 'server-b'], ['server-a', 'server-b', 'client'], '02')
    ]
  };
  const after = {
    id: 'after', client: [{ id: 'client:2', kind: 'request' }], upstream: [
      post('upstream:2', 'first', 'client:2', {
        role: 'tool', parent_uuid: 'answer', content: [decision('client'), decision('server-a'), decision('server-b', 'accepted')]
      }, '03'),
      post('upstream:3', 'first', 'client:2', { role: 'tool', parent_uuid: 'answer', content: [decision('client')] }, '04'),
      post('upstream:4', 'other', 'client:2', { role: 'tool', parent_uuid: 'answer', content: [decision('server-a')] }, '05')
    ]
  };
  const links = serverToolLinks([before, after]);
  const forward = exchangeLinks(before.client, before.upstream, before.id, [], links.get(before.id));
  const backward = exchangeLinks(after.client, after.upstream, after.id, [], links.get(after.id));
  assert.deepEqual([...forward.peers.get('assistant:1').keys()], ['upstream:2']);
  assert.deepEqual([...backward.peers.get('upstream:2').keys()], ['client:2', 'assistant:1']);
  assert.deepEqual([...backward.peers.get('upstream:3').keys()], ['client:2']);
  assert.deepEqual([...backward.peers.get('upstream:4').keys()], ['client:2']);
  const wires = [...forward.connections, ...backward.connections];
  assert.deepEqual(wires.filter(wire => wire.from === 'assistant:1'), [
    { from: 'assistant:1', to: 'upstream:2', indirect: false }
  ]);
  assert.equal(forward.serverToolSources.size, 0);
});

test('Трасса без метаданных по-прежнему связывает чистый серверный вызов и эхо', () => {
  const client = [{ id: 'client:1', kind: 'request' }];
  const upstream = [
    post('upstream:1', 'one', 'client:1', { role: 'user' }, '01'),
    { id: 'ack:1', kind: 'sse', call: 'upstream:1', time: '02',
      body: { role: 'user', uuid: 'saved', finished: true, content: null } },
    calls('assistant:1', undefined, undefined, ['server'], '03'),
    post('upstream:2', 'one', 'client:1', { role: 'tool', parent_uuid: 'answer', content: [decision('server')] }, '04')
  ];
  const links = serverToolLinks([{ id: 'single', client, upstream }]);
  const graph = exchangeLinks(client, upstream, 'single', [], links.get('single'));
  assert.deepEqual(graph.connections, [
    { from: 'client:1', to: 'upstream:1', indirect: false },
    { from: 'upstream:1', to: 'ack:1', indirect: false },
    { from: 'client:1', to: 'assistant:1', indirect: true },
    { from: 'assistant:1', to: 'upstream:2', indirect: false }
  ]);
  assert.deepEqual([...graph.serverToolSources], ['assistant:1']);
});
