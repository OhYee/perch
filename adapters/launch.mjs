import { spawn } from 'node:child_process';
import { bridgeInvocation } from '../portable-runtime.mjs';

// Only invoked by `start` with an adapter-owned module. The child reports its
// identity over the inherited pipe, never via a title/PID search or a log.
export function launchBridge(moduleURL, { cwd, env = process.env, args = [] }) {
  return new Promise((resolve, reject) => {
    const [executable, ...entry] = bridgeInvocation(moduleURL);
    const child = spawn(executable, [...entry, ...args], {
      cwd, env, detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    const timer = setTimeout(() => fail(new Error('Timed out starting agent')), 30000);
    function cleanup() {
      clearTimeout(timer);
      child.off('exit', exited);
      child.off('message', ready);
      child.off('error', fail);
      child.off('disconnect', disconnected);
    }
    function fail(error) {
      cleanup();
      // Kill the isolated process group, including any not-yet-ready agent.
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') return reject(e); }
      }
      reject(error);
    }
    function disconnected() { fail(new Error('Agent disconnected before startup completed')); }
    function exited() { fail(new Error('Agent exited before startup completed')); }
    function ready(msg) {
      if (msg?.ready !== true || !msg.session?.id || !msg.session?.send || !msg.session?.wait) {
        return fail(new Error(msg?.error || 'Agent startup failed'));
      }
      cleanup();
      child.disconnect();
      child.unref();
      resolve(msg.session);
    }
    child.once('error', fail);
    child.once('exit', exited);
    child.once('disconnect', disconnected);
    child.once('message', ready);
  });
}
