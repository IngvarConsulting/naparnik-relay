export function isSavedUserMessage(packet) {
  const body = packet.body;
  return packet.kind === 'sse' && body?.role === 'user' && body.finished === true && Boolean(body.uuid) &&
    body.content == null && body.content_delta == null;
}

function messageConversation(packet) {
  if (packet.kind !== 'request' || packet.method !== 'POST') return;
  return /\/conversations\/([^/?]+)\/messages(?:\?|$)/.exec(packet.path)?.[1].toLowerCase();
}

export function serverToolLinks(records) {
  const packets = [];
  for (const record of records) {
    const conversations = new Map();
    for (const packet of record.upstream ?? []) {
      const conversation = messageConversation(packet);
      if (conversation) conversations.set(packet.id, conversation);
    }
    const clientIds = new Set((record.client ?? []).map(packet => String(packet.id)));
    for (const packet of record.upstream ?? []) {
      const body = packet.body;
      if (!(packet.kind === 'sse' && body?.role === 'assistant' && body.finished && body.content?.tool_calls) &&
          !(conversations.has(packet.id) && body?.role === 'tool')) continue;
      const conversation = conversations.get(packet.id) ?? conversations.get(packet.call) ?? record.conversation;
      if (conversation) packets.push({ packet, conversation, exchangeId: record.id, clientIds });
    }
  }
  packets.sort((a, b) => a.packet.time.localeCompare(b.packet.time));

  const links = new Map();
  const parents = new Map();
  for (const { packet, conversation, exchangeId, clientIds } of packets) {
    const body = packet.body;
    if (packet.kind === 'sse' && body?.finished === true && body.role === 'assistant' &&
        body.uuid && Array.isArray(body.content?.tool_calls)) {
      const toolIds = new Set(body.content.tool_calls.map(call => call?.id).filter(Boolean));
      if (toolIds.size) parents.set(JSON.stringify([conversation, body.uuid]), { packet, exchangeId, toolIds });
      continue;
    }
    if (!messageConversation(packet) || body?.role !== 'tool' || !Array.isArray(body.content)) continue;
    const parent = parents.get(JSON.stringify([conversation, body.parent_uuid]));
    if (!parent || parent.packet.toolScope === 'client') continue;
    const explicit = Array.isArray(parent.packet.serverToolIds) ? new Set(parent.packet.serverToolIds) : undefined;
    const decisions = body.content.filter(result => {
      if (!parent.toolIds.has(result?.tool_call_id) || result.content !== null ||
          !['accepted', 'rejected'].includes(result.status)) return false;
      if (explicit) return explicit.has(result.tool_call_id);
      // Old traces lack per-call scope. Client results can be rejected, but never accepted.
      return parent.packet.toolScope === 'server' || result.status === 'accepted' ||
        (!parent.packet.toolScope && parent.exchangeId === exchangeId);
    });
    if (!decisions.length) continue;
    const source = String(packet.source ?? '');
    const link = {
      from: String(parent.packet.id), to: String(packet.id), resultExchange: exchangeId,
      decisionOnly: decisions.length === body.content.length,
      allServer: new Set(decisions.map(result => result.tool_call_id)).size === parent.toolIds.size,
      source: clientIds.has(source) ? source : undefined
    };
    for (const owner of new Set([parent.exchangeId, exchangeId])) {
      if (!links.has(owner)) links.set(owner, []);
      links.get(owner).push(link);
    }
  }
  return links;
}

export function exchangeLinks(client, upstream, exchangeId, toolResults, launches) {
  const clientIds = new Set(client.map(packet => String(packet.id)));
  const upstreamIds = new Set(upstream.map(packet => String(packet.id)));
  const decisionPosts = new Set(launches.filter(link => link.decisionOnly).map(link => link.to));
  const peers = new Map();
  const connections = [];
  const serverToolSources = new Set();
  const connect = (from, to, fromSide, toSide, { indirect = false, toolResult = false, draw = true } = {}) => {
    if (peers.get(from)?.has(to)) return;
    for (const [owner, peer, side] of [[from, to, toSide], [to, from, fromSide]]) {
      if (!peers.has(owner)) peers.set(owner, new Map());
      peers.get(owner).set(peer, { side, indirect, toolResult: toolResult && (owner === from ? 'result' : 'call') });
    }
    if (draw) connections.push({ from, to, indirect });
  };
  for (const packet of client) {
    const source = String(packet.source ?? '');
    if (upstreamIds.has(source)) connect(source, String(packet.id), 'upstream', 'client');
  }
  const userPosts = new Set();
  for (const packet of upstream) {
    const id = String(packet.id);
    const source = String(packet.source ?? '');
    if (messageConversation(packet) && (packet.body?.role == null || packet.body.role === 'user')) userPosts.add(id);
    const call = String(packet.call ?? '');
    if (isSavedUserMessage(packet) && userPosts.has(call)) connect(call, id, 'upstream', 'upstream');
    if (clientIds.has(source) && !decisionPosts.has(id)) connect(source, id, 'client', 'upstream');
  }
  for (const { from, to, resultExchange } of toolResults) {
    connect(from, to, 'client', 'client', { toolResult: true, draw: exchangeId === resultExchange });
  }
  for (const { from, to, resultExchange, decisionOnly, allServer, source } of launches) {
    const draw = exchangeId === resultExchange;
    if (allServer) serverToolSources.add(from);
    if (decisionOnly && source) connect(source, from, 'client', 'upstream', { indirect: true, draw });
    connect(from, to, 'upstream', 'upstream', { draw });
  }
  return { peers, connections, serverToolSources };
}
