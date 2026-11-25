import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseLanguage, systemLanguage } from '../locale.mjs';

const cli = fileURLToPath(new URL('../cli.mjs', import.meta.url));

test('effective message locale follows POSIX precedence; unsupported locales fall back to English', () => {
  assert.equal(systemLanguage({ LANG: 'en_US.UTF-8', LC_MESSAGES: 'zh_CN.UTF-8' }), 'zh');
  assert.equal(systemLanguage({ LC_ALL: 'C', LC_MESSAGES: 'zh_CN.UTF-8' }), 'en');
  assert.equal(systemLanguage({ LANG: 'fr_FR.UTF-8' }), 'en');
  assert.deepEqual(parseLanguage(['send', '--lang=en-US', 'omp:id', '--', '--lang=zh'], { LANG: 'zh_CN' }), { lang: 'en', args: ['send', 'omp:id', '--', '--lang=zh'] });
  assert.throws(() => parseLanguage(['--lang', 'fr'], { LANG: 'en' }), /--lang/);
});

test('explicit language overrides the environment for help and invalid options', () => {
  const env = { ...process.env, LC_ALL: 'zh_CN.UTF-8' };
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { env, encoding: 'utf8' });
  const zh = run('--help'), en = run('--lang', 'en', '--help');
  assert.equal(zh.status, 0); assert.match(zh.stdout, /用法/);
  assert.equal(en.status, 0); assert.match(en.stdout, /Usage:/);
  const bad = run('list', '--nonexistent');
  assert.notEqual(bad.status, 0); assert.match(bad.stderr, /未知选项.*--nonexistent/);
});

test('each command has local usage and examples, including nested integration help', () => {
  for (const topic of ['list', 'start', 'resume', 'send', 'input', 'history', 'view', 'wait', 'close', 'integration', 'integration install', 'integration install omp', 'integration install agy', 'integration agy-hook', 'integration agy-statusline']) {
    for (const [lang, heading] of [['en', 'Examples:'], ['zh', '示例：']]) {
      const result = spawnSync(process.execPath, [cli, ...topic.split(' '), '--help', '--lang', lang], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      assert.doesNotMatch(result.stdout, /agent-session/);
      const [usage, examples] = result.stdout.split(heading);
      assert.ok(usage.includes(`perch ${topic}`), `${lang}: missing usage for ${topic}`);
      assert.ok(examples?.includes(`perch ${topic}`), `${lang}: missing example for ${topic}`);
      assert.ok(!usage.includes(`perch ${topic === 'start' ? 'history' : 'start'} <`), `${topic} printed the global command list`);
      if (topic === 'resume') {
        assert.match(result.stdout, lang === 'en' ? /only conversations created by Perch/ : /只允许恢复 Perch 创建的对话/);
      }
      if (topic === 'integration agy-statusline') {
        assert.match(result.stdout, lang === 'en' ? /piped JSON/ : /从管道读取 JSON/);
        assert.match(result.stdout, lang === 'en' ? /changes and saves the agy status line setting/ : /修改并保存 agy 状态行设置/);
        assert.match(result.stdout, /\/statusline perch integration agy-statusline && :/);
      }
    }
  }
});

test('pane and viewer help describes the supported behavior in both languages', () => {
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
  for (const lang of ['en', 'zh']) {
    const start = run('start', '--help', '--lang', lang);
    assert.equal(start.status, 0, start.stderr);
    assert.match(start.stdout, /--pane right/);
    assert.match(start.stdout, /--pane tern --workspace (?:NAME|work) --tab (?:NAME|agents)/);
    assert.match(start.stdout, /perch start omp --pane right/);
    assert.match(start.stdout, /perch start omp --pane tern --workspace work --tab agents/);
    assert.match(start.stdout, /perch start omp --pane herdr --workspace work --tab agents/);
    assert.match(start.stdout, /perch start omp --native --pane tmux --workspace work --tab agents/);
    assert.match(start.stdout, /pane (?:is|为) null/);
    assert.match(start.stdout, /perch start <omp\|codex\|claude> \[prompt\] --native --pane right\|tern\|herdr\|tmux/);
    assert.match(start.stdout, /perch start agy \[prompt\] --native --pane right\|tern\|herdr\|tmux/);
    assert.match(start.stdout, /perch start agy --cwd "\$PWD" --json/);
    assert.match(start.stdout, /perch start omp --native --pane right --cwd "\$PWD" --model MODEL --json/);
    assert.match(start.stdout, /perch start codex --native --pane right --cwd "\$PWD" --model MODEL --json/);
    assert.match(start.stdout, /perch start claude --native --pane tern --workspace work --tab agents --cwd "\$PWD" --model MODEL --executable \/absolute\/path\/to\/claude --json/);
    assert.match(start.stdout, /\{provider, mode: "native", pane: \{backend, id\}\}/);
    if (lang === 'en') {
      assert.match(start.stdout, /without sending a prompt/);
      assert.match(start.stdout, /current terminal pane/);
      assert.match(start.stdout, /creating missing targets or splitting an existing tab/);
      assert.match(start.stdout, /exits nonzero[\s\S]*usable session ID and pane error/);
      assert.match(start.stdout, /--native requires an explicit --pane right, tern, herdr, or tmux/);
      assert.match(start.stdout, /--pane herdr and --pane tmux also require --workspace NAME and --tab NAME/);
      assert.match(start.stdout, /for tmux they are session and window names/);
      assert.match(start.stdout, /pane\.id is not a chat ID/);
      assert.match(start.stdout, /no independent Perch bridge or daemon/);
      assert.match(start.stdout, /Detaching is not the same as\s+closing the actual pane/);
      assert.match(start.stdout, /capabilities vary by provider and integration/);
    } else {
      assert.match(start.stdout, /不发送提示词/);
      assert.match(start.stdout, /当前终端窗格/);
      assert.match(start.stdout, /目标不存在时创建，标签页已存在时在其中分屏/);
      assert.match(start.stdout, /非零状态退出并报告可用的会话 ID 和窗格错误/);
      assert.match(start.stdout, /--native 必须显式指定 --pane right、tern、herdr 或 tmux/);
      assert.match(start.stdout, /--pane herdr 和 --pane tmux 同样必须指定 --workspace NAME 和 --tab NAME/);
      assert.match(start.stdout, /tmux 对应会话和窗口名称/);
      assert.match(start.stdout, /pane\.id 不是聊天会话 ID/);
      assert.match(start.stdout, /没有独立的 Perch 桥接进程或守护进程/);
      assert.match(start.stdout, /断开终端与关闭实际窗格不同/);
      assert.match(start.stdout, /发现与能力因提供方和集成而异/);
    }
    for (const args of [['view', '--help'], ['help', 'view']]) {
      const view = run(...args, '--lang', lang);
      assert.equal(view.status, 0, view.stderr);
      assert.match(view.stdout, /perch view <id> \[--lang zh\|en\]/);
      assert.match(view.stdout, /perch view "\$id"/);
      assert.doesNotMatch(view.stdout, /--json/);
      if (lang === 'en') {
        assert.match(view.stdout, /current terminal without opening a new pane/);
        assert.match(view.stdout, /most recent 20 messages and refreshes/);
        assert.match(view.stdout, /read-only.*never sends messages or closes the session/);
      } else {
        assert.match(view.stdout, /当前终端查看会话，不打开新窗格/);
        assert.match(view.stdout, /最近 20 条消息，并随历史记录变化刷新/);
        assert.match(view.stdout, /只读，不会发送消息或关闭会话/);
      }
    }
    const overview = run('--help', '--lang', lang);
    assert.equal(overview.status, 0, overview.stderr);
    const viewUsage = overview.stdout.split('\n').find(line => line.includes('perch view '));
    assert.equal(viewUsage?.trim(), 'perch view <id> [--lang zh|en]');
  }
});

test('send and input help distinguish provider delivery from native terminal input', () => {
  for (const lang of ['en', 'zh']) {
    const run = (...args) => spawnSync(process.execPath, [cli, ...args, '--lang', lang], { encoding: 'utf8' });
    const overview = run('--help');
    const send = run('send', '--help');
    assert.equal(overview.status, 0, overview.stderr);
    assert.equal(send.status, 0, send.stderr);
    assert.match(overview.stdout, /perch input <id> <text> \[--enter\]/);
    assert.match(overview.stdout, /perch input <id> --key <key>/);
    assert.match(send.stdout, /perch send <id> <message>/);
    assert.match(send.stdout, /perch send <id> --stdin/);
    assert.match(send.stdout, /perch send "\$id" '\/skill:example'/);
    for (const output of [overview.stdout, send.stdout]) {
      assert.doesNotMatch(output, /--type|--press|perch (?:type|press|command) /);
    }
    if (lang === 'en') {
      assert.match(send.stdout, /provider's message transport[\s\S]*does not infer intent/);
      assert.match(send.stdout, /slash-leading prompts are forwarded unchanged/);
      assert.match(send.stdout, /\/skill: prompts after the first turn/);
      assert.match(send.stdout, /OMP RPC support[\s\S]*TUI/);
      assert.match(send.stdout, /identity change invalidates the handle/);
      assert.match(send.stdout, /does not wait for a reply or approve\s+permission requests/);
    } else {
      assert.match(send.stdout, /提供方的消息投递通道，不根据文本推断意图/);
      assert.match(send.stdout, /斜杠开头提示词原样转发，包括第一轮之后的 \/skill:/);
      assert.match(send.stdout, /OMP RPC 支持，可能与 TUI 不同/);
      assert.match(send.stdout, /会话身份变化会使句柄失效/);
      assert.match(send.stdout, /投递不等待回复，也不会批准权限请求/);
    }
    for (const args of [['input', '--help'], ['help', 'input']]) {
      const input = run(...args);
      assert.equal(input.status, 0, input.stderr);
      assert.match(input.stdout, /perch input <id> <text> \[--enter\]/);
      assert.match(input.stdout, /perch input <id> --key <key>/);
      assert.match(input.stdout, /perch input "\$id" '\/vibe' --enter/);
      assert.doesNotMatch(input.stdout, /--type|--press|perch (?:type|press|command) /);
      for (const key of ['Enter', 'Escape', 'Tab', 'Backspace', 'Up', 'Down', 'Left', 'Right']) {
        assert.match(input.stdout, new RegExp(`\\b${key}\\b`));
      }
      if (lang === 'en') {
        assert.match(input.stdout, /perch input "\$id" 'Summarize the current work' --enter/);
        assert.match(input.stdout, /ordinary editor is ready[\s\S]*input is empty[\s\S]*no popup/);
        assert.match(input.stdout, /nonempty, single-line, without control\s+characters[\s\S]*64 KiB in UTF-8/);
        assert.match(input.stdout, /--key cannot be combined with text or --enter/);
        assert.match(input.stdout, /input does not accept --stdin/);
        assert.match(input.stdout, /native OMP sessions with the rich extension on Tern or tmux/);
        assert.match(input.stdout, /foreground\s+process match, no input is sent/);
        assert.match(input.stdout, /terminal\s+delivery only[\s\S]*partial delivery[\s\S]*null/);
        assert.match(input.stdout, /running or blocked/);
        assert.match(input.stdout, /Native agy does not support text, --enter or named keys/);
      } else {
        assert.match(input.stdout, /perch input "\$id" '总结当前工作' --enter/);
        assert.match(input.stdout, /普通编辑器已就绪、输入为空且没有弹窗/);
        assert.match(input.stdout, /非空单行文本，不含控制字符（UTF-8 最多 64 KiB）/);
        assert.match(input.stdout, /--key 不能与文本或 --enter 同时使用/);
        assert.match(input.stdout, /input 不支持 --stdin/);
        assert.match(input.stdout, /Tern 或 tmux 中加载完整扩展的原生 OMP 会话/);
        assert.match(input.stdout, /前台进程没有精确匹配，不会发送输入/);
        assert.match(input.stdout, /终端已接收，\s*不表示应用已执行；部分投递[\s\S]*null/);
        assert.match(input.stdout, /running 或 blocked/);
        assert.match(input.stdout, /原生 agy 不支持文本、--enter 或具名按键/);
      }
    }
  }
});
