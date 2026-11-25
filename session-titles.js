import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const zcodeId = new RegExp('^(?:sess_)?' + uuid + '$', 'i');
const harnessId = new RegExp('^session-' + uuid + '$', 'i');

export class SessionTitles {
  constructor(zcodeRoot = join(process.env.ZCODE_DATA_BASE_DIR || homedir(), '.zcode'), harnessRoot = process.env.DSH_HOME || join(homedir(), '.dsh')) {
    this.database = join(zcodeRoot, 'cli', 'db', 'db.sqlite');
    this.projections = join(harnessRoot, 'storages', 'session_projcache', 'sessions');
    this.cache = new Map();
  }

  async harnessTitle(id) {
    const path = join(this.projections, id + '.json');
    try {
      const { mtimeMs, size } = await stat(path);
      const cached = this.cache.get(id);
      if (cached?.mtimeMs === mtimeMs && cached.size === size) return cached.title;
      const projection = JSON.parse(await readFile(path, 'utf8'));
      const value = projection.record.rows.title?.val;
      const title = typeof value === 'string' ? value.trim() : '';
      this.cache.set(id, { mtimeMs, size, title });
      return title;
    } catch { return undefined; }
  }

  async snapshot(records) {
    const sessions = records.sessions.map(session => ({ ...session }));
    const zcode = sessions.filter(s => s.protocol === 'OpenAI' && zcodeId.test(s.id));
    if (zcode.length) {
      let db;
      try {
        const { DatabaseSync } = await import('node:sqlite');
        db = new DatabaseSync(this.database, { readOnly: true });
        const query = db.prepare('SELECT title FROM session WHERE id = ?');
        for (const s of zcode) {
          const row = query.get(s.id.startsWith('sess_') ? s.id : 'sess_' + s.id);
          if (row) Object.assign(s, { agent: 'ZCode', title: row.title });
        }
      } catch {
        // The agent's optional index may be missing or temporarily locked.
      } finally { db?.close(); }
    }
    for (const s of sessions) {
      if (s.protocol !== 'Anthropic' || !harnessId.test(s.id)) continue;
      const title = await this.harnessTitle(s.id);
      if (title !== undefined) Object.assign(s, { agent: 'DeepSeek Harness', title });
    }
    return { ...records, sessions };
  }
}
