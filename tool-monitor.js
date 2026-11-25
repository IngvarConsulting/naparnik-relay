import { readFileSync, renameSync, writeFileSync } from 'node:fs';

export class ToolMonitor {
  records = { clients: { OpenAI: [], Anthropic: [] }, history: [] };

  constructor(file) {
    this.file = file;
    if (file) {
      try {
        const data = JSON.parse(readFileSync(file, 'utf8'));
        if (!Array.isArray(data?.history) || !Array.isArray(data.clients?.OpenAI) || !Array.isArray(data.clients?.Anthropic))
          throw new Error('Invalid tool history.');
        this.records = data;
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

  observe(protocol, names) {
    const current = new Set(this.records.clients[protocol]);
    const size = current.size;
    for (const name of names) current.add(name);
    if (current.size !== size) {
      this.records.clients[protocol] = [...current].sort();
      this.save();
    }
  }

  serverCall(protocol, name) {
    this.records.history.unshift({ name, protocol, time: new Date().toISOString() });
    this.records.history.length = Math.min(100, this.records.history.length);
    this.save();
  }
}
