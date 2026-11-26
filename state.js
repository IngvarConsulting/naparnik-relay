import { createHmac, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, linkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const dir = process.env.RELAY_DATA_DIR || join(homedir(), '.naparnik-relay');
export const port = Number(process.env.RELAY_PORT || 47831);
export const origin = 'http://127.0.0.1:' + port;
const file = join(dir, 'connection.json');
function writePrivateJSON(path, value, create = false) {
  const tmp = path + '.' + randomBytes(8).toString('hex');
  try {
    writeFileSync(tmp, JSON.stringify(value), { mode: 0o600, flag: 'wx', flush: true });
    if (create) linkSync(tmp, path);
    else renameSync(tmp, path);
  } finally {
    try {
      unlinkSync(tmp);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  }
}
export function save(value, create = false) {
  writePrivateJSON(file, value, create);
}

const isServerDecision = item => typeof item?.tool_call_id === 'string' &&
  ['accepted', 'rejected'].includes(item.status) && item.content === null &&
  (item.name === undefined || typeof item.name === 'string');

function isCursor(value, allowRoot = false) {
  return typeof value?.conversation === 'string' && value.conversation &&
    ((typeof value.parent === 'string' && value.parent) || (allowRoot && value.parent === null)) &&
    Array.isArray(value.clientNames) && value.clientNames.every(name => typeof name === 'string') &&
    Array.isArray(value.serverDecisions) && value.serverDecisions.every(isServerDecision);
}

const isDigest = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
function isRecovery(value) {
  return isDigest(value?.fingerprint) && isCursor(value.origin, true) &&
    value.base?.conversation === value.origin.conversation &&
    (value.base.parent === null || typeof value.base.parent === 'string') &&
    Array.isArray(value.posts) && value.posts.length > 0 && value.posts.every(post =>
      post?.sent === true && typeof post.complete === 'boolean' && typeof post.noGenerate === 'boolean' &&
      typeof post.unreadEvent === 'boolean' &&
      ['user', 'tool'].includes(post.role) && (post.parent === null || typeof post.parent === 'string') &&
      isDigest(post.signature) && isDigest(post.content) &&
      ['toolIds', 'acks', 'finalIds', 'drafts', 'running'].every(field =>
        Array.isArray(post[field]) && post[field].every(item => typeof item === 'string')) &&
      (post.clientNames === undefined || post.role === 'user' &&
        Array.isArray(post.clientNames) && post.clientNames.every(name => typeof name === 'string')) &&
      (post.ignoredToolRows === undefined || post.role === 'tool' &&
        Array.isArray(post.ignoredToolRows) && post.ignoredToolRows.every(id => typeof id === 'string' && id)) &&
      (post.serverDecisions === undefined || Array.isArray(post.serverDecisions) &&
        post.serverDecisions.every(item => isServerDecision(item) && post.toolIds.includes(item.tool_call_id))));
}

export class SessionBindings {
  constructor(profileDir, key) {
    this.directory = join(profileDir, 'sessions');
    this.key = key;
  }

  path(id) {
    // The same client session under a different Naparnik key has its own cursor.
    const name = createHmac('sha256', this.key).update(id).digest('hex');
    return join(this.directory, name + '.json');
  }

  get(id) {
    try {
      const state = JSON.parse(readFileSync(this.path(id), 'utf8'));
      if (!isCursor(state, Boolean(state?.recoveries?.length)) ||
          (state.recoveries !== undefined && (!Array.isArray(state.recoveries) || !state.recoveries.every(isRecovery))) ||
          (state.checkpoints !== undefined && (!Array.isArray(state.checkpoints) || !state.checkpoints.every(
            checkpoint => isCursor(checkpoint) && isDigest(checkpoint.fingerprint)
          )))) throw new Error('Повреждена сохранённая привязка диалога.');
      return state;
    } catch (error) {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    }
  }

  set(id, { conversation, parent, clientNames, serverDecisions, checkpoints, recoveries }) {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    writePrivateJSON(this.path(id), { conversation, parent, clientNames: [...clientNames], serverDecisions, checkpoints, recoveries });
  }

  delete(id) {
    try {
      unlinkSync(this.path(id));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
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
