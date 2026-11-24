#!/usr/bin/env node
import { appendFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';

if (process.argv[2] === 'app-server' && process.argv[3] === '--stdio') {
  const threadId = randomUUID();
  let nextTurn = 0;
  const write = message => process.stdout.write(JSON.stringify(message) + '\n');
  const log = value => { if (process.env.CODEX_FIXTURE_LOG) appendFileSync(process.env.CODEX_FIXTURE_LOG, JSON.stringify(value) + '\n'); };
  const notify = (method, params) => write({ method, params });
  const item = (turnId, value) => notify('item/completed', { threadId, turnId, item: value });
  const complete = (turnId, status, error = null) => notify('turn/completed', { threadId, turn: { id: turnId, status, error, items: [], itemsView: 'notLoaded' } });
  createInterface({ input: process.stdin }).on('line', line => {
    const message = JSON.parse(line);
    if (!message.method) { log({ reply: message.id }); return; }
    if (!Object.hasOwn(message, 'id')) return;
    log({ method: message.method, params: message.params });
    if (message.method === 'initialize') return write({ id: message.id, result: {} });
    if (message.method === 'thread/start') return write({ id: message.id, result: { thread: { id: threadId, cwd: message.params.cwd, name: null, turns: [] } } });
    if (message.method !== 'turn/start') return write({ id: message.id, error: { code: -32601 } });
    const turnId = `fixture-turn-${++nextTurn}`;
    const text = message.params.input[0].text;
    if (text === 'reject') return write({ id: message.id, error: { code: -32600 } });
    if (text === 'unconfirmed') return write({ id: message.id, result: {} });
    const start = () => {
      notify('turn/started', { threadId, turn: { id: turnId, status: 'inProgress', items: [] } });
      item(turnId, { id: `${turnId}-user`, type: 'userMessage', content: [{ type: 'text', text }] });
    };
    const finish = () => {
      item(turnId, { id: `${turnId}-commentary`, type: 'agentMessage', phase: 'commentary', text: 'not the answer' });
      if (text !== 'partial') item(turnId, { id: `${turnId}-answer`, type: 'agentMessage', phase: text === 'legacy' ? null : 'final_answer', text: `answer ${turnId}` });
      complete(turnId, 'completed');
    };
    if (text === 'slow-start') {
      const timer = setInterval(() => {
        if (!existsSync(process.env.CODEX_FIXTURE_RELEASE)) return;
        clearInterval(timer);
        write({ id: message.id, result: { turn: { id: turnId, status: 'inProgress', items: [] } } });
        start();
        finish();
      }, 10);
      return;
    }
    if (text === 'early') {
      start();
      finish();
      return write({ id: message.id, result: { turn: { id: turnId, status: 'inProgress', items: [] } } });
    }
    write({ id: message.id, result: { turn: { id: turnId, status: 'inProgress', items: [] } } });
    start();
    if (text === 'hold') return;
    if (text === 'pending') return write({ id: 'approval-1', method: 'item/commandExecution/requestApproval', params: { threadId, turnId, itemId: 'command-1' } });
    if (text === 'fail') return complete(turnId, 'failed', { message: 'fixture failure' });
    if (text === 'interrupt') return complete(turnId, 'interrupted');
    finish();
  });
}
