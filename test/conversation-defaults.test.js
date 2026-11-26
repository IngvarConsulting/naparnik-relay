import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { createServer } from '../server.js';

test('Настройки диалога сохраняются и применяются при создании новых диалогов', async t => {
  const temporaryRoot = resolve(tmpdir());
  const profileDir = mkdtempSync(join(temporaryRoot, 'relay-dialog-defaults-'));
  t.after(() => {
    assert.equal(dirname(resolve(profileDir)), temporaryRoot);
    rmSync(profileDir, { recursive: true, force: true });
  });
  const configPath = join(profileDir, 'connection.json');
  const oldConnection = { admin: 'settings-admin', localKey: 'settings-local', upstream: 'settings-upstream' };
  const persist = connection => writeFileSync(configPath, JSON.stringify(connection));
  const connection = () => JSON.parse(readFileSync(configPath, 'utf8'));
  persist(oldConnection);

  const initial = { ui_language: 'ru', programming_language: '1c', script_language: 'ru' };
  const chosen = { ui_language: 'en', programming_language: 'java', script_language: 'en' };
  const creations = [];
  const messagePaths = [];
  const mock = http.createServer(async (req, res) => {
    const path = req.url.split('?')[0];
    if (path === '/conversations' && req.method === 'POST') {
      let content = '';
      for await (const chunk of req) content += chunk;
      creations.push(JSON.parse(content));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ uuid: `dialog-${creations.length}` }));
    } else if (path.endsWith('/messages') && req.method === 'POST') {
      for await (const _ of req) { /* Drain the message request. */ }
      messagePaths.push(path);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify({
        uuid: `answer-${messagePaths.length}`, role: 'assistant', finished: true, content: { content: 'Ответ' }
      })}\n\n`);
    } else if (path.endsWith('/context_tokens')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ token_count: 10, max_context_length: 1000 }));
    } else {
      res.writeHead(404).end();
    }
  });

  async function start(server) {
    server.listen(0, '127.0.0.1');
    t.after(() => { if (server.listening) server.close(); });
    await once(server, 'listening');
    return 'http://127.0.0.1:' + server.address().port;
  }

  const upstream = await start(mock);
  async function startRelay() {
    const relay = createServer({ connection: connection(), upstream, profileDir, persist });
    const base = await start(relay);
    const panelHeaders = { 'X-Relay-Panel': '1', 'Content-Type': 'application/json' };
    const login = await fetch(base + '/panel/session', {
      method: 'POST', headers: panelHeaders, body: JSON.stringify({ token: oldConnection.admin })
    });
    assert.equal(login.status, 200);
    panelHeaders.Cookie = login.headers.get('set-cookie').split(';')[0];
    await login.json();
    const settings = base + '/panel/conversation-defaults';
    return {
      relay, settings,
      get: () => fetch(settings, { headers: panelHeaders }),
      put: value => fetch(settings, { method: 'PUT', headers: panelHeaders, body: JSON.stringify(value) }),
      send: async sessionId => {
        const response = await fetch(base + '/v1/chat/completions', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${oldConnection.localKey}`, 'X-Session-ID': sessionId, 'Content-Type': 'application/json'
          },
          body: JSON.stringify({ model: 'naparnik', messages: [{ role: 'user', content: 'Вопрос' }] })
        });
        assert.equal(response.status, 200);
        await response.json();
      }
    };
  }

  const app = await startRelay();
  const anonymous = await fetch(app.settings, { headers: { 'X-Relay-Panel': '1' } });
  assert.equal(anonymous.status, 401);
  await anonymous.json();
  assert.deepEqual(await (await app.get()).json(), initial);
  await app.send('existing');
  assert.deepEqual(creations, [initial]);

  for (const invalid of [
    { ...chosen, ui_language: 'de' }, { ...chosen, programming_language: '' },
    { ...chosen, script_language: 1 }
  ]) {
    const response = await app.put(invalid);
    assert.equal(response.status, 400);
    await response.json();
  }
  assert.deepEqual(connection(), oldConnection);

  const saved = await app.put(chosen);
  assert.equal(saved.status, 200);
  assert.deepEqual(await saved.json(), chosen);
  assert.deepEqual(connection(), { ...oldConnection, conversationDefaults: chosen });
  await app.send('existing');
  await app.send('new');
  assert.deepEqual(creations, [initial, chosen]);
  assert.deepEqual(messagePaths, ['/conversations/dialog-1/messages', '/conversations/dialog-1/messages',
    '/conversations/dialog-2/messages']);

  await new Promise((resolve, reject) => app.relay.close(error => error ? reject(error) : resolve()));
  const restarted = await startRelay();
  assert.deepEqual(await (await restarted.get()).json(), chosen);
  await restarted.send('after-restart');
  assert.deepEqual(creations, [initial, chosen, chosen]);

  const customLanguage = { ...chosen, programming_language: 'python' };
  const custom = await restarted.put(customLanguage);
  assert.equal(custom.status, 200);
  assert.deepEqual(await custom.json(), customLanguage);
  await restarted.send('custom-language');
  assert.deepEqual(creations, [initial, chosen, chosen, customLanguage]);
});
