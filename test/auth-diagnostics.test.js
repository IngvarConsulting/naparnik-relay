import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import test from 'node:test';
import { createServer } from '../server.js';

const admin = 'fixture-admin-secret';
const localKey = 'fixture-local-secret';
const candidate = 'fixture-candidate-secret';

async function fixture(t, upstreamHandler, saved = '') {
  const listen = async server => {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => { server.close(); server.closeAllConnections(); });
    return 'http://127.0.0.1:' + server.address().port;
  };
  const upstream = await listen(http.createServer(upstreamHandler));
  const base = await listen(createServer({ upstream, connection: { admin, localKey, upstream: saved } }));
  const headers = { 'Content-Type': 'application/json', 'X-Relay-Panel': '1' };
  const auth = await fetch(base + '/panel/session', { method: 'POST', headers, body: JSON.stringify({ token: admin }) });
  assert.equal(auth.status, 200);
  const cookie = auth.headers.get('set-cookie').split(';')[0];
  const panel = (path, method = 'GET', input, authenticated = true) => fetch(base + '/panel/' + path, {
    method, headers: { ...headers, ...(authenticated && { Cookie: cookie }) }, body: JSON.stringify(input)
  });
  const diagnostic = async id => {
    assert.match(id, /^[0-9a-f-]{36}$/);
    const response = await panel('auth-diagnostics?attempt=' + id);
    assert.equal(response.status, 200);
    return response.json();
  };
  return { panel, upstream, cookie, diagnostic };
}

test('Диагностика неудачной авторизации показывает запрос и ответ без ключей', async t => {
  let outgoing;
  let cookie;
  const app = await fixture(t, (req, res) => {
    outgoing = { method: req.method, path: req.url, auth: req.headers.authorization };
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error_type: 'invalid_token', error: `Ключ ${candidate} отклонён`, localKey, admin, cookie }));
  });
  cookie = app.cookie.split('=')[1];
  const failed = await app.panel('account', 'POST', { key: candidate });
  assert.equal(failed.status, 401);
  const { error } = await failed.json();
  assert.deepEqual(outgoing, { method: 'GET', path: '/budget', auth: 'Bearer ' + candidate });
  const diagnostic = await app.diagnostic(error.diagnosticId);
  assert.equal(diagnostic.error.code, 'invalid_token');
  assert.equal(diagnostic.error.status, 401);
  const [request, response] = diagnostic.packets;
  assert.equal(request.method, 'GET');
  assert.equal(request.path, app.upstream + '/budget');
  assert.equal(response.kind, 'response');
  assert.equal(response.status, 401);
  assert.equal(response.body.error, 'Ключ [скрыто] отклонён');
  for (const secret of [candidate, admin, localKey, cookie]) assert.ok(!JSON.stringify(diagnostic).includes(secret));
  assert.equal((await app.panel('auth-diagnostics?attempt=' + error.diagnosticId, 'GET', undefined, false)).status, 401);
  assert.deepEqual(await (await app.panel('trace')).json(), { sessions: [], exchanges: [] });
});

test('Невалидный локальный ключ даёт диагностику без HTTP-запроса', async t => {
  let calls = 0;
  const app = await fixture(t, (_req, res) => { calls++; res.end(); });
  const response = await app.panel('account', 'POST', { key: 'invalid with spaces' });
  assert.equal(response.status, 400);
  const { error } = await response.json();
  const diagnostic = await app.diagnostic(error.diagnosticId);
  assert.equal(diagnostic.error.code, 'invalid_request_error');
  assert.deepEqual(diagnostic.packets, []);
  assert.equal(calls, 0);
});

test('Ошибка сети при проверке сохранённого ключа сохраняет причину сбоя', async t => {
  const app = await fixture(t, (req) => req.socket.destroy(), candidate);
  const { problem } = await (await app.panel('refresh', 'POST')).json();
  assert.equal(problem.code, 'connection_error');
  const diagnostic = await app.diagnostic(problem.diagnosticId);
  const [request, failure] = diagnostic.packets;
  assert.equal(request.path, app.upstream + '/budget');
  assert.equal(failure.kind, 'error');
  assert.equal(failure.status, undefined);
  assert.equal(failure.body.code, 'UND_ERR_SOCKET');
  assert.match(failure.body.message, /соединение/i);
  assert.ok(!JSON.stringify(diagnostic).includes(candidate));
});

test('Не-JSON ответ в проверке ключа остаётся доступен как текст', async t => {
  const app = await fixture(t, (_req, res) => {
    res.writeHead(502, { 'Content-Type': 'text/html' });
    res.end(`<h1>Прокси отклонил запрос</h1><p>${candidate}</p>`);
  });
  const failed = await app.panel('account', 'POST', { key: candidate });
  assert.equal(failed.status, 502);
  const { error } = await failed.json();
  const diagnostic = await app.diagnostic(error.diagnosticId);
  const response = diagnostic.packets.find(packet => packet.kind === 'response');
  assert.equal(response.status, 502);
  assert.equal(response.body, '<h1>Прокси отклонил запрос</h1><p>[скрыто]</p>');
});

test('Перенаправление при проверке ключа видно в диагностике и не выполняется', async t => {
  const paths = [];
  const app = await fixture(t, (req, res) => {
    paths.push(req.url);
    res.writeHead(302, { Location: '/sso' });
    res.end('Login required');
  });
  const failed = await app.panel('account', 'POST', { key: candidate });
  assert.equal(failed.status, 502);
  const { error } = await failed.json();
  assert.equal(error.code, 'unexpected_redirect');
  const diagnostic = await app.diagnostic(error.diagnosticId);
  const response = diagnostic.packets.find(packet => packet.kind === 'response');
  assert.equal(response?.status, 302);
  assert.equal(response.body, 'Login required');
  assert.deepEqual(paths, ['/budget']);
});
