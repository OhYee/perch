import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { start, list, lookupBridge, send, waitIdle, close, request, history } from '../adapters/claude.mjs';

// The executable is a local native fixture, never the installed Claude CLI.
const source = String.raw`
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
int main(int argc, char **argv) {
  const char *id = NULL;
  for (int i = 1; i + 1 < argc; i++) if (!strcmp(argv[i], "--session-id")) id = argv[i + 1];
  if (!id) return 1;
  setvbuf(stdout, NULL, _IONBF, 0);
  char *line = NULL; size_t size = 0;
  while (getline(&line, &size, stdin) != -1) {
    char *uuid = strstr(line, "\"uuid\":\"");
    if (!uuid) continue;
    uuid += strlen("\"uuid\":\"");
    char *end = strchr(uuid, '"'); if (!end) continue; *end = 0;
    printf("{\"type\":\"user\",\"isReplay\":true,\"session_id\":\"%s\",\"uuid\":\"%s\"}\n", id, uuid);
    printf("{\"type\":\"user\",\"isReplay\":true,\"session_id\":\"%s\",\"uuid\":\"%s\"}\n", id, uuid);
    if (strstr(end + 1, "slow")) usleep(250000);
    if (strstr(end + 1, "die")) { free(line); return 1; }
    printf("{\"type\":\"result\",\"subtype\":\"success\",\"session_id\":\"00000000-0000-0000-0000-000000000000\",\"result\":\"wrong session\"}\n");
    printf("{\"type\":\"assistant\",\"uuid\":\"%s\",\"session_id\":\"%s\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"intermediate\"}]}}\n", uuid, id);
    printf("{\"type\":\"assistant\",\"uuid\":\"%s\",\"session_id\":\"%s\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"intermediate\"}]}}\n", uuid, id);
    if (strstr(end + 1, "fail")) printf("{\"type\":\"result\",\"subtype\":\"error_during_execution\",\"is_error\":true,\"session_id\":\"%s\"}\n", id);
    else printf("{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"session_id\":\"%s\"}\n", id);
  }
  free(line); return 0;
}
`;

test('managed native fixture tracks only matching terminal results and retains legacy bridge', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-session-claude-fixture-'));
  const originalPath = process.env.PATH;
  const originalConfig = process.env.CLAUDE_CONFIG_DIR;
  const originalHome = process.env.HOME;
  const originalLocale = process.env.LC_ALL;
  let session;
  let legacy;
  try {
    const code = join(dir, 'fixture.c');
    const binary = join(dir, 'claude');
    await writeFile(code, source);
    await promisify(execFile)('/usr/bin/cc', [code, '-o', binary]);
    process.env.PATH = join(dir, 'empty-path');
    process.env.HOME = dir;
    process.env.CLAUDE_CONFIG_DIR = dir;
    process.env.LC_ALL = 'en_US.UTF-8';
    await assert.rejects(start({ cwd: dir }), /absolute path.*trusted native/i);
    const script = join(dir, 'not-native');
    await writeFile(script, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    await assert.rejects(start({ cwd: dir, executable: script }), /native binary/i);
    session = await start({ cwd: dir, executable: binary });
    assert.equal(session.wait, true);
    assert.equal((await list()).find(s => s.id === session.id)?.close, true);
    assert.equal(await lookupBridge('claude:../../other'), null);
    assert.equal(await lookupBridge('claude:00000000-0000-4000-8000-000000000000'), null);
    assert.deepEqual(await waitIdle(session, 0), { status: 'completed' });
    assert.equal(await send(session, 'slow'), undefined);
    assert.deepEqual(await waitIdle(session, 0), { status: 'timeout' });
    assert.deepEqual(await waitIdle(session, 20), { status: 'timeout' });
    await assert.rejects(send(session, 'must not be delivered'), /busy/i);
    const waitingIndefinitely = waitIdle(session, null);
    assert.deepEqual(await waitIdle(session, 70000), { status: 'completed' });
    assert.deepEqual(await waitingIndefinitely, { status: 'completed' });
    assert.deepEqual(await waitIdle(session, 0), { status: 'completed' });
    const registry = join(dir, 'broken-registry');
    await mkdir(registry);
    await writeFile(join(registry, 'claude'), '#!/bin/sh\nexit 2\n', { mode: 0o700 });
    process.env.PATH = registry;
    await assert.rejects(list(), /registry unavailable/i);
    const discovered = await lookupBridge(session.id);
    assert.equal(discovered?.pid, session.pid);
    assert.equal(discovered?.wait, true);
    assert.deepEqual(await history(discovered, Infinity), [{ role: 'user', text: 'slow' }, { role: 'assistant', text: 'intermediate' }]);
    assert.equal(await send(discovered, 'fail'), undefined);
    assert.equal((await waitIdle(session, 2000)).status, 'failed');
    assert.equal((await waitIdle(session, 0)).status, 'failed');
    await assert.rejects(waitIdle(session, -1), /Invalid wait timeout/);
    process.env.PATH = join(dir, 'empty-path');

    legacy = spawn(process.execPath, [fileURLToPath(new URL('../adapters/claude-bridge.mjs', import.meta.url)), binary], { cwd: dir, stdio: ['ignore', 'ignore', 'pipe'] });
    const legacyId = await new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error('Legacy bridge startup timed out')), 5000);
      legacy.once('error', reject);
      legacy.once('exit', () => reject(new Error('Legacy bridge exited')));
      legacy.stderr.on('data', chunk => {
        output += chunk;
        const match = /claude:([0-9a-f-]{36})/i.exec(output);
        if (match) { clearTimeout(timer); resolve(match[1]); }
      });
    });
    const old = (await list()).find(s => s.id === `claude:${legacyId}`);
    assert.ok(old);
    assert.equal(old.wait, false);
    assert.equal(old.close, false);
    await assert.rejects(waitIdle(old, 0), /does not support waiting/);
    await assert.rejects(request(legacyId, { op: 'waitIdle', timeoutMs: 0 }), /Invalid request/);
    assert.equal(await send(old, 'legacy prompt'), undefined);
    await assert.rejects(close(old), /does not support closing/);

    assert.equal(await send(session, 'slow'), undefined);
    const waiting = waitIdle(session, 2000);
    await new Promise(resolve => setTimeout(resolve, 20));
    await close(session);
    assert.equal((await waiting).status, 'interrupted');
    session = await start({ cwd: dir, executable: binary });
    assert.equal(await send(session, 'die'), undefined);
    assert.equal((await waitIdle(session, 2000)).status, 'failed');
    await close(session);
    await assert.rejects(request(legacyId, { op: 'close' }), /Invalid request/);
  } finally {
    if (session) await close(session).catch(() => {});
    if (legacy && legacy.exitCode === null) {
      legacy.kill('SIGTERM');
      await new Promise(resolve => legacy.once('exit', resolve));
    }
    if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
    if (originalConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = originalConfig;
    if (originalLocale === undefined) delete process.env.LC_ALL; else process.env.LC_ALL = originalLocale;
    if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
    await rm(dir, { recursive: true, force: true });
  }
});
