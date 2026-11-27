#!/usr/bin/env node
import { parseArgs, promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { access, lstat, mkdir, open, readFile, realpath, rename, stat, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { connect } from 'node:net';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLanguage } from './locale.mjs';
import { translateDiagnostic } from './diagnostics.mjs';
import { overview, commandHelp, sessionStatus } from './help.mjs';
import { followConversation } from './view.mjs';
import { sendTerminalInput, supportedTerminalKeys } from './terminal-input.mjs';
import { cliInvocation, embeddedOmpExtension, getVersion, repository, kind, entry } from './portable-runtime.mjs';

const providers = ['omp', 'codex', 'claude', 'agy'];
const labels = {
  session: '会话', process: '进程', yes: '是', no: '否', live: '实时', persisted: '已保存',
  user: '用户', assistant: '助手', system: '系统', tool: '工具', developer: '开发者',
  completed: '已完成', timeout: '等待超时', needs_input: '需要人工输入', failed: '失败', interrupted: '已中断',
};
let lang = 'en';
const tr = (en, zh) => lang === 'zh' ? zh : en;
const label = value => lang === 'zh' && Object.hasOwn(labels, value) ? labels[value] : value;
const diagnostic = message => translateDiagnostic(String(message), lang);
const statusInk = { idle: 32, running: 36, blocked: 33, failed: 31, stopped: 2, unknown: 2 };
const style = (text, code, stream = process.stdout) =>
  stream.isTTY && !Object.hasOwn(process.env, 'NO_COLOR') && process.env.TERM !== 'dumb' && !process.argv.slice(2).includes('--json')
    ? `\x1b[${code}m${text}\x1b[0m` : text;
function highlightHelp(help) {
  const token = /(\bperch\s+)(integration(?:\s+(?:install(?:\s+(?:omp|agy))?|agy-hook|agy-statusline))?|list|start|resume|send|input|wait|history|view|close|version|update|help)\b|(?<![\w-])--[\w-]+|(?<![\w-])-[a-zA-Z](?![\w-])|<[^<>\n]+>|\b(?:idle|running|blocked|failed|stopped|unknown)\b/g;
  return help.split('\n').map(line => {
    if (/^\s*(?:Usage:|用法：|Examples:|示例：)\s*$/.test(line)) return style(line, 1);
    return line.replace(token, (match, prefix, command) => {
      if (prefix) return prefix + style(command, '1;36');
      if (match.startsWith('-')) return style(match, 33);
      if (match.startsWith('<')) return style(match, 35);
      return style(match, statusInk[match]);
    });
  }).join('\n');
}
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
function displayWidth(text) {
  let width = 0;
  for (const { segment } of segmenter.segment(text)) {
    if (/^\p{Mark}+$/u.test(segment)) continue;
    const cp = segment.codePointAt(0);
    width += /\p{Emoji_Presentation}|\u20e3|\ufe0f/u.test(segment) ||
      (cp >= 0x1100 && (cp <= 0x115f || cp === 0x2329 || cp === 0x232a ||
        (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
        (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) ||
        (cp >= 0xfe10 && cp <= 0xfe19) || (cp >= 0xfe30 && cp <= 0xfe6f) ||
        (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) ||
        (cp >= 0x20000 && cp <= 0x3fffd))) ? 2 : 1;
  }
  return width;
}
function argumentError(error) {
  if (lang !== 'zh' || !error.code?.startsWith('ERR_PARSE_ARGS_')) return error;
  const option = quote(error.message.match(/'[^']*'/)?.[0] ?? '');
  const detail = {
    ERR_PARSE_ARGS_UNKNOWN_OPTION: `未知选项 ${option}`,
    ERR_PARSE_ARGS_INVALID_OPTION_VALUE: `选项 ${option} 的值无效或缺失`,
    ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL: '不接受位置参数',
  }[error.code] ?? '参数无效';
  return Error(detail);
}
const quote = s => String(s ?? '').replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/gu, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
const multiline = s => String(s).split('\n').map(quote).join('\n');
const json = value => console.log(JSON.stringify(value, null, 2));
const opt = (type = 'boolean') => ({ type });
async function adapter(name) {
  if (!providers.includes(name)) throw Error(tr(`Unknown provider: ${quote(name)}`, `未知提供方：${quote(name)}`));
  if (name === 'omp') return import('./adapters/omp.mjs');
  if (name === 'codex') return import('./adapters/codex.mjs');
  if (name === 'agy') return import('./adapters/agy.mjs');
  return import('./adapters/claude.mjs');
}

function validatePaneOptions(values) {
  if (values.split !== undefined && !['right', 'down'].includes(values.split)) {
    throw Error(tr('--split must be right or down', '--split 必须是 right 或 down'));
  }
  if (values.target !== undefined && (!values.target.trim() || values.target.startsWith('-') || /[\x00-\x1f\x7f-\x9f]/u.test(values.target))) {
    throw Error(tr('--target requires a valid pane ID', '--target 需要有效的窗格 ID'));
  }
  if ((values.split !== undefined || values.target !== undefined) && values.pane !== 'right') {
    throw Error(tr('--split and --target require --pane right', '--split 和 --target 需要 --pane right'));
  }
  if (values.pane === undefined) {
    if (values.workspace !== undefined || values.tab !== undefined) throw Error(tr('--workspace and --tab require --pane tern, tmux, or herdr', '--workspace 和 --tab 需要 --pane tern、tmux 或 herdr'));
    return;
  }
  if (!['right', 'tern', 'tmux', 'herdr'].includes(values.pane)) throw Error(tr('--pane must be right, tern, tmux, or herdr', '--pane 必须是 right、tern、tmux 或 herdr'));
  if (values.pane === 'right') {
    if (values.workspace !== undefined || values.tab !== undefined) throw Error(tr('--workspace and --tab require --pane tern, tmux, or herdr', '--workspace 和 --tab 需要 --pane tern、tmux 或 herdr'));
    return;
  }
  for (const name of ['workspace', 'tab']) {
    const value = values[name];
    if (value === undefined || !value.trim() || value.startsWith('-') || /[\x00-\x1f\x7f-\x9f\u2028-\u202e\u2066-\u2069]/u.test(value)) {
      throw Error(tr(`--pane ${values.pane} requires a valid --${name}`, `--pane ${values.pane} 需要有效的 --${name}`));
    }
  }
}

async function resolveExecutable(name) {
  if (!name || name.startsWith('-') || /[\x00-\x1f\x7f-\x9f]/u.test(name)) {
    throw Error(tr('Invalid executable', '可执行文件无效'));
  }
  const candidates = name.includes('/')
    ? [resolve(name)]
    : (process.env.PATH ?? '/usr/bin:/bin').split(delimiter).map(dir => resolve(dir || '.', name));
  for (const candidate of candidates) {
    try {
      if (!(await stat(candidate)).isFile()) continue;
      await access(candidate, constants.X_OK);
      return await realpath(candidate);
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR', 'EACCES'].includes(error.code)) throw error;
    }
  }
  throw Error(tr(`Executable not found or not executable: ${quote(name)}`, `找不到可执行文件或无执行权限：${quote(name)}`));
}

function nativeEnvironment(provider) {
  if (provider === 'agy') return [`HOME=${resolve(homedir())}`];
  const names = provider === 'codex' ? ['CODEX_HOME']
    : provider === 'claude' ? ['CLAUDE_CONFIG_DIR']
      : ['OMP_PROFILE', 'PI_PROFILE', 'PI_CONFIG_DIR', 'PI_CODING_AGENT_DIR', 'XDG_STATE_HOME'];
  const paths = new Set(['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'PI_CODING_AGENT_DIR', 'XDG_STATE_HOME']);
  const unset = [], assignments = [];
  for (const name of names) {
    const value = process.env[name];
    if (value === undefined) unset.push('-u', name);
    else assignments.push(`${name}=${paths.has(name) && value ? resolve(value) : value}`);
  }
  if (provider === 'omp' && process.env.PERCH_MANAGED_WORKER === '1') {
    assignments.push('PERCH_MANAGED_WORKER=1');
  }
  return [...unset, ...assignments];
}

function nativeYoloArgs(provider, providerArgs) {
  const hasFlag = (...flags) => providerArgs.some(arg => flags.some(flag => arg === flag || arg.startsWith(`${flag}=`)));
  if (provider === 'agy') return ['--dangerously-skip-permissions'];
  if (provider === 'omp') {
    return hasFlag('--approval-mode', '--auto-approve') ? [] : ['--approval-mode', 'yolo'];
  }
  if (provider === 'codex') {
    return hasFlag('--dangerously-bypass-approvals-and-sandbox', '--full-auto', '-a', '--ask-for-approval', '-s', '--sandbox')
      ? [] : ['--dangerously-bypass-approvals-and-sandbox'];
  }
  if (provider === 'claude') {
    return hasFlag('--permission-mode', '--dangerously-skip-permissions')
      ? [] : ['--permission-mode', 'bypassPermissions', '--dangerously-skip-permissions'];
  }
  return [];
}

async function ensureAgyTrustedWorkspace(cwd) {
  try {
    const realCwd = await realpath(cwd).catch(() => resolve(cwd));
    const settingsDir = join(homedir(), '.gemini', 'antigravity-cli');
    const settingsPath = join(settingsDir, 'settings.json');
    const lockPath = join(settingsDir, '.settings.lock');
    await mkdir(settingsDir, { recursive: true, mode: 0o700 });

    let locked = false;
    for (let attempt = 0; attempt < 25; attempt++) {
      try {
        const lh = await open(lockPath, 'wx', 0o600);
        await lh.close();
        locked = true;
        break;
      } catch (error) {
        if (error?.code !== 'EEXIST') return;
        try {
          const info = await lstat(lockPath);
          if (Date.now() - info.mtimeMs > 10000) await unlink(lockPath).catch(() => {});
        } catch {}
        await new Promise(r => setTimeout(r, 20));
      }
    }
    if (!locked) return;

    try {
      let data = {};
      try {
        const handle = await open(settingsPath, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const info = await handle.stat();
          if (!info.isFile()) return;
          const parsed = JSON.parse(await handle.readFile('utf8'));
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
          data = parsed;
        } finally {
          await handle.close();
        }
      } catch (error) {
        if (error?.code !== 'ENOENT') return;
      }
      if (data.trustedWorkspaces === undefined) data.trustedWorkspaces = [];
      if (!Array.isArray(data.trustedWorkspaces)) return;
      if (data.trustedWorkspaces.includes(realCwd)) return;
      data.trustedWorkspaces.push(realCwd);

      const tmpPath = join(settingsDir, `.settings.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
      try {
        const handle = await open(tmpPath, 'wx', 0o600);
        try {
          await handle.writeFile(`${JSON.stringify(data, null, 2)}\n`, 'utf8');
        } finally {
          await handle.close();
        }
        await rename(tmpPath, settingsPath);
      } catch (error) {
        await unlink(tmpPath).catch(() => {});
        throw error;
      }
    } finally {
      await unlink(lockPath).catch(() => {});
    }
  } catch {
    // Best-effort only: never block launching agy if settings.json is unavailable.
  }
}

function buildNativeCommand(provider, nativeExecutable, values, initialPrompt, providerArgs = []) {
  const command = ['/usr/bin/env', ...nativeEnvironment(provider), nativeExecutable, ...nativeYoloArgs(provider, providerArgs)];
  if (values.model !== undefined) command.push('--model', values.model);
  if (values.resume !== undefined) {
    if (provider === 'agy') command.push(`--resume=${values.resume}`);
    else command.push('--resume', values.resume);
  }
  command.push(...providerArgs);
  if (initialPrompt !== undefined) {
    // agy 的交互提示词是一个选项值，不是任意位置参数或独立开关。
    if (provider === 'agy') command.push(`--prompt-interactive=${initialPrompt}`);
    else command.push('--', initialPrompt);
  }
  return command;
}

async function launchPane(values, session, provider, cwd, nativeExecutable, initialPrompt, providerArgs = []) {
  if (nativeExecutable && provider === 'agy') {
    await ensureAgyTrustedWorkspace(cwd);
  }
  if (nativeExecutable && values.pane === 'right' && values.target !== undefined) {
    const direction = values.split ?? 'down';
    const command = buildNativeCommand(provider, nativeExecutable, values, initialPrompt, providerArgs);
    let stdout;
    try {
      ({ stdout } = await promisify(execFile)('tern', ['split', values.target, direction, '--cwd', cwd, '--json', '--', ...command], { maxBuffer: 1024 * 1024 }));
    } catch (error) {
      throw Error(String(error.stderr || error.message).trim());
    }
    let result;
    try { result = JSON.parse(stdout); } catch { throw Error('Invalid tern split response'); }
    if (!result || !['string', 'number'].includes(typeof result.block) || !String(result.block)) {
      throw Error('Invalid tern split response');
    }
    return { backend: 'tern', id: result.block };
  }
  const args = ['--mode', 'right'];
  if (values.pane !== 'right') args.push('--backend', values.pane, '--session', values.workspace, '--tab', values.tab);
  if (nativeExecutable) {
    args.push('--cwd', cwd, '--', ...buildNativeCommand(provider, nativeExecutable, values, initialPrompt, providerArgs));
  } else {
    args.push('--wait-output', '[as-ready]', '--');
    const environment = provider === 'codex'
      ? [`CODEX_HOME=${resolve(cwd, process.env.CODEX_HOME || join(homedir(), '.codex'))}`]
      : provider === 'omp'
        ? [...(process.env.XDG_STATE_HOME ? [`XDG_STATE_HOME=${resolve(cwd, process.env.XDG_STATE_HOME)}`] : ['-u', 'XDG_STATE_HOME']),
            `PI_CODING_AGENT_DIR=${resolve(cwd, process.env.PI_CODING_AGENT_DIR || join(homedir(), '.omp/agent'))}`]
        : provider === 'agy'
          ? [...(process.env.XDG_STATE_HOME ? [`XDG_STATE_HOME=${resolve(process.env.XDG_STATE_HOME)}`] : ['-u', 'XDG_STATE_HOME']),
              `HOME=${resolve(homedir())}`]
          : [`CLAUDE_CONFIG_DIR=${resolve(cwd, process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'))}`];
    args.push('/usr/bin/env', ...environment, ...cliInvocation(), 'view', session.id, '--lang', lang);
  }
  let stdout;
  try {
    ({ stdout } = await promisify(execFile)('terminal-pane', args, { maxBuffer: 1024 * 1024 }));
  } catch (error) {
    throw Error(String(error.stderr || error.message).trim());
  }
  let result;
  try { result = JSON.parse(stdout); } catch { throw Error('Invalid terminal-pane response'); }
  if (!result || !['tern', 'tmux', 'herdr'].includes(result.backend) || !['string', 'number'].includes(typeof result.pane) || !String(result.pane)) {
    throw Error('Invalid terminal-pane response');
  }
  return { backend: result.backend, id: result.pane };
}
function publicSession({ id, provider, kind = 'session', pid, cwd, title, status, send, history, wait = false, close = false, sendReason, historyReason, historyMode }) {
  return { id, provider, kind, pid, cwd, title: typeof title === 'string' && title.trim() ? title : null, status: typeof status === 'string' && Object.hasOwn(sessionStatus, status) ? status : 'unknown', send, history, wait, close, sendReason, historyReason, historyMode };
}

async function readStdin(limit, tooLarge) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > limit) throw Error(tooLarge);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, bytes);
}

async function promptText(value, stdin) {
  if (stdin) {
    if (process.stdin.isTTY) throw Error(tr('--stdin expects piped or redirected text', '--stdin 需要管道或重定向输入'));
    value = (await readStdin(1024 * 1024, tr('Message exceeds 1 MiB', '消息超过 1 MiB'))).toString('utf8');
  }
  if (value !== undefined && !value.trim()) throw Error(tr('Message must not be empty', '消息不能为空'));
  return value;
}

async function installOmpIntegration() {
  const validProfile = value => /^[a-z0-9][a-z0-9._-]{0,63}$/.test(value) &&
    !value.endsWith('.') && !/^(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\..*)?$/i.test(value);
  const profile = (process.env.OMP_PROFILE ?? process.env.PI_PROFILE ?? '').trim();
  if (profile && profile !== 'default' && !validProfile(profile)) {
    throw Error(tr(`Invalid OMP profile: ${quote(profile)}`, `无效的 OMP profile：${quote(profile)}`));
  }
  const namedProfile = profile && profile !== 'default';
  const root = join(homedir(), process.env.PI_CONFIG_DIR || '.omp');
  const legacyProfile = (process.env.PI_PROFILE ?? '').trim();
  const inheritedProfileDir = legacyProfile && legacyProfile !== 'default' && validProfile(legacyProfile)
    ? join(root, 'profiles', legacyProfile, 'agent') : undefined;
  const agentOverride = process.env.PI_CODING_AGENT_DIR;
  const agentDir = namedProfile
    ? join(root, 'profiles', profile, 'agent')
    : agentOverride && agentOverride !== inheritedProfileDir ? resolve(agentOverride) : join(root, 'agent');
  const dir = join(agentDir, 'extensions');
  const path = join(dir, 'agent-session.ts');
  const content = embeddedOmpExtension ?? `export { default } from ${JSON.stringify(fileURLToPath(new URL('./omp-extension.ts', import.meta.url)))};\n`;
  const conflict = () => Error(tr(
    `Cannot install OMP integration: ${quote(path)} already exists and is not this installation; remove or move it before retrying.`,
    `无法安装 OMP 集成：${quote(path)} 已存在且不是本次安装的文件；请先移走或删除它，再重试。`,
  ));
  await mkdir(dir, { recursive: true, mode: 0o700 });
  try {
    const file = await open(path, 'wx', 0o600);
    try { await file.writeFile(content); } finally { await file.close(); }
    return { provider: 'omp', status: 'installed', path };
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  if (!(await lstat(path)).isFile()) throw conflict();
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (error.code === 'ELOOP') throw conflict();
    throw error;
  }
  try {
    if (!(await file.stat()).isFile() || await file.readFile('utf8') !== content) throw conflict();
  } finally { await file.close(); }
  return { provider: 'omp', status: 'already_installed', path };
}

function shellQuote(arg) {
  return `'${String(arg).replaceAll("'", "'\\''")}'`;
}

async function installAgyIntegration() {
  const configDir = process.env.AGY_CONFIG_DIR ? resolve(process.env.AGY_CONFIG_DIR) : join(homedir(), '.gemini', 'config');
  const dir = join(configDir, 'plugins', 'perch');
  const command = `${cliInvocation().map(shellQuote).join(' ')} integration agy-hook`;
  const handler = [{ type: 'command', command, timeout: 5 }];
  const files = [
    [join(dir, 'plugin.json'), `${JSON.stringify({ name: 'perch' }, null, 2)}\n`],
    [join(dir, 'hooks.json'), `${JSON.stringify({
      'perch-native': {
        SessionStart: handler,
        PreInvocation: handler,
        Stop: handler,
      },
    }, null, 2)}\n`],
  ];
  const conflict = target => Error(tr(
    `Cannot install AGY integration: ${quote(target)} already exists and is not this installation; remove or move it before retrying.`,
    `无法安装 AGY 集成：${quote(target)} 已存在且不是本次安装的文件；请先移走或删除它，再重试。`,
  ));
  const existingDir = await lstat(dir).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (existingDir && !existingDir.isDirectory()) throw conflict(dir);
  const states = [];
  for (const [path, content] of files) {
    const info = await lstat(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (!info) {
      states.push({ path, content, present: false });
      continue;
    }
    if (!info.isFile()) throw conflict(path);
    let file;
    try {
      file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
      if (error.code === 'ELOOP') throw conflict(path);
      throw error;
    }
    try {
      if (!(await file.stat()).isFile() || await file.readFile('utf8') !== content) throw conflict(path);
    } finally { await file.close(); }
    states.push({ path, content, present: true });
  }
  if (states.every(item => item.present)) return { provider: 'agy', status: 'already_installed', path: dir };
  await mkdir(dir, { recursive: true, mode: 0o700 });
  for (const { path, content, present } of states) {
    if (present) continue;
    try {
      const file = await open(path, 'wx', 0o600);
      try { await file.writeFile(content); } finally { await file.close(); }
    } catch (error) {
      if (error.code === 'EEXIST') throw conflict(path);
      throw error;
    }
  }
  return { provider: 'agy', status: 'installed', path: dir };
}

async function run([command, ...args]) {
  const rootHelp = overview(lang);
  if (command === '--version' || command === '-V') {
    if (args.length) throw Error(tr('Version flags take no arguments', '版本选项不接受参数'));
    return console.log(await getVersion());
  }
  if (!command || command === '--help' || command === '-h' || (command === 'help' && !args.length)) {
    return console.log(highlightHelp(rootHelp));
  }
  const boundary = args.indexOf('--');
  const beforeBoundary = boundary === -1 ? args : args.slice(0, boundary);
  if (command === 'help' || beforeBoundary.some(arg => arg === '--help' || arg === '-h')) {
    let topic;
    if (command === 'help') {
      topic = args.length === 1 && ['--help', '-h'].includes(args[0]) ? 'help' : args.join(' ');
    } else if (command === 'integration') {
      topic = [command, ...beforeBoundary.filter(arg => !['--help', '-h', '--json'].includes(arg))].join(' ');
    } else {
      topic = command;
    }
    const page = commandHelp(topic, lang);
    if (!page) throw Error(tr(`Unknown help topic: ${quote(topic)}`, `未知帮助主题：${quote(topic)}`));
    return console.log(highlightHelp(page));
  }
  const help = commandHelp(command, lang) ?? rootHelp;
  const options = { json: opt() };
  if (command === 'update') Object.assign(options, { check: opt(), beta: opt(), repo: opt('string') });
  if (command === 'list') options.provider = opt('string');
  else if (command === 'history') Object.assign(options, { limit: opt('string'), all: opt() });
  else if (command === 'send') options.stdin = opt();
  else if (command === 'input') Object.assign(options, { key: opt('string'), enter: opt() });
  else if (command === 'start') Object.assign(options, { cwd: opt('string'), model: opt('string'), resume: opt('string'), executable: opt('string'), native: opt(), pane: opt('string'), split: opt('string'), target: opt('string'), workspace: opt('string'), tab: opt('string') });
  else if (command === 'wait') options.timeout = opt('string');
  else if (command === 'board') Object.assign(options, { socket: opt('string'), token: opt('string'), item: opt('string'), text: opt('string'), stdin: opt(), handoff: opt(), title: opt('string'), decision: opt('string'), revision: opt('string'), target: opt('string'), items: opt('string') });
  else if (!['resume', 'close', 'integration', 'view', 'version', 'update'].includes(command)) throw Error(tr(`Unknown command: ${quote(command)}\n${rootHelp}`, `未知命令：${quote(command)}\n${rootHelp}`));
  let values, positionals;
  try { ({ values, positionals } = parseArgs({ args: command === 'start' ? beforeBoundary : args, options, allowPositionals: true })); }
  catch (error) { throw argumentError(error); }
  if (command === 'board') {
    const [op, ...extra] = positionals;
    if (!op || extra.length) throw Error(help);
    const socketPath = values.socket ?? process.env.PERCH_BOARD_SOCKET;
    const token = values.token ?? process.env.PERCH_BOARD_TOKEN;
    if (!socketPath || !token) throw Error(tr('board needs --socket and --token (see the Session Board access instructions you were given)', 'board 需要 --socket 和 --token（见您收到的 Session Board access 说明）'));
    let text = values.text;
    if (values.stdin) {
      if (process.stdin.isTTY) throw Error(tr('--stdin expects piped or redirected text', '--stdin 需要管道或重定向输入'));
      text = (await readStdin(200 * 1024, tr('Board text exceeds 200 KiB', 'board 文本超过 200 KiB'))).toString('utf8');
    }
    if (values.revision !== undefined && !/^\d+$/.test(values.revision)) throw Error(tr('--revision must be a non-negative integer', '--revision 必须是非负整数'));
    const request = {
      token, op,
      ...(text !== undefined ? { text } : {}),
      ...(values.item !== undefined ? { item: values.item } : {}),
      ...(values.handoff ? { handoff: true } : {}),
      ...(values.title !== undefined ? { title: values.title } : {}),
      ...(values.decision !== undefined ? { decision: values.decision } : {}),
      ...(values.revision !== undefined ? { revision: Number(values.revision) } : {}),
      ...(values.target !== undefined ? { target: values.target } : {}),
      ...(values.items !== undefined ? { items: values.items.split(',').map(entry => entry.trim()).filter(Boolean) } : {}),
    };
    const response = await new Promise((resolveResponse, reject) => {
      const socket = connect(socketPath);
      let data = '';
      socket.setEncoding('utf8');
      socket.setTimeout(30000, () => { socket.destroy(); reject(Error(tr('board request timed out', 'board 请求超时'))); });
      socket.on('error', error => reject(Error(['ENOENT', 'ECONNREFUSED'].includes(error?.code)
        ? tr('board is unavailable (the owning session is no longer running); report your result in your final reply instead', 'board 不可用（所属会话已不在运行）；请改为在最终回复里汇报结果')
        : tr(`board connection failed: ${error?.message ?? 'unknown error'}`, `board 连接失败：${error?.message ?? '未知错误'}`))));
      socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`));
      socket.on('data', chunk => { data += chunk; });
      socket.on('end', () => {
        try { resolveResponse(JSON.parse(data.trim())); } catch { reject(Error(tr('Invalid board response', 'board 响应无效'))); }
      });
    });
    if (!response?.ok) throw Error(typeof response?.error === 'string' ? response.error : tr('board request failed', 'board 请求失败'));
    if (values.json) return json(response.result);
    return console.log(typeof response.result?.text === 'string' ? response.result.text : JSON.stringify(response.result, null, 2));
  }
  if (command === 'version' || command === 'update') {
    if (positionals.length) throw Error(tr(`${command} takes no positional arguments`, `${command} 不接受位置参数`));
    const version = await getVersion();
    if (command === 'version') return values.json ? json({ version }) : console.log(version);
    const { runUpdate } = await import('./update.mjs');
    const result = await runUpdate({ version, repository, kind, entry, check: !!values.check, beta: !!values.beta, repo: values.repo });
    if (values.json) return json(result);
    const message = {
      up_to_date: tr('Already up to date', '已是最新版本'),
      available: tr('Update available', '有可用更新'),
      updated: tr('Updated', '已更新'),
    }[result.status];
    return console.log(`${message}: ${quote(result.current)} → ${quote(result.latest)}`);
  }
  if (command === 'integration') {
    if (positionals[0] === 'agy-statusline') {
      if (positionals.length !== 1 || values.json || boundary !== -1) throw Error(commandHelp('integration agy-statusline', lang));
      if (process.stdin.isTTY) throw Error(tr('AGY status line expects JSON on piped stdin', 'AGY 状态行需要从管道读取 JSON'));
      const api = await adapter('agy');
      let input;
      try {
        const bytes = await readStdin(64 * 1024, tr('AGY status line report exceeds 64 KiB', 'AGY 状态行报告超过 64 KiB'));
        try { input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch {}
        if (!input || typeof input !== 'object' || Array.isArray(input)) {
          throw Error(tr('Invalid AGY status line JSON', 'AGY 状态行 JSON 无效'));
        }
      } catch (error) {
        // 只有来自真实 agy 状态行的回调才会清除旧绑定；错误不输出原始报告。
        try { await api.recordNativeStatus(null); } catch {}
        throw error;
      }
      return console.log(quote(diagnostic(await api.recordNativeStatus(input))));
    }
    if (positionals[0] === 'agy-hook') {
      if (positionals.length !== 1 || values.json || boundary !== -1) throw Error(commandHelp('integration agy-hook', lang));
      if (process.stdin.isTTY) throw Error(tr('AGY hook expects JSON on piped stdin', 'AGY hook 需要从管道读取 JSON'));
      const api = await adapter('agy');
      let input;
      try {
        const bytes = await readStdin(256 * 1024, tr('AGY hook payload exceeds 256 KiB', 'AGY hook 载荷超过 256 KiB'));
        try { input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch {}
        if (!input || typeof input !== 'object' || Array.isArray(input)) {
          throw Error(tr('Invalid AGY hook JSON', 'AGY hook JSON 无效'));
        }
      } catch (error) {
        try { await api.recordNativeHook(null); } catch {}
        throw error;
      }
      await api.recordNativeHook(input);
      return console.log('{}');
    }
    if (positionals.length !== 2 || positionals[0] !== 'install' || !['omp', 'agy'].includes(positionals[1])) {
      const topic = positionals[0] === 'install'
        ? positionals[1] === 'omp' ? 'integration install omp'
          : positionals[1] === 'agy' ? 'integration install agy'
            : 'integration install'
        : 'integration';
      throw Error(commandHelp(topic, lang));
    }
    const result = positionals[1] === 'agy' ? await installAgyIntegration() : await installOmpIntegration();
    return values.json ? json(result) : console.log(`${style(result.status === 'installed' ? tr('Installed', '已安装') : tr('Already installed', '已安装过'), 32)}: ${style(quote(result.path), 36)}`);
  }
  if (command === 'list') {
    if (positionals.length) throw Error(`${tr('list takes no positional arguments', 'list 不接受位置参数')}\n${help}`);
    const selected = values.provider === undefined ? providers : [values.provider];
    const results = await Promise.allSettled(selected.map(async name => (await (await adapter(name)).list()).map(publicSession)));
    const sessions = [];
    for (const [i, result] of results.entries()) {
      if (result.status === 'fulfilled') sessions.push(...result.value);
      else { console.error(style(`${quote(selected[i])}: ${quote(diagnostic(result.reason?.message ?? result.reason))}`, 31, process.stderr)); process.exitCode = 1; }
    }
    if (values.json) return json(sessions);
    if (!sessions.length) return console.log(process.exitCode ? tr('Discovery incomplete; no sessions returned.', '发现过程未完成；未返回会话。') : tr('No live sessions found.', '未找到活动会话。'));
    const reasons = new Map();
    function capability(enabled, reason, mode = 'yes') {
      if (enabled) return quote(label(mode));
      if (!reason) return label('no');
      if (!reasons.has(reason)) reasons.set(reason, reasons.size + 1);
      return `${label('no')}[${reasons.get(reason)}]`;
    }
    const rows = [tr(['TITLE', 'ID', 'HISTORY', 'SEND', 'STATUS', 'KIND', 'PID', 'CWD'], ['标题', 'ID', '历史', '发送', '状态', '类型', 'PID', '目录']), ...sessions.map(s => [
      quote(s.title) || '—', quote(s.id), capability(s.history, s.historyReason, s.historyMode), capability(s.send, s.sendReason),
      tr(s.status, sessionStatus[s.status]), quote(label(s.kind)), quote(s.pid) || '—', quote(s.cwd) || '—',
    ])];
    const [headers] = rows;
    const widths = headers.map((_, i) => rows.reduce((max, row) => Math.max(max, displayWidth(row[i])), 0));
    // The redirected table keeps its original column order.
    const order = process.stdout.isTTY ? [0, 1, 4, 2, 3, 5, 6, 7] : headers.map((_, i) => i);
    for (const [r, row] of rows.entries()) console.log(order.map(i => {
      const v = row[i];
      const ink = r === 0 || i === 0 ? 1 : i === 1 ? 36 : i === 4 ? statusInk[sessions[r - 1].status] : null;
      return (ink ? style(v, ink) : v) + (i === 7 ? '' : ' '.repeat(widths[i] - displayWidth(v)));
    }).join('  '));
    if (reasons.size) console.log();
    for (const [reason, n] of reasons) console.log(style(`[${n}] ${quote(diagnostic(reason))}`, 33));
    return;
  }
  const [id, argument] = positionals;
  if (!id) throw Error(help);
  if (command === 'start') {
    if (positionals.length > (values.native ? 2 : 1)) throw Error(help);
    if (argument !== undefined && !argument.trim()) throw Error(tr('Message must not be empty', '消息不能为空'));
    if (values.executable !== undefined && id !== 'claude') throw Error(tr('--executable is only for Claude', '--executable 仅用于 Claude'));
    const providerArgs = boundary === -1 ? [] : args.slice(boundary + 1);
    if (id === 'agy' && providerArgs.length) throw Error('Raw arguments are not supported for agy');
    if (id === 'agy' && argument?.includes('\0')) throw Error(tr('AGY native startup prompts must not contain NUL', 'AGY 原生启动提示词不能包含空字符'));
    if (!values.native && providerArgs.length && id !== 'omp') throw Error(tr('Raw arguments for this provider require --native', '此提供方仅在 --native 模式下支持原始参数'));
    if (!values.native && values.resume !== undefined) throw Error(tr('--resume on start requires --native (use perch resume <id> for managed sessions)', 'start 的 --resume 需要 --native（托管会话请使用 perch resume <id>）'));
    validatePaneOptions(values);
    const api = await adapter(id);
    const cwd = await realpath(values.cwd ?? process.cwd());
    if (!(await stat(cwd)).isDirectory()) throw Error(tr('--cwd must be a directory', '--cwd 必须是目录'));
    if (values.native) {
      if (values.pane === undefined) throw Error(tr('--native requires --pane right, tern, tmux, or herdr', '--native 需要 --pane right、tern、tmux 或 herdr'));
      if (values.model !== undefined && (!values.model.trim() || values.model.startsWith('-') || /[\x00-\x1f\x7f-\x9f]/u.test(values.model))) {
        throw Error(tr('Invalid model', '模型无效'));
      }
      if (values.resume !== undefined) {
        if (!['omp', 'agy'].includes(id)) throw Error(tr('--resume with --native is only supported for omp and agy', '--native --resume 仅支持 omp 和 agy'));
        if (!values.resume.trim() || values.resume.startsWith('-') || /[\s\x00-\x1f\x7f-\x9f]/u.test(values.resume)) {
          throw Error(tr('Invalid resume session ID', '恢复会话 ID 无效'));
        }
        if (id === 'agy' && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(values.resume)) {
          throw Error(tr('Invalid AGY resume conversation UUID', 'AGY 恢复会话 UUID 无效'));
        }
      }
      if (id === 'claude' && (!values.executable || !isAbsolute(values.executable))) {
        throw Error(tr('Pass the absolute path to the trusted native Claude executable, not a wrapper.', '请传入可信 Claude 原生可执行文件的绝对路径，不要使用包装程序。'));
      }
      let executable = await resolveExecutable(values.executable ?? id);
      if (id === 'claude') executable = await api.validateNativeExecutable(executable);
      const pane = await launchPane(values, null, id, cwd, executable, argument, providerArgs);
      return values.json ? json({ provider: id, mode: 'native', pane }) : console.log(`${tr('Native pane created', '已创建原生窗格')}: ${quote(pane.backend)} ${quote(pane.id)}`);
    }
    const session = await api.start({ cwd, model: values.model, executable: values.executable, providerArgs });
    if (values.pane === undefined) return values.json ? json({ id: session.id, provider: id }) : console.log(`${style(tr('Started', '已启动'), 32)}: ${style(quote(session.id), 36)}`);
    try {
      const pane = await launchPane(values, session, id, cwd);
      return values.json ? json({ id: session.id, provider: id, pane }) : console.log(`${style(tr('Started', '已启动'), 32)}: ${style(quote(session.id), 36)}\n${tr('Pane', '窗格')}: ${quote(pane.backend)} ${quote(pane.id)}`);
    } catch (error) {
      const message = diagnostic(error.message);
      if (values.json) json({ id: session.id, provider: id, pane: null, error: message });
      else console.log(`${style(tr('Started', '已启动'), 32)}: ${style(quote(session.id), 36)}`);
      console.error(style(`${tr('Pane launch failed', '窗格启动失败')}: ${multiline(message)}`, 31, process.stderr));
      process.exitCode = 1;
      return;
    }
  }
  if (command === 'input' && values.key !== undefined && (argument !== undefined || values.enter)) {
    throw Error(tr('--key cannot be combined with text or --enter', '--key 不能与文本或 --enter 同时使用'));
  }
  const expectedPositionals = command === 'send' ? (values.stdin ? 1 : 2)
    : command === 'input' ? (values.key === undefined ? 2 : 1) : 1;
  if (positionals.length !== expectedPositionals) throw Error(help);
  if (command === 'view' && values.json) throw Error(tr('view does not support --json', 'view 不支持 --json'));
  const seconds = values.timeout === undefined ? null : Number(values.timeout);
  if (command === 'wait' && values.timeout !== undefined && (!/^\d+$/.test(values.timeout) || !Number.isSafeInteger(seconds) || seconds > 86400)) {
    throw Error(tr('--timeout must be 0 to 86400 seconds', '--timeout 须为 0 到 86400 之间的整数秒'));
  }
  let limit = 20;
  if (command === 'history') {
    if (values.all && values.limit !== undefined) throw Error(tr('Choose --all or --limit, not both', '请选择 --all 或 --limit，不能同时使用'));
    if (values.all) limit = Infinity;
    if (values.limit !== undefined) {
      limit = Number(values.limit);
      if (!/^[1-9]\d*$/.test(values.limit) || !Number.isSafeInteger(limit)) throw Error(tr('--limit must be a positive integer', '--limit 必须是正整数'));
    }
  }
  let text;
  if (command === 'send') {
    text = await promptText(argument, values.stdin);
  } else if (command === 'input') {
    if (values.key !== undefined) {
      if (!supportedTerminalKeys.includes(values.key.toLowerCase())) throw Error(tr(`--key expects one of: ${supportedTerminalKeys.join(', ')}`, `--key 可选值：${supportedTerminalKeys.join('、')}`));
      text = values.key;
    } else {
      if (!argument || Buffer.byteLength(argument) > 64 * 1024 || /[\x00-\x1f\x7f-\x9f\u2028\u2029]/u.test(argument)) {
        throw Error(tr('input requires nonempty single-line text without control characters (maximum 64 KiB)', 'input 需要不含控制字符的非空单行文本（最多 64 KiB）'));
      }
      text = argument;
    }
  }
  const provider = id.split(':', 1)[0];
  const api = await adapter(provider);
  if (command === 'resume') {
    if (!api.resume) throw Error(tr('resume supports managed OMP and AGY sessions only', 'resume 只支持 OMP 和 agy 托管会话'));
    const session = await api.resume(id);
    return values.json ? json({ id: session.id, provider: session.provider }) : console.log(`${style(tr('Available', '会话可用'), 32)}: ${style(quote(session.id), 36)}`);
  }
  const nativeAgy = provider === 'agy' && /^agy:(?:native|pid)-/.test(id);
  const direct = nativeAgy ? await api.lookupNative(id) : await api.lookupBridge?.(id);
  // agy 的已知句柄只查对应桥接或原生进程；旧句柄失效时不扫描其他对话。
  const matches = direct ? [direct] : provider === 'agy' ? [] : (await api.list()).filter(s => s.id === id);
  const savedLookup = command === 'history' || command === 'send' || (provider === 'agy' && command === 'view');
  if (!matches.length && !nativeAgy && savedLookup) {
    const saved = await api.savedSession?.(id);
    if (saved && (command === 'send' || provider === 'agy')) throw Error(tr(`Session is closed; run perch resume ${quote(id)} first`, `会话已关闭，请先执行 perch resume ${quote(id)}`));
    if (saved) matches.push(saved);
  }
  if (matches.length !== 1) throw Error(matches.length ? tr(`Ambiguous session: ${quote(id)}`, `会话不唯一：${quote(id)}`) : tr(`Session no longer listed: ${quote(id)}`, `会话已不在列表中：${quote(id)}`));
  const [session] = matches;
  const capability = command === 'view' ? 'history' : command;
  if (command !== 'input' && !session[capability]) {
    const reason = session[`${capability}Reason`] ? diagnostic(session[`${capability}Reason`]) : tr('no supported interface', '没有受支持的接口');
    const action = {send:'发送', history:'历史', wait:'等待', close:'关闭'}[capability];
    throw Error(tr(`${capability} unavailable: ${reason}`, `${action}不可用：${reason}`));
  }
  if (command === 'view') {
    return await followConversation({ read: () => api.history(session, 20), id: session.id, title: session.title, lang, style, quote, multiline });
  }
  if (command === 'input') {
    const action = { mode: values.key === undefined ? 'text' : 'key', text, enter: !!values.enter };
    let confirm;
    if (session.provider === 'agy') {
      if (session._agy === 'managed') throw Error(tr('input is not available for managed AGY sessions; use send', 'AGY 托管会话不支持 input，请使用 send'));
      confirm = () => api.confirmNativeTui(session, action);
    } else {
      if (session.provider !== 'omp' || typeof api.confirmNativeTui !== 'function') {
        throw Error(tr('input requires a live native OMP TUI session with the local extension', 'input 需要启用本地扩展的活动 OMP 原生 TUI 会话'));
      }
      confirm = async () => {
        let info;
        try { info = await api.confirmNativeTui(session); }
        catch { throw Error(tr('Native OMP TUI identity could not be confirmed', '无法确认原生 OMP TUI 会话身份')); }
        if (values.enter && ['running', 'blocked'].includes(info.status)) {
          throw Error(tr('input --enter is unavailable while the OMP session is busy or blocked', 'OMP 会话忙碌或阻塞时不能使用 input --enter'));
        }
      };
    }
    await confirm();
    deliveryAttempted = true;
    await sendTerminalInput({ pid: session.pid, ...action, confirm, lang });
    return values.json ? json({ accepted: true }) : console.log(style(tr('Terminal input delivered; command execution is not confirmed.', '终端输入已送达；不代表命令已执行。'), 32));
  }
  if (command === 'send') {
    deliveryAttempted = true;
    await api.send(session, text, { lang });
    return values.json ? json({ accepted: true }) : console.log(style(tr('Accepted.', '已接收。'), 32));
  }
  if (command === 'close') {
    await api.close(session);
    return values.json ? json({ id, closed: true }) : console.log(`${style(tr('Closed', '已关闭'), 32)}: ${style(quote(id), 36)}`);
  }
  if (command === 'wait') {
    const result = await api.waitIdle(session, seconds === null ? null : seconds * 1000);
    const codes = { completed: 0, timeout: 2, needs_input: 3, failed: 1, interrupted: 1 };
    if (!Object.hasOwn(codes, result.status)) throw Error(tr('Invalid session status', '无效的会话状态'));
    process.exitCode = codes[result.status];
    const output = { id, status: result.status, ...(typeof result.error === 'string' ? { error: result.error } : {}) };
    if (values.json) return json(output);
    const message = `${label(result.status)}${result.error ? `: ${multiline(diagnostic(result.error))}` : ''}`;
    if (result.status === 'completed') console.log(style(message, 32));
    else console.error(style(message, 31, process.stderr));
    return;
  }
  const messages = await api.history(session, limit);
  if (values.json) return json(messages.map(({ role, text }) => ({ role, text })));
  if (!messages.length) return console.log(tr('No chat messages yet.', '暂无聊天消息。'));
  for (const { role, text } of messages) console.log(`${style(`[${quote(label(role))}]`, 36)} ${multiline(text)}`);
}
process.stdout.on('error', e => { if (e.code === 'EPIPE') process.exit(0); throw e; });
let deliveryAttempted = false;
async function main() {
  const rawArgs = process.argv.slice(2);
  let parsed;
  try {
    parsed = parseLanguage(rawArgs);
    lang = parsed.lang;
    await run(parsed.args);
  } catch (error) {
    let args = parsed?.args;
    if (!args) {
      args = [...rawArgs];
      while (args[0] === '--lang' || args[0]?.startsWith('--lang=')) {
        if (args.shift() === '--lang') args.shift();
      }
    }
    const stop = args.indexOf('--');
    const flags = stop === -1 ? args : args.slice(0, stop);
    if (['send', 'input'].includes(args[0]) && flags.includes('--json')) {
      json({ accepted: deliveryAttempted && error.deliveryUnknown === true ? null : false });
    }
    throw error;
  }
}
main().catch(error => { console.error(style(multiline(diagnostic(error.message)), 31, process.stderr)); process.exitCode = 1; });
