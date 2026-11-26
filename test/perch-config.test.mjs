import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPerchConfig, parseYaml, renderPerchSystemPrompt, resolveModelAlias } from '../perch-config.ts';

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

  // Override mode: systemPromptFiles replaces built-in skeleton and expands {{roles}} in place
  const overridePath = join(home, 'PERCH_SYSTEM.md');
  await writeFile(overridePath, `# Custom Director\n\n{{roles}}\n\nCustom footer.\n`);
  const overridden = renderPerchSystemPrompt({
    ...cfg,
    systemPromptFiles: ['~/PERCH_SYSTEM.md'],
    appendSystemPromptFiles: [],
    appendSystemPrompt: 'Appended tail.',
  }, { cwd: projectDir, env });
  assert.doesNotMatch(overridden, /# Perch Mode/);
  assert.match(overridden, /# Custom Director/);
  assert.equal((overridden.match(/`investigate`/g) ?? []).length, 1, 'roles table expanded once in place');
  assert.match(overridden, /Custom footer\.\n\nAppended tail\./);
});
