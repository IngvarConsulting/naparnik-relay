import test from 'node:test';
import assert from 'node:assert/strict';
import { linkedScroll, scrollAnchors } from '../public/trace-scroll.js';

test('Прокрутка совмещает связанные пакеты и интерполирует между ними в обе стороны', () => {
  const anchors = scrollAnchors([
    { client: 100, upstream: 200 },
    { client: 300, upstream: 300 }
  ], 400, 600);

  assert.equal(linkedScroll(anchors, 100, 'client'), 200);
  assert.equal(linkedScroll(anchors, 200, 'client'), 250);
  assert.equal(linkedScroll(anchors, 250, 'upstream'), 200);
  assert.equal(linkedScroll(anchors, -1, 'client'), 0);
  assert.equal(linkedScroll(anchors, 801, 'upstream'), 400);
});

test('Серия пакетов с одним источником прокручивается к центральному связанному пакету', () => {
  const anchors = scrollAnchors([
    { client: 40, upstream: 200, priority: 1 },
    { client: 100, upstream: 200, priority: 2 },
    { client: 140, upstream: 200, priority: 2 },
    { client: 180, upstream: 200, priority: 2 }
  ], 400, 400);

  assert.deepEqual(anchors, [
    { client: 0, upstream: 0 },
    { client: 140, upstream: 200 },
    { client: 400, upstream: 400 }
  ]);
  assert.equal(linkedScroll(anchors, 200, 'upstream'), 140);
});

test('Пересекающиеся связи не разворачивают прокрутку и сохраняют приоритетную связь', () => {
  const anchors = scrollAnchors([
    { client: 75, upstream: 200, priority: 3 },
    { client: 100, upstream: 100, priority: 1 },
    { client: 150, upstream: 300, priority: 1 },
    { client: -10, upstream: 220 },
    { client: 200, upstream: NaN }
  ], 250, 500);

  assert.deepEqual(anchors, [
    { client: 0, upstream: 0 },
    { client: 75, upstream: 200 },
    { client: 150, upstream: 300 },
    { client: 250, upstream: 500 }
  ]);
  for (const axis of ['client', 'upstream']) {
    const positions = Array.from({ length: 501 }, (_, index) => linkedScroll(anchors, index, axis));
    assert.ok(positions.every((position, index) => !index || position >= positions[index - 1]));
  }
});

test('Колонка без прокрутки остаётся на месте', () => {
  const anchors = scrollAnchors([], 90, 0);
  assert.equal(linkedScroll(anchors, 60, 'client'), 0);
  assert.equal(linkedScroll(anchors, 0, 'upstream'), 0);
});
