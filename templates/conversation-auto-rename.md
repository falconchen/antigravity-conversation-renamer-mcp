---
trigger: always_on
---

# 对话标题动态重命名规范（conversation-renamer MCP）

当工具集中存在 `conversation-renamer` MCP 工具（`get_conversation_title`、`rename_conversation`）时，遵循以下混合触发规范：

1. **获取当前对话 ID**：始终使用系统上下文 `<user_information>` 中的 `Conversation ID` 作为 `conversation_id` 参数。
2. **手动重命名（立即执行）**：当用户明确要求修改、总结或重新命名对话标题时，立即调用 `rename_conversation`。
3. **主动重命名（主题明显偏离时，保持克制）**：
   - 当对话已进行 2 轮及以上，且实际展开的核心任务或问题已明显偏离初始提问（或初始标题过于宽泛如“你好”“帮我看个问题”）时，先调用 `get_conversation_title` 检查当前标题；
   - 若确认当前标题与正在推进的主题明显不符，生成一个简明准确的标题（与对话语言一致，中文建议 8–20 字，英文建议 3–7 词，不含多余标点或换行），调用 `rename_conversation` 完成更新；
   - 同一对话若核心主题未再次明显转变，不要重复改名；调用完成后无需大段汇报，必要时一句话简短带过即可。
