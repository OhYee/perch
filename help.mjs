export const sessionStatus = {
  idle: '空闲', running: '执行中', blocked: '阻塞', failed: '失败', stopped: '已停止', unknown: '未知',
};

const syntax = {
  list: ['perch list [--provider omp|codex|claude|agy] [--json] [--lang zh|en]'],
  start: [
    'perch start <omp|codex|claude> [--cwd dir] [--model model] [--executable path] [--pane right|tern|herdr|tmux] [--workspace name] [--tab name] [--json] [--lang zh|en] [-- provider-args...]',
    'perch start <omp|codex|claude> [prompt] --native --pane right|tern|herdr|tmux [--cwd dir] [--model model] [--executable path] [--workspace name] [--tab name] [--json] [--lang zh|en] [-- provider-args...]',
    'perch start agy [--cwd dir] [--model model] [--pane right|tern|herdr|tmux] [--workspace name] [--tab name] [--json] [--lang zh|en]',
    'perch start agy [prompt] --native --pane right|tern|herdr|tmux [--cwd dir] [--model model] [--workspace name] [--tab name] [--json] [--lang zh|en]',
  ],
  resume: ['perch resume <id> [--json] [--lang zh|en]'],
  send: [
    'perch send <id> <message> [--json] [--lang zh|en]',
    'perch send <id> --stdin [--json] [--lang zh|en]',
  ],
  input: [
    'perch input <id> <text> [--enter] [--json] [--lang zh|en]',
    'perch input <id> --key <key> [--json] [--lang zh|en]',
  ],
  history: ['perch history <id> [--limit N | --all] [--json] [--lang zh|en]'],
  view: ['perch view <id> [--lang zh|en]'],
  wait: ['perch wait <id> [--timeout seconds] [--json] [--lang zh|en]'],
  close: ['perch close <id> [--json] [--lang zh|en]'],
  integration: [
    'perch integration install omp [--json] [--lang zh|en]',
    'perch integration install agy [--json] [--lang zh|en]',
    'perch integration agy-hook',
    'perch integration agy-statusline',
  ],
  version: ['perch --version | -V', 'perch version [--json] [--lang zh|en]'],
  update: ['perch update [--check] [--beta] [--json] [--repo OWNER/REPO] [--lang zh|en]'],
  help: ['perch help [<command> ...] [--lang zh|en]'],
};

const pages = {
  version: {
    en: {
      purpose: 'Show the installed Perch version.',
      details: '--json emits an object with a version field.',
      examples: 'perch --version\nperch version --json',
    },
    zh: {
      purpose: '显示已安装的 Perch 版本。',
      details: '--json 输出包含 version 字段的对象。',
      examples: 'perch -V\nperch version --json',
    },
  },
  update: {
    en: {
      purpose: 'Check for or install the latest GitHub Release.',
      details: `Only stable releases are considered by default; --beta also considers prereleases.
--check reports availability without installing. --json emits current, latest, and status.
--repo OWNER/REPO selects the release repository when the installation has no trusted origin.
Source checkouts are never overwritten by release files.`,
      examples: 'perch update --check\nperch update --beta --check\nperch update --check --repo OWNER/REPO --json\nperch update',
    },
    zh: {
      purpose: '检查或安装最新的 GitHub 发行版。',
      details: `默认只检查稳定版；--beta 也检查预发行版。
--check 只检查，不安装。--json 输出 current、latest 和 status。
安装包没有可信来源时，使用 --repo OWNER/REPO 指定发行仓库。
不会使用发行文件覆盖源码目录。`,
      examples: 'perch update --check\nperch update --beta --check\nperch update --check --repo OWNER/REPO --json\nperch update',
    },
  },
  list: {
    en: {
      purpose: 'Discover local sessions and their capabilities.',
      details: `--provider selects one provider; without it, all providers are queried.
--json emits machine-readable output. Session status values are:
  idle | running | blocked | failed | stopped | unknown
Status is reported by the host and does not guarantee a verifiable local process.
Recognized native agy TUIs appear as process clues unless the Perch agy plugin
(perch integration install agy) or a verified status line report identifies the
current conversation. On macOS, ambiguous startup arguments, including values
with spaces, can hide the process entirely. Archived agy conversations are not listed.`,
      examples: 'perch list --provider omp --json\nperch list --provider agy',
    },
    zh: {
      purpose: '发现本机会话及其支持的操作。',
      details: `--provider 选择一个提供方；省略时查询全部提供方。
--json 输出机器可读数据。会话 status 枚举：
  idle | running | blocked | failed | stopped | unknown
状态由宿主报告，不保证存在可验证的本机进程。
可识别的原生 agy TUI 默认只显示进程线索；安装 Perch 的 agy 插件（perch integration install agy）或在 macOS agy 1.5.16 中启用状态行后，可识别当前对话。
macOS 上，启动参数解析不明确时（例如参数值包含空格），连进程线索也可能不显示。
不列出归档对话。`,
      examples: 'perch list --provider omp --json\nperch list --provider agy',
    },
  },
  start: {
    en: {
      purpose: 'Create a managed session or launch a native TUI.',
      details: `--cwd sets the working directory (default: current directory).
--model selects a model. --executable is only for Claude and is required for
Claude: provide the absolute path to a trusted native Claude executable.
OMP (managed and native): --model MODEL[:LEVEL]. Omit :LEVEL to use OMP's default.
Put provider options after -- except for agy, which accepts no extra arguments.
Native OMP, Codex, and Claude forward them verbatim. Only managed OMP accepts
additional arguments (-e/--extension and --thinking).
Managed agy opens a private ACP session. Sign in to agy separately if required.
If the state directory is rejected, create a new private directory with
mkdir -m 700 "$HOME/.perch-state" and set XDG_STATE_HOME to its absolute path.
Use that same directory for later commands; do not change shared permissions.
An explicit --model must be offered by agy; Perch does not fall back to the default.
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
Omitting it starts the TUI without an initial prompt. Native agy uses
--prompt-interactive and does not accept a positional prompt starting with -.
On macOS, omit the initial prompt and avoid option values with spaces if you
need to discover the TUI with list; these can make startup arguments ambiguous.
--json returns only
{provider, mode: "native", pane: {backend, id}}; pane.id is not a chat ID.
There is no independent Perch bridge or daemon for native mode: the
terminal backend owns the PTY and program lifetime. Detaching is not the same as
closing the actual pane, which ends the program. Native session discovery and
capabilities vary by provider and integration; do not assume send or close works.
Use send to submit a message to a supported session.`,
      examples: `perch start omp --cwd "$PWD" --json
perch start omp --model provider/model:high --json
perch start omp --pane right
perch start omp --pane tern --workspace work --tab agents
perch start omp --pane herdr --workspace work --tab agents
perch start omp --native --pane tmux --workspace work --tab agents
perch start omp "你好" --pane right --native
perch start omp --native --pane right --cwd "$PWD" --model MODEL --json
perch start codex --native --pane right --cwd "$PWD" --model MODEL --json
perch start claude --native --pane tern --workspace work --tab agents --cwd "$PWD" --model MODEL --executable /absolute/path/to/claude --json
perch start agy --cwd "$PWD" --json
perch start agy 'Hello' --native --pane right`,
    },
    zh: {
      purpose: '新建托管会话，或启动原生 TUI。',
      details: `--cwd 指定工作目录（默认当前目录）。
--model 指定模型。--executable 仅用于 Claude，启动 Claude 时必填，
须提供可信的原生 Claude 可执行文件的绝对路径。
OMP 托管和原生启动均支持 --model 模型名[:思考等级]。省略后缀时使用 OMP 默认等级。
提供方参数放在 -- 之后，agy 不接受附加参数。原生 OMP、Codex 和 Claude 原样传递；
托管模式只有 OMP 接受附加参数（-e/--extension 和 --thinking）。
托管 agy 新建私有 ACP 会话。如需认证，请先在 agy 中另行登录。
如果状态目录被拒绝，请用 mkdir -m 700 "$HOME/.perch-state" 创建私有目录；
将 XDG_STATE_HOME 设为其绝对路径，后续命令使用同一路径。不要更改共享目录的权限。
指定 --model 时，该模型必须由 agy 提供；Perch 不会退回默认模型。
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
可选的初始提示词须为单个非空位置参数，省略时不带初始提示词。
原生 agy 使用 --prompt-interactive 传入提示词，不接受以 - 开头的位置参数。
如果需要让 macOS 上的 list 发现原生 agy，请省略初始提示词，并避免使用含空格的选项值；
这些参数可能导致 Perch 无法识别启动方式。
--json 仅返回
{provider, mode: "native", pane: {backend, id}}；pane.id 不是聊天会话 ID。
原生模式没有独立的 Perch 桥接进程或守护进程：终端后端持有 PTY
并管理程序生命周期。断开终端与关闭实际窗格不同，关闭窗格会结束程序。
原生会话的发现与能力因提供方和集成而异；不能假定支持 send 或 close。
向支持的会话发送消息请使用 send。`,
      examples: `perch start omp --cwd "$PWD" --json
perch start omp --model provider/model:high --json
perch start omp --pane right
perch start omp --pane tern --workspace work --tab agents
perch start omp --pane herdr --workspace work --tab agents
perch start omp --native --pane tmux --workspace work --tab agents
perch start omp "你好" --pane right --native
perch start omp --native --pane right --cwd "$PWD" --model MODEL --json
perch start codex --native --pane right --cwd "$PWD" --model MODEL --json
perch start claude --native --pane tern --workspace work --tab agents --cwd "$PWD" --model MODEL --executable /absolute/path/to/claude --json
perch start agy --cwd "$PWD" --json
perch start agy '你好' --native --pane right`,
    },
  },
  resume: {
    en: {
      purpose: 'Reopen a managed OMP or agy conversation, or reuse its running session.',
      details: `Pass the same stable ID returned by start or list. No prompt is sent and
interrupted work is not restarted. For agy, only conversations created by Perch
are eligible, and the provider must support loading them. To read a closed agy
conversation, resume it first. A long conversation can still reopen; only the
retained history window is available afterward. Use the same XDG_STATE_HOME
as at startup. Native and process-only IDs cannot be resumed.`,
      examples: 'perch resume "$id" --json',
    },
    zh: {
      purpose: '重新打开 OMP 或 agy 托管对话；如果仍在运行，则直接复用。',
      details: `使用 start 或 list 返回的同一个稳定 ID。不会发送消息或重做中断的任务。
agy 只允许恢复 Perch 创建的对话，并要求提供方支持加载。要读取已关闭的 agy 对话，
请先 resume。长对话仍可恢复，但只保留窗口内的历史。请使用启动时的 XDG_STATE_HOME。
原生对话 ID 和只有进程号的 ID 不能恢复。`,
      examples: 'perch resume "$id" --json',
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
permission requests. Plugin-enabled native agy sessions deliver prompts via the
verified terminal pane (staging multiline or long prompts to a private file);
statusline-only native agy sessions do not support send.`,
      examples: `# Set id to an existing session ID from list or start first.
printf '%s\\n' 'Summarize the current work' | perch send "$id" --stdin
perch send "$id" '/skill:example'`,
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
请通过 list 获取当前 ID。投递不等待回复，也不会批准权限请求。
安装 hook 插件的原生 agy 会话通过已校验的终端窗格投递消息（多行或长消息写入私有临时文件后引用）；仅启用状态行的原生 agy 会话不支持 send。`,
      examples: `# 先将 id 设为 list 或 start 返回的已有会话 ID。
printf '%s\\n' '总结当前工作' | perch send "$id" --stdin
perch send "$id" '/skill:example'`,
    },
  },
  input: {
    en: {
      purpose: 'Send text or a single key to a native OMP or AGY terminal.',
      details: `Before input, ensure the ordinary editor is ready, its input is empty, and no popup
is open. Text is written literally: it must be nonempty, single-line, without control
characters, and at most 64 KiB in UTF-8. Add --enter to press Enter after the text;
this combination is rejected while the session reports running or blocked.
--key names are case-insensitive: Enter, Escape, Tab, Backspace, Up, Down, Left, Right, Ctrl+Q, Ctrl+Enter.
--key cannot be combined with text or --enter. input does not accept --stdin;
use -- to end options when needed. /vibe toggles a mode; repeating it toggles it back.
Input supports native OMP sessions with the rich extension and native agy sessions
with the Perch hook plugin on Tern, Herdr, or tmux, using a full session ID and
verified live process identity. Managed sessions and read-only viewers are unsupported.
If there is no exact foreground process match, no input is sent.
Statusline-only native agy does not support text, --enter or named keys: its status
line cannot verify editor focus or exclude a permission prompt. Use the original terminal.
--json reports accepted: true, false, or null (delivery unknown). True means terminal
delivery only, not that the application acted on it; partial delivery or a transport
failure after writing can yield null. False and unknown exit nonzero. If delivery is
unknown, check the session before acting; do not retry automatically.`,
      examples: `# Set id to an existing native OMP or AGY session ID from list first.
perch input "$id" 'Summarize the current work' --enter
perch input "$id" '/vibe' --enter
perch input "$id" 'Check the new alert after this task'
perch input "$id" --key Ctrl+Q`,
    },
    zh: {
      purpose: '向原生 OMP 或 AGY 终端输入文本或单个按键。',
      details: `输入前请确认普通编辑器已就绪、输入为空且没有弹窗。
文本原样输入，必须为非空单行文本，不含控制字符（UTF-8 最多 64 KiB）；
加 --enter 可在输入后按 Enter。会话报告 running 或 blocked 时会拒绝此组合。
--key 的键名不区分大小写：Enter、Escape、Tab、Backspace、Up、Down、Left、Right、Ctrl+Q、Ctrl+Enter。
--key 不能与文本或 --enter 同时使用。input 不支持 --stdin；需要时可用 -- 结束选项。
/vibe 会切换模式，再执行一次会切换回来。
输入支持 Tern、Herdr 或 tmux 中加载完整扩展的原生 OMP 会话，以及安装 Perch hook 插件的原生 agy 会话，
须使用完整会话 ID 并通过实时会话身份核验；不支持托管会话或只读查看器。若前台进程没有精确匹配，不会发送输入。
仅启用状态行的原生 agy 不支持文本、--enter 或具名按键（状态行无法确认编辑器焦点或排除权限弹窗），请使用原终端。
--json 返回 accepted：true、false 或 null（投递结果未知）。true 只表示终端已接收，
不表示应用已执行；部分投递或写入后的传输失败可能返回 null。false 和 null 均以非零状态退出。
结果未知时先检查会话，不要自动重试。`,
      examples: `# 先将 id 设为 list 返回的已有原生 OMP 或 AGY 会话 ID。
perch input "$id" '总结当前工作' --enter
perch input "$id" '/vibe' --enter
perch input "$id" '完成当前任务后再查这条新告警'
perch input "$id" --key Ctrl+Q`,
    },
  },
  history: {
    en: {
      purpose: 'Read the chat messages currently visible for a session.',
      details: `By default the last 20 messages are shown in chronological order.
--limit N selects a positive number of messages; --all reads all available
messages. These options are mutually exclusive. --json emits structured messages.
Managed agy retains up to 1,024 messages and 4 MiB of chat text. The default
and --limit can return fewer messages. A running reply can appear while it
streams; if it exceeds the retention limit, it is removed rather than kept
as a partial message. --all fails if any messages were omitted or evicted.
Plugin-enabled native agy sessions read persisted history from transcript.jsonl;
statusline-only native agy history remains unavailable.`,
      examples: `# Set id to an existing session ID from list or start first.
perch history "$id" --limit 2`,
    },
    zh: {
      purpose: '读取会话当前可见的聊天消息。',
      details: `默认按时间顺序显示最近 20 条消息。
--limit N 指定消息条数（正整数）；--all 读取全部可用消息，两者不能同时使用。
--json 输出结构化消息。托管 agy 最多保留 1,024 条、合计 4 MiB 的聊天文本。
默认或使用 --limit 时，返回的条数可能更少。回复生成时可看到实时文本；
如果回复超出保留上限，就会移除整条回复，而不是保留半条；
如果有消息被省略或淘汰，--all 会报错。安装 hook 插件的原生 agy 会话从 transcript.jsonl 读取持久化历史；仅启用状态行的原生 agy 不读取历史。`,
      examples: `# 先将 id 设为 list 或 start 返回的已有会话 ID。
perch history "$id" --limit 2`,
    },
  },
  view: {
    en: {
      purpose: 'Follow a session in the current terminal without opening a new pane.',
      details: `Displays the most recent 20 messages and refreshes as history changes.
Only retained messages are shown; there may be fewer than 20.
The viewer is read-only: it never sends messages or closes the session.`,
      examples: `# Set id to an existing session ID from list or start first.
perch view "$id"`,
    },
    zh: {
      purpose: '在当前终端查看会话，不打开新窗格。',
      details: `显示最近 20 条消息，并随历史记录变化刷新；保留的消息不足 20 条时只显示现有条目。
查看器为只读，不会发送消息或关闭会话。`,
      examples: `# 先将 id 设为 list 或 start 返回的已有会话 ID。
perch view "$id"`,
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
perch wait "$id" --timeout 300 --json`,
    },
    zh: {
      purpose: '等待会话当前工作结束。',
      details: `默认无限等待；--timeout 接受 0 到 86400 的整数秒，0 只检查一次。
超时不会取消工作或改变会话状态。查看消息请使用 history；--json 返回结果状态。
结果状态及退出码：completed 0；timeout 2；needs_input 3；
failed 1；interrupted 1。参数及其他错误也以 1 退出。
needs_input 需要人工处理，不要自动批准请求。`,
      examples: `# 先将 id 设为支持 wait 的已有会话 ID。
perch wait "$id" --timeout 300 --json`,
    },
  },
  close: {
    en: {
      purpose: 'Close a session managed by this tool.',
      details: 'Closing may interrupt unfinished work. --json returns the ID and close result.',
      examples: `# Set id to an existing managed session ID from start first.
perch close "$id"`,
    },
    zh: {
      purpose: '关闭由本工具托管的会话。',
      details: '关闭可能中断尚未完成的工作。--json 返回 ID 和关闭结果。',
      examples: `# 先将 id 设为 start 返回的已有托管会话 ID。
perch close "$id"`,
    },
  },
  integration: {
    en: {
      purpose: 'Set up local provider integrations.',
      details: `install omp installs the extension for the active OMP profile.
install agy installs the native Antigravity CLI plugin with lifecycle hooks.
agy-hook is the hook callback invoked by the installed agy plugin.
agy-statusline is a callback for the native agy status line; it does not change settings.`,
      examples: 'perch integration install omp --json\nperch integration install agy --json\nperch help integration agy-statusline',
    },
    zh: {
      purpose: '使用本地提供方集成。',
      details: `install omp 为当前 OMP profile 安装扩展。
install agy 安装原生 Antigravity CLI 生命周期 hook 插件。
agy-hook 是已安装的 agy 插件调用的 hook 回调。
agy-statusline 是原生 agy 状态行的回调，不修改设置。`,
      examples: 'perch integration install omp --json\nperch integration install agy --json\nperch help integration agy-statusline',
    },
  },
  'integration install': {
    en: {
      purpose: 'Install an integration for OMP or AGY.',
      details: `omp installs the extension for the active OMP profile.
agy installs the native Antigravity CLI plugin under ~/.gemini/config/plugins/perch.
--json returns the result and path.`,
      examples: 'perch integration install omp --json\nperch integration install agy --json',
    },
    zh: {
      purpose: '为 OMP 或 AGY 安装集成。',
      details: `omp 将扩展安装到当前 OMP profile。
agy 将原生 Antigravity CLI 插件安装到 ~/.gemini/config/plugins/perch。
--json 返回结果和安装路径。`,
      examples: 'perch integration install omp --json\nperch integration install agy --json',
    },
  },
  'integration install omp': {
    en: {
      purpose: 'Install the OMP extension for the active profile.',
      details: `Run in the same environment as the target OMP session. Existing installations
are not overwritten; restart a running OMP TUI to load the extension.
The extension also registers the perch tool inside OMP (including /vibe mode)
with async completion follow-up notifications and automatic cleanup on exit.
--json returns the installation result and path.`,
      examples: 'perch integration install omp --json',
    },
    zh: {
      purpose: '为当前 profile 安装 OMP 扩展。',
      details: `请在目标 OMP 会话相同的环境中执行。不会覆盖已有安装；运行中的 OMP TUI
需要重启才能加载扩展。该扩展同时会在 OMP 内注册 perch 工具（支持 /vibe 模式），
提供异步完成回推通知与退出自动清理。--json 返回安装结果和路径。`,
      examples: 'perch integration install omp --json',
    },
  },
  'integration install agy': {
    en: {
      purpose: 'Install the native Antigravity CLI plugin for Perch.',
      details: `Writes plugin.json and hooks.json to ~/.gemini/config/plugins/perch (or
$AGY_CONFIG_DIR/plugins/perch) to register SessionStart, PreInvocation, and Stop
hooks. Enables native agy discovery, persisted history, wait, input, and send
(via Tern, Herdr, or tmux pane input). Existing foreign files or symlinks are
never overwritten; restart a running agy TUI to load the plugin.
--json returns the installation result and path.`,
      examples: 'perch integration install agy --json',
    },
    zh: {
      purpose: '安装原生 Antigravity CLI 的 Perch 插件。',
      details: `在 ~/.gemini/config/plugins/perch（或 $AGY_CONFIG_DIR/plugins/perch）写入
plugin.json 和 hooks.json，注册 SessionStart、PreInvocation 和 Stop 生命周期 hook。
启用后可为原生 agy 提供会话发现、持久化历史读取、wait、input 和 send（经由 Tern、Herdr 或 tmux 窗格输入）。
不会覆盖已有的其他文件或符号链接；运行中的 agy TUI 需要重启才能加载插件。
--json 返回安装结果和路径。`,
      examples: 'perch integration install agy --json',
    },
  },
  'integration agy-hook': {
    en: {
      purpose: 'Record native agy conversation state from a lifecycle hook.',
      details: `Invoked automatically by the plugin installed via perch integration install agy.
Reads hook JSON from piped stdin, verifies the calling interactive agy process
ancestry, updates the private per-PID receipt, and prints {} on stdout.`,
      examples: 'perch integration install agy --json\nprintf \'{}\' | perch integration agy-hook',
    },
    zh: {
      purpose: '接收原生 agy 生命周期 hook 上报并更新会话状态。',
      details: `由 perch integration install agy 安装的插件自动调用。
从管道读取 hook JSON，核实调用链中的活动交互式 agy 进程，更新私有收据并在标准输出返回 {}。`,
      examples: 'perch integration install agy --json\nprintf \'{}\' | perch integration agy-hook',
    },
  },
  'integration agy-statusline': {
    en: {
      purpose: 'Verify a conversation report from the native agy status line.',
      details: `Conversation identification is supported on macOS with agy 1.5.16 only.
In the target agy TUI, enter this exact recipe, including && :, with a
trusted Perch executable. You may use its single-quoted absolute path instead
of perch. The suffix preserves the shell needed to verify the report's source.
This changes and saves the agy status line setting; save any previous command
so you can restore it. Perch does not change settings itself.
The callback expects piped JSON and must be able to inspect its process ancestry.
Without a verified report during the query, including when a sandbox blocks
the check or the TUI is idle, a recognized process is listed without a
conversation ID. Ambiguous startup arguments on macOS can prevent even process
discovery. This does not enable history, view, send, input, wait or close.`,
      examples: '/statusline perch integration agy-statusline && :\nperch list --provider agy --json',
    },
    zh: {
      purpose: '验证原生 agy 状态行报告的当前对话身份。',
      details: `当前仅支持在 macOS 的 agy 1.5.16 中通过状态行识别对话。
请在目标 agy TUI 中按示例执行命令，保留 && :。使用可信的 Perch 可执行文件，
也可用单引号括住的绝对路径替代 perch。后缀会保留用于核实报告来源的 shell。
该命令会修改并保存 agy 状态行设置；如有原命令请先保留，以便还原。Perch 不会代改设置。
回调从管道读取 JSON，且必须能检查进程的父子关系。如果沙箱阻止检查、TUI 闲置，
或因其他原因导致查询期间没有可验证的新报告，list 只为能识别的进程提供线索。
macOS 上若启动参数解析不明确，连进程线索也可能不显示。
此集成不会开启 history、view、send、input、wait 或 close。`,
      examples: '/statusline perch integration agy-statusline && :\nperch list --provider agy --json',
    },
  },
  help: {
    en: {
      purpose: 'Show the overview or help for a command without executing it.',
      details: 'Pass a command path after help, or use --help or -h after a command. --lang zh|en selects the help language.',
      examples: 'perch help integration install omp',
    },
    zh: {
      purpose: '显示命令总览或指定命令的帮助，不执行该命令。',
      details: '在 help 后提供命令路径，或在命令后使用 --help 或 -h。--lang zh|en 选择帮助语言。',
      examples: 'perch help integration install omp',
    },
  },
};

const lines = command => {
  const entries = command === 'integration agy-statusline' ? [syntax.integration[3]]
    : command === 'integration agy-hook' ? [syntax.integration[2]]
      : command === 'integration install omp' ? [syntax.integration[0]]
        : command === 'integration install agy' ? [syntax.integration[1]]
          : command === 'integration install' ? [syntax.integration[0], syntax.integration[1]]
            : syntax[command];
  return entries.map(line => `  ${line}`).join('\n');
};

export function overview(lang) {
  const zh = lang === 'zh';
  return `${zh ? '用法：' : 'Usage:'}\n${Object.keys(syntax).map(lines).join('\n')}

${zh ? '管理本机 OMP、Codex、Claude 和 Antigravity CLI（agy）会话。' : 'Manage local OMP, Codex, Claude, and Antigravity CLI (agy) sessions.'}
${zh ? '使用 perch help <command> 或在命令后添加 --help 查看详细帮助。' : 'Use perch help <command> or add --help after a command for details.'}`;
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
