import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import test from 'node:test';

async function fixture(t, entry) {
  const probe = createServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address();
  await new Promise(resolve => probe.close(resolve));

  const base = 'http://127.0.0.1:' + port;
  const profile = await mkdtemp(join(tmpdir(), 'relay-desktop-test-'));
  const env = { ...process.env, RELAY_PORT: String(port), RELAY_DATA_DIR: profile };
  const start = (file, args = [], stdio = ['pipe', 'pipe', 'ignore']) =>
    spawn(process.execPath, [fileURLToPath(new URL('../' + file, import.meta.url)), ...args], {
      env, stdio, windowsHide: true
    });
  const processHandle = start(entry);
  const stopped = once(processHandle, 'exit');
  t.after(async () => {
    if (processHandle.exitCode === null && processHandle.signalCode === null) processHandle.kill();
    await stopped;
    await rm(profile, { recursive: true, force: true });
  });
  const startup = createInterface({ input: processHandle.stdout });
  try {
    const [line] = await Promise.race([
      once(startup, 'line', { signal: AbortSignal.timeout(6000) }),
      stopped.then(() => { throw new Error('Изолированный шлюз завершился до запуска'); })
    ]);
    assert.ok(line.includes(base), 'Шлюз сообщил адрес запуска');
  } finally {
    startup.close();
  }

  const headers = { 'content-type': 'application/json', 'x-relay-panel': '1' };
  async function panelStop() {
    const { admin } = JSON.parse(await readFile(join(profile, 'connection.json'), 'utf8'));
    const session = await fetch(base + '/panel/session', { method: 'POST', headers, body: JSON.stringify({ token: admin }) });
    assert.equal(session.status, 200);
    headers.cookie = session.headers.get('set-cookie').split(';')[0];
    return fetch(base + '/panel/stop', { method: 'POST', headers });
  }
  async function cliStop() {
    const command = start('launch.js', ['--stop'], 'ignore');
    const finished = once(command, 'exit');
    const timeout = setTimeout(() => command.kill(), 8000);
    try {
      const [code] = await finished;
      return code;
    } finally {
      clearTimeout(timeout);
    }
  }
  return { health: () => fetch(base + '/health'), panelStop, cliStop, stopped };
}

test('Команда остановки и панель сохраняют работу настольного шлюза', async t => {
  const app = await fixture(t, 'desktop-server.js');
  assert.equal(await app.cliStop(), 1);
  const health = await app.health();
  assert.equal(health.status, 200);
  assert.equal((await health.json()).mode, 'desktop');
  const stop = await app.panelStop();
  assert.equal(stop.status, 409);
  assert.equal((await stop.json()).error.code, 'desktop_service');
  assert.equal((await app.health()).status, 200);
});

test('Команда остановки завершает браузерный шлюз', { timeout: 15000 }, async t => {
  const app = await fixture(t, 'server.js');
  const health = await app.health();
  assert.equal((await health.json()).mode, 'standalone');
  assert.equal(await app.cliStop(), 0);
  assert.deepEqual(await app.stopped, [0, null]);
});
