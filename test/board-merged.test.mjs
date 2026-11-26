import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BoardStore } from '../board/store.ts';
import { startBoardWeb } from '../board/web.ts';
import { perchWorkerBoardPrompt, recordPerchWorkerReceipt } from '../board/runtime.ts';

test('BoardStore state machine, automatic perch spawn binding, receipts, decisions, and independent review', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'perch-board-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const sessionFile = join(dir, 'main.jsonl');
  const dbPath = join(dir, 'main', 'board.sqlite');
  const store = new BoardStore(join(dir, 'board.sqlite'));
  t.after(() => store.close());

  const main = { kind: 'main', id: 'main' };
  const snap1 = store.apply(main, { op: 'create', title: 'Fix mount race', description: 'Full details', criteria: 'Unit tests pass' });
  const item = snap1.items[0];
  assert.equal(item.state, 'unassigned');

  const token = '11111111-2222-4333-8444-555555555555';
  store.beginSpawn(token, item.id, 'execute');
  store.commitSpawn(token, 'agy:worker-1');
  const binding = store.bindingForWorker('agy:worker-1');
  assert.deepEqual(binding, { item: item.id, role: 'execute', attempt: 1 });

  store.receipt('agy:worker-1', 'perch:1', 'Fixed race and ran go test', 1);
  const notices = store.pendingReceiptNotices();
  assert.equal(notices.length, 1);
  assert.equal(notices[0].item, item.id);

  // Worker submits; same worker cannot review own work
  store.apply({ kind: 'worker', id: 'agy:worker-1', attempt: 1 }, { op: 'submit', item: item.id, text: 'Tests green' });
  assert.throws(() => {
    store.apply(main, { op: 'assign', item: item.id, worker: 'agy:worker-1', role: 'review' });
  }, /already assigned|cannot review/i);

  // Independent reviewer approves
  store.apply(main, { op: 'assign', item: item.id, worker: 'omp:reviewer-2', role: 'review' });
  const doneSnap = store.apply({ kind: 'worker', id: 'omp:reviewer-2', attempt: 1 }, { op: 'approve', item: item.id, text: 'Verified' });
  assert.equal(doneSnap.items[0].state, 'done');

  // Decisions + perchWorkerBoardPrompt helper on sessionFile path
  store.apply(main, { op: 'decide', title: 'Use stack layout', text: 'Keep left 50% fixed', items: [item.id] });
  assert.equal(store.snapshot().decisions.length, 1);

  // Verify runtime helpers with session-scoped boardPath
  const { mkdir } = await import('node:fs/promises');
  await mkdir(join(dir, 'main'), { recursive: true });
  const s2 = new BoardStore(dbPath);
  const s2Item = s2.apply(main, { op: 'create', title: 'Inspect logs', criteria: 'Cite line numbers' }).items[0];
  s2.beginSpawn('22222222-2222-4333-8444-555555555555', s2Item.id, 'execute');
  s2.commitSpawn('22222222-2222-4333-8444-555555555555', 'agy:native-1');
  s2.close();

  const ctxBlock = perchWorkerBoardPrompt(sessionFile, s2Item.id, 'execute');
  assert.ok(ctxBlock && ctxBlock.includes('Inspect logs') && ctxBlock.includes('Cite line numbers'));
  assert.equal(recordPerchWorkerReceipt(sessionFile, 'agy:native-1', 'perch:1', 'Found line 42'), true);
});

test('BoardWeb serves assets with security headers, handles snapshot, confirmation, discuss, and rejects cross-origin', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'perch-board-web-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new BoardStore(join(dir, 'board.sqlite'));
  t.after(() => store.close());

  const main = { kind: 'main', id: 'main' };
  const item = store.apply(main, { op: 'create', title: 'Review design', criteria: 'Check lock order' }).items[0];
  const decision = store.apply(main, { op: 'decide', title: 'No polling', text: 'Use async updates', items: [item.id] }).decisions[0];

  const discussed = [];
  const web = await startBoardWeb(
    store,
    (message, target) => { discussed.push({ message, target }); },
    () => ({ id: 'session-123', name: 'Test Session' }),
  );
  t.after(() => web.close());

  const homeRes = await fetch(web.url);
  assert.equal(homeRes.status, 200);
  assert.equal(homeRes.headers.get('x-frame-options'), 'DENY');
  assert.match(await homeRes.text(), /会话看板/);

  const cssRes = await fetch(`${web.url}board.css`);
  assert.equal(cssRes.status, 200);

  const snapRes = await fetch(`${web.url}api/snapshot`);
  assert.equal(snapRes.status, 200);
  const snap = await snapRes.json();
  assert.equal(snap.session.id, 'session-123');
  assert.equal(snap.items.length, 1);
  assert.equal(snap.decisions.length, 1);

  // Cross-origin request is rejected with 403
  const forbidden = await fetch(`${web.url}api/command`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example' },
    body: JSON.stringify({ op: 'read', decision: decision.id, revision: decision.revision }),
  });
  assert.equal(forbidden.status, 403);

  // Valid confirmation marks decision read
  const confirmRes = await fetch(`${web.url}api/command`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ op: 'read', decision: decision.id, revision: decision.revision }),
  });
  assert.equal(confirmRes.status, 200);
  const updated = await confirmRes.json();
  assert.equal(updated.decisions[0].read, true);

  // Valid discuss request forwards snapshot to callback
  const discussRes = await fetch(`${web.url}api/discuss`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ item }),
  });
  assert.equal(discussRes.status, 200);
  assert.equal(discussed.length, 1);
  assert.match(discussed[0].message, /Review design/);
});
