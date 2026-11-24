export const sessionStatus = {
  idle: '空闲', running: '执行中', blocked: '阻塞', failed: '失败', stopped: '已停止', unknown: '未知',
};

const syntax = {
  list: ['agent-session list [--provider omp|codex|claude] [--json] [--lang zh|en]'],
  start: [
    'agent-session start <omp|codex|claude> [--cwd dir] [--model model] [--executable path] [--pane right|tern|herdr|tmux] [--workspace name] [--tab name] [--json] [--lang zh|en] [-- provider-args...]',
    'agent-session start <omp|codex|claude> [prompt] --native --pane right|tern|herdr|tmux [--cwd dir] [--model model] [--executable path] [--workspace name] [--tab name] [--json] [--lang zh|en] [-- provider-args...]',
  ],
  resume: ['agent-session resume <id> [--json] [--lang zh|en]'],
  send: [
    'agent-session send <id> <message> [--json] [--lang zh|en]',
    'agent-session send <id> --stdin [--json] [--lang zh|en]',
  ],
  input: [
    'agent-session input <id> <text> [--enter] [--json] [--lang zh|en]',
    'agent-session input <id> --key <key> [--json] [--lang zh|en]',
  ],
  history: ['agent-session history <id> [--limit N | --all] [--json] [--lang zh|en]'],
  view: ['agent-session view <id> [--lang zh|en]'],
  wait: ['agent-session wait <id> [--timeout seconds] [--json] [--lang zh|en]'],
  close: ['agent-session close <id> [--json] [--lang zh|en]'],
  integration: ['agent-session integration install omp [--json] [--lang zh|en]'],
  help: ['agent-session help [<command> ...] [--lang zh|en]'],
};

const pages = {
  list: {
    en: {
      purpose: 'Discover local sessions and their capabilities.',
      details: `--provider selects one provider; without it, all providers are queried.
--json emits machine-readable output. Session status values are:
  idle | running | blocked | failed | stopped | unknown
Status is reported by the host and does not guarantee a verifiable local process.`,
      examples: 'agent-session list --provider omp --json',
    },
    zh: {
      purpose: '发现本机会话及其支持的操作。',
      details: `--provider 选择一个提供方；省略时查询全部提供方。
--json 输出机器可读数据。会话 status 枚举：
  idle | running | blocked | failed | stopped | unknown
状态由宿主报告，不保证存在可验证的本机进程。`,
      examples: 'agent-session list --provider omp --json',
    },
  },
  start: {
    en: {
      purpose: 'Create a managed session or launch a native TUI.',
      details: `--cwd sets the working directory (default: current directory).
--model selects a model. --executable is only for Claude and is required for
Claude: provide the absolute path to a trusted native Claude executable.
OMP (managed and native): --model MODEL[:LEVEL]. Omit :LEVEL to use OMP's default.
Put provider options after --. Native mode forwards them verbatim. Managed OMP accepts -e/--extension and --thinking; other managed bridges do not accept extra arguments.
Without --native, start creates a managed session without sending a prompt; use
send to submit a message. Without --pane, no viewer is opened. --pane right opens
a viewer in a split of the current terminal pane.
--pane tern --workspace NAME --tab NAME opens a viewer in the named Tern
workspace and tab, creating missing targets or splitting an existing tab.
--pane herdr and --pane tmux also require --workspace NAME and --tab NAME and
follow the same placement rules. For Herdr these are workspace and tab names;
for tmux they are session and window names.
If opening the managed viewer fails after the session starts, the command exits nonzero
and reports the usable session ID and pane error; with --json, pane is null.
On managed success --json returns the session ID and provider, plus pane: {backend, id}
when requested.
--native requires an explicit --pane right, tern, herdr, or tmux and launches the actual
provider TUI instead of a managed session or viewer. Named backends use the same
workspace and tab requirements and placement rules in both modes. An optional nonempty prompt
must be a single positional argument; it is passed to the provider at startup.
Omitting it starts the TUI without an initial prompt. --json returns only
{provider, mode: "native", pane: {backend, id}}; pane.id is not a chat ID.
There is no independent agent-session bridge or daemon for native mode: the
terminal backend owns the PTY and program lifetime. Detaching is not the same as
closing the actual pane, which ends the program. Native session discovery and
capabilities vary by provider and integration; do not assume send or close works.
Use send to submit a message to a supported session.`,
      examples: `agent-session start omp --cwd "$PWD" --json
agent-session start omp --model provider/model:high --json
agent-session start omp --pane right
agent-session start omp --pane tern --workspace work --tab agents
agent-session start omp --pane herdr --workspace work --tab agents
agent-session start omp --native --pane tmux --workspace work --tab agents
agent-session start omp "你好" --pane right --native
agent-session start omp --native --pane right --cwd "$PWD" --model MODEL --json
agent-session start codex --native --pane right --cwd "$PWD" --model MODEL --json
agent-session start claude --native --pane tern --workspace work --tab agents --cwd "$PWD" --model MODEL --executable /absolute/path/to/claude --json`,
    },
    zh: {
      purpose: '新建托管会话，或启动原生 TUI。',
      details: `--cwd 指定工作目录（默认当前目录）。
--model 指定模型。--executable 仅用于 Claude，启动 Claude 时必填，
须提供可信的原生 Claude 可执行文件的绝对路径。
OMP 托管和原生启动均支持 --model 模型名[:思考等级]。省略后缀时使用 OMP 默认等级。
提供方参数放到 -- 之后。原生模式逐项原样传递；托管 OMP 接受 -e/--extension 和 --thinking，其他托管模式不接受附加参数。
不使用 --native 时新建托管会话，不发送提示词；请用 send 发送消息。
省略 --pane 时不打开查看器；--pane right 在当前终端窗格中分屏打开查看器。
--pane tern --workspace NAME --tab NAME 在指定 Tern 工作区和标签页打开查看器；
目标不存在时创建，标签页已存在时在其中分屏。
--pane herdr 和 --pane tmux 同样必须指定 --workspace NAME 和 --tab NAME，
放置规则相同。Herdr 对应工作区和标签页名称，tmux 对应会话和窗口名称。
若会话启动后打开托管查看窗格失败，命令以非零状态退出并报告可用的会话 ID 和窗格错误；
使用 --json 时 pane 为 null。托管会话成功时 --json 返回会话 ID 和提供方，
请求窗格时还返回 pane: {backend, id}。
--native 必须显式指定 --pane right、tern、herdr 或 tmux，启动提供方的真实 TUI，
而不是托管会话或查看器。两种模式的具名后端使用相同的工作区、标签页要求和放置规则。
可选的初始提示词须为单个非空位置参数，
启动时传给提供方；省略时不带初始提示词。--json 仅返回
{provider, mode: "native", pane: {backend, id}}；pane.id 不是聊天会话 ID。
原生模式没有独立的 agent-session 桥接进程或守护进程：终端后端持有 PTY
并管理程序生命周期。断开终端与关闭实际窗格不同，关闭窗格会结束程序。
原生会话的发现与能力因提供方和集成而异；不能假定支持 send 或 close。
向支持的会话发送消息请使用 send。`,
      examples: `agent-session start omp --cwd "$PWD" --json
agent-session start omp --model provider/model:high --json
agent-session start omp --pane right
agent-session start omp --pane tern --workspace work --tab agents
agent-session start omp --pane herdr --workspace work --tab agents
agent-session start omp --native --pane tmux --workspace work --tab agents
agent-session start omp "你好" --pane right --native
agent-session start omp --native --pane right --cwd "$PWD" --model MODEL --json
agent-session start codex --native --pane right --cwd "$PWD" --model MODEL --json
agent-session start claude --native --pane tern --workspace work --tab agents --cwd "$PWD" --model MODEL --executable /absolute/path/to/claude --json`,
    },
  },
  resume: {
    en: {
      purpose: 'Open a saved managed OMP conversation, or reuse its running session.',
      details: 'Pass the same stable ID returned by start or list. No prompt is sent and interrupted work is not restarted. A process-only ID is not resumable.',
      examples: 'agent-session resume "$id" --json',
    },
    zh: {
      purpose: '重新打开已保存的 OMP 托管对话；如果还在运行，直接复用。',
      details: '使用 start 或 list 返回的同一个稳定 ID。不会发送消息，也不会重做中断的任务。只有进程号的记录不能恢复。',
      examples: 'agent-session resume "$id" --json',
    },
  },
  send: {
    en: {
      purpose: 'Deliver a message to an existing session without waiting for a reply.',
      details: `Provide a message argument or --stdin with piped or redirected text
(up to 1 MiB). send uses the provider's message transport; it does not infer intent
from the text or turn slash-leading messages into terminal commands. For native
terminal text or key input, use input instead.
--json reports accepted: true, false, or null (delivery unknown). False and unknown
exit nonzero. If delivery is unknown, check the session before acting; do not retry
automatically.
For managed OMP, slash-leading prompts are forwarded unchanged, including
/skill: prompts after the first turn. Execution depends on OMP RPC support and
may differ from its TUI. A session identity change invalidates the handle; use
list to obtain the current ID. Submission does not wait for a reply or approve
permission requests.`,
      examples: `# Set id to an existing session ID from list or start first.
printf '%s\\n' 'Summarize the current work' | agent-session send "$id" --stdin
agent-session send "$id" '/skill:example'`,
    },
    zh: {
      purpose: '向已有会话投递消息，不等待回复。',
      details: `提供消息参数，或用 --stdin 从管道或重定向读取文本（最多 1 MiB）。
send 使用提供方的消息投递通道，不根据文本推断意图，也不会将斜杠开头的消息转换为终端命令。
要向原生终端输入文本或按键，请使用 input。
--json 返回 accepted：true、false 或 null（投递结果未知）。false 和 null 均以非零状态退出。
结果未知时先检查会话，不要自动重试。
托管 OMP 的斜杠开头提示词原样转发，包括第一轮之后的 /skill: 提示词。
能否执行取决于 OMP RPC 支持，可能与 TUI 不同。会话身份变化会使句柄失效，
请通过 list 获取当前 ID。投递不等待回复，也不会批准权限请求。`,
      examples: `# 先将 id 设为 list 或 start 返回的已有会话 ID。
printf '%s\\n' '总结当前工作' | agent-session send "$id" --stdin
agent-session send "$id" '/skill:example'`,
    },
  },
  input: {
    en: {
      purpose: 'Send text or a single key to a native OMP terminal.',
      details: `Before input, ensure the ordinary editor is ready, its input is empty, and no popup
is open. Text is written literally: it must be nonempty, single-line, without control
characters, and at most 64 KiB in UTF-8. Add --enter to press Enter after the text;
this combination is rejected while OMP reports running or blocked.
--key names are case-insensitive: Enter, Escape, Tab, Backspace, Up, Down, Left, Right, Ctrl+Q, Ctrl+Enter.
--key cannot be combined with text or --enter. input does not accept --stdin;
use -- to end options when needed. /vibe toggles a mode; repeating it toggles it back.
Input is only for native OMP sessions with the rich extension on Tern or tmux,
using a full session ID and an exact live session-identity handshake. Managed
sessions and read-only viewers are unsupported. If there is no exact foreground
process match, no input is sent.
--json reports accepted: true, false, or null (delivery unknown). True means terminal
delivery only, not that the application acted on it; partial delivery or a transport
failure after writing can yield null. False and unknown exit nonzero. If delivery is
unknown, check the session before acting; do not retry automatically.`,
      examples: `# Set id to an existing native OMP session ID from list first.
agent-session input "$id" 'Summarize the current work' --enter
agent-session input "$id" '/vibe' --enter
agent-session input "$id" 'Check the new alert after this task'
agent-session input "$id" --key Ctrl+Q`,
    },
    zh: {
      purpose: '向原生 OMP 终端输入文本或单个按键。',
      details: `输入前请确认普通编辑器已就绪、输入为空且没有弹窗。
文本原样输入，必须为非空单行文本，不含控制字符（UTF-8 最多 64 KiB）；
加 --enter 可在输入后按 Enter。OMP 报告 running 或 blocked 时会拒绝此组合。
--key 的键名不区分大小写：Enter、Escape、Tab、Backspace、Up、Down、Left、Right、Ctrl+Q、Ctrl+Enter。
--key 不能与文本或 --enter 同时使用。input 不支持 --stdin；需要时可用 -- 结束选项。
/vibe 会切换模式，再执行一次会切换回来。
输入仅支持 Tern 或 tmux 中加载完整扩展的原生 OMP 会话，须使用完整会话 ID 和精确的实时
会话身份握手；不支持托管会话或只读查看器。若前台进程没有精确匹配，不会发送输入。
--json 返回 accepted：true、false 或 null（投递结果未知）。true 只表示终端已接收，
不表示应用已执行；部分投递或写入后的传输失败可能返回 null。false 和 null 均以非零状态退出。
结果未知时先检查会话，不要自动重试。`,
      examples: `# 先将 id 设为 list 返回的已有原生 OMP 会话 ID。
agent-session input "$id" '总结当前工作' --enter
agent-session input "$id" '/vibe' --enter
agent-session input "$id" '完成当前任务后再查这条新告警'
agent-session input "$id" --key Ctrl+Q`,
    },
  },
  history: {
    en: {
      purpose: 'Read the chat messages currently visible for a session.',
      details: `By default the last 20 messages are shown in chronological order.
--limit N selects a positive number of messages; --all reads all available
messages. These options are mutually exclusive. --json emits structured messages.`,
      examples: `# Set id to an existing session ID from list or start first.
agent-session history "$id" --limit 2`,
    },
    zh: {
      purpose: '读取会话当前可见的聊天消息。',
      details: `默认按时间顺序显示最近 20 条消息。
--limit N 指定消息条数（正整数）；--all 读取全部可用消息，两者不能同时使用。
--json 输出结构化消息。`,
      examples: `# 先将 id 设为 list 或 start 返回的已有会话 ID。
agent-session history "$id" --limit 2`,
    },
  },
  view: {
    en: {
      purpose: 'Follow a session in the current terminal without opening a new pane.',
      details: `Displays the most recent 20 messages and refreshes as history changes.
The viewer is read-only: it never sends messages or closes the session.`,
      examples: `# Set id to an existing session ID from list or start first.
agent-session view "$id"`,
    },
    zh: {
      purpose: '在当前终端查看会话，不打开新窗格。',
      details: `显示最近 20 条消息，并随历史记录变化刷新。
查看器为只读，不会发送消息或关闭会话。`,
      examples: `# 先将 id 设为 list 或 start 返回的已有会话 ID。
agent-session view "$id"`,
    },
  },
  wait: {
    en: {
      purpose: 'Wait for the current work in a session to finish.',
      details: `Without --timeout, wait indefinitely; --timeout accepts integer seconds from
0 to 86400, and 0 checks once. A timeout does not cancel work or change session
status. Use history to read messages. --json returns the result status.
Result statuses and exit codes: completed 0; timeout 2; needs_input 3;
failed 1; interrupted 1. Argument and other errors also exit 1.
needs_input requires human attention; do not automatically approve a request.`,
      examples: `# Set id to an existing session ID that supports wait first.
agent-session wait "$id" --timeout 300 --json`,
    },
    zh: {
      purpose: '等待会话当前工作结束。',
      details: `默认无限等待；--timeout 接受 0 到 86400 的整数秒，0 只检查一次。
超时不会取消工作或改变会话状态。查看消息请使用 history；--json 返回结果状态。
结果状态及退出码：completed 0；timeout 2；needs_input 3；
failed 1；interrupted 1。参数及其他错误也以 1 退出。
needs_input 需要人工处理，不要自动批准请求。`,
      examples: `# 先将 id 设为支持 wait 的已有会话 ID。
agent-session wait "$id" --timeout 300 --json`,
    },
  },
  close: {
    en: {
      purpose: 'Close a session managed by this tool.',
      details: 'Closing may interrupt unfinished work. --json returns the ID and close result.',
      examples: `# Set id to an existing managed session ID from start first.
agent-session close "$id"`,
    },
    zh: {
      purpose: '关闭由本工具托管的会话。',
      details: '关闭可能中断尚未完成的工作。--json 返回 ID 和关闭结果。',
      examples: `# 先将 id 设为 start 返回的已有托管会话 ID。
agent-session close "$id"`,
    },
  },
  integration: {
    en: {
      purpose: 'Manage integrations; currently only installing the OMP extension is supported.',
      details: 'The install omp action installs the extension for the active OMP profile. --json returns the result and path.',
      examples: 'agent-session integration install omp --json',
    },
    zh: {
      purpose: '管理集成；目前仅支持安装 OMP 扩展。',
      details: 'install omp 操作为当前 OMP profile 安装扩展。--json 返回结果和安装路径。',
      examples: 'agent-session integration install omp --json',
    },
  },
  'integration install': {
    en: {
      purpose: 'Install an integration; OMP is the supported target.',
      details: 'The extension is installed for the active OMP profile. --json returns the result and path.',
      examples: 'agent-session integration install omp --json',
    },
    zh: {
      purpose: '安装集成；支持的目标为 OMP。',
      details: '扩展安装到当前 OMP profile。--json 返回结果和安装路径。',
      examples: 'agent-session integration install omp --json',
    },
  },
  'integration install omp': {
    en: {
      purpose: 'Install the OMP extension for the active profile.',
      details: `Run in the same environment as the target OMP session. Existing installations
are not overwritten; restart a running OMP TUI to load the extension.
--json returns the installation result and path.`,
      examples: 'agent-session integration install omp --json',
    },
    zh: {
      purpose: '为当前 profile 安装 OMP 扩展。',
      details: `请在目标 OMP 会话相同的环境中执行。不会覆盖已有安装；运行中的 OMP TUI
需要重启才能加载扩展。--json 返回安装结果和路径。`,
      examples: 'agent-session integration install omp --json',
    },
  },
  help: {
    en: {
      purpose: 'Show the overview or help for a command without executing it.',
      details: 'Pass a command path after help, or use --help or -h after a command. --lang zh|en selects the help language.',
      examples: 'agent-session help integration install omp',
    },
    zh: {
      purpose: '显示命令总览或指定命令的帮助，不执行该命令。',
      details: '在 help 后提供命令路径，或在命令后使用 --help 或 -h。--lang zh|en 选择帮助语言。',
      examples: 'agent-session help integration install omp',
    },
  },
};

const syntaxKey = command => command.startsWith('integration') ? 'integration' : command;
const lines = command => syntax[syntaxKey(command)].map(line => `  ${line}`).join('\n');

export function overview(lang) {
  const zh = lang === 'zh';
  return `${zh ? '用法：' : 'Usage:'}\n${Object.keys(syntax).map(lines).join('\n')}

${zh ? '管理本机 OMP、Codex 和 Claude 会话。' : 'Manage local OMP, Codex, and Claude sessions.'}
${zh ? '使用 agent-session help <command> 或在命令后添加 --help 查看详细帮助。' : 'Use agent-session help <command> or add --help after a command for details.'}`;
}

export function commandHelp(command, lang) {
  if (!Object.hasOwn(pages, command)) return undefined;
  const page = pages[command][lang === 'zh' ? 'zh' : 'en'];
  const zh = lang === 'zh';
  return `${zh ? '用法：' : 'Usage:'}\n${lines(command)}

${page.purpose}
${page.details}
${command === 'help' ? '' : zh ? '\n--lang zh|en 选择输出语言。' : '\n--lang zh|en selects the output language.'}

${zh ? '示例：' : 'Examples:'}
${page.examples.split('\n').map(line => `  ${line}`).join('\n')}`;
}
