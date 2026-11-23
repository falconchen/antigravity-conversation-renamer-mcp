# Antigravity Conversation Renamer MCP

一个面向 **Google Antigravity** 的轻量级 TypeScript / Node.js Stdio MCP Server。

在 Antigravity 中开启对话时，初始标题往往由第一条消息自动生成；随着讨论逐步展开，实际任务很容易偏离最初的标题。通过本 MCP，Antigravity 可以在话题明显转向、输入 `/rename` 或收到你的指令时，**免辅助功能权限、无需重启客户端**，自动无损地重命名当前或历史对话标题，并实时反映在界面与检索中。

---

## 最简安装：直接让 Antigravity 自己装（推荐）

打开任意一个 Antigravity 对话，直接复制下面这句话发给它即可：

```text
请阅读 https://github.com/falconchen/antigravity-conversation-renamer-mcp 的 README，按其中的「AI Agent 自动安装指南」帮我完成安装、测试与配置。
```

> 如果你只想要 `/rename` 手动改名，不希望 AI 在话题偏离时自动改名，可以把上面那句话改成：`...安装配置（加上 --no-rule，仅启用手动和 /rename）`。

---

## AI Agent 自动安装指南（For AI Assistants）

> **致正在阅读本文档的 AI Agent（Antigravity / Claude Code / Codex 等）**：请严格按以下幂等步骤为用户完成安装，不要将本仓库克隆到用户当前的业务项目目录中，也不要覆盖用户原有的 `mcp_config.json` 其他配置。

### 前置条件
- 需要 **Node.js >= 22.5.0**（用于内置 `node:sqlite`，零原生编译依赖）。
- 在非交互 Shell 中（尤其是 macOS 使用 `nvm` / `fnm` / `volta` / Homebrew 的环境），请先探测并加入常见 Node 路径，确认 `node -v` 满足 `>= 22.5.0`；若不满足，请暂停并告知用户先安装或切换到 Node.js 22.5+（推荐 Node 22 LTS 或 24+）。

### 执行步骤（推荐合并为单条命令执行）

1. **固定安装目录**：使用 `~/.local/share/antigravity-conversation-renamer-mcp`（若目录已存在则 `git pull --ff-only`，避免污染用户当前工作区）。
2. **安装依赖、跑沙盒测试并自动写入配置**：直接运行 `npm install && npm run setup`。
   - `scripts/setup.mjs` 会自动完成：
     - 校验 Node 版本 >= 22.5.0；
     - 编译 TypeScript 并运行全部单元测试与沙盒 Stdio MCP 端到端测试；
     - 自动使用当前 `node` 绝对路径（`process.execPath`）增量合并写入 `~/.gemini/config/mcp_config.json` 中的 `mcpServers["conversation-renamer"]`，**保留用户所有原有 MCP 配置**；
     - 部署混合模式自动触发规则到 `~/.gemini/config/rules/conversation-auto-rename.md`（若用户要求关闭自动触发则加 `-- --no-rule`）；
     - 部署 `/rename` 斜杠命令 Skill 到 `~/.gemini/config/skills/rename/SKILL.md`（若不需要则加 `-- --no-skill`）。

macOS / Linux 一键执行命令模板（Agent 可直接运行）：

```sh
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.volta/bin:$HOME/.fnm:$PATH"
if [ -d "$HOME/.nvm/versions/node" ]; then
  LATEST_NVM=$(ls -1 "$HOME/.nvm/versions/node" | sort -V | tail -n 1)
  [ -n "$LATEST_NVM" ] && export PATH="$HOME/.nvm/versions/node/$LATEST_NVM/bin:$PATH"
fi
INSTALL_DIR="$HOME/.local/share/antigravity-conversation-renamer-mcp"
if [ -d "$INSTALL_DIR/.git" ]; then
  git -C "$INSTALL_DIR" pull --ff-only
else
  mkdir -p "$(dirname "$INSTALL_DIR")"
  git clone https://github.com/falconchen/antigravity-conversation-renamer-mcp.git "$INSTALL_DIR"
fi
cd "$INSTALL_DIR" && npm install && npm run setup
```

Windows PowerShell 命令模板：

```powershell
$InstallDir = Join-Path $HOME ".local\share\antigravity-conversation-renamer-mcp"
if (Test-Path (Join-Path $InstallDir ".git")) {
  git -C $InstallDir pull --ff-only
} else {
  New-Item -ItemType Directory -Force -Path (Split-Path $InstallDir) | Out-Null
  git clone https://github.com/falconchen/antigravity-conversation-renamer-mcp.git $InstallDir
}
Set-Location $InstallDir
npm install; if ($LASTEXITCODE -eq 0) { npm run setup }
```

### 安装后提示用户
执行成功后，向用户报告：
1. 安装目录、`node` 绝对路径以及写入的配置文件路径；
2. 提醒用户**重启 Antigravity（或在 Additional Options `...` → MCP Servers 中刷新）**使配置生效；
3. 生效后可直接在对话框输入 `/rename` 或“根据内容更新当前对话标题”进行测试。

---

## 特性亮点

- **实时生效且防覆写**：优先原子写入 `~/.gemini/antigravity/annotations/<convID>.pbtxt`（Antigravity `language_server` 运行期事实源），再同步更新 SQLite 与缓存，避免被内存中的旧标题覆盖。
- **零原生编译依赖**：基于 Node.js 22.5+ 内置 `node:sqlite`（开启 `readBigInts: true` 无损保留 64 位纳秒级时间戳）与纯 TypeScript Protobuf Wire 级无损 Patcher。
- **四位点无损同步**：
  1. `~/.gemini/antigravity/annotations/<convID>.pbtxt`（原地替换 `title`，保留 `last_user_view_time` 等其他字段）
  2. `~/.gemini/antigravity/conversation_summaries.db` 的 `conversation_summaries` 表（更新 `title`、`preview`，无损局部改写 `raw_summary` 的 Field `1` 与 `15.1`，保留所有其余与未知字段）
  3. `conversation_summaries.db` 的 `conversations_fts` 虚拟表（无损重建 `chunk_index = -1` 标题检索行，不触碰正文索引）
  4. `~/.gemini/antigravity/agyhub_summaries_proto.pb`（局部替换对应会话条目，原子写回）
- **混合模式触发 + `/rename` 斜杠命令**：既支持话题偏离自动更新，也支持随时 `/rename` 一键改名。
- **免系统权限弹窗**：纯本地磁盘无损读写，不依赖 macOS Accessibility 辅助功能，不抢占前台焦点，不查杀 Antigravity 进程。

---

## 使用方法

安装并重启/刷新 Antigravity 后，支持以下全部方式：

### 方式一：`/rename` 斜杠命令
- `/rename`：自动根据当前对话内容总结最贴切的新标题并更新
- `/rename 排查 Redis 内存泄漏`：直接将当前对话重命名为指定标题

### 方式二：自然语言手动改名
- `把当前对话标题改为「排查 Redis 内存泄漏」`
- `根据目前聊的内容，更新一下当前对话标题`

### 方式三：话题偏离时自动触发
当你从最初的问题（例如“你好，帮我看个报错”）逐步深入到具体工程任务（例如“重构登录鉴权中间件”）后，Antigravity 会在合适时机自动调用 `get_conversation_title` 检查现有标题，确认偏离后调用 `rename_conversation` 更新标题，且不会在主题未变时反复改名。

### 方式四：查看或批量整理历史对话
- `列出最近 10 条对话` / `列出当前项目下的历史对话`
- `把刚才那个标题为 "Untitled" 的历史对话改成「部署 Docker 监控栈」`

> **批量修改历史空闲（IDLE）对话后的生效说明**：
> - **当前正在聊的活跃对话**：改名后会实时刷新且重启不丢失；
> - **少量历史空闲对话（免重启技巧）**：在侧边栏直接点开一次该对话，Antigravity 会立即重读 `annotations/<id>.pbtxt`，实时刷新侧边栏标题并同步到内存与数据库；
> - **大批量历史空闲对话（不想逐条点开）**：由于运行中的 Antigravity 在内存里缓存了旧摘要，普通退出（`Cmd+Q`）时退出保存钩子会把内存旧标题写回数据库（但 `annotations/*.pbtxt` 中的新标题会完好保留）。运行一次一键冷同步刷新命令即可阻断退出脏写回、把所有 `.pbtxt` 新标题同步回数据库并重新拉起 Antigravity：
>   ```sh
>   cd ~/.local/share/antigravity-conversation-renamer-mcp
>   npm run sync-relaunch
>   ```
>   支持可选参数：`--dry-run`（仅预览待同步项）、`--sync-only`（仅写盘不重启）、`--no-relaunch`（冷同步后不自动拉起）、`--detached`（从 Antigravity 内调用时脱离父进程后台执行）。

---

## 手动安装与自定义配置

如果你想自己控制安装路径或手动编辑配置：

```sh
git clone https://github.com/falconchen/antigravity-conversation-renamer-mcp.git
cd antigravity-conversation-renamer-mcp
npm install
npm run setup
```

`npm run setup` 支持以下可选参数：
- `npm run setup -- --no-rule`：不安装自动触发规则（仅使用手动对话或 `/rename`）
- `npm run setup -- --no-skill`：不安装 `/rename` 斜杠命令 Skill
- `npm run setup -- --skip-test`：跳过测试直接配置

如需纯手工配置，可参考 [`templates/mcp_config.snippet.json`](./templates/mcp_config.snippet.json) 将以下内容合并到 `~/.gemini/config/mcp_config.json`（`command` 请填写 `which node` 返回的绝对路径）：

```json
{
  "mcpServers": {
    "conversation-renamer": {
      "command": "/ABSOLUTE/PATH/TO/node",
      "args": [
        "/ABSOLUTE/PATH/TO/antigravity-conversation-renamer-mcp/dist/src/index.js"
      ]
    }
  }
}
```

> 如需指定自定义 Antigravity 数据目录，可在该节点下添加 `"env": { "ANTIGRAVITY_DATA_DIR": "/custom/path" }`（默认 `~/.gemini/antigravity`）。

---

## 暴露的 MCP 工具

| 工具名 | 只读/写入 | 入参 | 说明 |
| :--- | :---: | :--- | :--- |
| `get_conversation_title` | 只读 | `conversation_id` | 读取指定会话在数据库、`.pbtxt` 与 Protobuf 中的当前标题、步数及同步状态（`inSync`） |
| `rename_conversation` | 写入（幂等） | `conversation_id`, `new_title`, `reason?` | 自动清洗标题换行与多余空白，无损同步更新 `.pbtxt`、SQLite 主表、FTS5 索引与缓存快照，并返回 `uiRefreshHint` 提示是否需重启刷新 |
| `list_recent_conversations` | 只读 | `limit?` (1–100), `workspace?`, `include_subagents?` | 列出最近未删除的对话 ID、标题、工作区路径（`workspacePaths`）、`projectId` 与最后修改时间，支持按工作区路径/目录名过滤（兼容中文 URL 编码路径） |

---

## 项目结构

```text
.
├── src/
│   ├── index.ts          # Stdio MCP Server 入口
│   ├── tools.ts          # MCP 工具注册与 zod 参数校验
│   ├── renamer.ts        # 核心重命名编排（幂等校验与四位点原子同步）
│   ├── pbtxtPatcher.ts   # annotations/<id>.pbtxt 无损解析、转义与原子写入
│   ├── protoPatcher.ts   # 零依赖无损 Protobuf Wire 解析器与局部字段 Patcher
│   ├── sqliteStore.ts    # SQLite WAL 事务读写（conversation_summaries + FTS5）
│   └── paths.ts          # 数据路径解析与 conversation_id 安全校验
├── scripts/
│   ├── setup.mjs             # 一键编译、测试并无损写入全局配置
│   ├── uninstall.mjs         # 一键安全卸载全局配置（保留已有对话）
│   └── sync-and-relaunch.mjs # 批量历史改名后一键冷同步 .pbtxt 至 DB 并安全重启
├── tests/
│   ├── pbtxtPatcher.test.ts
│   ├── protoPatcher.test.ts
│   ├── renamer.e2e.test.ts
│   ├── setup.test.ts
│   └── syncPbtxt.test.ts
├── templates/
│   ├── mcp_config.snippet.json
│   ├── conversation-auto-rename.md
│   └── skills/
│       └── rename/
│           └── SKILL.md
└── README.md
```

---

## 开发与测试

```sh
npm run build   # 编译 TypeScript 至 dist/
npm test        # 编译并运行全部单元测试、安装脚本测试与 Stdio MCP 端到端沙盒测试
```

---

## 卸载

卸载本 MCP **不会影响或删除任何已有对话记录**，已修改好的对话标题也会继续保留。

### 一键让 AI 帮我卸载
在 Antigravity 中直接发送：
```text
请按 https://github.com/falconchen/antigravity-conversation-renamer-mcp 的卸载说明帮我卸载 conversation-renamer MCP 并清理本地安装目录。
```

### 手动一键卸载
在安装目录下执行：
```sh
cd ~/.local/share/antigravity-conversation-renamer-mcp
npm run uninstall-agy
cd ~ && rm -rf ~/.local/share/antigravity-conversation-renamer-mcp
```
然后重启 Antigravity（或在 **Additional Options (`...`) → MCP Servers** 中刷新）即可。

（也可纯手工清理：从 `~/.gemini/config/mcp_config.json` 移除 `conversation-renamer` 节点，并执行 `rm -f ~/.gemini/config/rules/conversation-auto-rename.md && rm -rf ~/.gemini/config/skills/rename`。）

---

## 常见问题

1. **Antigravity 中看不到 `conversation-renamer` 或启动报错 `spawn node ENOENT`**
   - 确认 `~/.gemini/config/mcp_config.json` 中的 `command` 是 `which node` 返回的绝对路径，且版本 `>= 22.5.0`（使用 `npm run setup` 会自动写入正确路径）。
2. **批量修改历史空闲对话标题后，侧边栏没变化甚至普通重启后还原了？**
   - 活跃对话会由 `language_server` 实时同步刷新；历史空闲对话的旧摘要缓存在运行中进程内存里，普通退出（`Cmd+Q`）时退出钩子会覆盖数据库，但 `annotations/*.pbtxt` 中的新标题完好保留。运行 `npm run sync-relaunch` 即可在冷状态下将全部 `.pbtxt` 新标题同步回 SQLite / FTS5 / 缓存并安全重启 Antigravity 立即生效。
3. **会损坏 Antigravity 的对话数据吗？**
   - 不会。所有修改仅针对标题相关字段，`.pbtxt` 与 `.pb` 采用同目录临时文件 + `rename` 原子替换；Protobuf 使用 Wire 级局部 Patch 并在落盘前做完整性校验，保留全部未知字段；SQLite 使用 `busy_timeout = 5000` 与 `BEGIN IMMEDIATE` 短事务，不触碰 WAL 文件与运行时状态字段。

---

## License

[MIT](./LICENSE)
