import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, linkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const dir = process.env.RELAY_DATA_DIR || join(homedir(), '.naparnik-relay');
export const port = Number(process.env.RELAY_PORT || 47831);
export const origin = 'http://127.0.0.1:' + port;
const file = join(dir, 'connection.json');
export function save(value, create = false) {
  const tmp = file + '.' + randomBytes(8).toString('hex');
  writeFileSync(tmp, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
  try {
    if (create) linkSync(tmp, file);
    else renameSync(tmp, file);
  } finally {
    try {
      unlinkSync(tmp);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  }
}
export function load() {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('Некорректный RELAY_PORT');
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const value = {
    admin: randomBytes(32).toString('hex'),
    localKey: 'nr-' + randomBytes(24).toString('hex'),
    upstream: ''
  };
  try {
    save(value, true);
    return value;
  } catch (e) {
    if (e.code === 'EEXIST') return load();
    throw e;
  }
}
