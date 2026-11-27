import { panelRequest } from './panel.js';
import { draftStatus, exchangeLinks, isSavedUserMessage, serverToolLinks } from './trace-links.js';
import { linkedScroll, scrollAnchors } from './trace-scroll.js';
import { renderPacketBody } from './trace-syntax.js';

const $ = id => document.getElementById(id);
const sessionList = $('trace-sessions');
const panes = Object.fromEntries(['client', 'upstream'].map(side => [side, {
  list: $('trace-' + side + '-packets'), scroll: $('trace-' + side + '-scroll')
}]));
const wireArea = $('trace-lines');
const sync = $('trace-sync');
const svgNS = 'http://www.w3.org/2000/svg';
const wireDrawing = document.createElementNS(svgNS, 'svg');
wireArea.append(wireDrawing);
const feedback = $('trace-feedback');
const sessionFeedback = $('session-feedback');
const sessionRows = new Map();
const exchangeRows = new Map();
const packetRows = new Map();
const pending = new Set();
const timeFormat = new Intl.DateTimeFormat('ru-RU', {
  hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3
});
const dateFormat = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const packetKinds = { request: 'Запрос', response: 'Ответ', sse: 'SSE', error: 'Ошибка', limit: 'Лимит трассировки' };
const draftLabels = {
  start: ['Старт потока', 'Эта дельта открыла клиентский SSE-поток.'],
  tracked: ['Контроль финала', 'Relay учёл UUID сообщения при проверке завершения потока и восстановлении после обрыва.'],
  skip: ['SKIP Draft', 'UUID уже учтён. Содержимое дельты агенту не передано.'],
  draft: ['Черновик', 'В этой записи нет данных о том, был ли UUID учтён.']
};
let selected = null;
let hovered, focused, selectedPacket;
let highlighted = [];
let connectionPositions = [], anchors = [], gutterCenter = 0;
let layoutDirty = true, redraw = 0, scrollSource;
let lastScrolled = 'client';
const synchronized = new Map();

function node(tag, content, className) {
  const element = document.createElement(tag);
  if (content != null) element.textContent = content;
  if (className) element.className = className;
  return element;
}

function timeElement(value, format = timeFormat) {
  const time = node('time');
  const date = new Date(value ?? NaN);
  if (!Number.isNaN(date.valueOf())) {
    time.textContent = format.format(date);
    time.dateTime = date.toISOString();
    time.title = date.toLocaleString('ru-RU');
  }
  return time;
}

function packetNumber(id) {
  const text = String(id);
  return /:([0-9]+)$/.exec(text)?.[1] ?? text;
}

function displayProtocol(protocol) {
  if (protocol === 'OpenAI') return 'OpenAI Chat Completions';
  if (protocol === 'Anthropic') return 'Anthropic Messages';
  return protocol || 'Агент';
}

function sessionName(session) {
  return session.title?.trim() || 'Сессия …' + String(session.id).slice(-8);
}

function setFeedback(element, message, error = false) {
  element.textContent = message;
  element.classList.toggle('panel-error', error);
}

function select(id) {
  if (id === selected) return;
  selected = id;
  for (const { list, scroll } of Object.values(panes)) {
    list.replaceChildren();
    scroll.scrollTop = 0;
  }
  exchangeRows.clear();
  packetRows.clear();
  hovered = focused = selectedPacket = scrollSource = undefined;
  lastScrolled = 'client';
  synchronized.clear();
  $('trace-columns').hidden = true;
  $('trace-sync-control').hidden = true;
  scheduleDrawing(true);
  const active = sessionRows.get(selected)?.session;
  $('exchange-title').textContent = active ? sessionName(active) : 'Обмен';
  setFeedback(feedback, active ? 'Загружаем обмен…' : 'Выберите сессию.');
  updateSelection();
  void refresh();
}

function updateSelection() {
  for (const [id, row] of sessionRows) {
    if (id === selected) row.button.setAttribute('aria-current', 'true');
    else row.button.removeAttribute('aria-current');
  }
}

function renderSessions(sessions) {
  const visible = new Set(sessions.map(session => session.id));
  for (const [id, row] of sessionRows) {
    if (visible.has(id)) continue;
    row.item.remove();
    sessionRows.delete(id);
  }
  let position = sessionList.firstElementChild;
  for (const session of sessions) {
    let row = sessionRows.get(session.id);
    if (!row) {
      const item = node('li');
      const button = node('button', null, 'trace-session');
      const title = node('strong');
      const meta = node('span', null, 'trace-session-meta');
      button.type = 'button';
      button.addEventListener('click', () => select(session.id));
      button.append(title, meta);
      item.append(button);
      row = { item, button, title, meta };
      sessionRows.set(session.id, row);
    }
    row.session = session;
    row.title.textContent = sessionName(session);
    row.title.title = row.title.textContent;
    row.meta.replaceChildren(node('span', session.protocol || 'Агент'), timeElement(session.updated, dateFormat));
    if (row.item !== position) sessionList.insertBefore(row.item, position);
    position = row.item.nextElementSibling;
  }
  setFeedback(sessionFeedback, sessions.length ? '' : 'Сессии появятся после первого запроса через Relay.');
  updateSelection();
}

function readingLine(pane) {
  return Math.min(85, pane.clientHeight * .25);
}

function scrollPane(side, top) {
  const scroll = panes[side].scroll;
  const before = scroll.scrollTop;
  scroll.scrollTop = top;
  if (Math.abs(scroll.scrollTop - before) > .5) synchronized.set(side, scroll.scrollTop);
}

function revealSource(id) {
  const target = packetRows.get(id);
  if (!target) return;
  target.details.open = true;
  target.summary.focus({ preventScroll: true });
  const { scroll } = panes[target.side];
  scrollPane(target.side, scroll.scrollTop + target.summary.getBoundingClientRect().top -
    scroll.getBoundingClientRect().top - readingLine(scroll));
  selectedPacket = id;
  scheduleDrawing(true);
}

function requestLine(packet, className) {
  const line = node('code', null, className);
  if (packet.method) line.append(node('span', packet.method, 'syntax-method'));
  if (packet.method && packet.path) line.append(' ');
  if (packet.path) line.append(node('span', packet.path, 'syntax-path'));
  line.title = line.textContent;
  return line;
}

function isStreamStartFrame(body) {
  return body?.type === 'message_start' || (body?.object === 'chat.completion.chunk' &&
    Array.isArray(body.choices) && body.choices.some(choice => choice?.delta?.role === 'assistant'));
}

function isAssistantBeginning(packet) {
  const body = packet.body;
  return packet.kind === 'sse' && body?.role === 'assistant' && body.finished === false && Boolean(body.uuid) &&
    body.content == null && body.content_delta == null;
}

function conversationPacketLabel(packet, serverToolSources) {
  if (isSavedUserMessage(packet)) return 'Напарник сохранил сообщение';
  if (isAssistantBeginning(packet)) return 'Начало сообщения';
  const body = packet.body;
  if (packet.kind !== 'sse' || body?.role !== 'assistant' || body.finished !== true) return;
  if (body.content?.tool_calls?.length) {
    const scope = packet.toolScope ?? (serverToolSources.has(String(packet.id)) ? 'server' : undefined);
    const tool = {
      server: 'серверного инструмента',
      client: 'клиентского инструмента',
      mixed: 'серверных и клиентских инструментов'
    }[scope] ?? 'инструмента';
    return (body.content.content ? 'Ответ и вызов ' : 'Вызов ') + tool;
  }
  return body.content?.content ? 'Текст ответа' : 'Финал сообщения';
}

function packetBody(packet, label, showTime = false) {
  const body = node(label ? 'section' : 'div', null, 'trace-packet-body');
  if (label) {
    const heading = node('div', null, 'trace-body-heading');
    heading.append(node('h4', label));
    if (showTime) heading.append(timeElement(packet.time));
    body.append(heading);
  }
  body.append(Object.hasOwn(packet, 'body')
    ? renderPacketBody(packet.body) : node('p', 'Пакет без тела.', 'panel-feedback'));
  if (packet.truncated) body.append(node('p', 'Запись ограничена лимитом трассировки.', 'panel-feedback'));
  return body;
}

function packetDetails({ packet, response, beginning }, side, opened, links, streamStartSource, serverToolSources) {
  const id = String(packet.id);
  const members = beginning ? [beginning, packet] : response ? [packet, response] : [packet];
  const group = { ids: members.map(item => String(item.id)), peers: new Set() };
  const row = node('div', null, 'trace-packet-row');
  row.dataset.tracePacket = id;
  const details = node('details', null, 'trace-packet');
  details.dataset.packetId = id;
  if (response) details.dataset.responseId = String(response.id);
  if (beginning) details.dataset.beginningId = String(beginning.id);
  details.open = group.ids.some(id => opened.has(id));
  const payload = packet.body;
  const draft = side === 'upstream' && draftStatus(packet, streamStartSource);
  if (draft === 'skip') details.classList.add('trace-packet-draft');
  const summary = node('summary');
  const heading = node('span', null, 'trace-packet-heading');
  const purpose = side === 'upstream' && conversationPacketLabel(packet, serverToolSources);
  const kind = node('strong', packetKinds[packet.kind] || packet.kind);
  const outcome = response ?? packet;
  if (outcome.kind === 'error' || outcome.status >= 400) kind.classList.add('panel-error');
  heading.append(kind);
  if (purpose) {
    const label = node('span', purpose, 'trace-conversation-label');
    label.title = purpose;
    heading.append(label);
  }
  const hasRoute = packet.method || packet.path;
  if (hasRoute) heading.append(requestLine(packet));
  if (draft) {
    const [caption, tooltip] = draftLabels[draft];
    const label = node('span', caption, draft === 'start' ? 'trace-start-label' : 'trace-draft-label');
    label.title = tooltip;
    heading.append(label);
  }
  if (packet.kind === 'sse' && !purpose) {
    if (payload === '[DONE]') heading.append(node('span', 'DONE', 'trace-done-label'));
    const name = packet.event || (typeof packet.body === 'string'
      ? /(?:^|\n)event:\s*([\w.-]+)/.exec(packet.body)?.[1]
      : packet.body?.type);
    if (name) heading.append(node('code', name, 'syntax-field'));
  }
  const meta = node('span', null, 'trace-packet-meta');
  const number = packetNumber(id);
  const packetId = node('code', number === id ? id : '№ ' + number);
  packetId.title = id;
  if (response) {
    const replyNumber = packetNumber(response.id);
    packetId.textContent = `№ ${number}/${replyNumber}`;
    packetId.title = `Запрос № ${number}, ответ № ${replyNumber}`;
  } else if (beginning) {
    const startNumber = packetNumber(beginning.id);
    packetId.textContent = `№ ${startNumber}/${number}`;
    packetId.title = `Начало № ${startNumber}, финал № ${number}`;
  }
  meta.append(packetId);
  if (outcome.status != null) {
    const status = node('code', outcome.status, 'trace-status');
    if (outcome.status >= 400) status.classList.add('panel-error');
    meta.append(status);
  }
  meta.append(timeElement(packet.time));
  summary.append(heading, meta);
  details.append(summary);

  const content = node('div', null, 'trace-packet-detail');
  const showBody = () => {
    if (!details.open || content.firstChild) return;
    if (hasRoute) content.append(requestLine(packet, 'trace-full-route'));
    if (beginning) content.append(packetBody(beginning, 'Начало сообщения', true));
    content.append(packetBody(packet, response ? 'Запрос' : beginning ? 'Финал' : undefined));
    if (response) {
      const label = response.kind === 'error' && response.status == null ? 'Ошибка' : 'Ответ';
      content.append(packetBody(response, label, true));
    }
  };
  showBody();
  details.addEventListener('toggle', () => {
    showBody();
    scheduleDrawing(true);
  });
  details.append(content);

  const references = node('div', null, 'trace-peer-list');
  for (const member of members) {
    const owner = String(member.id);
    const peers = [...links.get(owner) ?? []].sort(([a], [b]) => Number(packetNumber(a)) - Number(packetNumber(b)));
    const buttons = new Map();
    for (const [peer, relation] of peers) {
      const number = packetNumber(peer);
      const button = node('button', number, 'trace-peer');
      button.type = 'button';
      button.dataset.peer = peer;
      button.dataset.owner = owner;
      const targetSide = relation.side === 'client' ? 'агента' : 'Напарника';
      button.title = `Открыть пакет ${targetSide} № ${number}`;
      if (relation.toolResult === 'result') button.title = `Открыть запрос с результатом инструмента № ${number}`;
      if (relation.toolResult === 'call') button.title = `Открыть вызов клиентского инструмента № ${number}`;
      if (relation.indirect) button.title += ' · косвенная связь';
      button.setAttribute('aria-label', button.title);
      button.addEventListener('click', () => revealSource(peer));
      buttons.set(peer, button);
      references.append(button);
      group.peers.add(peer);
    }
    packetRows.set(owner, { details, summary, side, buttons, group });
  }
  if (side === 'client') row.append(details, references);
  else row.append(references, details);
  return row;
}

function linkContextFrames(client, upstream) {
  const contextCalls = new Set(upstream.filter(packet => packet.kind === 'request' && packet.method === 'GET' &&
    packet.path?.split('?', 1)[0].endsWith('/context_tokens')).map(packet => String(packet.id)));
  const measurements = upstream.filter(packet => packet.kind === 'response' && packet.status >= 200 && packet.status < 300 &&
    contextCalls.has(String(packet.call)));
  if (!measurements.length) return client;

  return client.map(packet => {
    if (packet.kind !== 'sse' || packet.source != null) return packet;
    const context = packet.body?.naparnik_context ?? packet.body?.message?.naparnik_context;
    if (!Number.isSafeInteger(context?.token_count) || context.token_count < 0 ||
        !Number.isSafeInteger(context.max_context_length) || context.max_context_length <= 0) return packet;
    const sequence = Number(packetNumber(packet.id));
    // The measurement is recorded before the SSE frame that carries its result.
    const sources = measurements.filter(response => Number(packetNumber(response.id)) < sequence &&
      response.body?.token_count === context.token_count && response.body?.max_context_length === context.max_context_length);
    return sources.length === 1 ? { ...packet, source: sources[0].id } : packet;
  });
}

function emittedToolIds(packet) {
  const body = packet.body;
  if (packet.kind === 'sse' && body?.type === 'content_block_start' && body.content_block?.type === 'tool_use') {
    return [body.content_block.id];
  }
  if (packet.kind === 'response' && body?.role === 'assistant' && Array.isArray(body.content)) {
    return body.content.filter(block => block?.type === 'tool_use').map(block => block.id);
  }
  if (['sse', 'response'].includes(packet.kind) && Array.isArray(body?.choices)) {
    return body.choices.flatMap(choice => {
      const calls = (packet.kind === 'sse' ? choice?.delta : choice?.message)?.tool_calls;
      return Array.isArray(calls) ? calls.map(call => call?.id) : [];
    });
  }
  return [];
}

function returnedToolIds(packet) {
  const messages = packet.body?.messages;
  if (!Array.isArray(messages)) return [];
  // Only the latest turn contains new results in requests that repeat the chat history.
  const tail = messages.slice(messages.findLastIndex(message => message?.role === 'assistant') + 1);
  if (packet.path === '/v1/chat/completions') {
    return tail.filter(message => message?.role === 'tool').map(message => message.tool_call_id);
  }
  if (packet.path === '/v1/messages') {
    return tail.flatMap(message => message?.role === 'user' && Array.isArray(message.content)
      ? message.content.filter(block => block?.type === 'tool_result').map(block => block.tool_use_id)
      : []);
  }
  return [];
}

function toolResultLinks(records) {
  const links = new Map();
  const outstanding = new Map();
  const packets = records.flatMap(record => (record.client ?? []).map(packet => ({ packet, exchangeId: record.id })));
  // Overlapping requests can have packets recorded after a later exchange began.
  packets.sort((a, b) => a.packet.time.localeCompare(b.packet.time));
  for (const { packet, exchangeId } of packets) {
    const packetId = String(packet.id);
    if (packet.kind !== 'request') {
      for (const id of emittedToolIds(packet)) {
        if (typeof id === 'string' && id) outstanding.set(id, { packetId, exchangeId });
      }
      continue;
    }
    const matched = new Map();
    for (const id of returnedToolIds(packet)) {
      const call = outstanding.get(id);
      if (!call) continue;
      outstanding.delete(id);
      matched.set(call.packetId, call);
    }
    for (const call of matched.values()) {
      const link = { from: call.packetId, to: packetId, resultExchange: exchangeId };
      for (const owner of [call.exchangeId, exchangeId]) {
        if (!links.has(owner)) links.set(owner, []);
        links.get(owner).push(link);
      }
    }
  }
  return links;
}

function traceCards(packets, side) {
  const requests = new Set(packets.filter(packet => packet.kind === 'request').map(packet => String(packet.id)));
  const clientRequest = side === 'client' && requests.size === 1 ? requests.values().next().value : undefined;
  const responses = new Map();
  const assistantBeginnings = new Map();
  const beginnings = new Map();
  for (const packet of packets) {
    const body = packet.body;
    if (side === 'upstream' && packet.kind === 'sse' && body?.role === 'assistant' && body.uuid) {
      const key = JSON.stringify([packet.call ?? null, body.uuid]);
      if (isAssistantBeginning(packet) && !assistantBeginnings.has(key)) assistantBeginnings.set(key, packet);
      if (body.finished === true && assistantBeginnings.has(key)) {
        beginnings.set(String(packet.id), assistantBeginnings.get(key));
        assistantBeginnings.delete(key);
      }
    }
    if (packet.kind !== 'response' && packet.kind !== 'error') continue;
    const request = packet.call == null ? (packet.kind === 'response' ? clientRequest : undefined) : String(packet.call);
    if (!requests.has(request)) continue;
    const previous = responses.get(request);
    if (!previous || (previous.kind === 'error' && packet.kind === 'response')) responses.set(request, packet);
  }
  const paired = new Set([...responses.values(), ...beginnings.values()]);
  return packets.filter(packet => !paired.has(packet)).map(packet => {
    const id = String(packet.id);
    return { packet, response: responses.get(id), beginning: beginnings.get(id) };
  });
}

function renderExchanges(records, session) {
  const clientLabel = displayProtocol(session.protocol);
  $('trace-client-title').textContent = 'Агент · ' + clientLabel;
  $('trace-columns').hidden = records.length === 0;
  $('trace-sync-control').hidden = records.length === 0;
  let changed = false;
  const remove = row => {
    for (const section of Object.values(row.sections)) section.remove();
    for (const id of row.packetIds) packetRows.delete(id);
    changed = true;
  };
  const visible = new Set(records.map(record => record.id));
  for (const [id, row] of exchangeRows) {
    if (visible.has(id)) continue;
    remove(row);
    exchangeRows.delete(id);
  }
  const sides = Object.keys(panes);
  const positions = Object.fromEntries(sides.map(side => [side, panes[side].list.firstElementChild]));
  const toolResults = toolResultLinks(records);
  const serverTools = serverToolLinks(records);
  for (const record of records) {
    let row = exchangeRows.get(record.id);
    const toolLinks = toolResults.get(record.id) ?? [];
    const launches = serverTools.get(record.id) ?? [];
    const signature = JSON.stringify([record, toolLinks, launches]);
    if (!row || row.signature !== signature) {
      const opened = new Set(row?.packetIds.filter(id => packetRows.get(id)?.details.open));
      if (row) {
        for (const side of sides) {
          if (row.sections[side] === positions[side]) positions[side] = positions[side].nextElementSibling;
        }
        remove(row);
      }
      const upstreamPackets = record.upstream ?? [];
      const clientPackets = linkContextFrames(record.client ?? [], upstreamPackets);
      const { peers, connections, serverToolSources } = exchangeLinks(clientPackets, upstreamPackets, record.id, toolLinks, launches);
      const start = clientPackets.find(packet => packet.kind === 'sse' && isStreamStartFrame(packet.body));
      const streamStartSource = start?.source == null ? undefined : String(start.source);
      row = { signature, sections: {}, packetIds: [], connections };
      for (const side of sides) {
        const section = node('section', null, 'trace-exchange trace-side');
        const header = node('header', null, 'trace-exchange-header');
        header.title = String(record.id);
        header.append(timeElement(record.time));
        section.append(header);
        const packets = side === 'client' ? clientPackets : upstreamPackets;
        for (const card of traceCards(packets, side)) {
          section.append(packetDetails(card, side, opened, peers, streamStartSource, serverToolSources));
        }
        for (const packet of packets) row.packetIds.push(String(packet.id));
        if (!packets.length) section.append(node('p', 'Пакетов пока нет.', 'panel-feedback'));
        row.sections[side] = section;
      }
      exchangeRows.set(record.id, row);
      changed = true;
    }
    for (const side of sides) {
      const section = row.sections[side];
      if (section !== positions[side]) {
        panes[side].list.insertBefore(section, positions[side]);
        changed = true;
      }
      positions[side] = section.nextElementSibling;
    }
  }
  if (changed) scheduleDrawing(true);
}

function measureLinks() {
  const client = panes.client.scroll, upstream = panes.upstream.scroll;
  const wireLeft = wireArea.getBoundingClientRect().left;
  const clientBox = client.getBoundingClientRect(), upstreamBox = upstream.getBoundingClientRect();
  gutterCenter = (clientBox.right + upstreamBox.left) / 2 - wireLeft;
  const origin = {
    client: clientBox.top - client.scrollTop,
    upstream: upstreamBox.top - upstream.scrollTop
  };
  const position = (element, side) => {
    const rect = element.getBoundingClientRect();
    return rect.top + rect.height / 2 - origin[side];
  };
  const endpoint = (button, side) => {
    const rect = button.getBoundingClientRect();
    return {
      side,
      x: (side === 'client' ? rect.right : rect.left) - wireLeft,
      y: rect.top + rect.height / 2 - origin[side]
    };
  };
  const readings = { client: readingLine(client), upstream: readingLine(upstream) };
  const points = [...exchangeRows.values()].map(({ sections }) => ({
    client: position(sections.client.firstElementChild, 'client') - readings.client,
    upstream: position(sections.upstream.firstElementChild, 'upstream') - readings.upstream,
    priority: 0
  }));
  const positions = new Map();
  const packetPosition = id => {
    if (!positions.has(id)) {
      const row = packetRows.get(id);
      positions.set(id, position(row.summary, row.side));
    }
    return positions.get(id);
  };
  connectionPositions = [];
  for (const { connections } of exchangeRows.values()) {
    for (const { from, to, indirect } of connections) {
      const source = packetRows.get(from), target = packetRows.get(to);
      connectionPositions.push({
        from, to, indirect,
        start: endpoint(source.buttons.get(to), source.side), end: endpoint(target.buttons.get(from), target.side)
      });
      if (indirect || source.side === target.side) continue;
      const [clientId, upstreamId] = source.side === 'client' ? [from, to] : [to, from];
      points.push({ client: packetPosition(clientId) - readings.client,
        upstream: packetPosition(upstreamId) - readings.upstream, priority: 6 });
    }
  }
  anchors = scrollAnchors(points, client.scrollHeight - client.clientHeight, upstream.scrollHeight - upstream.clientHeight);
}

function appendWire(group, path, className) {
  const line = document.createElementNS(svgNS, 'path');
  line.setAttribute('d', path);
  line.setAttribute('class', className);
  group.append(line);
}

function drawLinks() {
  const width = wireArea.clientWidth, height = wireArea.clientHeight;
  const currentId = (hovered ?? focused)?.id ?? selectedPacket;
  const currentPeer = (hovered ?? focused)?.peer;
  const current = packetRows.get(currentId);
  if (current?.details !== highlighted[0]) {
    for (const details of highlighted) details.classList.remove('trace-related', 'trace-highlight');
    highlighted = [];
    if (current?.group.peers.size) {
      current.details.classList.add('trace-related', 'trace-highlight');
      const related = new Set([...current.group.peers].map(id => packetRows.get(id).details));
      for (const details of related) details.classList.add('trace-related');
      highlighted = [current.details, ...related];
    }
  }
  if (!width || !height) {
    wireDrawing.replaceChildren();
    return;
  }
  wireDrawing.setAttribute('viewBox', `0 0 ${width} ${height}`);
  const scroll = { client: panes.client.scroll.scrollTop, upstream: panes.upstream.scroll.scrollTop };
  const paths = document.createDocumentFragment();
  const activePaths = document.createDocumentFragment();
  const inside = y => y >= 0 && y <= height;
  for (const { from, to, indirect, start, end } of connectionPositions) {
    const x1 = start.x, x2 = end.x;
    const y1 = start.y - scroll[start.side], y2 = end.y - scroll[end.side];
    if (!inside(y1) || !inside(y2)) continue;
    const active = currentPeer
      ? (from === currentId && to === currentPeer) || (to === currentId && from === currentPeer)
      : current?.group.ids.includes(from) || current?.group.ids.includes(to);
    const style = active ? ' active' : current?.group.peers.size ? ' muted' : '';
    const group = active ? activePaths : paths;
    const departure = start.side === 'client' ? 1 : -1;
    const arrival = end.side === 'upstream' ? 1 : -1;
    const middle = (x1 + x2) / 2;
    const local = start.side === end.side;
    const depth = local ? Math.min(24, Math.abs(middle - gutterCenter)) : 0;
    const straight = local ? Math.min(8, depth / 2) : Math.min(14, Math.abs(x2 - x1) / 4);
    const bend = middle + departure * depth;
    const curve = `M${x1} ${y1} H${x1 + departure * straight} ` +
      `C${bend} ${y1} ${bend} ${y2} ${x2 - arrival * straight} ${y2} H${x2}`;
    const arrowBase = x2 - arrival * 5;
    const arrow = ` M${arrowBase} ${y2 - 3} L${x2} ${y2} L${arrowBase} ${y2 + 3}`;
    appendWire(group, indirect ? curve : curve + arrow, 'trace-wire' + (indirect ? ' indirect' : '') + style);
    if (indirect) appendWire(group, arrow, 'trace-wire-tip' + style);
  }
  wireDrawing.replaceChildren(paths, activePaths);
}

function scheduleDrawing(layout = false) {
  layoutDirty ||= layout;
  if (redraw) return;
  redraw = requestAnimationFrame(() => {
    redraw = 0;
    if (layoutDirty) {
      layoutDirty = false;
      measureLinks();
    }
    if (scrollSource && sync.checked && anchors.length) {
      const counterpart = scrollSource === 'client' ? 'upstream' : 'client';
      scrollPane(counterpart, linkedScroll(anchors, panes[scrollSource].scroll.scrollTop, scrollSource));
    }
    scrollSource = undefined;
    drawLinks();
  });
}

const layoutObserver = new ResizeObserver(() => scheduleDrawing(true));
layoutObserver.observe(wireArea);
for (const [side, { list, scroll }] of Object.entries(panes)) {
  layoutObserver.observe(list);
  scroll.addEventListener('scroll', () => {
    const expected = synchronized.get(side);
    if (expected === undefined || Math.abs(scroll.scrollTop - expected) > 1) {
      lastScrolled = scrollSource = side;
    }
    synchronized.delete(side);
    scheduleDrawing();
  }, { passive: true });
  const cardAt = element => {
    const button = element?.closest?.('.trace-peer');
    const id = button?.dataset.owner ?? element?.closest?.('[data-trace-packet]')?.dataset.tracePacket;
    return id ? { id, peer: button?.dataset.peer } : undefined;
  };
  scroll.addEventListener('pointerover', event => {
    hovered = cardAt(event.target);
    scheduleDrawing();
  });
  scroll.addEventListener('pointerout', event => {
    hovered = scroll.contains(event.relatedTarget) ? cardAt(event.relatedTarget) : undefined;
    scheduleDrawing();
  });
  scroll.addEventListener('focusin', event => {
    focused = cardAt(event.target);
    scheduleDrawing();
  });
  scroll.addEventListener('focusout', event => {
    focused = scroll.contains(event.relatedTarget) ? cardAt(event.relatedTarget) : undefined;
    scheduleDrawing();
  });
  scroll.addEventListener('click', event => {
    if (event.target.closest('summary')) selectedPacket = cardAt(event.target)?.id;
    scheduleDrawing();
  });
}

sync.addEventListener('change', () => {
  if (sync.checked) scrollSource = lastScrolled;
  scheduleDrawing();
});

async function refresh(force = false) {
  const id = selected;
  if ((!force && document.hidden) || pending.has(id)) return;
  pending.add(id);
  try {
    const data = await panelRequest(id === null ? 'trace' : 'trace?session=' + encodeURIComponent(id));
    if (selected !== id) return;
    const sessions = data.sessions ?? [];
    renderSessions(sessions);
    const session = sessionRows.get(id)?.session;
    if (id !== null && !session) {
      select(null);
      return;
    }
    if (!session) return;
    $('exchange-title').textContent = sessionName(session);
    const records = data.exchanges ?? [];
    renderExchanges(records, session);
    setFeedback(feedback, records.length ? '' : 'Для этой сессии пока нет записей.');
  } catch (error) {
    if (id === selected) setFeedback(id === null ? sessionFeedback : feedback, error.message, true);
  } finally {
    pending.delete(id);
  }
}

$('trace-refresh').addEventListener('click', () => refresh(true));
document.addEventListener('visibilitychange', () => refresh());
setInterval(refresh, 2500);
void refresh();
