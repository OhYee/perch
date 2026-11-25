import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import extension from '../omp-extension.ts';
import { createNativeAdapter, macArgv, nativeReceiptDirectory } from '../adapters/agy-native.mjs';
import { sendTerminalInput } from '../terminal-input.mjs';

const cli = fileURLToPath(new URL('../cli.mjs', import.meta.url));

async function until(check, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await sleep(20);
  }
  assert.fail('Timed out waiting for condition');
}

// Mock AGY ACP model server: speaks real JSON-RPC ACP and returns fixed replies per turn.
const mockAgyAcpServer = `#!${process.execPath}
const fs = require('node:fs');
const readline = require('node:readline');
const argvLog = process.env.MOCK_AGY_ARGV_LOG;
if (argvLog) fs.appendFileSync(argvLog, JSON.stringify(process.argv.slice(2)) + '\\n');
const sessionId = 'mock-acp-session-1';
let turn = 0;
const send = obj => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...obj }) + '\\n');
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', line => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    return send({
      id: msg.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true, sessionCapabilities: { close: {} } },
      },
    });
  }
  if (msg.method === 'session/new') {
    return send({
      id: msg.id,
      result: {
        sessionId,
        title: 'Mock AGY ACP Session',
        configOptions: [{
          id: 'model',
          category: 'model',
          type: 'select',
          currentValue: 'gemini-4-neon',
          options: [{ value: 'gemini-4-neon', label: 'Gemini 4 Neon' }],
        }],
      },
    });
  }
  if (msg.method === 'session/set_config_option') {
    return send({
      id: msg.id,
      result: {
        configOptions: [{
          id: 'model',
          category: 'model',
          type: 'select',
          currentValue: msg.params.value,
          options: [{ value: 'gemini-4-neon', label: 'Gemini 4 Neon' }],
        }],
      },
    });
  }
  if (msg.method === 'session/prompt') {
    turn += 1;
    const text = (msg.params?.prompt || []).map(p => p.text || '').join('');
    const delayMs = text.includes('SLOW_ACK') ? 1300 : 20;
    setTimeout(() => {
      send({
        method: 'session/update',
        params: {
          sessionId,
          requestId: msg.id,
          update: {
            sessionUpdate: 'agent_message_chunk',
            messageId: 'm-' + turn,
            content: { type: 'text', text: 'MOCK_MODEL_ACP_TURN_' + turn + ':' + text.split('\\n')[0] },
          },
        },
      });
      setTimeout(() => {
        send({ id: msg.id, result: { sessionId, stopReason: 'end_turn' } });
      }, 40);
    }, delayMs);
    return;
  }
  if (msg.method === 'session/close') {
    return send({ id: msg.id, result: {} });
  }
});
`;

test('E2E managed AGY flow: omp-extension -> real cli -> real agy-acp-bridge -> mock ACP server with yolo flag and deliveryUnknown recovery', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'perch-e2e-managed-agy-')));
  const home = join(root, 'home');
  const cwd = join(root, 'work');
  const state = join(root, 'state');
  const bin = join(root, 'bin');
  const argvLog = join(root, 'agy-argv.jsonl');
  await Promise.all([mkdir(home, { mode: 0o700 }), mkdir(cwd, { mode: 0o700 }), mkdir(state, { mode: 0o700 }), mkdir(bin, { mode: 0o700 })]);

  const agyPath = join(bin, 'agy');
  await writeFile(agyPath, mockAgyAcpServer, { mode: 0o755 });
  await chmod(agyPath, 0o755);

  const prev = {
    HOME: process.env.HOME,
    PATH: process.env.PATH,
    XDG_STATE_HOME: process.env.XDG_STATE_HOME,
    PERCH_BIN: process.env.PERCH_BIN,
    PERCH_HEARTBEAT_MS: process.env.PERCH_HEARTBEAT_MS,
    PERCH_AGY_ADMISSION_MS: process.env.PERCH_AGY_ADMISSION_MS,
    MOCK_AGY_ARGV_LOG: process.env.MOCK_AGY_ARGV_LOG,
  };
  t.after(async () => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await rm(root, { recursive: true, force: true });
  });

  process.env.HOME = home;
  process.env.PATH = `${bin}:${process.env.PATH ?? ''}`;
  process.env.XDG_STATE_HOME = state;
  delete process.env.PERCH_BIN;
  process.env.PERCH_HEARTBEAT_MS = '0';
  process.env.PERCH_AGY_ADMISSION_MS = '700';
  process.env.MOCK_AGY_ARGV_LOG = argvLog;

  const handlers = new Map();
  const tools = new Map();
  const sentMessages = [];
  const ctx = {
    mode: 'rpc',
    cwd,
    agent: { kind: 'main', id: 'main' },
    sessionModes: { getState: () => ({ vibe: { status: 'inactive' } }) },
    isIdle: () => true,
    hasPendingMessages: () => false,
    sessionManager: { getSessionId: () => 'omp-e2e-director', getBranch: () => [] },
    hasUI: false,
    ui: { notify: () => {} },
  };
  extension({
    arktype: schema => schema,
    on: (event, handler) => handlers.set(event, handler),
    registerCommand: () => {},
    registerTool: tool => tools.set(tool.name, tool),
    getSessionName: () => 'Director',
    getActiveTools: () => ['perch'],
    setActiveTools: async () => {},
    sendMessage: (message, options) => { sentMessages.push({ message, options }); },
    sendUserMessage: async () => {},
  });

  const perch = tools.get('perch');
  assert.ok(perch, 'perch tool must be registered');

  // Turn 1: real start + send + background wait + history + async pushback
  const started = await perch.execute('e2e-1', {
    op: 'start',
    name: 'mock-neon',
    provider: 'agy',
    model: 'gemini-4-neon',
    cwd,
    prompt: 'First turn prompt\nwith second line',
  }, undefined, undefined, ctx);
  assert.equal(started.details.provider, 'agy');
  assert.equal(started.details.accepted, true);
  assert.equal(started.details.notify, true);

  // Verify mock agy ACP process received --dangerously-skip-permissions automatically
  const spawnedArgvs = (await readFile(argvLog, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(spawnedArgvs[0], ['acp', '--dangerously-skip-permissions']);

  await until(() => sentMessages.length === 1);
  assert.match(sentMessages[0].message.content, /MOCK_MODEL_ACP_TURN_1:First turn prompt/);
  assert.match(sentMessages[0].message.content, /Action:/);

  // Turn 2: slow ack (> PERCH_AGY_ADMISSION_MS=700ms) triggers deliveryUnknown,
  // omp-extension probes running state and still delivers completion notification.
  const slowSend = await perch.execute('e2e-2', {
    op: 'send',
    id: started.details.id,
    text: 'SLOW_ACK follow-up',
  }, undefined, undefined, ctx);
  assert.equal(slowSend.details.accepted, null);
  assert.equal(slowSend.details.running, true);
  assert.equal(slowSend.details.notify, true);

  await until(() => sentMessages.length === 2);
  assert.match(sentMessages[1].message.content, /MOCK_MODEL_ACP_TURN_2:SLOW_ACK follow-up/);

  const history = await perch.execute('e2e-3', { op: 'history', id: started.details.id, limit: 10 }, undefined, undefined, ctx);
  assert.deepEqual(history.details.map(m => m.text), [
    'First turn prompt\nwith second line',
    'MOCK_MODEL_ACP_TURN_1:First turn prompt',
    'SLOW_ACK follow-up',
    'MOCK_MODEL_ACP_TURN_2:SLOW_ACK follow-up',
  ]);

  await handlers.get('session_shutdown')({}, ctx);
});

test('E2E native AGY flow: plugin install, yolo native launch, transcript_full.jsonl hooks, wait, history, and Turn 2 multiline pane send', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'perch-e2e-native-agy-')));
  const home = join(root, 'home');
  const cwd = join(root, 'work');
  const bin = join(root, 'bin');
  const paneLog = join(root, 'pane.jsonl');
  const agyArgvLog = join(root, 'agy-native-argv.jsonl');
  const ternLog = join(root, 'tern.jsonl');
  await Promise.all([mkdir(home, { mode: 0o700 }), mkdir(cwd, { mode: 0o700 }), mkdir(bin, { mode: 0o700 })]);

  const pid = 62111;
  const uuid = '11111111-2222-4333-8444-555555555555';
  const transcriptFull = join(home, '.gemini', 'antigravity-cli', 'brain', uuid, '.system_generated', 'logs', 'transcript_full.jsonl');

  // Mock agy native executable records exact argv passed by real cli.mjs
  const agyExe = join(bin, 'agy');
  await writeFile(agyExe, `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync(process.env.AGY_ARGV_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
`, { mode: 0o755 });

  // Mock terminal-pane runs the command it received and returns a tern pane id
  await writeFile(join(bin, 'terminal-pane'), `#!${process.execPath}
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.PANE_LOG, JSON.stringify(args) + '\\n');
const cmd = args.slice(args.indexOf('--') + 1);
const res = spawnSync(cmd[0], cmd.slice(1), { encoding: 'utf8' });
if (res.status !== 0) { console.error(res.stderr || res.error); process.exit(1); }
console.log(JSON.stringify({ backend: 'tern', pane: 'tern-pane-77' }));
`, { mode: 0o755 });

  // Mock ps reports our fake native agy PID as an active foreground TTY process
  await writeFile(join(bin, 'ps'), `#!${process.execPath}
console.log('${pid} ${pid} ${pid} ttys099');
`, { mode: 0o755 });

  // Mock tern verifies foreground pid and logs injected text/enter keys
  await writeFile(join(bin, 'tern'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'ls') {
  console.log(JSON.stringify({ sessions: [{ tabs: [{ blocks: [{ id: 77, live: true, program: 'agy' }] }] }] }));
  process.exit(0);
}
if (args[0] === 'process' && args[1] === '77') {
  console.log(JSON.stringify({ pane: 77, foreground: { pid: ${pid} } }));
  process.exit(0);
}
if (args[0] === 'send') {
  fs.appendFileSync(process.env.TERN_LOG, JSON.stringify(args) + '\\n');
  process.exit(0);
}
process.exit(1);
`, { mode: 0o755 });

  const prev = { HOME: process.env.HOME, PATH: process.env.PATH, LC_ALL: process.env.LC_ALL, TERN_LOG: process.env.TERN_LOG };
  let receipts;
  t.after(async () => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (receipts) await rm(receipts, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  });

  process.env.HOME = home;
  process.env.PATH = `${bin}:${process.env.PATH ?? ''}`;
  process.env.LC_ALL = 'C';
  process.env.TERN_LOG = ternLog;
  receipts = nativeReceiptDirectory();

  const childEnv = {
    HOME: home,
    PATH: `${bin}:${process.env.PATH}`,
    LC_ALL: 'C',
    PANE_LOG: paneLog,
    AGY_ARGV_LOG: agyArgvLog,
    TERN_LOG: ternLog,
  };

  // 1. Install real agy plugin via real cli.mjs
  const install = spawnSync(process.execPath, [cli, 'integration', 'install', 'agy', '--json'], { env: childEnv, encoding: 'utf8' });
  assert.equal(install.status, 0, install.stderr);
  const hooksJson = JSON.parse(await readFile(join(home, '.gemini', 'config', 'plugins', 'perch', 'hooks.json'), 'utf8'));
  assert.ok(hooksJson['perch-native'].SessionStart[0].command.endsWith('integration agy-hook'));

  // 2. Stage Turn 1 prompt (zero spaces) and launch via real cli.mjs start agy --native --pane right
  const stagedTurn1 = join(root, 'turn1-prompt.md');
  await writeFile(stagedTurn1, 'Turn 1: check config\nLine 2 details', { mode: 0o600 });
  const zeroSpacePrompt = `请阅读并严格执行该文件中的完整指令:${stagedTurn1}`;
  const launch = spawnSync(process.execPath, [
    cli, 'start', 'agy', zeroSpacePrompt, '--native', '--pane', 'right', '--cwd', cwd, '--model', 'gemini-4-neon', '--json',
  ], { env: childEnv, encoding: 'utf8' });
  assert.equal(launch.status, 0, launch.stderr);
  assert.deepEqual(JSON.parse(launch.stdout), { provider: 'agy', mode: 'native', pane: { backend: 'tern', id: 'tern-pane-77' } });

  // Verify mock agy received --dangerously-skip-permissions + zero-space --prompt-interactive, and macArgv accepts it
  const [launchedArgv] = (await readFile(agyArgvLog, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(launchedArgv, ['--dangerously-skip-permissions', '--model', 'gemini-4-neon', `--prompt-interactive=${zeroSpacePrompt}`]);
  const flattened = `${agyExe} ${launchedArgv.join(' ')}`;
  const parsedMacArgv = macArgv(flattened, [agyExe, 'agy']);
  assert.deepEqual(parsedMacArgv, [agyExe, ...launchedArgv]);

  // 3. Drive real agy-native adapter + real sendTerminalInput (via mock tern)
  let hookCaller;
  const rows = new Map([
    [pid, { pid, ppid: 1, tty: 'ttys099', argv: parsedMacArgv, birth: 'fixture-boot:native', cwd, isAgy: true }],
  ]);
  const nativeApi = createNativeAdapter({
    inspectProcesses: async targetPid => targetPid === undefined ? [...rows.values()] : [...rows.values()].filter(r => r.pid === targetPid),
    inspectHookSource: async () => hookCaller,
    sendInput: sendTerminalInput,
    confirmTurnMs: 120,
  });

  const emitHook = async payload => {
    hookCaller = pid;
    try { return await nativeApi.recordNativeHook(payload); }
    finally { hookCaller = undefined; }
  };

  // Turn 1 lifecycle: SessionStart (with lastUserInput -> running immediately!) -> PreInvocation -> transcript -> Stop
  const startRes = await emitHook({
    conversationId: uuid,
    cwd,
    transcriptPath: transcriptFull,
    hookEventName: 'SessionStart',
    lastUserInput: zeroSpacePrompt,
  });
  assert.deepEqual(startRes, { conversation: uuid, status: 'running' });

  const [session] = await nativeApi.listNative();
  assert.equal(session.kind, 'session');
  assert.equal(session.status, 'running');
  assert.equal(session.send, true);
  assert.equal(session.history, true);
  assert.equal(session.wait, true);

  // waitNative stays running until Stop(fullyIdle: true)
  const waitTurn1 = nativeApi.waitNative(session, 5000);
  await sleep(30);
  await emitHook({ conversationId: uuid, cwd, transcriptPath: transcriptFull, hookEventName: 'PreInvocation', invocationNum: 0 });
  await mkdir(dirname(transcriptFull), { recursive: true });
  await writeFile(transcriptFull, [
    JSON.stringify({ type: 'USER_INPUT', source: 'USER_EXPLICIT', content: `<USER_REQUEST>\n${zeroSpacePrompt}\n</USER_REQUEST>` }),
    JSON.stringify({ type: 'PLANNER_RESPONSE', content: 'MOCK_MODEL_NATIVE_TURN_1' }),
  ].join('\n') + '\n', { mode: 0o600 });
  await emitHook({ conversationId: uuid, cwd, transcriptPath: transcriptFull, hookEventName: 'Stop', fullyIdle: true });
  assert.deepEqual(await waitTurn1, { status: 'completed' });

  const hist1 = await nativeApi.historyNative(session, 10);
  assert.equal(hist1.at(-1).text, 'MOCK_MODEL_NATIVE_TURN_1');

  // Turn 2: multiline sendNative stages a private 0600 file and sends single-line instruction through REAL sendTerminalInput -> mock tern
  const turn2Prompt = 'Turn 2 follow-up\nCheck edge cases\nReturn summary';
  await nativeApi.sendNative(session, turn2Prompt, { lang: 'en' });

  const ternCalls = (await readFile(ternLog, 'utf8')).trim().split('\n').map(JSON.parse);
  const textCall = ternCalls.find(args => args[0] === 'send' && args[1] === '77' && args[2] === 'text');
  const enterCall = ternCalls.find(args => args[0] === 'send' && args[1] === '77' && args[2] === 'keys' && args[3] === 'Enter');
  assert.ok(textCall, 'expected real sendTerminalInput to invoke mock tern send 77 text');
  assert.ok(enterCall, 'expected real sendTerminalInput to invoke mock tern send 77 keys Enter');
  const injected = textCall[3];
  const stagedTurn2 = /^Read and follow the complete instructions in (.+)$/.exec(injected)?.[1];
  assert.ok(stagedTurn2, `expected staged turn 2 path, got: ${injected}`);
  assert.equal((await lstat(stagedTurn2)).mode & 0o777, 0o600);
  assert.equal(await readFile(stagedTurn2, 'utf8'), turn2Prompt);

  // Mock agy completes Turn 2 via PreInvocation + transcript_full.jsonl + Stop
  await emitHook({ conversationId: uuid, cwd, transcriptPath: transcriptFull, hookEventName: 'PreInvocation', invocationNum: 1 });
  const waitTurn2 = nativeApi.waitNative(session, 5000);
  await sleep(30);
  const prevTranscript = await readFile(transcriptFull, 'utf8');
  await writeFile(transcriptFull, prevTranscript + [
    JSON.stringify({ type: 'USER_INPUT', source: 'USER_EXPLICIT', content: `<USER_REQUEST>\n${injected}\n</USER_REQUEST>` }),
    JSON.stringify({ type: 'PLANNER_RESPONSE', content: 'MOCK_MODEL_NATIVE_TURN_2' }),
  ].join('\n') + '\n', { mode: 0o600 });
  await emitHook({ conversationId: uuid, cwd, transcriptPath: transcriptFull, hookEventName: 'Stop', fullyIdle: true });
  assert.deepEqual(await waitTurn2, { status: 'completed' });

  const hist2 = await nativeApi.historyNative(session, 10);
  assert.deepEqual(hist2.map(m => m.text), [
    zeroSpacePrompt,
    'MOCK_MODEL_NATIVE_TURN_1',
    injected,
    'MOCK_MODEL_NATIVE_TURN_2',
  ]);
});
