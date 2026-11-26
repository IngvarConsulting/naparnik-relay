function sharedEndpoint(points, axis, other) {
  points.sort((a, b) => a[axis] - b[axis] || b.priority - a.priority || a[other] - b[other]);
  const unique = [];
  for (let start = 0; start < points.length;) {
    const first = points[start];
    let end = start + 1;
    while (end < points.length && points[end][axis] === first[axis] && points[end].priority === first.priority) end++;
    // When one packet produced several frames, align to the middle of that series.
    unique.push(points[start + Math.floor((end - start - 1) / 2)]);
    while (end < points.length && points[end][axis] === first[axis]) end++;
    start = end;
  }
  return unique;
}

function monotoneChain(points) {
  const order = new Map([...points].sort((a, b) => a.upstream - b.upstream)
    .map((point, index) => [point.upstream, index + 1]));
  // The prefix tree finds the best compatible earlier chain in logarithmic time.
  const prefixes = new Array(points.length + 1);
  let best;
  points.sort((a, b) => a.client - b.client);
  for (const point of points) {
    const rank = order.get(point.upstream);
    let previous;
    for (let index = rank - 1; index > 0; index -= index & -index) {
      const prefix = prefixes[index];
      if (prefix && (!previous || prefix.score > previous.score)) previous = prefix;
    }
    const current = { point, previous, score: (previous?.score ?? 0) + point.priority + 1 };
    for (let index = rank; index < prefixes.length; index += index & -index) {
      if (!prefixes[index] || prefixes[index].score < current.score) prefixes[index] = current;
    }
    if (!best || best.score < current.score) best = current;
  }

  const result = [];
  for (let chain = best; chain; chain = chain.previous) {
    const { client, upstream } = chain.point;
    result.push({ client, upstream });
  }
  return result.reverse();
}

const scrollLimit = value => Number.isFinite(value) ? Math.max(value, 0) : 0;

// Anchors describe where the same part of the exchange starts in each column.
export function scrollAnchors(points, clientMax, upstreamMax) {
  const start = { client: 0, upstream: 0 };
  const end = { client: scrollLimit(clientMax), upstream: scrollLimit(upstreamMax) };
  const inside = points.filter(point => point.client > 0 && point.client < end.client &&
    point.upstream > 0 && point.upstream < end.upstream)
    .map(({ client, upstream, priority }) => ({ client, upstream, priority: scrollLimit(priority) }));
  const unique = sharedEndpoint(sharedEndpoint(inside, 'client', 'upstream'), 'upstream', 'client');
  return [start, ...monotoneChain(unique), end];
}

export function linkedScroll(anchors, position, from) {
  if (!anchors.length || !(position > 0)) return 0;
  const to = from === 'client' ? 'upstream' : 'client';
  let low = 0, high = anchors.length - 1;
  if (position >= anchors[high][from]) return anchors[high][to];
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (anchors[middle][from] <= position) low = middle;
    else high = middle;
  }
  const start = anchors[low], end = anchors[high];
  const progress = (position - start[from]) / (end[from] - start[from]);
  return start[to] + (end[to] - start[to]) * progress;
}
