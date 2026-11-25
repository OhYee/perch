import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createNativeAdapter, macArgv, nativeReceiptDirectory, parseAgyTranscript } from '../adapters/agy-native.mjs';

const firstPid = 61401;
const secondPid = 61402;
const clue = pid => `agy:pid-${pid}`;
const uuids = ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'];
const transcriptPath = (home, uuid, app = 'antigravity', file = 'transcript.jsonl') =>
  join(home, '.gemini', app, 'brain', uuid, '.system_generated', 'logs', file);
const report = (f, uuid, title, extra = {}) => ({
  product: 'antigravity', version: '1.5.16', cwd: f.cwd,
  session_id: uuid, conversation_id: uuid, transcript_path: transcriptPath(f.home, uuid),
  conversation_title: title, agent_state: 'idle', pending_input_count: 0, tool_confirmation_pending: false,
  ...extra,
});
const hookPayload = (f, uuid, event, extra = {}) => ({
  conversationId: uuid,
  cwd: f.cwd,
  transcriptPath: transcriptPath(f.home, uuid, 'antigravity-cli', 'transcript_full.jsonl'),
  hookEventName: event,
  ...extra,
});

async function fixture(t) {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'perch-agy-native-')));
  const cwd = join(home, 'same work');
  const old = { HOME: process.env.HOME, XDG_STATE_HOME: process.env.XDG_STATE_HOME };
  let receipts;
  t.after(async () => {
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    if (receipts) await rm(receipts, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });
  await mkdir(cwd);
  Object.assign(process.env, { HOME: home, XDG_STATE_HOME: join(home, 'state') });
  receipts = nativeReceiptDirectory();
  const executable = join(home, 'agy');
  const proc = (pid, extra = {}) => ({
    pid, ppid: 1, tty: `pts/${pid - firstPid + 7}`, argv: [executable], birth: `fixture-boot:${pid}`, cwd, isAgy: true, ...extra,
  });
  const rows = new Map();
  const queries = [];
  const beforeInspection = new Map();
  let source;
  let hookSource;
  const sent = [];
  let sendHandler;
  const api = createNativeAdapter({
    // 这里替换 OS 观察，不复制生产绑定或 transcript 校验的逻辑。
    async inspectProcesses(pid) {
      queries.push(pid);
      const before = beforeInspection.get(pid);
      if (before) {
        beforeInspection.delete(pid);
        await before();
      }
      return pid === undefined ? [...rows.values()] : [...rows.values()].filter(p => p.pid === pid);
    },
    async inspectStatusSource() { return source; },
    async inspectHookSource() { return hookSource; },
    async sendInput(request) {
      await request.confirm?.();
      sent.push({ pid: request.pid, mode: request.mode, text: request.text, enter: request.enter, lang: request.lang });
      if (sendHandler) return await sendHandler(request);
    },
    confirmTurnMs: 40,
  });
  return {
    api, proc, rows, home, cwd, executable, queries, receipts, sent,
    onSendInput(fn) { sendHandler = fn; },
    beforeNextInspection(pid, fn) { beforeInspection.set(pid, fn); },
    async publish(pid, payload) {
      source = pid;
      try { return await api.recordNativeStatus(payload); }
      finally { source = undefined; }
    },
    async publishHook(pid, payload) {
      hookSource = pid;
      try { return await api.recordNativeHook(payload); }
      finally { hookSource = undefined; }
    },
  };
}

function assertClue(row, pid, cwd) {
  assert.equal(row.id, clue(pid));
  assert.equal(row.pid, pid);
  assert.equal(row.cwd, cwd);
  assert.equal(row.kind, 'process');
  assert.equal(row.title, null);
  assert.equal(row.status, 'unknown');
  assert.equal(row.send, false);
  assert.equal(row.history, false);
  assert.equal(row.wait, false);
  assert.equal(row.close, false);
}

test('AGY keeps same-directory interactive TUI clues separate and ignores noninteractive or false identities', async t => {
  const f = await fixture(t);
  const initial = 'fixture-initial-prompt-not-a-title';
  f.rows.set(firstPid, f.proc(firstPid, { argv: [f.executable, `--prompt-interactive=${initial}`] }));
  f.rows.set(secondPid, f.proc(secondPid));
  const excluded = [
    { argv: [f.executable, 'acp'] },
    { argv: [f.executable, 'worker'] },
    { argv: [f.executable, '-p', 'query'] },
    { argv: [f.executable, '--print=query'] },
    { argv: [f.executable, '--prompt', 'query'] },
    { argv: [f.executable, '--remote-control'] },
    { argv: [f.executable, '--version'] },
    { argv: [f.executable, '--help'] },
    { argv: [f.executable, '--model'] },
    { isAgy: false, argv: [f.executable, '--model', 'fixture'] },
    { tty: '?' },
    { birth: '' },
  ];
  excluded.forEach((extra, i) => f.rows.set(secondPid + 10 + i, f.proc(secondPid + 10 + i, extra)));
  const rows = await f.api.listNative();
  assert.deepEqual(rows.map(row => row.pid), [firstPid, secondPid]);
  for (const row of rows) assertClue(row, row.pid, f.cwd);
  assert.ok(!JSON.stringify(rows).includes(initial));
});

test('AGY macOS flattened argv rejects ambiguous prompt or path values for both discovery and callbacks', async t => {
  const f = await fixture(t);
  const executable = join(f.home, 'AGY install', 'agy');
  const names = [executable, 'agy'];
  const ambiguous = [
    `${executable} --prompt-interactive=Summarize this repo`,
    `${executable} -i Summarize this repo`,
    `${executable} --settings /synthetic/with spaces/settings.json`,
    `${executable} --log-file=/synthetic/with spaces/agy.log`,
    `${executable} --prompt-interactive=summary --print`,
  ];
  f.rows.set(firstPid, f.proc(firstPid, { argv: macArgv(`${executable} --prompt-interactive=Summary`, names) }));
  for (const [i, args] of ambiguous.entries()) {
    const pid = secondPid + i;
    f.rows.set(pid, f.proc(pid, { argv: macArgv(args, names) }));
    await assert.rejects(f.publish(pid, report(f, uuids[0], 'Ambiguous')), /callback refused/i);
  }
  const rows = await f.api.listNative();
  assert.equal(rows.length, 1);
  assertClue(rows[0], firstPid, f.cwd);
  await assert.rejects(lstat(f.receipts), { code: 'ENOENT' });
  assert.equal(await f.publish(firstPid, report(f, uuids[0], 'Unambiguous')), 'Perch: AGY conversation observed');
});

test('AGY targeted clue lookup does not infer a conversation from a PID and drops exited processes', async t => {
  const f = await fixture(t);
  f.rows.set(firstPid, f.proc(firstPid));
  f.rows.set(secondPid, f.proc(secondPid));
  assertClue(await f.api.lookupNative(clue(firstPid)), firstPid, f.cwd);
  assert.ok(f.queries.length > 0 && f.queries.every(pid => pid === firstPid));
  f.rows.delete(firstPid);
  assert.equal(await f.api.lookupNative(clue(firstPid)), undefined);
  assertClue(await f.api.lookupNative(clue(secondPid)), secondPid, f.cwd);
  f.rows.set(firstPid, f.proc(firstPid, { tty: 'pts/19', birth: 'fixture-reused-pid' }));
  assertClue(await f.api.lookupNative(clue(firstPid)), firstPid, f.cwd);
  assert.equal(await f.api.lookupNative('agy:native-invalid'), undefined);
});

test('AGY ignores archived transcripts and cannot bind a live TUI from a self-reported status line', async t => {
  const f = await fixture(t);
  const uuid = uuids[0];
  const transcript = transcriptPath(f.home, uuid);
  const hidden = 'fixture-archived-transcript-not-a-live-message';
  await mkdir(dirname(transcript), { recursive: true });
  await writeFile(transcript, `${JSON.stringify({ role: 'assistant', text: hidden })}\n`);
  assert.deepEqual(await f.api.listNative(), []);
  const before = (await readdir(f.home, { recursive: true })).sort();

  f.rows.set(firstPid, f.proc(firstPid, { argv: [f.executable, '--conversation', uuid] }));
  f.rows.set(secondPid, f.proc(secondPid));
  const forged = report(f, uuid, hidden, { pid: firstPid });
  await assert.rejects(async () => f.api.recordNativeStatus(forged), error => {
    assert.match(error.message, /callback refused/i);
    assert.ok(!error.message.includes(hidden) && !error.message.includes(transcript));
    return true;
  });
  for (const row of await f.api.listNative()) assertClue(row, row.pid, f.cwd);
  assert.deepEqual((await readdir(f.home, { recursive: true })).sort(), before);
  await assert.rejects(lstat(f.receipts), { code: 'ENOENT' });
  assert.equal(await f.api.lookupNative(`agy:native-fixture-${uuid}`), undefined);
  const row = await f.api.lookupNative(clue(firstPid));
  await assert.rejects(async () => f.api.historyNative(row, 20), /transcript|history/i);
  for (const action of [
    { mode: 'text', text: 'fixture text', enter: false },
    { mode: 'text', text: 'fixture text', enter: true },
    { mode: 'key', text: 'Enter', enter: false },
    { mode: 'key', text: 'Escape', enter: false },
  ]) await assert.rejects(async () => f.api.confirmNativeTui(row, action), /cannot|unavailable|could not/i);
  f.rows.delete(firstPid);
  assert.equal(await f.api.lookupNative(clue(firstPid)), undefined);
  assertClue(await f.api.lookupNative(clue(secondPid)), secondPid, f.cwd);
});

// 状态行没有闲置心跳；测试仅在对应查询期间注入新的合成报告。
async function duringReports(f, query, reports) {
  const result = query();
  const publishing = (async () => {
    await sleep(25);
    for (const [pid, payload] of reports) await f.publish(pid, payload);
  })();
  return (await Promise.all([result, publishing]))[0];
}

function assertBound(row, pid, uuid, title) {
  assert.match(row.id, /^agy:native-/);
  assert.ok(row.id.endsWith(`-${uuid}`));
  assert.equal(row.pid, pid);
  assert.equal(row.kind, 'session');
  assert.equal(row.title, title);
  assert.equal(row.status, 'idle');
  assert.deepEqual([row.send, row.history, row.wait, row.close], [false, false, false, false]);
}

function advanceReportClock(t) {
  // 用单调推进的测试时间控制报告和查询时序，不依赖 sleep 或文件 mtime 粒度。
  let now = Date.now() - 60_000;
  t.mock.method(Date, 'now', () => now);
  return () => { now += 10; };
}

test('AGY counts a report written during the first process inspection as fresh', async t => {
  const f = await fixture(t);
  const advance = advanceReportClock(t);
  const uuid = uuids[0];
  f.rows.set(firstPid, f.proc(firstPid));
  await f.publish(firstPid, report(f, uuid, 'Before query'));

  f.beforeNextInspection(undefined, async () => {
    advance();
    await f.publish(firstPid, report(f, uuid, 'During list inspection'));
  });
  const [listed] = await f.api.listNative();
  assertBound(listed, firstPid, uuid, 'During list inspection');

  f.beforeNextInspection(firstPid, async () => {
    advance();
    await f.publish(firstPid, report(f, uuid, 'During targeted inspection'));
  });
  const found = await f.api.lookupNative(listed.id);
  assertBound(found, firstPid, uuid, 'During targeted inspection');
  assert.equal(found.id, listed.id);

  // 下一次查询的开始时间等于上一份报告；旧报告不能重新授权绑定。
  assert.equal(await f.api.lookupNative(listed.id), undefined);
});

test('AGY targeted lookup accepts a later report only for the same conversation and live generation', async t => {
  const f = await fixture(t);
  const advance = advanceReportClock(t);
  const [uuid, switched] = uuids;
  f.rows.set(firstPid, f.proc(firstPid));
  f.rows.set(secondPid, f.proc(secondPid));
  await f.publish(firstPid, report(f, uuid, 'Seed target'));
  await f.publish(secondPid, report(f, uuid, 'Other claimant'));
  const { generation } = JSON.parse(await readFile(join(f.receipts, `pid-${firstPid}.json`), 'utf8'));
  const id = `agy:native-${firstPid}.${generation}-${uuid}`;

  const publish = async (conversation, title) => {
    advance();
    await f.publish(firstPid, report(f, conversation, title));
  };
  const lookupWithRefresh = payload => {
    f.beforeNextInspection(firstPid, async () => {
      await publish(uuid, 'During the initial inspection');
      f.beforeNextInspection(firstPid, () => publish(uuid, 'During revalidation'));
    });
    // 精确复核残留的重复声明时，另一个状态行回调恰好更新目标收据。
    f.beforeNextInspection(secondPid, payload);
    return f.api.lookupNative(id);
  };
  assert.equal(await lookupWithRefresh(() => publish(uuid, 'During live duplicate check')), undefined);
  f.rows.delete(secondPid);
  const latest = await lookupWithRefresh(() => publish(uuid, 'During duplicate check'));
  assertBound(latest, firstPid, uuid, 'During duplicate check');
  assert.equal(latest.id, id);
  assert.equal(await lookupWithRefresh(() => publish(switched, 'Switched during duplicate check')), undefined);
  assert.equal(await lookupWithRefresh(async () => {
    f.rows.set(firstPid, f.proc(firstPid, { birth: 'reused during duplicate check' }));
    await publish(uuid, 'Same conversation, different process generation');
  }), undefined);
});

test('AGY fresh verified reports bind same-cwd twins independently but do not grant history or input', async t => {
  const f = await fixture(t);
  f.rows.set(firstPid, f.proc(firstPid));
  f.rows.set(secondPid, f.proc(secondPid));
  const [first, second] = uuids;
  const privateField = 'fixture-quota-and-identity-must-not-persist';
  const reports = [
    [firstPid, report(f, first, 'First conversation', { user_email: privateField, quota: { token: privateField } })],
    [secondPid, report(f, second, 'Second conversation')],
  ];
  for (const [pid, payload] of reports) {
    const rendered = await f.publish(pid, payload);
    assert.equal(typeof rendered, 'string');
    assert.ok(!rendered.includes('\n') && !rendered.includes(privateField));
  }
  const listed = await duringReports(f, () => f.api.listNative(), reports);
  assert.equal(listed.length, 2);
  const registry = await lstat(f.receipts);
  assert.equal(registry.isDirectory(), true);
  assert.equal(registry.mode & 0o777, 0o700);
  assert.equal(registry.uid, process.getuid());
  for (const pid of [firstPid, secondPid]) {
    const path = join(f.receipts, `pid-${pid}.json`);
    const file = await lstat(path);
    assert.equal(file.isFile(), true);
    assert.equal(file.mode & 0o777, 0o600);
    assert.equal(file.uid, process.getuid());
    assert.ok(!(await readFile(path, 'utf8')).includes(privateField));
  }
  const a = listed.find(row => row.pid === firstPid);
  const b = listed.find(row => row.pid === secondPid);
  assertBound(a, firstPid, first, 'First conversation');
  assertBound(b, secondPid, second, 'Second conversation');
  assert.notEqual(a.id, b.id);
  assert.ok(!JSON.stringify(listed).includes(privateField));
  const target = await duringReports(f, () => f.api.lookupNative(a.id), reports);
  assert.equal(target.id, a.id);
  await assert.rejects(async () => f.api.historyNative(target, 20), /transcript|history/i);
  for (const action of [
    { mode: 'text', text: 'text', enter: false },
    { mode: 'text', text: 'text', enter: true },
    { mode: 'key', text: 'Enter', enter: false },
    { mode: 'key', text: 'Escape', enter: false },
  ]) {
    await assert.rejects(async () => f.api.confirmNativeTui(target, action), /status line|editor|unavailable/i);
  }
  const stale = await f.api.listNative();
  assert.deepEqual(stale.map(row => row.id).sort(), [clue(firstPid), clue(secondPid)]);
  assert.equal(await f.api.lookupNative(a.id), undefined);
});

test('AGY old conversation and process-generation handles never survive a switch, duplicate claim, or PID reuse', async t => {
  const f = await fixture(t);
  const [first, second, switched] = uuids;
  f.rows.set(firstPid, f.proc(firstPid));
  f.rows.set(secondPid, f.proc(secondPid));
  const firstStatus = report(f, first, 'Before switch');
  const secondStatus = report(f, second, 'Other terminal');
  const switchedStatus = report(f, switched, 'After switch');
  await f.publish(firstPid, firstStatus);
  await f.publish(secondPid, secondStatus);
  const findFirst = async () => (await f.api.listNative()).find(row => row.pid === firstPid);
  const before = await duringReports(f, findFirst, [[firstPid, firstStatus], [secondPid, secondStatus]]);
  assertBound(before, firstPid, first, 'Before switch');

  await f.publish(firstPid, switchedStatus);
  const after = await duringReports(f, findFirst, [[firstPid, switchedStatus], [secondPid, secondStatus]]);
  assertBound(after, firstPid, switched, 'After switch');
  assert.notEqual(after.id, before.id);
  assert.equal(await duringReports(f, () => f.api.lookupNative(before.id), [[firstPid, switchedStatus]]), undefined);

  const duplicate = [[firstPid, switchedStatus], [secondPid, switchedStatus]];
  await f.publish(secondPid, switchedStatus);
  const conflicting = await duringReports(f, () => f.api.listNative(), duplicate);
  assert.deepEqual(conflicting.map(row => row.id).sort(), [clue(firstPid), clue(secondPid)]);
  assert.equal(await duringReports(f, () => f.api.lookupNative(after.id), duplicate), undefined);

  f.rows.delete(secondPid);
  f.rows.set(firstPid, f.proc(firstPid, { birth: 'different-process-generation', tty: 'pts/43' }));
  assert.equal(await f.api.lookupNative(after.id), undefined);
  assertClue(await f.api.lookupNative(clue(firstPid)), firstPid, f.cwd);
  await f.publish(firstPid, switchedStatus);
  const reused = await duringReports(f, findFirst, [[firstPid, switchedStatus]]);
  assertBound(reused, firstPid, switched, 'After switch');
  assert.notEqual(reused.id, after.id);
  assert.equal(await duringReports(f, () => f.api.lookupNative(after.id), [[firstPid, switchedStatus]]), undefined);
  assert.equal(await f.api.lookupNative(clue(secondPid)), undefined);
});

test('AGY rejects malformed verified reports instead of binding their conversation or transcript paths', async t => {
  const f = await fixture(t);
  f.rows.set(firstPid, f.proc(firstPid));
  const [first, other] = uuids;
  const location = join(f.receipts, `pid-${firstPid}.json`);
  for (const fields of [
    { conversation_id: '' }, { session_id: other }, { cwd: dirname(f.cwd) },
    { transcript_path: transcriptPath(f.home, other) }, { transcript_path: join(f.home, 'untrusted.jsonl') },
    { version: 'unknown' }, { product: 'other' },
  ]) {
    await f.publish(firstPid, report(f, first, 'Initially verified'));
    const previous = await readFile(location, 'utf8');
    await f.publish(firstPid, report(f, first, 'Must not bind', fields)).catch(error => {
      assert.doesNotMatch(error.message, /Must not bind|untrusted\.jsonl/);
    });
    const invalidated = await readFile(location, 'utf8').catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
    assert.notEqual(invalidated, previous);
    assert.ok(!String(invalidated).includes('Must not bind'));
    const [row] = await f.api.listNative();
    assertClue(row, firstPid, f.cwd);
  }
});

test('AGY does not follow a substituted receipt symlink when refreshing a native report', async t => {
  const f = await fixture(t);
  f.rows.set(firstPid, f.proc(firstPid));
  const payload = report(f, uuids[0], 'Existing binding');
  await f.publish(firstPid, payload);
  const path = join(f.receipts, `pid-${firstPid}.json`);
  const target = join(f.home, 'external-receipt');
  const before = await readFile(path, 'utf8');
  await writeFile(target, before, { mode: 0o600 });
  await unlink(path);
  await symlink(target, path);
  await assert.rejects(f.publish(firstPid, { ...payload, conversation_title: 'No overwrite' }), /storage|register|receipt/i);
  assert.equal(await readFile(target, 'utf8'), before);
  assert.equal((await lstat(path)).isSymbolicLink(), true);
  const [row] = await f.api.listNative();
  assertClue(row, firstPid, f.cwd);
});

test('parseAgyTranscript extracts explicit user requests and visible assistant responses only', () => {
  const raw = [
    JSON.stringify({
      type: 'USER_INPUT',
      source: 'USER_EXPLICIT',
      content: '<USER_REQUEST>\nHello AGY\nSecond line\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\ntime\n</ADDITIONAL_METADATA>',
    }),
    JSON.stringify({ type: 'PLANNER_RESPONSE', thinking: 'internal thought', tool_calls: [{ name: 'run_command' }] }),
    JSON.stringify({ type: 'GENERIC', content: 'tool stdout should be skipped' }),
    JSON.stringify({ type: 'SYSTEM_MESSAGE', content: 'system log should be skipped' }),
    JSON.stringify({ type: 'PLANNER_RESPONSE', content: 'Done! Here is the answer.' }),
    JSON.stringify({ type: 'USER_INPUT', source: 'USER_EXPLICIT', content: 'Plain follow-up' }),
    'not valid json',
    JSON.stringify({ type: 'PLANNER_RESPONSE', content: 'Second reply' }),
  ].join('\n');
  assert.deepEqual(parseAgyTranscript(raw, Infinity), [
    { role: 'user', text: 'Hello AGY\nSecond line' },
    { role: 'assistant', text: 'Done! Here is the answer.' },
    { role: 'user', text: 'Plain follow-up' },
    { role: 'assistant', text: 'Second reply' },
  ]);
  assert.deepEqual(parseAgyTranscript(raw, 2), [
    { role: 'user', text: 'Plain follow-up' },
    { role: 'assistant', text: 'Second reply' },
  ]);
});

test('AGY hook plugin binds idle native TUI sessions including --dangerously-skip-permissions, reads transcript history, and waits', async t => {
  const f = await fixture(t);
  const uuid = uuids[0];
  f.rows.set(firstPid, f.proc(firstPid, { argv: [f.executable, '--dangerously-skip-permissions', '--model', 'gemini-4-neon'] }));

  // Forged hook without verified parent process must be refused
  await assert.rejects(() => f.api.recordNativeHook(hookPayload(f, uuid, 'SessionStart')), /hook callback refused/i);

  // SessionStart binds the session persistently across idle periods
  const started = await f.publishHook(firstPid, hookPayload(f, uuid, 'SessionStart'));
  assert.deepEqual(started, { conversation: uuid, status: 'idle' });

  const [listed] = await f.api.listNative();
  assert.equal(listed.kind, 'session');
  assert.equal(listed.pid, firstPid);
  assert.equal(listed.status, 'idle');
  assert.equal(listed.history, true);
  assert.equal(listed.historyMode, 'persisted');
  assert.equal(listed.wait, true);
  assert.equal(listed.send, true);
  assert.equal(listed.sendReason, undefined);
  assert.ok(listed.id.endsWith(`-${uuid}`));

  // Before transcript exists on disk, history returns []
  assert.deepEqual(await f.api.historyNative(listed, 20), []);

  // Write transcript_full.jsonl and verify history reads visible messages
  const path = transcriptPath(f.home, uuid, 'antigravity-cli', 'transcript_full.jsonl');
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, [
    JSON.stringify({ type: 'USER_INPUT', source: 'USER_EXPLICIT', content: '<USER_REQUEST>\nCheck repo\n</USER_REQUEST>' }),
    JSON.stringify({ type: 'PLANNER_RESPONSE', content: 'Repo looks good.' }),
  ].join('\n') + '\n', { mode: 0o600 });
  assert.deepEqual(await f.api.historyNative(listed, 10), [
    { role: 'user', text: 'Check repo' },
    { role: 'assistant', text: 'Repo looks good.' },
  ]);

  // SessionStart with lastUserInput immediately marks running (prevents premature wait completion)
  const withPrompt = await f.publishHook(firstPid, hookPayload(f, uuid, 'SessionStart', { lastUserInput: 'Initial task' }));
  assert.deepEqual(withPrompt, { conversation: uuid, status: 'running' });
  assert.deepEqual(await f.api.waitNative(listed, 0), { status: 'timeout' });

  // PreInvocation marks running and increments turnSeq; waitNative times out on 0ms, then completes on Stop
  await f.publishHook(firstPid, hookPayload(f, uuid, 'PreInvocation', { invocationNum: 1 }));
  const running = await f.api.lookupNative(listed.id);
  assert.equal(running.status, 'running');
  assert.equal(running._turnSeq, 1);
  assert.deepEqual(await f.api.waitNative(running, 0), { status: 'timeout' });

  const waiting = f.api.waitNative(running, 3000);
  await sleep(30);
  await f.publishHook(firstPid, hookPayload(f, uuid, 'Stop', { fullyIdle: false }));
  await sleep(30);
  await f.publishHook(firstPid, hookPayload(f, uuid, 'Stop', { fullyIdle: true }));
  assert.deepEqual(await waiting, { status: 'completed' });

  // Process exit causes waitNative to return interrupted
  await f.publishHook(firstPid, hookPayload(f, uuid, 'PreInvocation', { invocationNum: 2 }));
  const runningAgain = await f.api.lookupNative(listed.id);
  const interrupted = f.api.waitNative(runningAgain, 3000);
  await sleep(30);
  f.rows.delete(firstPid);
  const result = await interrupted;
  assert.equal(result.status, 'interrupted');
});

test('AGY hook rejects untrusted transcript paths and mismatched cwd', async t => {
  const f = await fixture(t);
  const [first, other] = uuids;
  f.rows.set(firstPid, f.proc(firstPid));
  for (const extra of [
    { transcriptPath: transcriptPath(f.home, other, 'antigravity-cli') },
    { transcriptPath: join(f.home, 'untrusted.jsonl') },
    { cwd: dirname(f.cwd) },
    { hookEventName: 'UnknownEvent' },
  ]) {
    await f.publishHook(firstPid, hookPayload(f, first, 'SessionStart'));
    const invalid = await f.publishHook(firstPid, hookPayload(f, first, 'PreInvocation', extra));
    assert.deepEqual(invalid, { conversation: null, status: 'unknown' });
    const [row] = await f.api.listNative();
    assertClue(row, firstPid, f.cwd);
  }
});

test('AGY hook-backed native sessions support confirmNativeTui and sendNative for short and multiline prompts', async t => {
  const f = await fixture(t);
  const uuid = uuids[0];
  f.rows.set(firstPid, f.proc(firstPid));
  await f.publishHook(firstPid, hookPayload(f, uuid, 'SessionStart'));
  const [session] = await f.api.listNative();

  // Idle hook session confirms safely for text + enter
  const confirmed = await f.api.confirmNativeTui(session, { mode: 'text', text: 'hello', enter: true });
  assert.equal(confirmed.id, session.id);

  // Short single-line send injects directly and detects PreInvocation
  f.onSendInput(async () => {
    await f.publishHook(firstPid, hookPayload(f, uuid, 'PreInvocation', { invocationNum: 1 }));
  });
  await f.api.sendNative(session, 'Summarize git status', { lang: 'zh' });
  assert.deepEqual(f.sent.at(-1), { pid: firstPid, mode: 'text', text: 'Summarize git status', enter: true, lang: 'zh' });

  // While running, enter and sendNative are rejected before terminal delivery
  await assert.rejects(() => f.api.confirmNativeTui(session, { mode: 'text', text: 'x', enter: true }), /busy or blocked/i);
  await assert.rejects(() => f.api.sendNative(session, 'Another prompt'), /busy/i);
  // Key without enter (e.g. Escape) is still allowed during running
  await f.api.confirmNativeTui(session, { mode: 'key', text: 'Escape', enter: false });

  // After Stop(fullyIdle: true), multiline prompt stages a private 0600 file and sends single-line reference
  await f.publishHook(firstPid, hookPayload(f, uuid, 'Stop', { fullyIdle: true }));
  f.onSendInput(null);
  const multiline = 'Line 1\nLine 2\nCheck all tests';
  await f.api.sendNative(session, multiline);
  const last = f.sent.at(-1);
  assert.equal(last.enter, true);
  const match = /^Read and follow the complete instructions in (.+)$/.exec(last.text);
  assert.ok(match, `expected staged file instruction, got: ${last.text}`);
  const stagedPath = match[1];
  const stagedStat = await lstat(stagedPath);
  assert.equal(stagedStat.isFile(), true);
  assert.equal(stagedStat.mode & 0o777, 0o600);
  assert.equal(await readFile(stagedPath, 'utf8'), multiline);

  // Partial terminal failure propagates deliveryUnknown
  f.onSendInput(async () => {
    const err = new Error('partial write');
    err.deliveryUnknown = true;
    throw err;
  });
  await assert.rejects(() => f.api.sendNative(session, 'Check again'), err => err.deliveryUnknown === true);
});
