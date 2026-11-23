---
name: rename
description: >-
  Rename the current Antigravity conversation title via the conversation-renamer MCP.
  Use when the user invokes /rename (with an optional custom title) or asks to rename the current conversation.
---

# Rename Current Conversation (`/rename`)

Use the `conversation-renamer` MCP tool (`rename_conversation`) to update the title of the current conversation.

## Steps

1. Read the current `Conversation ID` from `<user_information>`.
2. Determine the target title:
   - If the user provided a title after `/rename` (e.g., `/rename 修复鉴权 Bug`), use that exact title (trimmed of surrounding quotes or extra whitespace).
   - If the user invoked `/rename` without a title, summarize the core topic currently being worked on in this conversation into a concise, accurate title matching the conversation language (8–20 Chinese characters or 3–7 English words, no trailing punctuation or line breaks).
3. Call `rename_conversation` on the `conversation-renamer` MCP server with:
   - `conversation_id`: the current `Conversation ID`
   - `new_title`: the target title
4. Confirm the updated title in one concise sentence.
