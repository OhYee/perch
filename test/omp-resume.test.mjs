import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../cli.mjs', import.meta.url));

test('two supervisors resume the same archived OMP chat using an offline RPC fixture', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-session-resume-'));
  const env = { HOME: dir, PATH: dir, XDG_STATE_HOME: dir, PI_CODING_AGENT_DIR: dir, LC_ALL: 'en_US.UTF-8' };
  try {
    await writeFile(join(dir, 'omp'), `#!${process.execPath}
const { randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { createInterface } = require('node:readline');
const args = process.argv.slice(2);
if (args[0] === 'collab') { console.log(JSON.stringify({ version: 1, hosts: [] })); process.exit(0); }
if (args[0] === 'session') { console.log(JSON.stringify({ held: [], unknown: [] })); process.exit(0); }
if (args[0] !== '--mode' || args[1] !== 'rpc' || args[2] !== '--session-dir') process.exit(1);
const resume = args.indexOf('--resume');
const file = resume < 0 ? join(args[3], 'session_' + randomUUID() + '.jsonl') : args[resume + 1];
const rows = resume < 0 ? [] : readFileSync(file, 'utf8').trim().split('\\n').map(JSON.parse);
const sessionId = resume < 0 ? file.match(/_([0-9a-f-]+)\\.jsonl$/)[1] : rows[0].id;
const messages = rows.filter(row => row.type === 'message').map(row => row.message);
const emit = value => console.log(JSON.stringify(value));
emit({ type: 'ready', protocolVersion: 1, supportedProtocolVersions: [1, 2] });
createInterface({ input: process.stdin }).on('line', line => {
  const req = JSON.parse(line);
  const data = req.type === 'negotiate_protocol' ? { protocolVersion: 2 }
    : req.type === 'get_state' ? { sessionId, sessionFile: file, messageCount: messages.length, isSettled: true }
    : req.type === 'get_messages' ? { messages } : undefined;
  emit({ type: 'response', id: req.id, command: req.type, success: data !== undefined, data });
});
`, { mode: 0o700 });
    await checkResume(dir, env);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('two supervisors resume the same archived OMP chat without duplicating or replaying it', { skip: !process.env.TEST_NATIVE_OMP }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-session-resume-'));
  try {
    await checkResume(dir, { ...process.env, XDG_STATE_HOME: dir });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

async function checkResume(dir, env) {
  const run = async (...args) => JSON.parse((await exec(process.execPath, [cli, ...args, '--json'], { env, timeout: 45000 })).stdout);
  let id;
  try {
    ({ id } = await run('start', 'omp', '--cwd', dir));
    await run('close', id);
    assert.deepEqual(await run('history', id), []);
    // Seed only our offline test journal: no provider prompt or external delivery.
    const root = join(dir, 'agent-session');
    const folder = join(root, (await readdir(root)).find(name => name.startsWith('omp-')));
    const journal = join(folder, (await readdir(folder)).find(name => name.endsWith('.jsonl')));
    const timestamp = new Date().toISOString();
    const entry = { type: 'message', id: 'aaaaaaaa', parentId: null, timestamp, message: { role: 'user', content: 'offline fixture', timestamp: Date.now() } };
    await appendFile(journal, JSON.stringify(entry) + '\n');
    const expected = [{ role: 'user', text: 'offline fixture' }];
    assert.deepEqual(await run('history', id), expected);
    const results = await Promise.all([run('resume', id), run('resume', id)]);
    assert.deepEqual(results.map(s => s.id), [id, id]);
    assert.equal((await run('list', '--provider', 'omp')).filter(s => s.id === id).length, 1);
    assert.deepEqual(await run('history', id), expected);
    await run('close', id);
    assert.deepEqual(await run('history', id), expected);
  } finally {
    if (id) await run('close', id).catch(() => {});
  }
}
