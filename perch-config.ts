import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  /** Automatically review the director's replies with this role: every assistant turn, or once when the agent run ends. */
  reviewMode?: 'turn' | 'agent-end';
  /** Skip automatic review for replies shorter than this many characters. */
  reviewMinChars?: number;
  /** Detailed review criteria sent to the reviewer in addition to `capabilities` (only used with reviewMode). */
  reviewPrompt?: string;
};

export type PerchBoardConfig = {
  enabled: boolean;
  autoCreate: boolean;
};

export type PerchPromptEntry = {
  value: string;
  kind: 'file' | 'auto';
};

export type PerchPromptCandidate = {
  scope: 'global' | 'project';
  entries: PerchPromptEntry[];
  baseDir: string;
};

export type PerchModeConfig = {
  default: boolean;
  native?: boolean;
  layout: PerchLayout;
  heartbeatSeconds: number;
  idleCloseSeconds: number;
  discoverTimeoutMs: number;
  allowTools?: string[];
  disableTools: string[];
  /** Ordered system prompt override candidates (highest priority first). */
  systemPromptCandidates: PerchPromptCandidate[];
  /** Ordered append prompt layers (global then project). */
  appendPromptLayers: PerchPromptCandidate[];
  workerPromptPrefix?: string;
  board: PerchBoardConfig;
  roles: Record<string, PerchRoleConfig>;
  sources: string[];
};

export const DEFAULT_ALLOW_TOOLS = Object.freeze(['perch', 'board', 'read', 'ask']);

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

  if (!tokenizeYaml(source).length) return {};
  return parseNode(0, 0).value;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function asStringList(value: unknown): string[] {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      .map(item => item.trim());
  }
  return [];
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
    ...(obj.reviewMode === 'turn' || obj.reviewMode === 'agent-end' ? { reviewMode: obj.reviewMode } : {}),
    ...(typeof obj.reviewPrompt === 'string' && obj.reviewPrompt.trim() ? { reviewPrompt: obj.reviewPrompt.trim().slice(0, 4000) } : {}),
    ...(typeof obj.reviewMinChars === 'number' && Number.isSafeInteger(obj.reviewMinChars) && obj.reviewMinChars >= 0 && obj.reviewMinChars <= 100000
      ? { reviewMinChars: obj.reviewMinChars } : {}),
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

function extractPromptEntries(section: Record<string, unknown> | undefined, primaryKey: string, legacyFilesKey: string): PerchPromptEntry[] {
  if (!section) return [];
  return [
    ...asStringList(section[legacyFilesKey]).map(value => ({ value, kind: 'file' as const })),
    ...asStringList(section[primaryKey]).map(value => ({ value, kind: 'auto' as const })),
  ];
}

export function loadPerchConfig(options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): PerchModeConfig {
  const env = options.env ?? process.env;
  const agentDir = resolveOmpAgentDir(env);
  const globalPath = join(agentDir, 'config.yml');
  const projectBase = options.cwd ? resolve(options.cwd) : undefined;
  const projectPath = projectBase ? join(projectBase, '.omp', 'config.yml') : undefined;

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

  const rawIdleClose = merged.idleCloseSeconds;
  const idleCloseSeconds = typeof rawIdleClose === 'number' && Number.isSafeInteger(rawIdleClose) && rawIdleClose >= 0 && rawIdleClose <= 86400
    ? rawIdleClose
    : 0;

  const rawDiscover = merged.discoverTimeoutMs;
  const discoverTimeoutMs = typeof rawDiscover === 'number' && Number.isSafeInteger(rawDiscover) && rawDiscover >= 1000 && rawDiscover <= 120000
    ? rawDiscover
    : 40000;

  const hasExplicitAllow = Array.isArray(merged.allowTools);
  const hasExplicitDisable = Array.isArray(merged.disableTools);
  const allowTools = hasExplicitAllow
    ? asStringList(merged.allowTools)
    : hasExplicitDisable
      ? undefined
      : [...DEFAULT_ALLOW_TOOLS];
  const disableTools = hasExplicitDisable ? asStringList(merged.disableTools) : ['task'];

  const globalAutoFile = join(agentDir, 'PERCH_SYSTEM.md');
  const projectAutoFile = projectBase ? join(projectBase, '.omp', 'PERCH_SYSTEM.md') : undefined;
  const hasProjectAuto = !!(projectAutoFile && projectAutoFile !== globalAutoFile && existsSync(projectAutoFile));
  const hasGlobalAuto = existsSync(globalAutoFile);

  // System prompt override priority: project config > project PERCH_SYSTEM.md > global config > global PERCH_SYSTEM.md > built-in
  const systemPromptCandidates: PerchPromptCandidate[] = [];
  const projectSystemEntries = extractPromptEntries(projectPerch, 'systemPrompt', 'systemPromptFiles');
  if (projectSystemEntries.length && projectBase) {
    systemPromptCandidates.push({ scope: 'project', entries: projectSystemEntries, baseDir: projectBase });
  }
  if (hasProjectAuto && projectAutoFile && projectBase) {
    systemPromptCandidates.push({ scope: 'project', entries: [{ value: projectAutoFile, kind: 'file' }], baseDir: projectBase });
  }
  const globalSystemEntries = extractPromptEntries(globalPerch, 'systemPrompt', 'systemPromptFiles');
  if (globalSystemEntries.length) {
    systemPromptCandidates.push({ scope: 'global', entries: globalSystemEntries, baseDir: agentDir });
  }
  if (hasGlobalAuto) {
    systemPromptCandidates.push({ scope: 'global', entries: [{ value: globalAutoFile, kind: 'file' }], baseDir: agentDir });
  }

  // Append prompt layers accumulate: global -> project
  const appendPromptLayers: PerchPromptCandidate[] = [];
  const globalAppendEntries = extractPromptEntries(globalPerch, 'appendSystemPrompt', 'appendSystemPromptFiles');
  if (globalAppendEntries.length) {
    appendPromptLayers.push({ scope: 'global', entries: globalAppendEntries, baseDir: agentDir });
  }
  const projectAppendEntries = extractPromptEntries(projectPerch, 'appendSystemPrompt', 'appendSystemPromptFiles');
  if (projectAppendEntries.length && projectBase) {
    appendPromptLayers.push({ scope: 'project', entries: projectAppendEntries, baseDir: projectBase });
  }

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
    idleCloseSeconds,
    discoverTimeoutMs,
    ...(allowTools !== undefined ? { allowTools } : {}),
    disableTools,
    systemPromptCandidates,
    appendPromptLayers,
    ...(typeof merged.workerPromptPrefix === 'string' && merged.workerPromptPrefix.trim() ? { workerPromptPrefix: merged.workerPromptPrefix.trim() } : {}),
    board,
    roles,
    sources,
  };
}

function isExplicitFilePath(entry: string): boolean {
  if (!entry || /[\r\n]/.test(entry)) return false;
  if (entry.startsWith('~/') || entry.startsWith('./') || entry.startsWith('../') || entry.startsWith('file://')) {
    return true;
  }
  if (entry.startsWith('/') && !/\s/.test(entry)) {
    return true;
  }
  return !/\s/.test(entry) && /\.(?:md|txt|prompt)$/i.test(entry);
}

function expandPath(rawPath: string, baseDir: string, env: NodeJS.ProcessEnv): string {
  if (rawPath.startsWith('file://')) {
    try { return fileURLToPath(rawPath); } catch { /* fall through */ }
  }
  const home = env.HOME ? resolve(env.HOME) : resolve(homedir());
  if (rawPath === '~') return home;
  if (rawPath.startsWith('~/')) return join(home, rawPath.slice(2));
  return isAbsolute(rawPath) ? rawPath : resolve(baseDir, rawPath);
}

function stripMarkdownFrontmatter(text: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(text);
  return match ? text.slice(match[0].length).trim() : text.trim();
}

function isWithinDir(filePath: string, baseDir: string): boolean {
  try {
    const realBase = realpathSync(baseDir);
    const realFile = realpathSync(filePath);
    return realFile === realBase || realFile.startsWith(`${realBase}${sep}`);
  } catch {
    return false;
  }
}

function resolvePromptEntries(
  candidate: PerchPromptCandidate,
  env: NodeJS.ProcessEnv,
  warnings: string[],
): string[] {
  const resolved: string[] = [];
  for (const item of candidate.entries) {
    const entry = item.value;
    const treatAsFile = item.kind === 'file' || isExplicitFilePath(entry);
    if (!treatAsFile) {
      const text = entry.trim();
      if (text) resolved.push(text);
      continue;
    }
    const filePath = expandPath(entry, candidate.baseDir, env);
    try {
      if (candidate.scope === 'project') {
        const linfo = lstatSync(filePath);
        if (linfo.isSymbolicLink() || !linfo.isFile()) {
          warnings.push(`Perch project prompt path must be a regular non-symlink file inside the project: ${entry}`);
          continue;
        }
        if (!isWithinDir(filePath, candidate.baseDir)) {
          warnings.push(`Perch project prompt path cannot escape project root: ${entry}`);
          continue;
        }
      }
      const info = statSync(filePath);
      if (!info.isFile()) {
        warnings.push(`Perch prompt path is not a regular file: ${entry}`);
        continue;
      }
      if (info.size > MAX_PROMPT_FILE_BYTES) {
        warnings.push(`Perch prompt file exceeds 256 KiB limit: ${entry}`);
        continue;
      }
      const body = stripMarkdownFrontmatter(readFileSync(filePath, 'utf8'));
      if (body) resolved.push(body);
    } catch {
      warnings.push(`Perch prompt file not found or unreadable: ${entry}`);
    }
  }
  return resolved;
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
    const desc = [role.capabilities, role.constraints, role.reviewMode ? `自动评审（${role.reviewMode}）：其建议会以 [Perch review: ${role.name}] 到达` : undefined].filter(Boolean).join('；') || '—';
    rows.push(`| \`${role.name}\` | ${label} | \`${role.provider}\` | \`${role.model ?? 'default'}\` | ${write} | ${desc.replaceAll('|', '\\|')} |`);
  }
  return rows.join('\n');
}

function buildMinimalDefaultPrompt(config: PerchModeConfig, roleTable: string): string {
  const sections: string[] = [
    '# Perch Mode\n'
    + 'You are the orchestrator. Code editing, searching, and shell execution tools are restricted here by default — whenever you need to search code, edit files, run commands, or run tests, dispatch a `perch` worker (`perch({ op: "start", role: "...", name: "<short-name>", prompt: "..." })`).\n'
    + '- **Reuse workers for continuity**: to follow up on the same task, call `perch({ op: "send", id: "<name or id>", text: "..." })`; if that worker has stopped or been closed, Perch resumes its conversation automatically.\n'
    + '- **Stay non-blocking**: after dispatching, summarize briefly and end your turn to wait for `[Perch async update]` callbacks.',
  ];
  if (roleTable) {
    sections.push('## Worker Roles (`perch op=start` with `role`)\n\n' + roleTable);
  }
  if (config.board.enabled) {
    sections.push('## Session Board\nUse the `board` tool to track work items, acceptance criteria, handoffs, and decisions (UI via `/board`).');
  }
  return sections.join('\n\n');
}

export function renderPerchSystemPromptWithWarnings(
  config: PerchModeConfig,
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): { prompt: string; warnings: string[] } {
  const env = options.env ?? process.env;
  const warnings: string[] = [];
  const roleTable = renderRolesTable(config.roles);

  let overrideParts: string[] = [];
  for (const candidate of config.systemPromptCandidates) {
    const parts = resolvePromptEntries(candidate, env, warnings);
    if (parts.length) {
      overrideParts = parts;
      break;
    }
  }

  const sections: string[] = [];
  if (overrideParts.length) {
    const hasRolesPlaceholder = overrideParts.some(part => part.includes('{{roles}}'));
    const expanded = overrideParts.map(part => part.replaceAll('{{roles}}', roleTable));
    sections.push(...expanded);
    if (roleTable && !hasRolesPlaceholder) {
      sections.push('## Worker Roles (`perch op=start` with `role`)\n\n' + roleTable);
    }
  } else {
    sections.push(buildMinimalDefaultPrompt(config, roleTable));
  }

  for (const layer of config.appendPromptLayers) {
    const parts = resolvePromptEntries(layer, env, warnings);
    for (const part of parts) {
      sections.push(part.replaceAll('{{roles}}', roleTable));
    }
  }

  return { prompt: sections.join('\n\n'), warnings };
}

export function renderPerchSystemPrompt(config: PerchModeConfig, options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): string {
  return renderPerchSystemPromptWithWarnings(config, options).prompt;
}
