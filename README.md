# Perch

用一个 CLI 管理本机当前用户的 OMP、Codex CLI、Claude Code 和 Antigravity CLI（`agy`）对话。可以发现已有会话，也可以新建可由脚本控制的后台会话；不需要常驻的中心服务。

[下载最新稳定版](https://github.com/OhYee/perch/releases/latest) · [快速使用](#快速使用) · [由总管 agent 管理对话](#让总管-agent-管理一轮对话) · [贡献指南](CONTRIBUTING.md)

## 安装与要求

按需选择以下一种安装方式。源码、npm 包和 `perch.mjs` 需要 Node.js 22.13 或更高版本；npm 包和源码还需要 npm。独立二进制运行时不需要 Node.js 或 Bun。Bun 1.4.4 仅用于从源码构建独立产物。

所有方式都需要另行安装并配置所用的 OMP、Codex CLI、Claude Code 或 Antigravity CLI；pane 功能另需 `terminal-pane`，部分示例使用 `jq`。Perch 支持 macOS 和 Linux（Linux 二进制需要 glibc），不支持 Windows 原生运行。会话能力取决于提供方和终端，见下表；Claude 的托管路径尚未实机验证。

### 从 GitHub Release 安装

在 [OhYee/perch Releases](https://github.com/OhYee/perch/releases) 选择版本。日常使用选 **Latest**；标有 **Pre-release** 的 `x.y.z-beta-<commit>` 是测试版。没有 Node.js 时选独立二进制；已有 Node.js 时可选单文件 `perch.mjs`，或用 npm 从发行包安装全局 `perch` 命令。

把需要的文件和**同一版本**的 `SHA256SUMS.txt` 下载到空目录。例如，下载 v0.2.0 的单文件版（使用 GitHub CLI，也可从页面下载）：

```sh
version=0.2.0
gh release download "v$version" --repo OhYee/perch -p perch.mjs -p SHA256SUMS.txt
```

安装或运行前，先在该目录定义下面的函数。它只校验选中的文件，无需下载全部产物：

```sh
verify_perch() {
  awk -v name="$1" '$2 == name { print; n++ } END { if (n != 1) exit 1 }' \
    SHA256SUMS.txt > perch-checksum.txt &&
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum -c perch-checksum.txt
  else
    shasum -a 256 -c perch-checksum.txt
  fi
}
```

**npm 包**：从 Release 下载 `perch-0.2.0.tgz` 和校验清单。以下用 v0.2.0 举例；包不发布到 npm registry，不要用 `npm install -g perch` 代替。

```sh
verify_perch perch-0.2.0.tgz && npm install -g --ignore-scripts ./perch-0.2.0.tgz && perch --version
```

**单文件 JavaScript**：下载 `perch.mjs`，校验成功后使用 Node.js 运行，无需安装依赖：

```sh
verify_perch perch.mjs && node ./perch.mjs --help
```

**独立二进制**：根据系统和 CPU 选择 `perch-darwin-arm64`、`perch-darwin-x64`、`perch-linux-arm64` 或 `perch-linux-x64`。`uname -m` 为 `arm64` 或 `aarch64` 时选 `arm64`，为 `x86_64` 或 `amd64` 时选 `x64`；`uname -s` 的 `Darwin` 对应 `darwin`，`Linux` 对应 `linux`。以下以 macOS Apple Silicon 为例：

```sh
verify_perch perch-darwin-arm64 && chmod +x ./perch-darwin-arm64 && ./perch-darwin-arm64 --help
```

将二进制放入 `PATH` 中并命名为 `perch` 后，即可直接使用下文命令。单文件 JavaScript 则以 `node /path/to/perch.mjs` 代替 `perch`。

### 从源码运行

在源码目录安装依赖并运行：

```sh
npm ci --ignore-scripts
./cli.mjs --help
./cli.mjs list
```

如需从任意目录使用 `perch`，可在源码目录运行以下命令，并将 `~/.local/bin` 加入 `PATH`；保留源码目录及其依赖：

```sh
mkdir -p "$HOME/.local/bin"
ln -s "$PWD/cli.mjs" "$HOME/.local/bin/perch"
```

也可安装 Bun 1.4.4 后在源码目录运行 `bun scripts/build-portable.mjs <output-directory> <target>` 构建：`target` 为 `mjs`、`darwin-arm64`、`darwin-x64`、`linux-arm64` 或 `linux-x64`。输出分别为 `perch.mjs` 或 `perch-<target>`，内含运行所需依赖、桥接程序和 OMP 扩展。

### 版本与更新

`perch --version`（或 `perch -V`）显示当前版本；`perch version --json` 输出机器可读的版本信息。更新命令访问 GitHub Release，默认只选择比当前版本更新的稳定版本；beta 用户也可以更新到较新的稳定版本：

```sh
perch update --check
perch update --check --json
perch update
perch update --check --beta  # 显式允许预发行版本
perch update --beta
```

`--check` 只查询，不修改安装。官方产物已绑定 `OhYee/perch`，无需传仓库名。源码和自行构建的版本没有预设发行源，可以用 `perch update --check --repo OhYee/perch` 查询。`--repo` 只对本次命令有效，不能覆盖官方产物绑定的仓库。

独立二进制和 `perch.mjs` 更新自身前会校验发行资产的 SHA256；全局 npm 安装使用已校验的发行 tarball，而非 npm registry。源码检出不会被下载的发行文件覆盖：请保留本地修改，按命令提示在确认来源后手动更新；工作区有未提交改动时不会自动覆盖。更新失败会返回非零状态。

## 快速使用

以下示例假设已配置 `perch` 命令；否则在源码目录使用 `./cli.mjs`，或按所选安装方式替换命令。

```sh
perch list
perch list --provider codex --json
perch send "$id" '请告诉我当前进度'  # id 是 list 给出的完整 ID
perch history "$id" --limit 10
```

`perch --help` 查看命令总览。在任一子命令后加 `--help` 或 `-h`，可查看该命令的参数和示例，例如 `perch start --help`、`perch integration install omp --help`。帮助只打印说明，不会启动会话或安装扩展。

终端提示支持简体中文和英文。默认按 `LC_ALL`、`LC_MESSAGES`、`LANG` 的优先级选择语言；其他语言及 `C` 环境使用英文。用 `perch list --lang zh` 或 `perch --lang en --help` 可临时覆盖。会话标题、聊天正文、路径和 ID 保留原文；切换语言不改变 `--json` 的输出。

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

`wait` 布尔字段仍表示能否调用 `perch wait`，与 `status` 独立。一次等待超时不改变会话状态。

`send` 使用提供方的消息投递通道，不根据文本推断意图，也不会将斜杠开头的消息转换为终端命令。它收到回执就退出，不等模型回复，也不会新开或恢复会话。`--json` 的 `accepted: true` 表示已接收，`false` 表示明确未发送成功，`null` 表示投递结果未知。后两者退出码非零；结果未知时先查 `history`，不要自动重发。要向原生终端输入文本或按键，请使用 `input`。

向托管 OMP 发送斜杠开头的提示词时，内容原样转发；第一轮之后的 `/skill:...` 也一样。能否执行取决于 OMP 的 RPC 支持，不能假定与 TUI 的斜杠命令完全一致。`send` 只提交，不等待回复，也不会批准权限请求。会话身份变化会使旧句柄失效；用 `list` 获取当前 ID，不要把旧 ID 当作新会话使用。

`send` uses the provider's message transport; it does not infer intent from text or convert slash-leading messages into terminal commands. For managed OMP sessions, slash-leading prompts (including `/skill:...` after the first turn) are forwarded unchanged. Whether they execute depends on OMP RPC support and may differ from the TUI. A changed session identity invalidates the old handle; use `list` for the current ID. `send` submits without waiting for a reply or approving permission requests. Use `input` for native terminal text or keys.

### 向原生 OMP 终端输入文本或按键

使用前请确认普通编辑器已就绪、输入为空且没有弹窗。`/vibe` 是切换命令，再发送一次会切换回来。
输入文本和按键仅支持 Tern 或 tmux 中加载完整扩展的原生 OMP 会话，须使用 `list` 返回的完整会话 ID 并通过精确的实时会话身份握手；不支持托管会话或只读查看器。前台进程没有精确匹配时不会输入。
`input ID TEXT` 向编辑器原样输入非空单行文本，不含控制字符（UTF-8 最多 64 KiB），可加 `--enter` 按回车；OMP 报告 `running` 或 `blocked` 时会拒绝此组合。`input ID --key KEY` 按一个具名按键，不区分大小写：`Enter`、`Escape`、`Tab`、`Backspace`、`Up`、`Down`、`Left`、`Right`、`Ctrl+Q`、`Ctrl+Enter`。`--key` 不能与文本或 `--enter` 同时使用。`input` 不支持 `--stdin`；普通消息投递及其 `--stdin` 保持不变。需要时使用 `--` 结束选项。

```sh
# 输入并提交普通聊天
perch input "$id" '请告诉我当前进度' --enter
# 输入并执行切换命令
perch input "$id" '/vibe' --enter
# 单独按一个键
perch input "$id" --key Enter
# OMP 默认键位：把编辑器中的文本排到当前任务之后
perch input "$id" '完成当前任务后再查这条新告警'
perch input "$id" --key ctrl+q
```

终端输入的 `accepted: true` 只表示终端已接收，不表示应用已执行；部分投递或写入后的传输失败可能返回 `null`。结果未知时先检查会话，不要自动重试。

升级旧脚本时，将 `send ID --type TEXT [--enter]` 改为 `input ID TEXT [--enter]`，将 `send ID --press KEY` 改为 `input ID --key KEY`；旧选项不再支持。

For native OMP terminal input, `input ID TEXT [--enter]` types literal text, while `input ID --key KEY` sends one key; `--key` cannot be combined with text or `--enter`. The terminal must be ready and the session must meet the identity and backend requirements above. `accepted: true` only acknowledges terminal delivery, not application execution. When upgrading, replace `send ID --type TEXT [--enter]` with `input ID TEXT [--enter]` and `send ID --press KEY` with `input ID --key KEY`; the old options are no longer supported.

## 让总管 agent 管理一轮对话

总管只需要保存会话 `id`。托管模式的 `start` 只创建会话，`send` 只发消息，`wait` 只等工作结束，`history` 随时读取截至查询时已可见的对话。

```sh
# 每一步都是独立命令。wait 超时不会取消任务，仍可用同一 id 继续等。
job=$(perch start omp --cwd "$PWD" --json) || exit 1
id=$(printf '%s' "$job" | jq -er .id) || exit 1
perch send "$id" '整理今天的工作，先给我草稿，不要提交' || exit 1
perch wait "$id" --timeout 300 || exit $?
perch history "$id" --limit 2
perch close "$id"
perch resume "$id"    # 重新打开同一段对话，不会发消息
```

- OMP 对话 ID 为 `omp:<原生会话 UUID>`：关闭后仍可用 `history` 读取已保存的托管记录；`resume` 打开同一记录，已经运行则复用，不补发消息或自动续做。旧的 `omp:<PID>:<随机值>` 不是持久 ID；对仍在线的会话，重新 `list --provider omp`，替换脚本中保存的旧值。`omp:pid-…` 仅标识进程，不能恢复。暂不支持恢复已关闭的原生 TUI、Codex 或 Claude。
- 托管模式的 `start` 不带消息；模型可用 `--model` 指定。多行消息可通过 `perch send "$id" --stdin` 发送。
- OMP 托管和原生启动都支持 `--model 模型名[:思考等级]`；省略等级时沿用 OMP 默认值。例如 `perch start omp --model MODEL --json`，请将 `MODEL` 替换为本机可用模型。提供方原始参数放在 `--` 之后，`--json` 等会话选项放在之前。原生 OMP、Codex 和 Claude 原样透传，托管 OMP 仅支持 `-e`/`--extension` 和 `--thinking`；其余托管模式及原生 agy 不接受额外参数。
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
perch start omp --pane right

# 不依赖当前 pane，指定 Tern 工作区和标签页
perch start codex --pane tern --workspace 'work' --tab 'agents' --json

# Herdr 工作区和标签页
perch start omp --pane herdr --workspace work --tab agents
# tmux 会话和窗口
perch start omp --pane tmux --workspace work --tab agents
```

显示位置只在指定 `--pane` 时生效，需要在 `PATH` 中安装 `terminal-pane`。`tern`、`herdr` 和 `tmux` 均须指定 `--workspace` 和 `--tab`：前两者是工作区和标签页名称，tmux 则是会话和窗口名称。目标不存在就创建；标签页或窗口已存在则在其中新增分屏，不覆盖已有内容。pane 展示同一个会话最近 20 条用户和助手消息，并持续刷新。关掉观察 pane 不等于 `perch close`。

总管仍使用返回的会话 `id` 发送消息；`pane` 是展示位置，不是发送目标。如果会话已启动但 pane 打开失败，请保留返回的 `id`，不要重新 `start`。可以在想用的终端执行 `perch view "$id"` 查看已有会话。

### 在 pane 启动原生交互界面

`--native` 启动提供方的真实交互式 TUI，而不是后台托管会话或只读查看器。必须显式指定 `--pane right|tern|herdr|tmux`；具名后端还需要 `--workspace` 和 `--tab`，放置规则与托管模式相同。可在提供方名称后传入一个非空的初始消息位置参数（包含空格时用引号括起来），启动时原样传给提供方；不传则不带初始消息。可用 `--cwd`、`--model` 传入工作目录和模型；Claude 仍必须通过 `--executable` 指定可信的原生可执行文件绝对路径。示例中的模型和路径请替换为本机可用值。

```sh
# 当前窗格右侧
perch start omp "你好" --pane right --native
perch start omp --native --pane right --cwd "$PWD" --model MODEL --json
perch start codex --native --pane right --cwd "$PWD" --model MODEL --json
perch start agy --native --pane right

# 指定 Tern 工作区和标签页
perch start claude --native --pane tern --workspace work --tab agents --cwd "$PWD" --model MODEL --executable /absolute/path/to/claude --json
# 指定 Herdr 或 tmux 位置
perch start omp --native --pane herdr --workspace work --tab agents
perch start omp --native --pane tmux --workspace work --tab agents
```

对原生 agy，初始消息通过 `--prompt-interactive` 传入；不能以 `-` 开头，也不接受 `--` 之后的额外参数。敏感消息不要放在启动参数中。

原生模式的 JSON 回执只有 `{provider, mode: "native", pane: {backend, id}}`。其中 `pane.id` 是窗格标识，不是聊天会话 ID，不能直接用于 `send`、`history`、`wait` 或 `close`。不同提供方及集成对原生会话的发现和可用操作各不相同；通过 `list` 查看实际能力，不要假定原生 TUI 一定可以被程序控制。

原生模式没有独立的 Perch 桥接进程或守护进程；Tern、tmux 等终端后端持有 PTY 并管理程序生命周期。断开终端或 detach 与关闭实际窗格不同：关闭实际窗格会结束其中的程序；这也不是对托管会话执行 `perch close`。如需交互或处理权限请求，请使用原生 TUI。

### 读取会话历史

历史按时间从早到晚输出，默认取最后 20 条聊天消息。`--all` 取全部可读聊天；`--json` 便于脚本处理。例如：

```sh
printf '%s\n' '第一行' '第二行' | perch send "$id" --stdin
perch history "$id" --all --json | jq -r '.[] | select(.role == "assistant") | .text'
```

消息含敏感信息时，建议从标准输入读取，不要把正文放入 shell 历史。agent 按自身设置保存会话；本地桥接进程在会话存活期间可持有回复以供等待。工具不使用提权，不管理其他系统用户的会话。

## 哪些会话可以接入

| Agent | 能发现的既有会话 | 新建可管理会话 |
|---|---|---|
| OMP | 持有会话锁且能绑定同一份日志时可读聊天分支；未写盘的终端可能只有进程线索。加载本地扩展后可向原终端发送消息 | `perch start omp`，通过原生 RPC 启动新会话 |
| Codex CLI | 共享 app-server 上已加载的 CLI 线程可以对话；不能绑定线程的终端仅作进程线索，不从归档恢复 | `perch start codex`，不要求先开一个 TUI |
| Claude Code | 从 `claude agents --json` 发现活会话，唯一匹配本地记录时可读历史；普通 TUI 无程序化输入口 | `perch start claude --executable /绝对路径/claude`，使用下述可信原生文件。新增托管路径尚未实机验证 |
| Antigravity CLI（`agy`） | 发现原生终端进程；启用状态行且查询期间能验证当时的对话时，显示原生会话身份。原生会话不能读取历史或控制 | `perch start agy`，为每个会话启动独立的 `agy acp` |

要让以后启动的 OMP 会话自动加载扩展，可由当前用户主动安装：

```sh
perch integration install omp
```

安装结果中的 `path` 是唯一写入的扩展文件；默认位于 `~/.omp/agent/extensions/agent-session.ts`。安装位置随当前 OMP 配置变化：`OMP_PROFILE`（或未设置时的 `PI_PROFILE`）选择命名 profile，`PI_CONFIG_DIR` 可改变配置根目录；`PI_CODING_AGENT_DIR` 只覆盖默认 profile 的目录。请在与目标 OMP 会话相同的环境中运行安装命令。再次执行不会覆盖已有文件；若同名文件不属于本安装，命令会报错。源码安装的扩展引用项目中的 `omp-extension.ts`，请保留项目目录。

为兼容已有会话，存储路径、环境变量、桥接协议和扩展文件名保持不变。

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

OMP 若取消了切换会话或分支的操作，扩展会暂停投递以防误发。在原终端输入 `/perch-reconnect`，然后重新 `list` 获取新的 ID。已安装或正在运行的旧版扩展仍使用 `/agent-session-reconnect`。

Claude 可用以下入口启动：

```sh
project="$PWD" # 从源码目录运行
node "$project/adapters/claude-bridge.mjs" /absolute/path/to/claude
```

Claude 启动命令中的路径应替换为您信任的原生 Claude 可执行文件。请在可信工作目录运行：Claude 的非交互模式会加载该目录适用的配置。不代答权限询问；需要询问的操作被拒绝。从另一个终端用 `perch` 聊天，原终端按 Ctrl-C 退出。OMP 扩展和 Claude 入口都只在本机同一系统用户内开放会话读写。

### Antigravity CLI：托管会话和原生终端

先确认 `PATH` 指向可信的 `agy`，并按 Antigravity CLI 的要求登录。Perch 不代登录。
`start agy` 通过专用的本地 ACP 连接新建会话，不发送初始消息，也不查找已有对话。
不传 `--model` 时使用 agy 默认模型；指定模型不可用时，启动会失败，不会改用默认模型。

托管 agy 在 `${XDG_STATE_HOME:-$HOME/.local/state}/agent-session/agy` 保存恢复所需的会话标识。如果 Perch 拒绝状态目录，不要修改共享目录权限或使用符号链接；请在自己控制的目录下新建私有目录（所有者为当前用户，权限 `0700`）：

```sh
mkdir -m 700 "$HOME/.perch-state" && export XDG_STATE_HOME="$HOME/.perch-state"
```

只需创建一次。以后在运行这些会话的命令前设置同一个 `XDG_STATE_HOME`。切换状态目录不会迁移旧会话。

```sh
job=$(perch start agy --cwd "$PWD" --json) || exit 1
id=$(printf '%s' "$job" | jq -er .id) || exit 1
printf '%s\n' '先概括你看到的项目结构，不要修改文件。' | perch send "$id" --stdin || exit $?
perch wait "$id" --timeout 300 || exit $?
perch history "$id" --limit 2
perch close "$id"
```

消息走 ACP，不转成按键。需要人工授权时，`wait` 返回 `needs_input`；Perch 不批准权限请求。
如果 `send` 返回 `accepted: null`，先查历史或等待，不要重发。

Perch 创建的托管对话使用 `agy:<UUID>`；请保留 `start` 返回的完整 ID。
`close` 会结束当前托管进程；之后不会在 `list` 显示，要读历史或继续对话须先显式执行 `perch resume "$id"`。
恢复会使用同一 ID，不会补发消息、自动续做任务或接管已有 TUI。提供方不支持回载时，`resume` 会报错，不会另开一个对话。

托管 agy 最多保留最近 1,024 条、合计 4 MiB 的聊天文本。`resume` 会在这个窗口内回放对话，不会仅因旧消息超出窗口而失败。
`history` 默认最多返回 20 条，`--limit N` 最多返回 N 条；`view` 也只显示窗口内最近 20 条。正在生成的回复可实时显示；如果回复超出保留上限，整条回复会被移除，`wait` 会报告失败。如果有消息被淘汰或省略，`history --all` 会报错，不会把保留窗口当成完整记录。

对于已有原生终端，`perch list --provider agy` 不扫描归档。默认只显示可识别的活动进程（`agy:pid-…`）。
macOS 的进程信息不保留参数边界：多词初始提示词或带空格的选项值可能使 Perch 无法确认启动方式，导致既不显示 PID，也无法验证状态行回调。若需要发现原生 TUI，请不带初始提示词启动，并避免使用含空格的选项值。

在 macOS 的 agy 1.5.16 中，可选择启用状态行来识别当前对话。其他版本或平台目前只提供进程线索。
若要启用，请在目标 agy 窗口手动输入：

```text
/statusline perch integration agy-statusline && :
```

使用可信的 Perch 可执行文件；也可用单引号括住其绝对路径来替代 `perch`。保留 `&& :`，以便 Perch 核实回调来源。
**[`/statusline` 会修改并保存 agy 的状态行设置](https://antigravity.google/docs/cli/commands/statusline/)。**
若要继续使用现有渲染器，请不要设置此命令；如需恢复，可在原窗口重新设置原命令，或用 `/statusline reset` 恢复内置状态行。
Perch 不会代改设置，也不会向原窗口输入命令。

只有查询期间收到新报告且能核实回调进程的父子关系，列表才会显示原生会话身份。agy 在状态变化时发送报告，闲置时不保证有新报告；如果沙箱拦截进程检查，或查询期间没有新报告，仍只显示进程线索。
原生 agy 不支持 `history`、`view`、`send`、`wait` 或 `close`。状态行不能确认编辑器焦点或排除选择及权限弹窗，因此 `input` 拒绝文本、`--enter` 和具名按键。请在原窗口继续交互。

## 参与项目

请参阅 [贡献指南](CONTRIBUTING.md)、[安全报告](SECURITY.md)、[AI 维护约定](AGENTS.md) 和 [0.1.0 发行说明](releases/v0.1.0.md)。

本项目采用 [MIT 许可证](LICENSE)。
