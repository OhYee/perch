import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { translateDiagnostic } from '../diagnostics.mjs';

test('diagnostics non-Claude known adapter reasons and errors', () => {
  const cases = [
    ['OMP session has not enabled the local Perch extension', 'OMP 会话未启用本地 Perch 扩展'],
    ['Current session identity is unavailable; enable the local extension', '当前会话身份不可用；请启用本地扩展'],
    ['OMP delivery timed out; delivery status is unknown; do not retry automatically', 'OMP 发送超时；投递状态未知，请勿自动重试'],
    ['Invalid OMP journal entry', '无效的 OMP 日志记录'],
    ['OMP journal identity changed', 'OMP 日志身份已改变'],
    ['Codex app-server is not running', 'Codex app-server 未运行'],
    ['Codex app-server connection failed; delivery may be unknown', 'Codex app-server 连接失败；投递状态可能未知'],
    ['Codex app-server rejected the request', 'Codex app-server 拒绝了请求'],
    ['Invalid request', '无效的请求'],
    ['Request rejected', '请求被拒绝'],
    ['Reconnect the local Perch bridge after a cancelled session transition', '会话切换取消后重新连接本地 Perch 桥接'],
    ['Perch bridge reconnected', 'Perch 桥接已重新连接'],
  ];
  for (const [source, expected] of cases) {
    assert.equal(translateDiagnostic(source, 'zh'), expected);
    assert.equal(translateDiagnostic(source, 'en'), source);
  }
});

test('legacy adapter diagnostics use Perch branding in both languages', () => {
  for (const [legacy, en, zh] of [
    ['OMP session is not managed by agent-session', 'OMP session is not managed by Perch', '此 OMP 会话不由 Perch 托管'],
    ['OMP session has not enabled the local agent-session extension', 'OMP session has not enabled the local Perch extension', 'OMP 会话未启用本地 Perch 扩展'],
  ]) {
    assert.equal(translateDiagnostic(legacy, 'en'), en);
    assert.equal(translateDiagnostic(legacy, 'zh'), zh);
  }
});

test('diagnostics non-Claude dynamic error codes preserve the code', () => {
  assert.equal(translateDiagnostic('Codex app-server rejected -32600', 'zh'), 'Codex app-server 拒绝了请求（错误码 -32600）');
  assert.equal(translateDiagnostic('Codex app-server rejected E_CUSTOM', 'zh'), 'Codex app-server 拒绝了请求（错误码 E_CUSTOM）');
  assert.equal(translateDiagnostic('Codex app-server rejected 42', 'en'), 'Codex app-server rejected 42');
});

test('diagnostics non-Claude unknown errors and payloads stay untouched', () => {
  const payloads = [
    'ENOENT: no such file or directory, open /private/path',
    'Invalid request: private user message',
    'Codex app-server rejected arbitrary user content',
    '{"error":"Invalid request","message":"hello"}',
    'Invalid request\nuser content',
    '',
  ];
  for (const payload of payloads) assert.equal(translateDiagnostic(payload, 'zh'), payload);
  const object = { error: 'Invalid request', text: 'hello' };
  assert.equal(translateDiagnostic(object, 'zh'), object);
});

test('diagnostics Claude adapter and bridge protocol errors', () => {
  const cases = [
    ['Claude does not expose programmatic input for this session; attach is interactive.', 'Claude 未为此会话提供程序化输入；附加会话需要交互操作。'],
    ['No unambiguous local transcript found.', '未找到唯一的本地会话记录。'],
    ['Claude exited before acknowledgment; delivery status is unknown', 'Claude 在确认前退出；投递状态未知'],
    ['Claude input failed; delivery status is unknown', 'Claude 输入失败；投递状态未知'],
    ['Claude bridge could not start.', 'Claude 桥接无法启动。'],
  ];
  for (const [source, expected] of cases) {
    assert.equal(translateDiagnostic(source, 'zh'), expected);
    assert.equal(translateDiagnostic(source, 'en'), source);
  }
});

test('diagnostics Claude bridge CLI uses system language for its own errors', () => {
  const bridge = fileURLToPath(new URL('../adapters/claude-bridge.mjs', import.meta.url));
  for (const [lang, expected] of [
    ['zh_CN.UTF-8', '请提供受信任的原生 Claude 可执行文件的绝对路径'],
    ['en_US.UTF-8', 'Pass the absolute path to the trusted native Claude executable'],
  ]) {
    const result = spawnSync(process.execPath, [bridge], { encoding: 'utf8', env: { ...process.env, LC_ALL: lang } });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(expected));
    assert.equal(result.stdout, '');
  }
});
