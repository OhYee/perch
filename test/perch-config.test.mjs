import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_ALLOW_TOOLS,
  loadPerchConfig,
  parseYaml,
  renderPerchSystemPrompt,
  renderPerchSystemPromptWithWarnings,
  resolveModelAlias,
} from '../perch-config.ts';

test('parseYaml handles real OMP config.yml structures including modelRoles, arrays, and folded block scalars', () => {
  const sample = `
# OMP configuration
modelRoles:
  ultra: openai-codex/gpt-6.2-astra:medium
  slow: openai-codex/gpt-6.2-sol:medium
  default: "@deepseek"
  deepseek: qoder/Deepseek-Flash
perch:
  default: true
  native: true
  layout: stack
  heartbeatSeconds: 0
  discoverTimeoutMs: 40000
  disableTools:
    - task
  systemPromptFiles:
    - ~/.agents/skills/cortex-team/SKILL.md
  workerPromptPrefix: >-
    [Worker 身份] 你是专项执行 worker。
    不要再派生子会话。
  board:
    enabled: true
    autoCreate: true
  roles:
    investigate:
      label: 问题排查
      provider: agy
      model: gemini-4-neon
      write: false
      capabilities: 长上下文只读定位
      constraints: 严格只读，不改代码
    complex-dev:
      label: 复杂开发
      provider: omp
      model: "@slow"
      write: true
`;
  const parsed = parseYaml(sample);
  assert.equal(parsed.modelRoles.ultra, 'openai-codex/gpt-6.2-astra:medium');
  assert.equal(parsed.modelRoles.default, '@deepseek');
  assert.equal(parsed.perch.default, true);
  assert.equal(parsed.perch.layout, 'stack');
  assert.equal(parsed.perch.heartbeatSeconds, 0);
  assert.deepEqual(parsed.perch.disableTools, ['task']);
  assert.equal(parsed.perch.workerPromptPrefix, '[Worker 身份] 你是专项执行 worker。 不要再派生子会话。');
  assert.equal(parsed.perch.roles.investigate.write, false);
  assert.equal(parsed.perch.roles['complex-dev'].model, '@slow');
});

test('parseYaml understands flow lists and maps people write in config.yml', () => {
  const parsed = parseYaml(`
perch: { default: false, layout: stack }
other:
  allowTools: [perch, board, "read", 'ask']
  empty: []
  nested: { a: [1, 2], b: { c: true }, d: "x, y" }
  json: ["a", "b"]
`);
  assert.deepEqual(parsed.perch, { default: false, layout: 'stack' });
  assert.deepEqual(parsed.other.allowTools, ['perch', 'board', 'read', 'ask']);
  assert.deepEqual(parsed.other.empty, []);
  assert.deepEqual(parsed.other.nested, { a: [1, 2], b: { c: true }, d: 'x, y' });
  assert.deepEqual(parsed.other.json, ['a', 'b']);
});

test('resolveModelAlias expands chained @aliases and guards cycles', () => {
  const roles = {
    a: '@b',
    b: 'openai-codex/gpt-6.2-sol:medium',
    loop1: '@loop2',
    loop2: '@loop1',
  };
  assert.equal(resolveModelAlias('@a', roles), 'openai-codex/gpt-6.2-sol:medium');
  assert.equal(resolveModelAlias('gemini-4-neon', roles), 'gemini-4-neon');
  assert.equal(resolveModelAlias('@missing', roles), '@missing');
  assert.equal(resolveModelAlias('@loop1', roles), '@loop1');
});

test('loadPerchConfig merges global and project config.yml, expands @aliases, and renders system prompt with stripped frontmatter', async t => {
  const root = await mkdtemp(join(tmpdir(), 'perch-config-test-'));
  const home = join(root, 'home');
  const agentDir = join(home, '.omp', 'agent');
  const projectDir = join(root, 'project');
  const skillDir = join(home, '.agents', 'skills', 'cortex-team');
  await Promise.all([
    mkdir(agentDir, { recursive: true }),
    mkdir(join(projectDir, '.omp'), { recursive: true }),
    mkdir(skillDir, { recursive: true }),
  ]);
  t.after(() => rm(root, { recursive: true, force: true }));

  await writeFile(join(skillDir, 'SKILL.md'), `---\nname: team\ndescription: "demo"\n---\n# Team Rules\nAlways report tables.\n`);
  await writeFile(join(agentDir, 'config.yml'), `
modelRoles:
  slow: openai-codex/gpt-6.2-sol:medium
  smol: openai-codex/gpt-6.1-terra:xhigh
perch:
  default: true
  layout: stack
  heartbeatSeconds: 0
  appendSystemPromptFiles:
    - ~/.agents/skills/cortex-team/SKILL.md
  appendSystemPrompt: "Extra append rule."
  roles:
    dev:
      label: 常规开发
      provider: omp
      model: "@smol"
      write: true
    investigate:
      label: 排查
      provider: agy
      model: gemini-4-neon
      write: false
`);
  await writeFile(join(projectDir, '.omp', 'config.yml'), `
perch:
  roles:
    dev:
      label: 项目定制开发
      provider: omp
      model: "@slow"
      write: true
`);

  const env = { HOME: home };
  const cfg = loadPerchConfig({ cwd: projectDir, env });
  assert.equal(cfg.default, true);
  assert.equal(cfg.layout, 'stack');
  assert.equal(cfg.heartbeatSeconds, 0);
  assert.equal(cfg.roles.dev.model, 'openai-codex/gpt-6.2-sol:medium');
  assert.equal(cfg.roles.dev.label, '项目定制开发');
  assert.equal(cfg.roles.investigate.provider, 'agy');
  assert.equal(cfg.roles.investigate.model, 'gemini-4-neon');
  assert.equal(cfg.roles.investigate.write, false);

  const appended = renderPerchSystemPrompt(cfg, { cwd: projectDir, env });
  assert.match(appended, /# Perch Mode/);
  assert.match(appended, /`investigate`.*`agy`.*`gemini-4-neon`.*只读/);
  assert.match(appended, /`dev`.*`openai-codex\/gpt-6\.2-sol:medium`/);
  assert.match(appended, /# Team Rules\nAlways report tables\./);
  assert.match(appended, /Extra append rule\./);
  assert.doesNotMatch(appended, /description: "demo"/);

  // Override mode: project-local systemPrompt path replaces built-in skeleton and expands {{roles}} in place
  const projectPrompt = join(projectDir, '.omp', 'custom-director.md');
  await writeFile(projectPrompt, `# Custom Director\n\n{{roles}}\n\nCustom footer.\n`);
  await writeFile(join(projectDir, '.omp', 'config.yml'), `
perch:
  systemPrompt: ./.omp/custom-director.md
  appendSystemPrompt: "Appended tail."
  roles:
    dev:
      label: 项目定制开发
      provider: omp
      model: "@slow"
      write: true
`);
  const overrideCfg = loadPerchConfig({ cwd: projectDir, env });
  const overridden = renderPerchSystemPrompt(overrideCfg, { cwd: projectDir, env });
  assert.doesNotMatch(overridden, /# Perch Mode/);
  assert.match(overridden, /# Custom Director/);
  assert.equal((overridden.match(/`investigate`/g) ?? []).length, 1, 'roles table expanded once in place');
  assert.match(overridden, /Custom footer\.\n\n# Team Rules\nAlways report tables\.\n\nExtra append rule\.\n\nAppended tail\./);
});

test('loadPerchConfig defaults allowTools, auto-discovers PERCH_SYSTEM.md by precedence, stacks appendSystemPrompt, confines project paths, and warns on missing/escaped paths', async t => {
  const root = await mkdtemp(join(tmpdir(), 'perch-config-prec-'));
  const home = join(root, 'home');
  const agentDir = join(home, '.omp', 'agent');
  const projectDir = join(root, 'project');
  await Promise.all([
    mkdir(agentDir, { recursive: true }),
    mkdir(join(projectDir, '.omp'), { recursive: true }),
  ]);
  t.after(() => rm(root, { recursive: true, force: true }));

  const env = { HOME: home };

  // 1. Default allowTools when neither allowTools nor disableTools is configured
  const bare = loadPerchConfig({ cwd: projectDir, env });
  assert.deepEqual(bare.allowTools, DEFAULT_ALLOW_TOOLS);
  assert.equal(bare.allowTools.includes('todo'), false);
  assert.equal(bare.idleCloseSeconds, 0);
  assert.match(renderPerchSystemPrompt(bare, { cwd: projectDir, env }), /Reuse workers for continuity/);

  // 2. Global ~/.omp/agent/PERCH_SYSTEM.md is auto-discovered without config.yml
  await writeFile(join(agentDir, 'PERCH_SYSTEM.md'), '# Global File Prompt\n{{roles}}\n');
  const fromGlobalFile = loadPerchConfig({ cwd: projectDir, env });
  const rGlobalFile = renderPerchSystemPromptWithWarnings(fromGlobalFile, { cwd: projectDir, env });
  assert.equal(rGlobalFile.warnings.length, 0);
  assert.match(rGlobalFile.prompt, /# Global File Prompt/);

  // 3. Global config.yml systemPrompt overrides global PERCH_SYSTEM.md; appendSystemPrompt accumulates global -> project
  await writeFile(join(agentDir, 'config.yml'), `
perch:
  idleCloseSeconds: 300
  systemPrompt: "# Global Config Inline"
  appendSystemPrompt: "Global append line."
`);
  const fromGlobalCfg = loadPerchConfig({ cwd: projectDir, env });
  assert.equal(fromGlobalCfg.idleCloseSeconds, 300);
  assert.match(renderPerchSystemPrompt(fromGlobalCfg, { cwd: projectDir, env }), /# Global Config Inline\n\nGlobal append line\./);

  // 4. Project .omp/PERCH_SYSTEM.md overrides global config.yml systemPrompt; project idleCloseSeconds overrides global
  await writeFile(join(projectDir, '.omp', 'PERCH_SYSTEM.md'), '# Project Auto Prompt\n');
  await writeFile(join(projectDir, '.omp', 'config.yml'), `
perch:
  idleCloseSeconds: 0
  allowTools:
    - perch
    - read
  appendSystemPrompt: "/perch rules: always delegate."
`);
  const fromProjectFile = loadPerchConfig({ cwd: projectDir, env });
  assert.equal(fromProjectFile.idleCloseSeconds, 0);
  assert.deepEqual(fromProjectFile.allowTools, ['perch', 'read']);
  const rProjectFile = renderPerchSystemPromptWithWarnings(fromProjectFile, { cwd: projectDir, env });
  assert.equal(rProjectFile.warnings.length, 0, 'inline text starting with / and spaces is not treated as a file path');
  assert.match(rProjectFile.prompt, /^# Project Auto Prompt\n\nGlobal append line\.\n\n\/perch rules: always delegate\.$/);

  // 5. Missing explicit file path and project-escaping paths emit warnings and never leak secrets outside project root
  const secretFile = join(home, 'secret.txt');
  await writeFile(secretFile, 'SUPER_SECRET_TOKEN');
  await rm(join(projectDir, '.omp', 'PERCH_SYSTEM.md'));
  await symlink(secretFile, join(projectDir, '.omp', 'PERCH_SYSTEM.md'));
  await writeFile(join(projectDir, '.omp', 'config.yml'), `
perch:
  systemPrompt: ./missing-prompt.md
  appendSystemPrompt:
    - ~/secret.txt
    - "Inline still works."
`);
  const withMissing = loadPerchConfig({ cwd: projectDir, env });
  const rMissing = renderPerchSystemPromptWithWarnings(withMissing, { cwd: projectDir, env });
  assert.ok(rMissing.warnings.some(w => w.includes('missing-prompt.md')));
  assert.ok(rMissing.warnings.some(w => w.includes('PERCH_SYSTEM.md') && w.includes('non-symlink')));
  assert.ok(rMissing.warnings.some(w => w.includes('~/secret.txt') && w.includes('escape project root')));
  assert.doesNotMatch(rMissing.prompt, /SUPER_SECRET_TOKEN/);
  assert.match(rMissing.prompt, /# Global Config Inline/);
  assert.match(rMissing.prompt, /Inline still works\./);
});
