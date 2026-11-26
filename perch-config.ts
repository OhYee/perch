import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

export type PerchProvider = 'omp' | 'codex' | 'claude' | 'agy';
export type PerchLayout = 'stack' | 'right' | 'tab';

export type PerchRoleConfig = {
  name: string;
  label?: string;
  provider: PerchProvider;
  model?: string;
  native?: boolean;
  write?: boolean;
  capabilities?: string;
  constraints?: string;
  promptPrefix?: string;
};

export type PerchBoardConfig = {
  enabled: boolean;
  autoCreate: boolean;
};

export type PerchModeConfig = {
  default: boolean;
  native?: boolean;
  layout: PerchLayout;
  heartbeatSeconds: number;
  discoverTimeoutMs: number;
  disableTools: string[];
  systemPrompt?: string;
  systemPromptFiles: string[];
  workerPromptPrefix?: string;
  board: PerchBoardConfig;
  roles: Record<string, PerchRoleConfig>;
  sources: string[];
};

const PROVIDERS = new Set<PerchProvider>(['omp', 'codex', 'claude', 'agy']);
const LAYOUTS = new Set<PerchLayout>(['stack', 'right', 'tab']);
const MAX_PROMPT_FILE_BYTES = 256 * 1024;
const VALID_PROFILE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function isValidProfile(value: string): boolean {
  return VALID_PROFILE.test(value) && !value.endsWith('.') && !/^(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\..*)?$/i.test(value);
}

export function resolveOmpAgentDir(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HOME ? resolve(env.HOME) : resolve(homedir());
  const profile = (env.OMP_PROFILE ?? env.PI_PROFILE ?? '').trim();
  const namedProfile = profile && profile !== 'default' && isValidProfile(profile);
  const root = join(home, env.PI_CONFIG_DIR || '.omp');
  const legacyProfile = (env.PI_PROFILE ?? '').trim();
  const inheritedProfileDir = legacyProfile && legacyProfile !== 'default' && isValidProfile(legacyProfile)
    ? join(root, 'profiles', legacyProfile, 'agent')
    : undefined;
  const agentOverride = env.PI_CODING_AGENT_DIR;
  if (namedProfile) return join(root, 'profiles', profile, 'agent');
  if (agentOverride && agentOverride !== inheritedProfileDir) return resolve(agentOverride);
  return join(root, 'agent');
}

function stripInlineComment(raw: string): string {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (quote) {
      if (quote === '"' && ch === '\\') { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '#' && (i === 0 || /\s/.test(raw[i - 1]))) return raw.slice(0, i).trimEnd();
  }
  return raw.trimEnd();
}

function parseYamlScalar(raw: string): unknown {
  const value = stripInlineComment(raw).trim();
  if (!value || value === 'null' || value === '~') return null;
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    try { return JSON.parse(value); } catch { return value.slice(1, -1); }
  }
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
    return value.slice(1, -1).replaceAll("''", "'");
  }
  if ((value.startsWith('[') && value.endsWith(']')) || (value.startsWith('{') && value.endsWith('}'))) {
    try { return JSON.parse(value); } catch { /* fall through */ }
  }
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) {
    const num = Number(value);
    if (Number.isFinite(num)) return num;
  }
  return value;
}

function splitKeyValue(line: string): [string, string] | null {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (quote === '"' && ch === '\\') { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === ':' && (i + 1 === line.length || /\s/.test(line[i + 1]))) {
      const keyRaw = line.slice(0, i).trim();
      if (!keyRaw) return null;
      const key = String(parseYamlScalar(keyRaw));
      return [key, line.slice(i + 1).trim()];
    }
  }
  return null;
}

type YamlLine = { indent: number; raw: string; text: string };

function tokenizeYaml(source: string): YamlLine[] {
  const result: YamlLine[] = [];
  for (const rawLine of source.replace(/\r\n/g, '\n').split('\n')) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed === '---' || trimmed === '...') continue;
    let indent = 0;
    while (indent < rawLine.length && rawLine[indent] === ' ') indent++;
    result.push({ indent, raw: rawLine, text: rawLine.slice(indent) });
  }
  return result;
}

function parseBlockScalar(lines: string[], startIndex: number, parentIndent: number, indicator: string): { value: string; nextIndex: number } {
  const folded = indicator.startsWith('>');
  const chomp = indicator.endsWith('-') ? 'strip' : indicator.endsWith('+') ? 'keep' : 'clip';
  const collected: string[] = [];
  let blockIndent: number | undefined;
  let i = startIndex;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) {
      collected.push('');
      continue;
    }
    let indent = 0;
    while (indent < line.length && line[indent] === ' ') indent++;
    if (indent <= parentIndent) break;
    if (blockIndent === undefined) blockIndent = indent;
    collected.push(line.slice(Math.min(indent, blockIndent)));
  }
  while (collected.length && collected.at(-1) === '' && chomp === 'strip') collected.pop();
  let trailing = '';
  if (chomp !== 'strip') {
    let blanks = 0;
    while (collected.length && collected.at(-1) === '') { collected.pop(); blanks++; }
    trailing = chomp === 'keep' ? '\n'.repeat(blanks + 1) : (collected.length ? '\n' : '');
  }
  let body: string;
  if (!folded) {
    body = collected.join('\n');
  } else {
    const parts: string[] = [];
    for (let j = 0; j < collected.length; j++) {
      const curr = collected[j];
      if (j === 0) { parts.push(curr); continue; }
      const prev = collected[j - 1];
      if (curr === '' || prev === '' || /^\s/.test(curr) || /^\s/.test(prev)) parts.push('\n' + curr);
      else parts.push(' ' + curr);
    }
    body = parts.join('');
  }
  return { value: body + trailing, nextIndex: i };
}

/** Pure-JS YAML parser fallback for Node; Bun runtime uses Bun.YAML.parse directly. */
export function parseYaml(source: string): unknown {
  const bunYaml = (globalThis as { Bun?: { YAML?: { parse?: (text: string) => unknown } } }).Bun?.YAML?.parse;
  if (typeof bunYaml === 'function') {
    return bunYaml(source);
  }
  const rawLines = source.replace(/\r\n/g, '\n').split('\n');

  function nextNonEmpty(start: number): number {
    let i = start;
    while (i < rawLines.length) {
      const trimmed = rawLines[i].trim();
      if (trimmed && !trimmed.startsWith('#') && trimmed !== '---' && trimmed !== '...') return i;
      i++;
    }
    return rawLines.length;
  }

  function indentOf(index: number): number {
    const line = rawLines[index];
    let n = 0;
    while (n < line.length && line[n] === ' ') n++;
    return n;
  }

  function parseNode(start: number, minIndent: number): { value: unknown; next: number } {
    const idx = nextNonEmpty(start);
    if (idx >= rawLines.length) return { value: null, next: idx };
    const indent = indentOf(idx);
    if (indent < minIndent) return { value: null, next: idx };
    const trimmed = rawLines[idx].slice(indent);
    if (trimmed === '-' || trimmed.startsWith('- ')) {
      return parseSequence(idx, indent);
    }
    if (splitKeyValue(trimmed)) {
      return parseMapping(idx, indent);
    }
    return { value: parseYamlScalar(trimmed), next: idx + 1 };
  }

  function parseSequence(start: number, baseIndent: number): { value: unknown[]; next: number } {
    const out: unknown[] = [];
    let i = start;
    while (i < rawLines.length) {
      i = nextNonEmpty(i);
      if (i >= rawLines.length) break;
      const indent = indentOf(i);
      if (indent !== baseIndent) break;
      const text = rawLines[i].slice(indent);
      if (!(text === '-' || text.startsWith('- '))) break;
      const rest = text.slice(1).trim();
      if (!rest) {
        const nested = parseNode(i + 1, baseIndent + 1);
        out.push(nested.value);
        i = nested.next;
        continue;
      }
      if (/^[|>][+-]?$/.test(rest)) {
        const block = parseBlockScalar(rawLines, i + 1, baseIndent, rest);
        out.push(block.value);
        i = block.nextIndex;
        continue;
      }
      const kv = splitKeyValue(rest);
      if (kv) {
        const itemObj: Record<string, unknown> = {};
        const itemIndent = baseIndent + 2;
        const [k, v] = kv;
        if (!v) {
          const nested = parseNode(i + 1, itemIndent + 1);
          itemObj[k] = nested.value;
          i = nested.next;
        } else if (/^[|>][+-]?$/.test(v)) {
          const block = parseBlockScalar(rawLines, i + 1, itemIndent, v);
          itemObj[k] = block.value;
          i = block.nextIndex;
        } else {
          itemObj[k] = parseYamlScalar(v);
          i = i + 1;
        }
        const extra = parseMapping(i, itemIndent);
        if (extra.value && typeof extra.value === 'object' && !Array.isArray(extra.value)) {
          Object.assign(itemObj, extra.value);
        }
        i = extra.next;
        out.push(itemObj);
        continue;
      }
      out.push(parseYamlScalar(rest));
      i++;
    }
    return { value: out, next: i };
  }

  function parseMapping(start: number, baseIndent: number): { value: Record<string, unknown>; next: number } {
    const out: Record<string, unknown> = {};
    let i = start;
    while (i < rawLines.length) {
      i = nextNonEmpty(i);
      if (i >= rawLines.length) break;
      const indent = indentOf(i);
      if (indent !== baseIndent) break;
      const text = rawLines[i].slice(indent);
      if (text === '-' || text.startsWith('- ')) break;
      const kv = splitKeyValue(text);
      if (!kv) break;
      const [key, valRaw] = kv;
      const val = stripInlineComment(valRaw).trim();
      if (!val) {
        const nextIdx = nextNonEmpty(i + 1);
        if (nextIdx < rawLines.length && indentOf(nextIdx) > baseIndent) {
          const nested = parseNode(nextIdx, indentOf(nextIdx));
          out[key] = nested.value;
          i = nested.next;
        } else {
          out[key] = null;
          i++;
        }
        continue;
      }
      if (/^[|>][+-]?$/.test(val)) {
        const block = parseBlockScalar(rawLines, i + 1, baseIndent, val);
        out[key] = block.value;
        i = block.nextIndex;
        continue;
      }
      out[key] = parseYamlScalar(val);
      i++;
    }
    return { value: out, next: i };
  }

  // Keep tokenizeYaml referenced for quick empty check
  if (!tokenizeYaml(source).length) return {};
  return parseNode(0, 0).value;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function readYamlFile(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const text = readFileSync(path, 'utf8');
    return asRecord(parseYaml(text));
  } catch {
    return undefined;
  }
}

export function resolveModelAlias(model: string | undefined, modelRoles: Record<string, string>): string | undefined {
  if (!model || typeof model !== 'string') return undefined;
  let current = model.trim();
  if (!current) return undefined;
  const visited = new Set<string>();
  while (current.startsWith('@')) {
    const alias = current.slice(1).trim();
    if (!alias || visited.has(alias) || visited.size >= 8) break;
    visited.add(alias);
    const resolved = modelRoles[alias];
    if (typeof resolved !== 'string' || !resolved.trim()) break;
    current = resolved.trim();
  }
  return current;
}

function parseRoleEntry(name: string, raw: unknown, modelRoles: Record<string, string>): PerchRoleConfig | undefined {
  if (typeof raw === 'string') {
    const idx = raw.indexOf(':');
    if (idx <= 0) return undefined;
    const provider = raw.slice(0, idx).trim() as PerchProvider;
    const model = resolveModelAlias(raw.slice(idx + 1).trim(), modelRoles);
    if (!PROVIDERS.has(provider)) return undefined;
    return { name, provider, ...(model ? { model } : {}) };
  }
  const obj = asRecord(raw);
  if (!obj) return undefined;
  const provider = typeof obj.provider === 'string' ? obj.provider.trim() as PerchProvider : undefined;
  if (!provider || !PROVIDERS.has(provider)) return undefined;
  const model = typeof obj.model === 'string' ? resolveModelAlias(obj.model, modelRoles) : undefined;
  return {
    name,
    provider,
    ...(typeof obj.label === 'string' && obj.label.trim() ? { label: obj.label.trim() } : {}),
    ...(model ? { model } : {}),
    ...(typeof obj.native === 'boolean' ? { native: obj.native } : {}),
    ...(typeof obj.write === 'boolean' ? { write: obj.write } : {}),
    ...(typeof obj.capabilities === 'string' && obj.capabilities.trim() ? { capabilities: obj.capabilities.trim() } : {}),
    ...(typeof obj.constraints === 'string' && obj.constraints.trim() ? { constraints: obj.constraints.trim() } : {}),
    ...(typeof obj.promptPrefix === 'string' && obj.promptPrefix.trim() ? { promptPrefix: obj.promptPrefix.trim() } : {}),
  };
}

function extractModelRoles(doc: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  const raw = asRecord(doc?.modelRoles);
  if (!raw) return out;
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string' && value.trim()) out[key] = value.trim();
  }
  return out;
}

export function loadPerchConfig(options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): PerchModeConfig {
  const env = options.env ?? process.env;
  const agentDir = resolveOmpAgentDir(env);
  const globalPath = join(agentDir, 'config.yml');
  const projectPath = options.cwd ? join(resolve(options.cwd), '.omp', 'config.yml') : undefined;

  const globalDoc = readYamlFile(globalPath);
  const projectDoc = projectPath && projectPath !== globalPath ? readYamlFile(projectPath) : undefined;

  const modelRoles: Record<string, string> = {
    ...extractModelRoles(globalDoc),
    ...extractModelRoles(projectDoc),
  };

  const sources: string[] = [];
  const globalPerch = asRecord(globalDoc?.perch);
  const projectPerch = asRecord(projectDoc?.perch);
  if (globalPerch) sources.push(globalPath);
  if (projectPerch && projectPath) sources.push(projectPath);

  const merged: Record<string, unknown> = {
    ...(globalPerch ?? {}),
    ...(projectPerch ?? {}),
  };

  const rawLayout = typeof merged.layout === 'string' ? merged.layout.trim() as PerchLayout : 'stack';
  const layout: PerchLayout = LAYOUTS.has(rawLayout) ? rawLayout : 'stack';

  const rawHeartbeat = merged.heartbeatSeconds;
  const heartbeatSeconds = typeof rawHeartbeat === 'number' && Number.isSafeInteger(rawHeartbeat) && rawHeartbeat >= 0 && rawHeartbeat <= 86400
    ? rawHeartbeat
    : 0;

  const rawDiscover = merged.discoverTimeoutMs;
  const discoverTimeoutMs = typeof rawDiscover === 'number' && Number.isSafeInteger(rawDiscover) && rawDiscover >= 1000 && rawDiscover <= 120000
    ? rawDiscover
    : 40000;

  const disableTools = Array.isArray(merged.disableTools)
    ? merged.disableTools.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map(s => s.trim())
    : ['task'];

  const systemPromptFiles = Array.isArray(merged.systemPromptFiles)
    ? merged.systemPromptFiles.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map(s => s.trim())
    : [];

  const globalBoard = asRecord(globalPerch?.board);
  const projectBoard = asRecord(projectPerch?.board);
  const mergedBoard = { ...(globalBoard ?? {}), ...(projectBoard ?? {}) };
  const board: PerchBoardConfig = {
    enabled: typeof mergedBoard.enabled === 'boolean' ? mergedBoard.enabled : true,
    autoCreate: typeof mergedBoard.autoCreate === 'boolean' ? mergedBoard.autoCreate : true,
  };

  const roles: Record<string, PerchRoleConfig> = {};
  for (const rawRoles of [asRecord(globalPerch?.roles), asRecord(projectPerch?.roles)]) {
    if (!rawRoles) continue;
    for (const [roleName, roleValue] of Object.entries(rawRoles)) {
      const parsed = parseRoleEntry(roleName.trim(), roleValue, modelRoles);
      if (parsed) roles[parsed.name] = parsed;
    }
  }

  return {
    default: merged.default === true,
    ...(typeof merged.native === 'boolean' ? { native: merged.native } : {}),
    layout,
    heartbeatSeconds,
    discoverTimeoutMs,
    disableTools,
    ...(typeof merged.systemPrompt === 'string' && merged.systemPrompt.trim() ? { systemPrompt: merged.systemPrompt.trim() } : {}),
    systemPromptFiles,
    ...(typeof merged.workerPromptPrefix === 'string' && merged.workerPromptPrefix.trim() ? { workerPromptPrefix: merged.workerPromptPrefix.trim() } : {}),
    board,
    roles,
    sources,
  };
}

function expandPath(rawPath: string, cwd: string | undefined, env: NodeJS.ProcessEnv): string {
  const home = env.HOME ? resolve(env.HOME) : resolve(homedir());
  if (rawPath === '~') return home;
  if (rawPath.startsWith('~/')) return join(home, rawPath.slice(2));
  return isAbsolute(rawPath) ? rawPath : resolve(cwd || process.cwd(), rawPath);
}

function stripMarkdownFrontmatter(text: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(text);
  return match ? text.slice(match[0].length).trim() : text.trim();
}

export function renderRolesTable(roles: Record<string, PerchRoleConfig>): string {
  const entries = Object.values(roles);
  if (!entries.length) return '';
  const rows = [
    '| `role` | 名称 | Provider | Model | 写权限 | 能力与约束 |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  for (const role of entries) {
    const label = role.label ?? role.name;
    const write = role.write === false ? '只读' : role.write === true ? '可写' : '默认';
    const desc = [role.capabilities, role.constraints].filter(Boolean).join('；') || '—';
    rows.push(`| \`${role.name}\` | ${label} | \`${role.provider}\` | \`${role.model ?? 'default'}\` | ${write} | ${desc.replaceAll('|', '\\|')} |`);
  }
  return rows.join('\n');
}

export function renderPerchSystemPrompt(config: PerchModeConfig, options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): string {
  const env = options.env ?? process.env;
  const sections: string[] = [
    '# Perch Mode Active',
    'You are operating in `/perch` orchestration mode. Dispatch specialist workers exclusively via the `perch` tool (never block with `perch op=wait(timeout>0)` or shell `sleep` loops). After dispatching, present a concise status summary and end your turn to wait for automatic `[Perch async update]` callbacks.',
  ];

  const roleTable = renderRolesTable(config.roles);
  if (roleTable) {
    sections.push(
      '## Configured Worker Roles (pass `role: "<name>"` to `perch op=start`)\n'
      + 'Pass `role` directly to `perch({ op: "start", role: "<name>", name: "<short-label>", cwd: "...", prompt: "..." })`; provider, model, native pane, worker identity header, and role constraints are auto-applied.\n\n'
      + roleTable,
    );
  }

  if (config.board.enabled) {
    sections.push(
      '## Session Board Integration\n'
      + 'Use the `board` tool (`op=snapshot`, `create`, `edit`, `assign`, `progress`, `submit`, `approve`, `reject`, `decide`, `replace`) to track work items, acceptance criteria, handoffs, and decisions. '
      + (config.board.autoCreate
        ? 'Starting a worker via `perch op=start` without `item` automatically creates and binds a board item (or pass `item` + `boardRole: "execute" | "review"` to bind an existing item). '
        : 'Pass `item` + `boardRole: "execute" | "review"` to `perch op=start` to bind a worker to a board item. ')
      + 'Worker completions automatically record a board receipt (a receipt is evidence only, never automatic submission or approval). The user can inspect the board UI anytime via `/board`.',
    );
  }

  for (const fileRef of config.systemPromptFiles) {
    const filePath = expandPath(fileRef, options.cwd, env);
    try {
      const info = statSync(filePath);
      if (!info.isFile() || info.size > MAX_PROMPT_FILE_BYTES) continue;
      const body = stripMarkdownFrontmatter(readFileSync(filePath, 'utf8'));
      if (body) sections.push(body);
    } catch {
      // Ignore unreadable optional prompt files so orchestration still starts cleanly.
    }
  }

  if (config.systemPrompt) {
    sections.push(config.systemPrompt);
  }

  return sections.join('\n\n');
}
