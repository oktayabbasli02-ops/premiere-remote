import test from 'node:test';
import assert from 'node:assert/strict';
import { CommandJournal, SerialQueue, StaleFilter } from '../src/journal.js';

test('a command id is executed once; duplicates get the cached result', () => {
  const j = new CommandJournal();
  assert.deepEqual(j.begin('dev1', 'c1'), { state: 'new' });
  assert.deepEqual(j.begin('dev1', 'c1'), { state: 'inflight' });
  j.complete('dev1', 'c1', { status: 'ok' });
  assert.deepEqual(j.begin('dev1', 'c1'), { state: 'done', result: { status: 'ok' } });
});

test('the same command id from different devices is independent', () => {
  const j = new CommandJournal();
  assert.equal(j.begin('dev1', 'c1').state, 'new');
  assert.equal(j.begin('dev2', 'c1').state, 'new');
});

test('lookup lets a reconnecting phone learn the outcome without re-sending', () => {
  const j = new CommandJournal();
  assert.deepEqual(j.lookup('d', 'x'), { state: 'unknown' });
  j.begin('d', 'x');
  assert.deepEqual(j.lookup('d', 'x'), { state: 'inflight' });
  j.complete('d', 'x', { status: 'error', error: { code: 'modal_dialog' } });
  assert.equal(j.lookup('d', 'x').result.error.code, 'modal_dialog');
});

test('finished entries expire after the TTL but in-flight ones do not', () => {
  let now = 0;
  const j = new CommandJournal({ ttlMs: 1000, now: () => now });
  j.begin('d', 'done'); j.complete('d', 'done', { status: 'ok' });
  j.begin('d', 'running');
  now = 5000;
  assert.deepEqual(j.lookup('d', 'done'), { state: 'unknown' });
  assert.deepEqual(j.lookup('d', 'running'), { state: 'inflight' });
});

test('journal is bounded', () => {
  const j = new CommandJournal({ maxEntries: 10 });
  for (let i = 0; i < 50; i++) { j.begin('d', `c${i}`); j.complete('d', `c${i}`, {}); }
  assert.ok(j.entries.size <= 10);
});

test('SerialQueue runs commands strictly in order even when earlier ones are slower', async () => {
  const q = new SerialQueue();
  const order = [];
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  await Promise.all([
    q.push(async () => { await delay(30); order.push(1); }),
    q.push(async () => { order.push(2); throw new Error('boom'); }).catch(() => {}),
    q.push(async () => { await delay(5); order.push(3); }),
  ]);
  assert.deepEqual(order, [1, 2, 3]);
});

test('StaleFilter drops out-of-order, old-epoch and too-old events', () => {
  let now = 10_000;
  const f = new StaleFilter({ maxAgeMs: 300, now: () => now });
  f.reset('e1');
  assert.equal(f.accept({ epoch: 'e1', seq: 1, ts: 9_950 }), true);
  assert.equal(f.accept({ epoch: 'e1', seq: 1, ts: 9_990 }), false, 'duplicate seq');
  assert.equal(f.accept({ epoch: 'e1', seq: 3, ts: 9_990 }), true);
  assert.equal(f.accept({ epoch: 'e1', seq: 2, ts: 9_995 }), false, 'reordered');
  assert.equal(f.accept({ epoch: 'e0', seq: 9, ts: 9_999 }), false, 'previous connection');
  assert.equal(f.accept({ epoch: 'e1', seq: 4, ts: 9_000 }), false, 'too old');
  // clock offset: phone clock is 5 s ahead
  f.clockOffsetMs = 5000;
  assert.equal(f.accept({ epoch: 'e1', seq: 5, ts: 14_950 }), true);
});
