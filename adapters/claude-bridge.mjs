#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, unlink } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { createInterface } from 'node:readline';
import net from 'node:net';
import { bridgeDir, privateBridgeDir, terminalSafeText, trackPending, validateNativeExecutable } from './claude.mjs';
import { systemLanguage } from '../locale.mjs';
import { translateDiagnostic } from '../diagnostics.mjs';

const lang = systemLanguage();

async function main() {
  const [executable, ...options] = process.argv.slice(2);
  const managed = options[0] === '--managed';
  const model = managed && options[1] === '--model' && options.length === 3 ? options[2] : undefined;
  if (!executable || !isAbsolute(executable) ||
      (options.length && !(managed && (options.length === 1 || model)))) {
    throw new Error(translateDiagnostic('Pass the absolute path to the trusted native Claude executable, not a wrapper.', lang));
  }
  const binary = await validateNativeExecutable(executable).catch(error => {
    throw new Error(translateDiagnostic(error.message, lang));
  });
  await mkdir(bridgeDir, { recursive: true, mode: 0o700 });
  if (!await privateBridgeDir()) throw new Error(translateDiagnostic('Claude bridge directory is not private to the current user', lang));

  const id = randomUUID();
  const socketPath = join(bridgeDir, `${id}.sock`);
  const permissionArgs = managed
    ? ['--permission-mode', 'bypassPermissions', '--dangerously-skip-permissions']
    : ['--permission-mode', 'dontAsk', '--permission-prompts', 'none'];
  const args = ['--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--replay-user-messages', '--session-id', id, ...permissionArgs];
  if (managed) args.push('--disable-slash-commands');
  if (model) args.push('--model', model);
  const child = spawn(binary, args, { stdio: ['pipe', 'pipe', 'inherit'] });
  const pending = new Map();
  const messages = [];
  const assistantEvents = new Set();
  const waiters = new Set();
  let active = null;
  let lastResult = { status: 'completed' };
  let running = true;
  let spawned = false;
  let listening = false;
  let ready = false;
  let closing = false;
  let killTimer;
  let expiryTimer;
  const stopChild = () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    if (!killTimer) {
      killTimer = setTimeout(() => child.kill('SIGKILL'), 2000);
      killTimer.unref();
    }
  };
  const status = () => !running ? 'stopped' : managed ? (active ? 'running' : 'idle') : 'unknown';
  const row = () => ({ id: `claude:${id}`, provider: 'claude', pid: child.pid, cwd: process.cwd(), status: status(), send: true, history: true, historyMode: 'live', wait: true, close: true, _bridge: true, _managed: true });
  const reply = (socket, value) => socket.end(JSON.stringify(value) + '\n');
  const reportReady = () => {
    if (managed && spawned && listening && !ready && running) {
      ready = true;
      process.send?.({ ready: true, session: row() });
    }
  };
  const finish = (result) => {
    active = null;
    lastResult = result;
    for (const waiter of waiters) waiter(result);
    waiters.clear();
  };
  child.stdin.on('error', () => {});
  child.on('spawn', () => { spawned = true; reportReady(); });
  child.on('error', () => { running = false; });
  child.on('close', () => {
    clearTimeout(killTimer);
    running = false;
    for (const { socket } of pending.values()) reply(socket, { error: 'Claude exited before acknowledgment; delivery status is unknown', deliveryUnknown: true });
    pending.clear();
    finish({ status: closing ? 'interrupted' : 'failed', error: closing ? 'Claude session closed' : 'Claude exited' });
    if (managed && !ready) process.send?.({ ready: false, error: 'Claude exited before startup' });
    if ((!managed || !ready || closing) && server.listening) server.close();
    else if (managed && ready && server.listening) expiryTimer = setTimeout(() => server.close(), 60000);
  });

  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    let event; try { event = JSON.parse(line); } catch { return; }
    if (!event || typeof event !== 'object') return;
    if (event.type === 'user' && event.isReplay && event.session_id === id && event.parent_tool_use_id == null && event.origin?.kind !== 'peer' && event.origin?.kind !== 'channel') {
      if (managed && (active?.id !== event.uuid || active.acknowledged)) return;
      const entry = pending.get(event.uuid);
      pending.delete(event.uuid);
      const content = event.message?.content;
      const text = entry?.text ?? (managed && active?.id === event.uuid ? active.text : null) ?? (typeof content === 'string' ? content : Array.isArray(content) ? content.filter(x => x?.type === 'text' && typeof x.text === 'string').map(x => x.text).join('\n') : '');
      if (text) messages.push({ role: 'user', text });
      if (managed && active?.id === event.uuid) active.acknowledged = true;
      if (entry) reply(entry.socket, { accepted: true });
    } else if (event.type === 'assistant' && (!managed || event.session_id === id) && event.parent_tool_use_id == null) {
      if (managed && (!active?.acknowledged || (event.uuid && assistantEvents.has(event.uuid)))) return;
      if (managed && event.uuid) assistantEvents.add(event.uuid);
      const content = event.message?.content;
      const text = Array.isArray(content) ? content.filter(x => x?.type === 'text' && typeof x.text === 'string').map(x => x.text).join('\n') : '';
      if (text) {
        messages.push({ role: 'assistant', text });
        if (!managed) process.stdout.write(terminalSafeText(text) + '\n');
      }
    } else if (event.type === 'result' && (!managed || event.session_id === id)) {
      if (managed && active?.acknowledged) {
        if (event.is_error || event.subtype !== 'success') {
          finish({ status: 'failed', error: 'Claude returned an error result' });
        } else {
          finish({ status: 'completed' });
        }
      } else if (event.is_error && !managed) {
        process.stderr.write(translateDiagnostic('Claude returned an error result.', lang) + '\n');
      }
    }
  });

  const server = net.createServer(socket => {
    socket.setEncoding('utf8');
    socket.setTimeout(65000, () => socket.destroy());
    let input = '';
    let handled = false;
    socket.on('error', () => {});
    socket.on('data', data => {
      if (handled) return;
      input += data;
      if (input.length > 1024 * 1024) { socket.destroy(); return; }
      const end = input.indexOf('\n');
      if (end < 0) return;
      handled = true;
      let req; try { req = JSON.parse(input.slice(0, end)); } catch { reply(socket, { error: 'Invalid request' }); return; }
      if (req?.op === 'info') {
        reply(socket, { id, pid: child.pid, bridgePid: process.pid, cwd: process.cwd(), managed, running, status: status(), protocolVersion: 2 });
      } else if (req?.op === 'history' && (req.limit === null || Number.isSafeInteger(req.limit) && req.limit > 0)) {
        reply(socket, { messages: req.limit === null ? messages : messages.slice(-req.limit) });
      } else if (managed && req?.op === 'waitIdle' && (req.timeoutMs === null || Number.isSafeInteger(req.timeoutMs) && req.timeoutMs >= 0 && req.timeoutMs <= 2147480000)) {
        if (!active) { reply(socket, lastResult); return; }
        if (req.timeoutMs === 0) { reply(socket, { status: 'timeout' }); return; }
        socket.setTimeout(0);
        let timer;
        const done = result => { clearTimeout(timer); waiters.delete(done); reply(socket, result); };
        if (req.timeoutMs !== null) timer = setTimeout(() => done({ status: 'timeout' }), req.timeoutMs);
        waiters.add(done);
        socket.once('close', () => { clearTimeout(timer); waiters.delete(done); });
      } else if (managed && req?.op === 'close') {
        closing = true;
        finish({ status: 'interrupted', error: 'Claude session closed' });
        reply(socket, { closed: true });
        stopChild();
        server.close();
      } else if (!running) {
        reply(socket, { error: 'Claude is not running' });
      } else if (req?.op === 'send' && typeof req.text === 'string' && req.text.length > 0 && req.text.length <= 512 * 1024 && pending.size < 100) {
        if (managed && active) { reply(socket, { error: 'Claude session is busy' }); return; }
        const messageId = randomUUID();
        if (managed) {
          active = { id: messageId, text: req.text, acknowledged: false };
          assistantEvents.clear();
        }
        trackPending(pending, messageId, socket, req.text);
        const message = { type: 'user', uuid: messageId, session_id: id, message: { role: 'user', content: req.text }, parent_tool_use_id: null };
        child.stdin.write(JSON.stringify(message) + '\n', error => {
          if (error) {
            running = false;
            stopChild();
            pending.delete(messageId);
            if (managed && active?.id === messageId) finish({ status: 'failed', error: 'Claude input failed; delivery status is unknown' });
            reply(socket, { error: 'Claude input failed; delivery status is unknown', deliveryUnknown: true });
          }
        });
      } else {
        reply(socket, { error: 'Invalid request' });
      }
    });
  });
  server.on('error', () => {
    stopChild();
    if (managed && !ready) process.send?.({ ready: false, error: 'Claude bridge could not start' });
    process.stderr.write(translateDiagnostic('Claude bridge could not start.', lang) + '\n');
    process.exitCode = 1;
  });
  server.on('close', () => { clearTimeout(expiryTimer); unlink(socketPath).catch(() => {}); });
  server.listen(socketPath, () => {
    listening = true;
    if (!running) { server.close(); return; }
    reportReady();
    if (!managed) process.stderr.write(`${translateDiagnostic('Claude bridge session:', lang)} claude:${id}\n`);
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
    closing = true;
    stopChild();
    server.close();
  });
}

main().catch(error => {
  if (process.send) process.send({ ready: false, error: error.message });
  else process.stderr.write(error.message + '\n');
  process.exitCode = 1;
});
