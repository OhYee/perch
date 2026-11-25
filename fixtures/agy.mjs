#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const { AGY_FIXTURE_LOG: logPath, AGY_FIXTURE_RELEASE: release, AGY_FIXTURE_START: startup, AGY_FIXTURE_STORE: store } = process.env;
const argv = process.argv.slice(2);
const log = value => { if (logPath) appendFileSync(logPath, JSON.stringify(value) + '\n'); };
log({ argv, pid: process.pid, ppid: process.ppid });
if (argv.length !== 2 || argv[0] !== 'acp' || argv[1] !== '--dangerously-skip-permissions') process.exit(2);

let sessionId = `fixture/opaque:${randomUUID()}`;
let model = 'fixture-default';
let messages = [];
let closeAllowed = true;
const privateText = 'fixture-private-provider-value';
const write = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
const result = (id, value) => write({ id, result: value });
const error = (id, code) => write({ id, error: { code, message: privateText, data: { text: privateText } } });
const update = (sessionUpdate, payload, target = sessionId) => write({
  method: 'session/update', params: { sessionId: target, update: { sessionUpdate, ...payload } },
});
const chunk = (text, role = 'agent_message_chunk', target = sessionId, messageId) => update(
  role, { content: { type: 'text', text }, ...(messageId && { messageId }) }, target,
);
const options = () => [{
  category: 'model', id: 'select-model', name: 'Model', type: 'select', currentValue: model,
  options: [{ group: 'available', name: 'Available', options: [
    { value: 'fixture-default', name: 'Default' }, { value: 'fixture-model', name: 'Fixture' },
  ] }],
}];

// 由测试明确放行首个真实进度和终态，避免依赖子进程启动速度。
function gate(phase, callback) {
  const timer = setInterval(() => {
    if (!existsSync(`${release}-${phase}`)) return;
    clearInterval(timer);
    callback();
  }, 10);
  return timer.unref();
}

function saveTurn(text, answer) {
  if (answer === undefined) messages.push({ text, role: 'user_message_chunk', messageId: randomUUID() });
  else messages.push({ text, role: 'user_message_chunk' }, { text: answer, role: 'agent_message_chunk' });
  if (store) writeFileSync(store, JSON.stringify({ sessionId, model, messages }));
}

function prompt({ id, params }) {
  if (params?.sessionId !== sessionId || params.prompt?.length !== 1 || params.prompt[0]?.type !== 'text') return error(id, -32602);
  const { text } = params.prompt[0];
  const finish = (reason = 'end_turn') => result(id, { stopReason: reason });
  const answer = `fixture answer ${messages.reduce((count, message) => count + Number(message.role === 'agent_message_chunk'), 1)}`;
  if (text === 'fixture:invalid') return error(id, -32602);
  if (text === 'fixture:error-before-ack') return error(id, -32603);
  if (text === 'fixture:disconnect') return process.exit(1);
  if (text === 'fixture:terminal-only') { saveTurn(text); return finish(); }
  if (text === 'fixture:ack-timeout') return gate('finish', finish);
  if (text === 'fixture:refusal') return finish('refusal');
  if (text === 'fixture:max-tokens') return finish('max_tokens');
  if (text === 'fixture:cancelled') return finish('cancelled');
  if (text === 'fixture:oversized') {
    const part = 'x'.repeat(2 * 1024 * 1024 + 1);
    const messageId = 'oversized';
    chunk(part, 'agent_message_chunk', sessionId, messageId);
    return gate('finish', () => {
      chunk(part, 'agent_message_chunk', sessionId, messageId);
      chunk('complete after oversized message', 'agent_message_chunk', sessionId, 'following');
      chunk('late incomplete fragment', 'agent_message_chunk', sessionId, messageId);
      finish();
    });
  }
  if (text === 'fixture:pending') {
    write({ id: 'permission-1', method: 'session/request_permission', params: { sessionId,
      toolCall: { toolCallId: 'tool-1', title: privateText, status: 'pending', rawInput: { text: privateText } },
      options: [{ optionId: 'allow', name: 'Allow once', kind: 'allow_once' }, { optionId: 'deny', name: 'Reject', kind: 'reject_once' }],
    } });
    write({ id: 'client-exec-1', method: 'terminal/create', params: { sessionId, command: privateText } });
    return;
  }
  if (text === 'fixture:gate') {
    result('unmatched-request', { stopReason: 'end_turn' });
    chunk(privateText, 'agent_message_chunk', 'other-session');
    update('session_info_update', { title: privateText }, 'other-session');
    update('session_info_update', { title: 'Fixture session' });
    update('config_option_update', { configOptions: options() });
    update('session_info_update', { title: 'Fixture session' });
    gate('progress', () => {
      chunk('echo ');
      chunk(privateText, 'agent_thought_chunk');
      update('tool_call', { toolCallId: 'tool-1', title: privateText, rawInput: { text: privateText }, status: 'in_progress' });
      gate('finish', () => {
        chunk('echo ');
        update('tool_call_update', { toolCallId: 'tool-1', status: 'completed', rawOutput: { text: privateText } });
        chunk('done');
        finish();
      });
    });
    return;
  }
  if (text === 'fixture:bad-frame' || text === 'fixture:exit-after-ack' || text === 'fixture:error-after-ack') {
    chunk('partial');
    return gate('finish', () => {
      if (text === 'fixture:exit-after-ack') process.exit(1);
      if (text === 'fixture:bad-frame') process.stdout.write(`${privateText}\n`);
      else error(id, -32603);
    });
  }
  chunk(answer);
  saveTurn(text, answer);
  finish();
}

createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  log(message);
  const { method, id, params } = message;
  switch (method) {
    case 'initialize':
      if (startup === 'exit') process.exit(1);
      return result(id, {
        protocolVersion: startup === 'protocol' ? 0 : 1,
        agentCapabilities: { loadSession: startup !== 'resume-only', sessionCapabilities: { list: {}, resume: {}, close: {} } },
        authMethods: [],
      });
    case 'session/new':
      if (startup === 'auth') return error(id, -32000);
      if (startup === 'no-id') return result(id, { sessionId: '' });
      if (store) writeFileSync(store, JSON.stringify({ sessionId, model, messages }));
      return result(id, { sessionId, configOptions: options() });
    case 'session/set_config_option':
      if (params?.sessionId !== sessionId || params.configId !== 'select-model' || params.value !== 'fixture-model') return error(id, -32602);
      if (startup !== 'ignore-model') model = params.value;
      return result(id, { configOptions: options() });
    case 'session/load': {
      if (startup === 'deny-load' || !store || !existsSync(store)) return error(id, -32602);
      ({ sessionId, model, messages } = JSON.parse(readFileSync(store, 'utf8')));
      if (params?.sessionId !== sessionId) return error(id, -32602);
      if (startup === 'gated-deny-load') return gate('load', () => error(id, -32602));
      const replay = () => {
        for (const { text, role, messageId } of messages) {
          const mid = Math.ceil(text.length / 2);
          chunk(text.slice(0, mid), role, sessionId, messageId);
          chunk(privateText, 'agent_thought_chunk');
          chunk(text.slice(mid), role, sessionId, messageId);
        }
        result(id, startup === 'mismatch-load' ? { sessionId: 'another-session' } : { configOptions: options() });
      };
      return startup === 'gated-load' ? gate('load', replay) : replay();
    }
    case 'session/prompt': return prompt(message);
    case 'session/cancel': return;
    case 'session/close':
      if (!closeAllowed || params?.sessionId !== sessionId) return error(id, -32602);
      closeAllowed = false;
      return result(id, {});
    default:
      if (method && Object.hasOwn(message, 'id')) return error(id, -32601);
  }
}).on('close', () => {
  if (startup === 'linger-on-eof') {
    log({ orphan: 'waiting' });
    gate('orphan-exit', () => { log({ orphan: 'released' }); }).ref();
  }
});
