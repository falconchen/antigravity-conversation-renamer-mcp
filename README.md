# Antigravity Conversation Renamer MCP

一个面向 **Google Antigravity** 的轻量级 TypeScript / Node.js Stdio MCP Server。

在 Antigravity 中开启对话时，初始标题往往由第一条消息自动生成；随着讨论逐步展开，实际任务很容易偏离最初的标题。通过本 MCP，Antigravity 可以在话题明显转向或收到你的指令时，**免辅助功能权限、无需重启客户端**，自动无损地重命名当前或历史对话标题，并实时反映在界面与检索中。

---

## 特性亮点

- **实时生效且防覆写**：优先原子写入 `~/.gemini/antigravity/annotations/<convID>.pbtxt`（Antigravity `language_server` 运行期事实源），再同步更新 SQLite 与缓存，避免被内存中的旧标题覆盖。
- **零原生编译依赖**：基于 Node.js 22.5+ 内置 `node:sqlite`（开启 `readBigInts: true` 无损保留 64 位纳秒级时间戳）与纯 TypeScript Protobuf Wire 级无损 Patcher。
- **四位点无损同步**：
  1. `~/.gemini/antigravity/annotations/<convID>.pbtxt`（原地替换 `title`，保留 `last_user_view_time` 等其他字段）
  2. `~/.gemini/antigravity/conversation_summaries.db` 的 `conversation_summaries` 表（更新 `title`、`preview`，无损局部改写 `raw_summary` 的 Field `1` 与 `15.1`，保留所有其余与未知字段）
  3. `conversation_summaries.db` 的 `conversations_fts` 虚拟表（无损重建 `chunk_index = -1` 标题检索行，不触碰正文索引）
  4. `~/.gemini/antigravity/agyhub_summaries_proto.pb`（局部替换对应会话条目，原子写回）
- **混合模式触发**：配套 `always_on` 全局规则模板，同时支持“话题偏离时自动改名”和“随时手动指令改名”。
- **免系统权限弹窗**：纯本地磁盘无损读写，不依赖 macOS Accessibility 辅助功能，不抢占前台焦点，不查杀 Antigravity 进程。

---

## 环境要求

- **Google Antigravity** 桌面端或 CLI
- **Node.js >= 22.5.0**（需要内置 `node:sqlite` 支持，推荐使用 Node 22 LTS 或 Node 24+）

检查本机 Node 版本与绝对路径：

```sh
node -v
which node
```

---

## 安装与配置

### 1. 克隆并构建项目

```sh
git clone https://github.com/falconchen/antigravity-conversation-renamer-mcp.git
cd antigravity-conversation-renamer-mcp
npm install
npm run build
```

> 可运行 `npm test` 执行全量单元测试与隔离沙盒下的真实 Stdio MCP 端到端链路测试。

### 2. 注册全局 MCP 服务

编辑（或新建）Antigravity 全局 MCP 配置文件 `~/.gemini/config/mcp_config.json`，在 `mcpServers` 中新增 `conversation-renamer` 节点（参考 [`templates/mcp_config.snippet.json`](./templates/mcp_config.snippet.json)）：

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

> **重要提示**：
> - `command` 请填写 `which node` 输出的**绝对路径**（尤其是使用 `nvm` / `fnm` / `volta` 的 macOS 用户，GUI 启动 Antigravity 时非交互 `PATH` 通常不包含版本管理器目录）。
> - `args[0]` 请填写编译后 `dist/src/index.js` 的**绝对路径**。
> - 如需指定自定义 Antigravity 数据目录，可在该节点下添加 `"env": { "ANTIGRAVITY_DATA_DIR": "/custom/path" }`（默认 `~/.gemini/antigravity`）。

### 3. （推荐）安装混合模式自动触发规则

若希望 Antigravity 在对话主题偏离时**自动判断并更新标题**，将 [`templates/conversation-auto-rename.md`](./templates/conversation-auto-rename.md) 复制到全局规则目录：

```sh
mkdir -p ~/.gemini/config/rules
cp ./templates/conversation-auto-rename.md ~/.gemini/config/rules/conversation-auto-rename.md
```

> 如果你只希望在自己明确开口要求时才改名，可以跳过此步骤，仅配置第 2 步的 MCP 即可。

### 4. （可选）安装 `/rename` 斜杠命令 Skill

若希望在输入框中直接键入 `/rename` 一键触发重命名，将 [`templates/skills/rename/SKILL.md`](./templates/skills/rename/SKILL.md) 复制到全局 Skills 目录：

```sh
mkdir -p ~/.gemini/config/skills/rename
cp ./templates/skills/rename/SKILL.md ~/.gemini/config/skills/rename/SKILL.md
```

### 5. 重启或刷新 Antigravity

重启 Antigravity（或在菜单 **Additional Options (`...`) → MCP Servers** 中刷新）即可生效。

---

## 使用方法

启用后，你可以在任意对话中直接使用以下方式：

### 方式一：`/rename` 斜杠命令（安装了 Skill 后）
- `/rename`：自动根据当前对话内容总结最贴切的新标题并更新
- `/rename 排查 Redis 内存泄漏`：直接将当前对话重命名为指定标题

### 方式二：手动指定标题
直接对 Antigravity 说：
- `把当前对话标题改为「排查 Redis 内存泄漏」`
- `重命名这个对话为 Auth Refactor`

### 方式三：让 Antigravity 自动总结并改名
- `根据目前聊的内容，更新一下当前对话标题`

### 方式四：主题偏离时自动触发（安装了混合规则后）
当你从最初的问题（例如“你好，帮我看个报错”）逐步深入到具体工程任务（例如“重构登录鉴权中间件”）后，Antigravity 会在合适时机自动调用 `get_conversation_title` 检查现有标题，确认偏离后调用 `rename_conversation` 更新标题，且不会在主题未变时反复改名。

### 方式五：查看或整理历史对话
- `列出最近 10 条对话`
- `把刚才那个标题为 "Untitled" 的历史对话改成「部署 Docker 监控栈」`

---

## 暴露的 MCP 工具

| 工具名 | 只读/写入 | 入参 | 说明 |
| :--- | :---: | :--- | :--- |
| `get_conversation_title` | 只读 | `conversation_id` | 读取指定会话在数据库、`.pbtxt` 与 Protobuf 中的当前标题、步数及同步状态（`inSync`） |
| `rename_conversation` | 写入（幂等） | `conversation_id`, `new_title`, `reason?` | 自动清洗标题换行与多余空白，无损同步更新 `.pbtxt`、SQLite 主表、FTS5 索引与缓存快照 |
| `list_recent_conversations` | 只读 | `limit?` (1–50), `include_subagents?` | 列出最近未删除的对话 ID、标题与最后修改时间（默认过滤子代理对话） |

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
├── tests/
│   ├── pbtxtPatcher.test.ts
│   ├── protoPatcher.test.ts
│   └── renamer.e2e.test.ts
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
npm test        # 编译并运行全部单元测试与 Stdio MCP 端到端沙盒测试
```

---

## 卸载

卸载本 MCP 不会影响或删除任何已有对话记录，已修改好的对话标题也会继续保留。按以下步骤即可彻底清理：

1. **移除全局 MCP 配置**：编辑 `~/.gemini/config/mcp_config.json`，删除 `mcpServers` 中的 `conversation-renamer` 字段并保存。
2. **删除自动触发规则与 `/rename` Skill**（如曾安装）：
   ```sh
   rm -f ~/.gemini/config/rules/conversation-auto-rename.md
   rm -rf ~/.gemini/config/skills/rename
   ```
3. **生效清理**：重启 Antigravity（或在 **Additional Options (`...`) → MCP Servers** 中刷新）。
4. **删除本地代码目录**（可选）：
   ```sh
   rm -rf /ABSOLUTE/PATH/TO/antigravity-conversation-renamer-mcp
   ```

---

## 常见问题

1. **Antigravity 中看不到 `conversation-renamer` 或启动报错 `spawn node ENOENT`**
   - 检查 `~/.gemini/config/mcp_config.json` 中的 `command` 是否为 `which node` 返回的绝对路径，且版本 `>= 22.5.0`。
2. **修改历史对话标题后，左侧边栏没有立刻变化？**
   - 活跃对话会由 `language_server` 实时同步刷新；历史空闲对话如前端缓存尚未重绘，切换列表或重新加载客户端即可看到最新标题，且全文搜索（FTS5）立即生效。
3. **会损坏 Antigravity 的对话数据吗？**
   - 不会。所有修改仅针对标题相关字段，`.pbtxt` 与 `.pb` 采用同目录临时文件 + `rename` 原子替换；Protobuf 使用 Wire 级局部 Patch 并在落盘前做完整性校验，保留全部未知字段；SQLite 使用 `busy_timeout = 5000` 与 `BEGIN IMMEDIATE` 短事务，不触碰 WAL 文件与运行时状态字段。

---

## License

[MIT](./LICENSE)
