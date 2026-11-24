# agent-session

用一个 CLI 管理本机当前用户的 OMP、Codex CLI 和 Claude Code 对话。可以发现已有会话，也可以新建可由脚本控制的后台会话；不需要常驻的中心服务。

## 安装与要求

需要 Node.js 22.13 或更高版本及 npm。从本项目源码目录安装依赖并运行：

```sh
npm ci --ignore-scripts
./cli.mjs --help
./cli.mjs list
```

如需从任意目录使用 `agent-session`，可在源码目录运行以下命令，并将 `~/.local/bin` 加入 `PATH`；保留源码目录及其依赖：

```sh
mkdir -p "$HOME/.local/bin"
ln -s "$PWD/cli.mjs" "$HOME/.local/bin/agent-session"
```

也可从 GitHub Release 安装。下载同一版本的 `agent-session-<版本>.tgz` 和 `SHA256SUMS.txt` 到一个空目录；校验通过后安装本地文件（以下以首个候选版本为例，不从 npm registry 发布本包）：

```sh
shasum -a 256 -c SHA256SUMS.txt && npm install --global --ignore-scripts ./agent-session-0.1.0.tgz
agent-session --help
```

对应功能需要本机安装并配置相应的 OMP、Codex CLI 或 Claude Code；pane 功能另需 `terminal-pane`，部分示例使用 `jq`。本机发现与发送在 macOS 上验证，其他平台的支持取决于提供方及终端。Claude 新增的托管路径尚未实机验证；各提供方已有会话的能力见下表。

## 快速使用

以下示例假设已按上方配置 `agent-session` 命令；否则在源码目录使用 `./cli.mjs`。

```sh
agent-session list
agent-session list --provider codex --json
agent-session send "$id" '请告诉我当前进度'  # id 是 list 给出的完整 ID
agent-session history "$id" --limit 10
```

`agent-session --help` 查看命令总览。在任一子命令后加 `--help` 或 `-h`，可查看该命令的参数和示例，例如 `agent-session start --help`、`agent-session integration install omp --help`。帮助只打印说明，不会启动会话或安装扩展。

终端提示支持简体中文和英文。默认按 `LC_ALL`、`LC_MESSAGES`、`LANG` 的优先级选择语言；其他语言及 `C` 环境使用英文。用 `agent-session list --lang zh` 或 `agent-session --lang en --help` 可临时覆盖。会话标题、聊天正文、路径和 ID 保留原文；切换语言不改变 `--json` 的输出。

输出到交互终端时，CLI 会用颜色区分标题、会话 ID、角色和状态。管道、重定向及 `--json` 输出不着色；设置 `NO_COLOR=1` 也可禁用颜色。列表的编号说明与表格之间留一空行。
交互终端始终使用表格，前三列是标题、完整 ID 和状态。窄窗口也不切换布局或截断字段；超宽行由终端自然换行。

`TITLE` 显示 agent 提供的原生会话标题；没有标题时显示 `—`（`--json` 中为 `null`），不会用首条消息或工作目录代替。

`KIND=session` 是已识别的会话；`process` 只是终端进程线索，不能当作另一个会话计数。`SEND=no` 后面会说明原因。`HISTORY=live` 表示从正在运行的会话读取，`persisted` 表示读取绑定到该会话的落盘聊天，可能比屏幕上的内容晚。

`STATUS` 描述查询时宿主报告的会话状态；`list --json` 始终使用下列英文枚举。状态不证明存在可验证的本机进程：例如，Claude 登记的后台会话可以是 `blocked`，但没有可关联的 PID。

| `status` | 含义 |
|---|---|
| `idle` | 当前没有工作在执行 |
| `running` | 工作已开始，或已有请求排队待处理 |
| `blocked` | 宿主报告受阻，例如等待输入或批准 |
| `failed` | 宿主报告当前会话处于错误状态 |
| `stopped` | 宿主确认会话或其进程已停止 |
| `unknown` | 没有可靠状态，或无法识别宿主返回的值 |

`wait` 布尔字段仍表示能否调用 `agent-session wait`，与 `status` 独立。一次等待超时不改变会话状态。

`send` 使用提供方的消息投递通道，不根据文本推断意图，也不会将斜杠开头的消息转换为终端命令。它收到回执就退出，不等模型回复，也不会新开或恢复会话。`--json` 的 `accepted: true` 表示已接收，`false` 表示明确未发送成功，`null` 表示投递结果未知。后两者退出码非零；结果未知时先查 `history`，不要自动重发。要向原生终端输入文本或按键，请使用 `input`。

向托管 OMP 发送斜杠开头的提示词时，内容原样转发；第一轮之后的 `/skill:...` 也一样。能否执行取决于 OMP 的 RPC 支持，不能假定与 TUI 的斜杠命令完全一致。`send` 只提交，不等待回复，也不会批准权限请求。会话身份变化会使旧句柄失效；用 `list` 获取当前 ID，不要把旧 ID 当作新会话使用。

`send` uses the provider's message transport; it does not infer intent from text or convert slash-leading messages into terminal commands. For managed OMP sessions, slash-leading prompts (including `/skill:...` after the first turn) are forwarded unchanged. Whether they execute depends on OMP RPC support and may differ from the TUI. A changed session identity invalidates the old handle; use `list` for the current ID. `send` submits without waiting for a reply or approving permission requests. Use `input` for native terminal text or keys.

### 向原生 OMP 终端输入文本或按键

使用前请确认普通编辑器已就绪、输入为空且没有弹窗。`/vibe` 是切换命令，再发送一次会切换回来。
输入文本和按键仅支持 Tern 或 tmux 中加载完整扩展的原生 OMP 会话，须使用 `list` 返回的完整会话 ID 并通过精确的实时会话身份握手；不支持托管会话或只读查看器。前台进程没有精确匹配时不会输入。
`input ID TEXT` 向编辑器原样输入非空单行文本，不含控制字符（UTF-8 最多 64 KiB），可加 `--enter` 按回车；OMP 报告 `running` 或 `blocked` 时会拒绝此组合。`input ID --key KEY` 按一个具名按键，不区分大小写：`Enter`、`Escape`、`Tab`、`Backspace`、`Up`、`Down`、`Left`、`Right`、`Ctrl+Q`、`Ctrl+Enter`。`--key` 不能与文本或 `--enter` 同时使用。`input` 不支持 `--stdin`；普通消息投递及其 `--stdin` 保持不变。需要时使用 `--` 结束选项。

```sh
# 输入并提交普通聊天
agent-session input "$id" '请告诉我当前进度' --enter
# 输入并执行切换命令
agent-session input "$id" '/vibe' --enter
# 单独按一个键
agent-session input "$id" --key Enter
# OMP 默认键位：把编辑器中的文本排到当前任务之后
agent-session input "$id" '完成当前任务后再查这条新告警'
agent-session input "$id" --key ctrl+q
```

终端输入的 `accepted: true` 只表示终端已接收，不表示应用已执行；部分投递或写入后的传输失败可能返回 `null`。结果未知时先检查会话，不要自动重试。

升级旧脚本时，将 `send ID --type TEXT [--enter]` 改为 `input ID TEXT [--enter]`，将 `send ID --press KEY` 改为 `input ID --key KEY`；旧选项不再支持。

For native OMP terminal input, `input ID TEXT [--enter]` types literal text, while `input ID --key KEY` sends one key; `--key` cannot be combined with text or `--enter`. The terminal must be ready and the session must meet the identity and backend requirements above. `accepted: true` only acknowledges terminal delivery, not application execution. When upgrading, replace `send ID --type TEXT [--enter]` with `input ID TEXT [--enter]` and `send ID --press KEY` with `input ID --key KEY`; the old options are no longer supported.

## 让总管 agent 管理一轮对话

总管只需要保存会话 `id`。托管模式的 `start` 只创建会话，`send` 只发消息，`wait` 只等工作结束，`history` 随时读取截至查询时已可见的对话。

```sh
# 每一步都是独立命令。wait 超时不会取消任务，仍可用同一 id 继续等。
job=$(agent-session start omp --cwd "$PWD" --json) || exit 1
id=$(printf '%s' "$job" | jq -er .id) || exit 1
agent-session send "$id" '整理今天的工作，先给我草稿，不要提交' || exit 1
agent-session wait "$id" --timeout 300 || exit $?
agent-session history "$id" --limit 2
agent-session close "$id"
agent-session resume "$id"    # 重新打开同一段对话，不会发消息
```

- OMP 对话 ID 为 `omp:<原生会话 UUID>`：关闭后仍可用 `history` 读取已保存的托管记录；`resume` 打开同一记录，已经运行则复用，不补发消息或自动续做。旧的 `omp:<PID>:<随机值>` 不是持久 ID；对仍在线的会话，重新 `list --provider omp`，替换脚本中保存的旧值。`omp:pid-…` 仅标识进程，不能恢复。暂不支持恢复已关闭的原生 TUI、Codex 或 Claude。
- 托管模式的 `start` 不带消息；模型可用 `--model` 指定。多行消息可通过 `agent-session send "$id" --stdin` 发送。
- OMP 托管和原生启动都支持 `--model 模型名[:思考等级]`；省略等级时沿用 OMP 默认值。例如 `agent-session start omp --model MODEL --json`，请将 `MODEL` 替换为本机可用模型。提供方原始参数放在 `--` 之后，`--json` 等会话选项放在之前。原生模式逐项透传；托管 OMP 仅支持 `-e`/`--extension` 和 `--thinking`，其余托管模式不接受额外参数。
- `wait ID` 默认不设时限；已经空闲（包括尚未发过消息）就立即返回。`--timeout N` 限制等待秒数，`--timeout 0` 只查当前状态。`--json` 返回状态，不附带聊天正文。要看回复，另用 `history`。
- `wait` 退出码：`0` 已完成；`2` 等待超时；`3` 需要人工输入；`1` 失败、中断或参数错误。脚本应按退出码分支；需要人工介入时不要自动同意，也不要把部分回复当最终结果。
  没有通过此 CLI 回答权限弹窗的命令。`needs_input` 是交给人的信号，不表示可以用下一条 `send` 代替批准。在没有交互窗口的托管会话中，先检查历史，再决定是否关闭并换到原生终端。
  普通 OMP 终端使用本地扩展。主 agent 暂停输出时，如果它的 Vibe 子任务仍在运行，或后台任务结果仍待投递，`list` 会显示 `running`（执行中），`wait` 不会判为完成。已完成、仅留在历史里的子任务不算忙。扩展不能区分计算和等待人工确认，自动化脚本建议设置 `--timeout`。
- `close` 只针对本工具托管的会话，可能打断尚未完成的任务。后台会话不随启动它的 shell 或 cron 退出；任务完成且不再追问时，请显式关闭。
- 对已有会话按 `list --json` 的 `send`、`history`、`wait`、`close` 判断能做什么；没有可靠空闲信号的会话不支持 `wait`。

如用 cron 调度，请先在 cron 使用的账户、`PATH` 和工作目录中演练；外部发布、并发防重和授权由调用方负责。

### 在指定 pane 查看托管会话

```sh
# 在当前 Tern、Herdr 或 tmux pane 的右侧显示新会话
agent-session start omp --pane right

# 不依赖当前 pane，指定 Tern 工作区和标签页
agent-session start codex --pane tern --workspace 'work' --tab 'agents' --json

# Herdr 工作区和标签页
agent-session start omp --pane herdr --workspace work --tab agents
# tmux 会话和窗口
agent-session start omp --pane tmux --workspace work --tab agents
```

显示位置只在指定 `--pane` 时生效，需要在 `PATH` 中安装 `terminal-pane`。`tern`、`herdr` 和 `tmux` 均须指定 `--workspace` 和 `--tab`：前两者是工作区和标签页名称，tmux 则是会话和窗口名称。目标不存在就创建；标签页或窗口已存在则在其中新增分屏，不覆盖已有内容。pane 展示同一个会话最近 20 条用户和助手消息，并持续刷新。关掉观察 pane 不等于 `agent-session close`。

总管仍使用返回的会话 `id` 发送消息；`pane` 是展示位置，不是发送目标。如果会话已启动但 pane 打开失败，请保留返回的 `id`，不要重新 `start`。可以在想用的终端执行 `agent-session view "$id"` 查看已有会话。

### 在 pane 启动原生交互界面

`--native` 启动提供方的真实交互式 TUI，而不是后台托管会话或只读查看器。必须显式指定 `--pane right|tern|herdr|tmux`；具名后端还需要 `--workspace` 和 `--tab`，放置规则与托管模式相同。可在提供方名称后传入一个非空的初始消息位置参数（包含空格时用引号括起来），启动时原样传给提供方；不传则不带初始消息。可用 `--cwd`、`--model` 传入工作目录和模型；Claude 仍必须通过 `--executable` 指定可信的原生可执行文件绝对路径。示例中的模型和路径请替换为本机可用值。

```sh
# 当前窗格右侧
agent-session start omp "你好" --pane right --native
agent-session start omp --native --pane right --cwd "$PWD" --model MODEL --json
agent-session start codex --native --pane right --cwd "$PWD" --model MODEL --json

# 指定 Tern 工作区和标签页
agent-session start claude --native --pane tern --workspace work --tab agents --cwd "$PWD" --model MODEL --executable /absolute/path/to/claude --json
# 指定 Herdr 或 tmux 位置
agent-session start omp --native --pane herdr --workspace work --tab agents
agent-session start omp --native --pane tmux --workspace work --tab agents
```

原生模式的 JSON 回执只有 `{provider, mode: "native", pane: {backend, id}}`。其中 `pane.id` 是窗格标识，不是聊天会话 ID，不能直接用于 `send`、`history`、`wait` 或 `close`。不同提供方及集成对原生会话的发现和可用操作各不相同；通过 `list` 查看实际能力，不要假定原生 TUI 一定可以被程序控制。

原生模式没有独立的 agent-session 桥接进程或守护进程；Tern、tmux 等终端后端持有 PTY 并管理程序生命周期。断开终端或 detach 与关闭实际窗格不同：关闭实际窗格会结束其中的程序；这也不是对托管会话执行 `agent-session close`。如需交互或处理权限请求，请使用原生 TUI。

### 读取会话历史

历史按时间从早到晚输出，默认取最后 20 条聊天消息。`--all` 取全部可读聊天；`--json` 便于脚本处理。例如：

```sh
printf '%s\n' '第一行' '第二行' | agent-session send "$id" --stdin
agent-session history "$id" --all --json | jq -r '.[] | select(.role == "assistant") | .text'
```

消息含敏感信息时，建议从标准输入读取，不要把正文放入 shell 历史。agent 按自身设置保存会话；本地桥接进程在会话存活期间可持有回复以供等待。工具不使用提权，不管理其他系统用户的会话。

## 哪些会话可以接入

| Agent | 能发现的既有会话 | 新建可管理会话 |
|---|---|---|
| OMP | 持有会话锁且能绑定同一份日志时可读聊天分支；未写盘的终端可能只有进程线索。加载本地扩展后可向原终端发送消息 | `agent-session start omp`，通过原生 RPC 启动新会话 |
| Codex CLI | 共享 app-server 上已加载的 CLI 线程可以对话；不能绑定线程的终端仅作进程线索，不从归档恢复 | `agent-session start codex`，不要求先开一个 TUI |
| Claude Code | 从 `claude agents --json` 发现活会话，唯一匹配本地记录时可读历史；普通 TUI 无程序化输入口 | `agent-session start claude --executable /绝对路径/claude`，使用下述可信原生文件。新增托管路径尚未实机验证 |

要让以后启动的 OMP 会话自动加载扩展，可由当前用户主动安装：

```sh
agent-session integration install omp
```

安装结果中的 `path` 是唯一写入的扩展文件；默认位于 `~/.omp/agent/extensions/agent-session.ts`。安装位置随当前 OMP 配置变化：`OMP_PROFILE`（或未设置时的 `PI_PROFILE`）选择命名 profile，`PI_CONFIG_DIR` 可改变配置根目录；`PI_CODING_AGENT_DIR` 只覆盖默认 profile 的目录。请在与目标 OMP 会话相同的环境中运行安装命令。再次执行不会覆盖已有文件；若同名文件不属于本安装，命令会报错。扩展引用本项目的 `omp-extension.ts`，请保留项目目录。

已运行的 OMP TUI 需要重启后才会加载扩展。要检查或撤销安装，将下面的路径替换为安装结果中的 `path`；确认它是本工具安装的文件后，只删除该文件：

```sh
ls -l "<安装结果中的 path>"
rm "<安装结果中的 path>"
```

如果只想在单次 OMP 会话中启用，仍可显式加载：

```sh
project="$PWD" # 从源码目录运行
omp -e "$project/omp-extension.ts"
```

OMP 若取消了切换会话或分支的操作，扩展会暂停投递以防误发。在原终端输入 `/agent-session-reconnect`，然后重新 `list` 获取新的 ID。

Claude 可用以下入口启动：

```sh
project="$PWD" # 从源码目录运行
node "$project/adapters/claude-bridge.mjs" /absolute/path/to/claude
```

Claude 启动命令中的路径应替换为您信任的原生 Claude 可执行文件。请在可信工作目录运行：Claude 的非交互模式会加载该目录适用的配置。不代答权限询问；需要询问的操作被拒绝。从另一个终端用 `agent-session` 聊天，原终端按 Ctrl-C 退出。OMP 扩展和 Claude 入口都只在本机同一系统用户内开放会话读写。

## 参与项目

请参阅 [贡献指南](CONTRIBUTING.md)、[安全报告](SECURITY.md)、[AI 维护约定](AGENTS.md) 和 [0.1.0 发行说明](releases/v0.1.0.md)。

本项目采用 [MIT 许可证](LICENSE)。
