import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

const activeTrace = new AsyncLocalStorage();

export const runTrace = (exchange, work) => activeTrace.run(exchange, work);
export const currentTrace = () => activeTrace.getStore();

const hidden = '[скрыто]';
const clipped = '[данные превышают лимит трассировки]';
const sensitiveFields = new Set([
  'authorization', 'proxyauthorization', 'xapikey', 'apikey', 'localkey', 'upstreamkey',
  'admintoken', 'admin', 'key', 'token', 'accesstoken', 'refreshtoken', 'idtoken',
  'xauthtoken', 'authtoken', 'accesskey', 'secretaccesskey', 'privatekey',
  'password', 'passwd', 'secret', 'clientsecret', 'cookie', 'setcookie', 'credentials'
]);

const sensitive = field => sensitiveFields.has(field.toLowerCase().replace(/[^a-z0-9]/g, ''));
const date = () => new Date().toISOString();

function redactText(value, secrets) {
  let result = value;
  for (const secret of secrets) result = result.replaceAll(secret, hidden);
  return result.replace(/\b(Bearer|Basic)[ \t]+[^\s,;"']+/gi, '$1 ' + hidden)
    .replace(/("([\w-]+)"\s*:\s*)"(?:\\.|[^"\\])*"/g,
      (match, prefix, field) => sensitive(field) ? prefix + JSON.stringify(hidden) : match)
    .replace(/([?&])([\w-]+)=([^&#\s"']*)/g,
      (match, separator, field) => sensitive(field) ? separator + field + '=' + hidden : match);
}

function cleanBody(value, secrets, maxBytes) {
  let remaining = maxBytes;
  let truncated = false;
  const seen = new WeakSet();
  function spend(bytes) {
    remaining -= bytes;
    if (remaining >= 0) return true;
    truncated = true;
    return false;
  }

  function clean(item, depth) {
    if (depth > 32) {
      truncated = true;
      return clipped;
    }
    if (typeof item === 'string') {
      if (item.length > maxBytes * 2) {
        truncated = true;
        return clipped;
      }
      if (/^\s*[{[]/.test(item)) {
        try {
          const inner = JSON.parse(item);
          const parsed = clean(inner, depth + 1);
          const json = JSON.stringify(parsed);
          if (json !== JSON.stringify(inner)) return json;
          return redactText(item, secrets);
        } catch {
          // Plain text and malformed JSON still go through text redaction.
        }
      }
      const sanitized = redactText(item, secrets);
      if (!spend(Buffer.byteLength(JSON.stringify(sanitized)))) return clipped;
      return sanitized;
    }
    if (!item || typeof item !== 'object') {
      spend(8);
      return typeof item === 'bigint' ? String(item) : item;
    }
    if (seen.has(item)) {
      truncated = true;
      return clipped;
    }
    seen.add(item);
    const result = Array.isArray(item) ? [] : Object.create(null);
    for (const field in item) {
      if (!Object.hasOwn(item, field)) continue;
      if (field.length > maxBytes) {
        truncated = true;
        break;
      }
      const key = redactText(field, secrets);
      if (!spend(Buffer.byteLength(key) + 6)) break;
      if (Array.isArray(result)) result.push(clean(item[field], depth + 1));
      else result[key] = sensitive(field) ? hidden : clean(item[field], depth + 1);
    }
    seen.delete(item);
    return result;
  }

  return { body: clean(value, 0), truncated };
}

export class TraceStore {
  #sessions = new Map();
  #exchanges = new Map();
  #bytes = 0;

  constructor({ maxSessions = 40, maxExchanges = 120, maxExchangesPerSession = 24, maxPacketsPerSide = 1000,
    maxPacketBytes = 96 * 1024, maxSideBytes = 512 * 1024, maxBytes = 16 * 1024 * 1024 } = {}) {
    this.limits = { maxSessions, maxExchanges, maxExchangesPerSession, maxPacketsPerSide, maxPacketBytes, maxSideBytes, maxBytes };
  }

  begin({ sessionId, title, protocol, secrets = [] }) {
    secrets = [...new Set(secrets.filter(value => typeof value === 'string' && value.length))].sort((a, b) => b.length - a.length);
    const safe = value => redactText(String(value ?? ''), secrets).slice(0, 1024);
    const time = date();
    const namedSession = safe(sessionId);
    const sessionKey = namedSession || randomUUID();
    const session = this.#sessions.get(sessionKey) ?? { id: sessionKey, title: '', protocol: '', updated: time, exchanges: new Set() };
    session.title ||= safe(title).slice(0, 110);
    session.protocol = safe(protocol) || session.protocol;
    session.updated = time;
    this.#sessions.delete(sessionKey);
    this.#sessions.set(sessionKey, session);
    const entry = { id: randomUUID(), time, client: [], upstream: [], bytes: 0, sideBytes: { client: 0, upstream: 0 }, session };
    this.#exchanges.set(entry.id, entry);
    session.exchanges.add(entry.id);
    this.#prune(session);
    let number = 0;
    const record = (side, data) => {
      if (!['client', 'upstream'].includes(side) || !this.#exchanges.has(entry.id) || entry[side].at(-1)?.kind === 'limit') return;
      const packet = { id: entry.id + ':' + ++number, time: date(), kind: safe(data.kind) };
      for (const key of ['method', 'path', 'status', 'call', 'source', 'event', 'toolScope']) {
        if (data[key] != null) packet[key] = typeof data[key] === 'number' ? data[key] : safe(data[key]);
      }
      if (Array.isArray(data.serverToolIds) && data.serverToolIds.length) packet.serverToolIds = data.serverToolIds.map(safe);
      if (data.body !== undefined) Object.assign(packet, cleanBody(data.body, secrets, this.limits.maxPacketBytes));
      if (data.truncated) packet.truncated = true;
      if (!packet.truncated) delete packet.truncated;
      let bytes = Buffer.byteLength(JSON.stringify(packet));
      if (bytes > this.limits.maxPacketBytes) {
        packet.body = clipped;
        packet.truncated = true;
        bytes = Buffer.byteLength(JSON.stringify(packet));
      }
      if (bytes > this.limits.maxPacketBytes) return;
      if (entry[side].length >= this.limits.maxPacketsPerSide - 1 || entry.sideBytes[side] + bytes > this.limits.maxSideBytes - 256) {
        const notice = { id: packet.id, time: packet.time, kind: 'limit', truncated: true, body: clipped };
        const noticeBytes = Buffer.byteLength(JSON.stringify(notice));
        if (entry.sideBytes[side] + noticeBytes <= this.limits.maxSideBytes) this.#append(entry, side, notice, noticeBytes);
        return;
      }
      this.#append(entry, side, packet, bytes);
      return packet.id;
    };

    const rename = value => {
      if (value && this.#exchanges.has(entry.id)) entry.session.title = safe(value).slice(0, 110);
    };
    const conversation = value => {
      if (!value || entry.conversation || !this.#exchanges.has(entry.id)) return;
      const id = entry.conversation = safe(value).toLowerCase();
      if (namedSession) return;

      const provisional = entry.session;
      const target = [...this.#sessions.values()].find(session =>
        session.protocol === provisional.protocol && session.conversation === id);
      if (!target) {
        provisional.conversation = id;
        return;
      }
      provisional.exchanges.delete(entry.id);
      if (!provisional.exchanges.size) this.#sessions.delete(provisional.id);
      entry.session = target;
      target.exchanges.add(entry.id);
      target.title ||= provisional.title;
      if (provisional.updated > target.updated) target.updated = provisional.updated;
      this.#sessions.delete(target.id);
      this.#sessions.set(target.id, target);
      this.#prune(target);
    };
    return {
      id: entry.id,
      get sessionId() { return entry.session.id; },
      record,
      conversation,
      initialTitle: value => { if (!entry.session.title) rename(value); },
      rename
    };
  }

  #append(entry, side, packet, bytes) {
    entry[side].push(packet);
    entry.bytes += bytes;
    entry.sideBytes[side] += bytes;
    entry.session.updated = packet.time;
    this.#bytes += bytes;
    this.#prune(entry.session);
  }

  #remove(id) {
    const entry = this.#exchanges.get(id);
    if (!entry) return;
    this.#bytes -= entry.bytes;
    this.#exchanges.delete(id);
    entry.session.exchanges.delete(id);
    if (!entry.session.exchanges.size) this.#sessions.delete(entry.session.id);
  }

  #prune(session) {
    while (session.exchanges.size > this.limits.maxExchangesPerSession) this.#remove(session.exchanges.values().next().value);
    while (this.#sessions.size > this.limits.maxSessions) {
      const oldest = this.#sessions.values().next().value;
      for (const id of oldest.exchanges) this.#remove(id);
    }
    while (this.#exchanges.size > this.limits.maxExchanges || this.#bytes > this.limits.maxBytes)
      this.#remove(this.#exchanges.keys().next().value);
  }

  snapshot(sessionId) {
    const sessions = [...this.#sessions.values()].map(({ id, title, protocol, updated, exchanges }) =>
      ({ id, title, protocol, updated, count: exchanges.size })).sort((a, b) => b.updated.localeCompare(a.updated));
    const exchanges = [...this.#exchanges.values()]
      .filter(entry => entry.session.id === sessionId)
      .map(({ id, time, client, upstream, conversation }) => ({ id, time, client, upstream, conversation }));
    return structuredClone({ sessions, exchanges });
  }

  clear() {
    this.#sessions.clear();
    this.#exchanges.clear();
    this.#bytes = 0;
  }
}
