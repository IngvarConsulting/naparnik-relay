import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolMonitor } from '../tool-monitor.js';

test('История и список объявленных инструментов переживают перезапуск', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-monitor-'));
  t.after(() => rmSync(dir, {recursive:true, force:true}));
  const file = join(dir, 'tools.json');
  const monitor = new ToolMonitor(file);
  monitor.observe('OpenAI', ['WebFetch', 'WebFetch']);
  monitor.serverCall('OpenAI', 'mcp__web__fetch');
  const restored = new ToolMonitor(file).records;
  assert.deepEqual(restored.clients.OpenAI, ['WebFetch']);
  assert.deepEqual(restored.history.map(r => [r.protocol, r.name]), [['OpenAI', 'mcp__web__fetch']]);
});

test('Старые записи остаются без сессии, новые сессии сохраняются отдельно', t => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-sessions-'));
  t.after(() => rmSync(dir, {recursive:true, force:true}));
  const file = join(dir, 'tools.json');
  writeFileSync(file, JSON.stringify({clients:{OpenAI:['old'], Anthropic:[]}, history:[]}));
  const monitor = new ToolMonitor(file);
  const session = monitor.observe('OpenAI', ['new'], 'one');
  monitor.observe('OpenAI', ['other'], 'two');
  monitor.serverCall('OpenAI', 'search', session);
  monitor.observe('OpenAI', ['replacement'], 'one');
  const data = new ToolMonitor(file).records;
  assert.deepEqual(data.clients.OpenAI, ['old']);
  assert.deepEqual(data.sessions.map(s => [s.id,s.tools,s.history.map(h => h.name)]), [
    ['one',['replacement'],['search']], ['two',['other'],[]]
  ]);
});
