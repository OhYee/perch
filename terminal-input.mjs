import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
// Without extended-key negotiation backends can collapse Ctrl+Enter into Enter.
const ctrlEnter = '\x1b[13;5u';
const keys = {
  enter: ['Enter', 'Enter', 'enter'],
  escape: ['Escape', 'Escape', 'esc'],
  tab: ['Tab', 'Tab', 'tab'],
  backspace: ['Backspace', 'BSpace', 'backspace'],
  up: ['ArrowUp', 'Up', 'up'],
  down: ['ArrowDown', 'Down', 'down'],
  left: ['ArrowLeft', 'Left', 'left'],
  right: ['ArrowRight', 'Right', 'right'],
  'ctrl+q': ['Ctrl+q', 'C-q', 'ctrl+q'],
  'ctrl+enter': [ctrlEnter, ctrlEnter, ctrlEnter],
};
export const supportedTerminalKeys = Object.freeze(Object.keys(keys));

async function command(file, args) {
  const { stdout } = await exec(file, args, { timeout: 2500, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } });
  return stdout;
}

async function processInfo(pid) {
  const row = (await command('ps', ['-p', String(pid), '-o', 'pid=,pgid=,tpgid=,tty='])).trim();
  const match = /^(\d+)\s+(\d+)\s+(-?\d+)\s+(\S+)$/.exec(row);
  if (!match || Number(match[1]) !== pid || match[4] === '?' || match[4] === '??') throw Error('process unavailable');
  return { pgid: Number(match[2]), tpgid: Number(match[3]), tty: match[4].replace(/^\/dev\//, '') };
}

async function tmuxPanes() {
  const rows = await command('tmux', ['-N', 'list-panes', '-a', '-F', '#{pane_id}|#{pane_pid}|#{pane_tty}|#{pane_dead}|#{pane_in_mode}']);
  return rows.trim().split('\n').filter(Boolean).map(row => {
    const match = /^(%\d+)\|(\d+)\|\/dev\/([^|]+)\|([01])\|([01])$/.exec(row);
    if (!match) throw Error('invalid tmux pane');
    return { id: match[1], pid: Number(match[2]), tty: match[3], dead: match[4] === '1', inMode: match[5] === '1' };
  });
}

async function ternBlocks() {
  const data = JSON.parse(await command('tern', ['ls', '--json']));
  if (!Array.isArray(data.sessions)) throw Error('invalid Tern listing');
  const blocks = [];
  for (const session of data.sessions) {
    if (!Array.isArray(session.tabs)) throw Error('invalid Tern listing');
    for (const tab of session.tabs) {
      if (!Array.isArray(tab.blocks)) throw Error('invalid Tern listing');
      for (const block of tab.blocks) {
        if (block.live !== true || !block.program) continue;
        if (!Number.isSafeInteger(block.id) || block.id <= 0) throw Error('invalid Tern block');
        blocks.push(String(block.id));
      }
    }
  }
  return blocks;
}

async function ternProcess(id) {
  const data = JSON.parse(await command('tern', ['process', id, '--json']));
  if (String(data.pane) !== id || (data.foreground !== null && !Number.isSafeInteger(data.foreground?.pid))) throw Error('invalid Tern process');
  return data;
}

async function herdrPanes() {
  const data = JSON.parse(await command('herdr', ['pane', 'list']));
  const panes = data?.result?.panes;
  if (!Array.isArray(panes)) throw Error('invalid Herdr listing');
  return panes.map(pane => {
    if (typeof pane?.pane_id !== 'string' || !pane.pane_id) throw Error('invalid Herdr pane');
    return pane.pane_id;
  });
}

async function herdrProcess(id) {
  const data = JSON.parse(await command('herdr', ['pane', 'process-info', '--pane', id]));
  const info = data?.result?.process_info;
  if (!info || info.pane_id !== id || !Array.isArray(info.foreground_processes)) throw Error('invalid Herdr process');
  return info;
}

function herdrMatches(info, pid, pgid) {
  return info.foreground_process_group_id === pgid && info.foreground_processes.some(proc => proc?.pid === pid);
}

async function findTarget(pid) {
  const process = await processInfo(pid);
  if (process.pgid <= 0 || process.pgid !== process.tpgid) throw Error('not foreground');
  let panes;
  try { panes = await tmuxPanes(); } catch { panes = []; }
  const matching = panes.filter(pane => pane.tty === process.tty);
  if (matching.length) {
    if (matching.length !== 1) throw Error('ambiguous tmux pane');
    if (pid !== process.tpgid) throw Error('tmux foreground is not the target process');
    const pane = matching[0];
    if (pane.dead || pane.inMode) throw Error('tmux pane unavailable');
    const owner = await processInfo(pane.pid);
    if (owner.tty !== pane.tty || owner.tpgid !== process.pgid) throw Error('tmux pane mismatch');
    return { backend: 'tmux', id: pane.id, panePid: pane.pid, tty: pane.tty };
  }
  let blocks;
  try { blocks = await ternBlocks(); } catch { blocks = null; }
  if (blocks) {
    const results = await Promise.all(blocks.map(async id => ({ id, process: await ternProcess(id) })));
    const found = results.filter(row => row.process.foreground?.pid === pid);
    if (found.length === 1) return { backend: 'tern', id: found[0].id };
    if (found.length > 1) throw Error('Tern block ambiguous');
  }
  const herdrIds = await herdrPanes();
  const herdrResults = await Promise.all(herdrIds.map(async id => ({ id, info: await herdrProcess(id) })));
  const herdrFound = herdrResults.filter(row => herdrMatches(row.info, pid, process.pgid));
  if (herdrFound.length !== 1) throw Error('Terminal pane unavailable or ambiguous');
  return { backend: 'herdr', id: herdrFound[0].id };
}

async function recheck(target, pid) {
  const process = await processInfo(pid);
  if (process.pgid <= 0 || process.pgid !== process.tpgid) throw Error('not foreground');
  if (target.backend === 'tern') {
    if ((await ternProcess(target.id)).foreground?.pid !== pid) throw Error('foreground changed');
    return;
  }
  if (target.backend === 'herdr') {
    if (!herdrMatches(await herdrProcess(target.id), pid, process.pgid)) throw Error('Herdr foreground changed');
    return;
  }
  if (pid !== process.tpgid) throw Error('tmux foreground is not the target process');
  const panes = (await tmuxPanes()).filter(pane => pane.id === target.id || pane.tty === target.tty);
  if (panes.length !== 1) throw Error('tmux pane changed');
  const pane = panes[0];
  if (pane.id !== target.id || pane.pid !== target.panePid || pane.tty !== target.tty || pane.tty !== process.tty || pane.dead || pane.inMode) throw Error('tmux pane changed');
  const owner = await processInfo(pane.pid);
  if (owner.tty !== pane.tty || owner.tpgid !== process.pgid) throw Error('tmux foreground changed');
}

function keyIndex(backend) {
  return backend === 'tern' ? 0 : backend === 'tmux' ? 1 : 2;
}

// Success means the terminal acknowledged input, not that the application accepted it.
export async function sendTerminalInput({ pid, mode, text, enter, confirm, lang }) {
  const tr = (en, zh) => lang === 'zh' ? zh : en;
  let attempted = false;
  try {
    if (!Number.isSafeInteger(pid) || pid <= 0 || typeof confirm !== 'function' || !['text', 'key'].includes(mode)) throw Error('invalid request');
    const key = mode === 'key' && typeof text === 'string' && Object.hasOwn(keys, text.toLowerCase()) ? keys[text.toLowerCase()] : null;
    if (mode === 'key' && !key) throw Error('invalid key');
    const target = await findTarget(pid);
    const mutate = async (kind, value) => {
      await recheck(target, pid);
      await confirm();
      attempted = true;
      if (target.backend === 'tern') await command('tern', ['send', target.id, kind === 'text' ? 'text' : 'keys', value]);
      else if (target.backend === 'herdr') await command('herdr', ['pane', kind === 'text' ? 'send-text' : 'send-keys', target.id, value]);
      else if (kind === 'text') await command('tmux', ['-N', 'send-keys', '-t', target.id, '-l', '--', value]);
      else await command('tmux', ['-N', 'send-keys', '-t', target.id, value]);
    };
    const idx = keyIndex(target.backend);
    if (mode === 'text') {
      await mutate('text', text);
      if (enter) await mutate('key', keys.enter[idx]);
    } else {
      const value = key[idx];
      await mutate(value === ctrlEnter ? 'text' : 'key', value);
    }
  } catch {
    const error = new Error(attempted
      ? tr('Terminal input may have been partially delivered; do not retry automatically.', '终端输入可能已部分送达；请勿自动重试。')
      : tr('Terminal input refused: could not verify the live foreground session.', '终端输入已拒绝：无法验证当前前台会话。'));
    if (attempted) error.deliveryUnknown = true;
    throw error;
  }
}
