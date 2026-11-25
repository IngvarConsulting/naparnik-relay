import { readFileSync, renameSync, writeFileSync } from 'node:fs';

export class ToolMonitor {
  records = { clients: { OpenAI: [], Anthropic: [] }, history: [], sessions: [] };

  constructor(file) {
    this.file = file;
    if (file) {
      try {
        const data = JSON.parse(readFileSync(file, 'utf8'));
        if (!Array.isArray(data?.history) || !Array.isArray(data.clients?.OpenAI) || !Array.isArray(data.clients?.Anthropic))
          throw new Error('Invalid tool history.');
        this.records = { ...data, sessions: data.sessions ?? [] };
      } catch (error) {
        if (error.code !== 'ENOENT') console.error('Не удалось прочитать журнал инструментов.');
      }
    }
  }

  save() {
    if (!this.file) return;
    try {
      const tmp = this.file + '.' + process.pid + '.tmp';
      writeFileSync(tmp, JSON.stringify(this.records), { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch {
      console.error('Не удалось сохранить журнал инструментов.');
    }
  }

  observe(protocol, names, sessionId) {
    if (sessionId) {
      const sessions = this.records.sessions;
      const index = sessions.findIndex(s => s.protocol === protocol && s.id === sessionId);
      const session = index < 0
        ? { id: sessionId, protocol, history: [], tools: [] }
        : sessions.splice(index, 1)[0];
      // Harness also sends title requests in this session without a tool declaration.
      session.lastRequestDeclaredTools = names !== undefined;
      if (session.lastRequestDeclaredTools) session.tools = [...new Set(names)].sort();
      session.updated = new Date().toISOString();
      sessions.unshift(session);
      this.save();
      return session;
    }
    // Records made without a session ID are a historical inventory.
    const current = new Set(this.records.clients[protocol]);
    const size = current.size;
    for (const name of names ?? []) current.add(name);
    if (current.size !== size) {
      this.records.clients[protocol] = [...current].sort();
      this.save();
    }
  }

  serverCall(protocol, name, session) {
    const history = session?.history ?? this.records.history;
    history.unshift({ name, protocol, time: new Date().toISOString() });
    history.length = Math.min(100, history.length);
    this.save();
  }
}
