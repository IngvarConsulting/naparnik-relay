const maxHighlightLength = 256 * 1024;
const maxHighlightTokens = 8000;
const punctuationHighlightLength = 32 * 1024;
const jsonTokens = /"(?:[^"\\]|\\.)*"|\b(?:true|false|null)\b|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|[{}[\],:]/g;
const keyColon = /\s*:/y;
const sseField = /^(data|event|id|retry)(: ?)([\s\S]*)$/;

function bodyText(body) {
  if (typeof body === 'string') return { text: body, json: false };
  try {
    const text = JSON.stringify(body, null, 2);
    return { text: text ?? '', json: text !== undefined };
  } catch {
    return { text: Object.prototype.toString.call(body), json: false };
  }
}

function isJson(text) {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

function flushText(view) {
  if (view.text) view.fragment.append(view.text);
  view.text = '';
}

function appendToken(view, text, type) {
  if (view.tokens >= maxHighlightTokens) {
    view.text += text;
    return;
  }
  flushText(view);
  const span = view.document.createElement('span');
  span.className = 'syntax-' + type;
  span.textContent = text;
  view.fragment.append(span);
  view.tokens++;
}

function appendJson(view, text) {
  const colorPunctuation = text.length <= punctuationHighlightLength;
  let end = 0;
  for (const match of text.matchAll(jsonTokens)) {
    if (match.index >= maxHighlightLength || view.tokens >= maxHighlightTokens) break;
    const token = match[0];
    view.text += text.slice(end, match.index);
    end = match.index + token.length;
    let type;
    if (token.startsWith('"')) {
      keyColon.lastIndex = end;
      type = keyColon.test(text) ? 'key' : 'string';
    } else if (/^[-0-9]/.test(token)) {
      type = 'number';
    } else if (/^[tfn]/.test(token)) {
      type = 'literal';
    } else if (colorPunctuation) {
      type = 'punctuation';
    }
    if (type) appendToken(view, token, type);
    else view.text += token;
  }
  view.text += text.slice(end);
}

function appendSse(view, text) {
  if (!/(?:^|\r\n|\r|\n)(?:event|data):/.test(text)) return false;
  for (const frame of text.split(/((?:\r\n|\n|\r(?!\n)){2,})/)) {
    if (!frame.includes(':')) {
      view.text += frame;
      continue;
    }
    const lines = frame.split(/(\r\n|\n|\r)/);
    const fields = lines.map(line => sseField.exec(line));
    const payload = fields.filter(field => field?.[1] === 'data').map(field => field[3]).join('\n');
    const json = isJson(payload);
    for (const [index, line] of lines.entries()) {
      const field = fields[index];
      if (!field) {
        view.text += line;
        continue;
      }
      const [, name, separator, value] = field;
      appendToken(view, name + ':', 'field');
      view.text += separator.slice(1);
      if (name === 'data' && json) {
        appendJson(view, value);
      } else if (name === 'data' && value === '[DONE]') {
        appendToken(view, value, 'literal');
      } else {
        view.text += value;
      }
    }
  }
  return true;
}

export function renderPacketBody(body, document = globalThis.document) {
  const pre = document.createElement('pre');
  pre.tabIndex = 0;
  const { text, json } = bodyText(body);
  const withinLimit = text.length <= maxHighlightLength;
  const view = { document, fragment: document.createDocumentFragment(), text: '', tokens: 0 };
  if (json || (withinLimit && isJson(text))) appendJson(view, text);
  else if (text === '[DONE]') appendToken(view, text, 'literal');
  else if (!withinLimit || !appendSse(view, text)) {
    pre.textContent = text;
    return pre;
  }
  flushText(view);
  pre.append(view.fragment);
  return pre;
}
