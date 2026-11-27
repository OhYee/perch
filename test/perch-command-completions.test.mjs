import assert from 'node:assert/strict';
import test from 'node:test';
import { completePerchCommand } from '../omp-extension.ts';

const values = result => result?.map(item => item.value) ?? null;

test('/perch completes subcommands by prefix', () => {
  assert.deepEqual(values(completePerchCommand('', [])), ['on', 'off', 'toggle', 'status', 'roles', 'close']);
  assert.deepEqual(values(completePerchCommand('o', [])), ['on', 'off']);
  assert.deepEqual(values(completePerchCommand('ro', [])), ['roles']);
  assert.equal(completePerchCommand('xyz', []), null);
});

test('/perch close completes all plus tracked worker names, deduplicated', () => {
  const workers = [
    { id: 'task-1', name: 'rev-sol', state: 'running' },
    { id: 'task-2', name: 'rev-neon', state: 'idle' },
    { id: 'task-3', state: 'completed' },
    { id: 'task-4', name: 'rev-sol', state: 'idle' },
  ];
  assert.deepEqual(values(completePerchCommand('close ', workers)), ['close all', 'close rev-sol', 'close rev-neon', 'close task-3']);
  assert.deepEqual(values(completePerchCommand('close rev-n', workers)), ['close rev-neon']);
  assert.equal(completePerchCommand('close rev-n', workers)[0].description, 'worker · idle');
  assert.equal(completePerchCommand('close nobody', workers), null);
});

test('/perch free-form prompts get no completions', () => {
  assert.equal(completePerchCommand('review the current branch', []), null);
  assert.equal(completePerchCommand('close rev-sol now', [{ id: 'a', name: 'rev-sol' }]), null);
});
