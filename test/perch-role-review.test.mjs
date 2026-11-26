import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import extension from '../omp-extension.ts';
import { loadPerchConfig } from '../perch-config.ts';

async function until(check, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await sleep(20);
  }
  assert.fail('Timed out waiting for condition');
}

test('perch.roles.<name>.reviewMode parses turn and agent-end and ignores invalid values', async t => {
  const root = await mkdtemp(join(tmpdir(), 'perch-review-config-'));
  const home = join(root, 'home');
  await mkdir(join(home, '.omp', 'agent'), { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(home, '.omp', 'agent', 'config.yml'), `
perch:
  roles:
    a:
      provider: omp
      reviewMode: agent-end
      reviewMinChars: 500
    b:
      provider: omp
      reviewMode: turn
    c:
      provider: omp
      reviewMode: sometimes
      reviewMinChars: -3
`);
  const cfg = loadPerchConfig({ cwd: root, env: { HOME: home } });
  assert.equal(cfg.roles.a.reviewMode, 'agent-end');
  assert.equal(cfg.roles.a.reviewMinChars, 500);
  assert.equal(cfg.roles.b.reviewMode, 'turn');
  assert.equal(cfg.roles.c.reviewMode, undefined);
  assert.equal(cfg.roles.c.reviewMinChars, undefined);
});

test('a role with reviewMode reviews the director reply, pushes suggestions once, and stays silent on OK', async t => {
  const root = await mkdtemp(join(tmpdir(), 'perch-review-run-'));
  const home = join(root, 'home');
  const cwd = join(root, 'work');
  const bin = join(root, 'bin');
  const log = join(root, 'perch.jsonl');
  const replyFile = join(root, 'reply.txt');
  await Promise.all([mkdir(join(home, '.omp', 'agent'), { recursive: true }), mkdir(cwd, { recursive: true }), mkdir(bin, { recursive: true })]);
  await writeFile(replyFile, 'Use headings and a table.');
  await writeFile(join(home, '.omp', 'agent', 'config.yml'), `
perch:
  default: true
  heartbeatSeconds: 0
  roles:
    readability:
      provider: omp
      model: cheap/model
      capabilities: readability of replies
      reviewMode: agent-end
      reviewMinChars: 20
`);

  const fakePerch = join(bin, 'fake-perch');
  await writeFile(fakePerch, `#!${process.execPath}
const { appendFileSync, readFileSync } = require('node:fs');
const args = process.argv.slice(2);
const chunks = [];
process.stdin.on('data', c => chunks.push(c));
process.stdin.on('end', () => {
  appendFileSync(process.env.MOCK_LOG, JSON.stringify({ args, stdin: Buffer.concat(chunks).toString('utf8') }) + '\\n');
  if (args[0] === 'start') console.log(JSON.stringify({ id: 'omp:cccccccc-cccc-4ccc-8ccc-cccccccccccc', provider: 'omp' }));
  else if (args[0] === 'send') console.log(JSON.stringify({ accepted: true }));
  else if (args[0] === 'wait') console.log(JSON.stringify({ id: args[1], status: 'completed' }));
  else if (args[0] === 'history') console.log(JSON.stringify([{ role: 'assistant', text: readFileSync(process.env.MOCK_REPLY, 'utf8') }]));
  else if (args[0] === 'list') console.log('[]');
  else console.log(JSON.stringify({ id: args[1], closed: true }));
});
`, { mode: 0o755 });
  await chmod(fakePerch, 0o755);

  const prev = { HOME: process.env.HOME, PERCH_BIN: process.env.PERCH_BIN, MOCK_LOG: process.env.MOCK_LOG, MOCK_REPLY: process.env.MOCK_REPLY };
  const handlers = new Map();
  const sent = [];
  const ctx = {
    mode: 'tui',
    cwd,
    agent: { kind: 'main', id: 'main' },
    sessionModes: { getState: () => ({ vibe: { status: 'inactive' } }) },
    isIdle: () => true,
    hasPendingMessages: () => false,
    sessionManager: { getSessionId: () => 'review-main', getSessionFile: () => undefined, getBranch: () => [], getEntries: () => [] },
    hasUI: true,
    ui: { notify() {}, setStatus() {} },
  };
  t.after(async () => {
    await handlers.get('session_shutdown')?.({}, ctx).catch(() => {});
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await rm(root, { recursive: true, force: true });
  });
  process.env.HOME = home;
  process.env.PERCH_BIN = fakePerch;
  process.env.MOCK_LOG = log;
  process.env.MOCK_REPLY = replyFile;

  extension({
    arktype: s => s,
    on: (ev, fn) => handlers.set(ev, fn),
    registerCommand() {},
    registerTool() {},
    getSessionName: () => 'Director',
    getActiveTools: () => ['perch', 'board', 'read', 'bash'],
    setActiveTools: async () => {},
    appendEntry() {},
    sendMessage: (message, options) => sent.push({ message, options }),
    sendUserMessage: async () => {},
  });
  await handlers.get('session_start')({}, ctx);

  const calls = async () => (await readFile(log, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(JSON.parse);
  const finishRun = async text => {
    await handlers.get('before_agent_start')({ reason: 'prompt', prompt: 'summarize the incident', systemPrompt: ['BASE'] }, ctx);
    handlers.get('message_end')({ message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text }] } }, ctx);
    await handlers.get('agent_end')({}, ctx);
  };

  // 1. Too short for reviewMinChars: no review
  await finishRun('short');
  await sleep(150);
  assert.equal((await calls()).length, 0);

  // 2. Long reply: reviewer is started with the role provider/model, sees user request and reply, suggestions are pushed
  const longReply = 'The incident began at 09:00 and affected three services; here is the long unstructured explanation.';
  await finishRun(longReply);
  await until(() => sent.some(s => s.message.customType === 'perch-review-note'));
  const note = sent.find(s => s.message.customType === 'perch-review-note');
  assert.deepEqual(note.options, { triggerTurn: true, deliverAs: 'followUp' });
  assert.match(note.message.content, /\[Perch review: readability\] \(agent-end\)/);
  assert.match(note.message.content, /Use headings and a table\./);
  const first = await calls();
  const start = first.find(c => c.args[0] === 'start');
  assert.deepEqual(start.args.slice(0, 2), ['start', 'omp']);
  assert.ok(start.args.includes('--model') && start.args.includes('cheap/model'));
  const send = first.find(c => c.args[0] === 'send');
  assert.match(send.stdin, /summarize the incident/);
  assert.match(send.stdin, /long unstructured explanation/);
  assert.match(send.stdin, /readability of replies/);

  // 3. The revision that answers the review note is not reviewed again
  const sendsBefore = first.filter(c => c.args[0] === 'send').length;
  await finishRun('Revised: the incident began at 09:00 and affected three services (table follows).');
  await sleep(200);
  assert.equal((await calls()).filter(c => c.args[0] === 'send').length, sendsBefore);

  // 4. A later reply is reviewed again by the same session; an OK verdict stays silent
  await writeFile(replyFile, 'OK');
  const notesBefore = sent.filter(s => s.message.customType === 'perch-review-note').length;
  await finishRun('A different, sufficiently long reply that is already well structured and clear.');
  await until(async () => (await calls()).filter(c => c.args[0] === 'send').length === sendsBefore + 1);
  await sleep(150);
  assert.equal(sent.filter(s => s.message.customType === 'perch-review-note').length, notesBefore);
  assert.equal((await calls()).filter(c => c.args[0] === 'start').length, 1, 'the reviewer session is reused');
});
