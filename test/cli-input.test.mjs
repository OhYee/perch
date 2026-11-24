import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../cli.mjs', import.meta.url));
const id = 'omp:123:00000000000000000000000000000000';
const agyManaged = 'agy:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const agyNative = 'agy:native-fixture-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const agyProcess = 'agy:pid-357';

// Substitute the provider and terminal transport, so these CLI tests never inspect
// or send input to a user's running sessions.
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-session-cli-input-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, 'calls');
  const loader = join(dir, 'loader.mjs');
  const adapter = `
    import { appendFileSync } from 'node:fs';
    const record = value => appendFileSync(process.env.CALL_LOG, JSON.stringify(value) + '\\n');
    export async function lookupBridge(id) {
      record(['lookup', id]);
      return { id, provider: 'omp', pid: 123, send: true };
    }
    export async function confirmNativeTui() {
      record(['confirm']);
      return { status: process.env.SESSION_STATUS || 'idle' };
    }
    export async function send(session, text) {
      record(['send', text]);
      if (process.env.SEND_UNKNOWN) { const e = Error('unknown'); e.deliveryUnknown = true; throw e; }
    }
  `;
  const agy = `
    import { appendFileSync } from 'node:fs';
    const record = value => appendFileSync(process.env.CALL_LOG, JSON.stringify(value) + '\\n');
    const [managed, native, processHint] = ${JSON.stringify([agyManaged, agyNative, agyProcess])};
    function row(id) {
      const mode = id === managed ? 'managed' : id === native ? 'native' : 'process';
      return { id, provider: 'agy', _agy: mode, _fixture: 'hidden-value',
        pid: mode === 'process' ? 357 : 123, kind: mode === 'process' ? 'process' : 'session',
        status: mode === 'process' ? 'unknown' : 'idle', title: null, cwd: null,
        send: mode === 'managed', wait: mode === 'managed', close: mode === 'managed', history: mode === 'managed',
        historyMode: mode === 'managed' ? 'live' : undefined };
    }
    export async function list() { record(['agy:list']); return [managed, native, processHint].map(row); }
    export async function lookupBridge(id) { record(['agy:bridge', id]); return id === managed ? row(id) : null; }
    export async function lookupNative(id) { record(['agy:native', id]); return [native, processHint].includes(id) ? row(id) : null; }
    export async function send(session, text) { record(['agy:send', session.id, text]); }
    export async function history(session) { record(['agy:history', session.id]); }
    export async function confirmNativeTui(session, action) {
      record(['agy:confirm', session.id, action]);
      throw Error('AGY native input is unavailable: the status line does not prove the editor can accept input safely');
    }
    export async function recordNativeStatus(report) { record(['agy:status', report]); return 'AGY fixture'; }
  `;
  const terminal = `
    import { appendFileSync } from 'node:fs';
    export { supportedTerminalKeys } from ${JSON.stringify(new URL('../terminal-input.mjs', import.meta.url).href)};
    export async function sendTerminalInput({ pid, mode, text, enter, confirm }) {
      await confirm();
      appendFileSync(process.env.CALL_LOG, JSON.stringify(['terminal', pid, mode, text, enter]) + '\\n');
      if (process.env.INPUT_UNKNOWN) { const e = Error('unknown'); e.deliveryUnknown = true; throw e; }
    }
  `;
  writeFileSync(loader, `
    const modules = {
      './adapters/omp.mjs': ${JSON.stringify(adapter)},
      './adapters/agy.mjs': ${JSON.stringify(agy)},
      './terminal-input.mjs': ${JSON.stringify(terminal)},
    };
    export async function resolve(specifier, context, nextResolve) {
      if (Object.hasOwn(modules, specifier)) {
        return { url: 'data:text/javascript,' + encodeURIComponent(modules[specifier]), shortCircuit: true };
      }
      return nextResolve(specifier, context);
    }
  `);
  return {
    run(args, env = {}, input) {
      return spawnSync(process.execPath, ['--no-warnings', '--experimental-loader', loader, cli, '--lang', 'en', ...args],
        { encoding: 'utf8', input, env: { HOME: dir, CALL_LOG: log, ...env } });
    },
    calls() {
      try { return readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); }
      catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    },
  };
}

test('input rejects invalid and ambiguous invocations before any session or terminal effects', t => {
  const f = fixture(t);
  const cases = [
    [['input', id, '--key', 'Enter', 'text'], /--key/i],
    [['input', id, '--key', 'Enter', '--enter'], /--key/i],
    [['input', id, '--key', 'Delete'], /--key expects/i],
    [['input', id, '--key', ''], /--key expects/i],
    [['input', id, ''], /single.line/i],
    [['input', id, 'line\nnext'], /single.line/i],
    [['input', id, '\u001b[31m'], /control/i],
    [['input', id, 'x'.repeat(65537)], /64 KiB/i],
    [['input', id, '--stdin'], /unknown option/i],
    [['send', id, '--type', 'text'], /unknown option/i],
    [['send', id, '--press', 'Enter'], /unknown option/i],
    [['send', id, '--enter', 'text'], /unknown option/i],
    [['send', id, '--key', 'Enter'], /unknown option/i],
    [['send', id, '--stdin', 'text'], /usage/i],
  ];
  for (const [args, message] of cases) {
    const result = f.run([...args, '--json']);
    assert.notEqual(result.status, 0, JSON.stringify(args.slice(0, 2)));
    assert.deepEqual(JSON.parse(result.stdout), { accepted: false });
    assert.match(result.stderr, message);
    assert.deepEqual(f.calls(), []);
  }
});

test('removed top-level verbs are rejected without session effects', t => {
  const f = fixture(t);
  for (const command of ['type', 'press', 'command']) {
    const result = f.run([command, id, 'text']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unknown command/i);
    assert.deepEqual(f.calls(), []);
  }
});

test('send uses provider delivery for literal text and stdin, never terminal input', t => {
  const f = fixture(t);
  for (const [args, stdin, text] of [
    [['send', id, '/model'], undefined, '/model'],
    [['send', id, '--stdin'], 'piped\ntext', 'piped\ntext'],
    [['send', id, '--', '--type'], undefined, '--type'],
  ]) {
    const result = f.run([args[0], '--json', ...args.slice(1)], {}, stdin);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { accepted: true });
    assert.deepEqual(f.calls().slice(-2), [['lookup', id], ['send', text]]);
  }
  assert.ok(f.calls().every(([op]) => op !== 'terminal'));
});

test('input dispatches literal text and keys through confirmed terminal transport', t => {
  const f = fixture(t);
  for (const [args, mode, text, enter] of [
    [['/model'], 'text', '/model', false],
    [['hello', '--enter'], 'text', 'hello', true],
    [['--key', 'Enter'], 'key', 'Enter', false],
    [['--key', 'Escape'], 'key', 'Escape', false],
    [['--key', 'cTrL+Q'], 'key', 'cTrL+Q', false],
    [['--key', 'CTRL+ENTER'], 'key', 'CTRL+ENTER', false],
    [['--', '--type'], 'text', '--type', false],
  ]) {
    const result = f.run(['input', '--json', id, ...args]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { accepted: true });
    assert.deepEqual(f.calls().slice(-4), [['lookup', id], ['confirm'], ['confirm'], ['terminal', 123, mode, text, enter]]);
  }
  assert.ok(f.calls().every(([op]) => op !== 'send'));
});

test('busy input with enter is rejected before terminal delivery', t => {
  const f = fixture(t);
  const result = f.run(['input', id, 'hello', '--enter', '--json'], { SESSION_STATUS: 'running' });
  assert.notEqual(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout), { accepted: false });
  assert.match(result.stderr, /busy or blocked/i);
  assert.deepEqual(f.calls(), [['lookup', id], ['confirm']]);
});

test('delivery uncertainty and invalid language preserve JSON outcomes for both commands', t => {
  const f = fixture(t);
  for (const [args, env] of [
    [['send', id, 'text', '--json'], { SEND_UNKNOWN: '1' }],
    [['input', id, 'text', '--json'], { INPUT_UNKNOWN: '1' }],
  ]) {
    const result = f.run(args, env);
    assert.notEqual(result.status, 0);
    assert.deepEqual(JSON.parse(result.stdout), { accepted: null });
  }
  for (const command of ['send', 'input']) {
    const result = f.run([command, id, 'text', '--json', '--lang', 'invalid']);
    assert.notEqual(result.status, 0);
    assert.deepEqual(JSON.parse(result.stdout), { accepted: false });
  }
});

test('AGY CLI publishes managed, native, and process capabilities without internal identity fields', t => {
  const f = fixture(t);
  const result = f.run(['list', '--provider', 'agy', '--json']);
  assert.equal(result.status, 0, result.stderr);
  const capabilities = Object.fromEntries(JSON.parse(result.stdout).map(
    ({ id, kind, status, send, history, wait, close, historyMode }) => [id, [kind, status, send, history, wait, close, historyMode]],
  ));
  assert.deepEqual(capabilities, {
    [agyManaged]: ['session', 'idle', true, true, true, true, 'live'],
    [agyNative]: ['session', 'idle', false, false, false, false, undefined],
    [agyProcess]: ['process', 'unknown', false, false, false, false, undefined],
  });
  assert.doesNotMatch(result.stdout, /_agy|hidden-value/);
  const history = f.run(['history', agyNative, '--limit', '1', '--json']);
  assert.equal(history.status, 1);
  assert.match(history.stderr, /history unavailable/i);
  assert.equal(f.run(['view', agyNative]).status, 1);
  assert.deepEqual(f.calls(), [['agy:list'], ['agy:native', agyNative], ['agy:native', agyNative]]);
});

test('AGY CLI sends only to its managed message transport and never falls back to terminal keys', t => {
  const f = fixture(t);
  const message = '/statusline\nliteral text';
  const managed = f.run(['send', agyManaged, '--stdin', '--json'], {}, message);
  assert.equal(managed.status, 0, managed.stderr);
  assert.deepEqual(JSON.parse(managed.stdout), { accepted: true });
  for (const id of [agyNative, agyProcess]) {
    const native = f.run(['send', id, '/statusline', '--json']);
    assert.equal(native.status, 1);
    assert.deepEqual(JSON.parse(native.stdout), { accepted: false });
  }
  for (const command of ['wait', 'close']) assert.equal(f.run([command, agyNative, '--json']).status, 1);
  assert.deepEqual(f.calls(), [['agy:bridge', agyManaged], ['agy:send', agyManaged, message],
    ['agy:native', agyNative], ['agy:native', agyProcess], ['agy:native', agyNative], ['agy:native', agyNative]]);
});

test('AGY CLI passes every native input form through the safety gate before any possible terminal effect', t => {
  const f = fixture(t);
  const managed = f.run(['input', agyManaged, 'text', '--json']);
  assert.equal(managed.status, 1);
  assert.deepEqual(JSON.parse(managed.stdout), { accepted: false });
  assert.match(managed.stderr, /managed AGY sessions.*use send/i);
  assert.deepEqual(f.calls(), [['agy:bridge', agyManaged]]);
  for (const [id, args, action] of [
    [agyNative, ['text'], { mode: 'text', text: 'text', enter: false }],
    [agyNative, ['text', '--enter'], { mode: 'text', text: 'text', enter: true }],
    [agyNative, ['--key', 'Enter'], { mode: 'key', text: 'Enter', enter: false }],
    [agyNative, ['--key', 'Escape'], { mode: 'key', text: 'Escape', enter: false }],
    [agyProcess, ['text'], { mode: 'text', text: 'text', enter: false }],
  ]) {
    const result = f.run(['input', id, ...args, '--json']);
    assert.equal(result.status, 1);
    assert.deepEqual(JSON.parse(result.stdout), { accepted: false });
    assert.deepEqual(f.calls().slice(-2), [['agy:native', id], ['agy:confirm', id, action]]);
  }
  assert.ok(f.calls().every(([op]) => op !== 'terminal' && op !== 'agy:send' && op !== 'agy:list'));
});

test('AGY status line accepts only a bounded piped JSON object and clears invalid reports without reflecting payloads', t => {
  const f = fixture(t);
  const args = ['integration', 'agy-statusline'];
  const report = { conversation_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', agent_state: 'idle' };
  const valid = f.run(args, {}, JSON.stringify(report));
  assert.equal(valid.status, 0, valid.stderr);
  assert.equal(valid.stdout, 'AGY fixture\n');
  assert.deepEqual(f.calls(), [['agy:status', report]]);
  const marker = 'fixture-statusline-private';
  for (const text of [`{${marker}`, JSON.stringify([marker]), JSON.stringify({ title: marker.repeat(4096) })]) {
    const rejected = f.run(args, {}, text);
    assert.equal(rejected.status, 1);
    assert.doesNotMatch(rejected.stdout + rejected.stderr, /fixture-statusline-private/);
    assert.deepEqual(f.calls().at(-1), ['agy:status', null]);
  }
  assert.equal(f.calls().length, 4);
});
