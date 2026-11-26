import test from 'node:test';
import assert from 'node:assert/strict';
import { renderPacketBody } from '../public/trace-syntax.js';

function render(body) {
  const createElement = tag => ({
    tag,
    children: [],
    append(child) { this.children.push(child); },
    set textContent(value) { this.children = [value]; },
    get textContent() { return this.children.map(child => typeof child === 'string' ? child : child.textContent).join(''); }
  });
  const document = { createDocumentFragment: () => createElement('fragment'), createElement };
  const pre = renderPacketBody(body, document);
  const spans = pre.children.flatMap(child => child.children ?? []).filter(child => child.tag === 'span');
  return { text: pre.textContent, spans };
}

test('Подсветка длинного POST с описаниями инструментов доходит до последних полей', () => {
  const body = {
    tools: Array.from({ length: 250 }, () => ({
      name: 'example', description: 'Описание инструмента '.repeat(7),
      parameters: { type: 'object', required: ['query'], properties: { query: { type: 'string' } } }
    })),
    stream: true
  };
  const { text, spans } = render(body);
  assert.equal(text, JSON.stringify(body, null, 2));
  assert.ok(spans.some(span => span.className === 'syntax-key' && span.textContent === '"stream"'));
  assert.ok(spans.some(span => span.className === 'syntax-literal' && span.textContent === 'true'));
});

test('При исчерпании бюджета подсветки длинный JSON сохраняет цвет начала и полное тело', () => {
  const body = { numbers: Array.from({ length: 10_000 }, (_, i) => i), end: 'конец пакета' };
  const { text, spans } = render(body);
  assert.equal(text, JSON.stringify(body, null, 2));
  assert.ok(spans.some(span => span.className === 'syntax-key' && span.textContent === '"numbers"'));
  assert.ok(spans.length < body.numbers.length);
});

test('Подсветка сохраняет исходный текст SSE, включая ограничители и терминатор', () => {
  const body = 'event: message\r\ndata: {"finished":false}\r\n\r\ndata: [DONE]\r\n';
  const { text, spans } = render(body);
  assert.equal(text, body);
  assert.ok(spans.some(span => span.className === 'syntax-field' && span.textContent === 'event:'));
  assert.ok(spans.some(span => span.className === 'syntax-key' && span.textContent === '"finished"'));
  assert.ok(spans.some(span => span.className === 'syntax-literal' && span.textContent === '[DONE]'));
});
