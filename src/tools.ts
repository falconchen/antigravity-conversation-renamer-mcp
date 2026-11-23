import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type AntigravityPaths, resolveAntigravityPaths } from "./paths.js";
import {
  getConversationTitleInfo,
  listConversations,
  MAX_TITLE_LENGTH,
  renameConversation,
} from "./renamer.js";

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 创建并注册 Antigravity 对话重命名 MCP Server。
 */
export function createConversationRenamerServer(
  paths: AntigravityPaths = resolveAntigravityPaths(),
): McpServer {
  const server = new McpServer({
    name: "conversation-renamer",
    version: "1.0.0",
  });

  server.tool(
    "get_conversation_title",
    "Read the current title and sync status of an Antigravity conversation. Pass the Conversation ID from <user_information> to check whether the current title has drifted from the active topic.",
    {
      conversation_id: z
        .string()
        .min(8)
        .describe("The Antigravity Conversation ID (UUID from <user_information>)."),
    },
    {
      title: "Get Conversation Title",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async ({ conversation_id }) => {
      try {
        const info = getConversationTitleInfo(conversation_id, paths);
        return {
          content: [{ type: "text", text: JSON.stringify(info, null, 2) }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: `读取对话标题失败: ${formatError(err)}` }],
        };
      }
    },
  );

  server.tool(
    "rename_conversation",
    "Rename an Antigravity conversation title cleanly across annotations/*.pbtxt, conversation_summaries.db (including lossless Protobuf patching and FTS5 index), and agyhub_summaries_proto.pb. Pass the Conversation ID from <user_information> and a concise, accurate new title.",
    {
      conversation_id: z
        .string()
        .min(8)
        .describe("The Antigravity Conversation ID (UUID from <user_information>)."),
      new_title: z
        .string()
        .min(1)
        .max(MAX_TITLE_LENGTH)
        .describe("Concise new conversation title matching the conversation language."),
      reason: z
        .string()
        .max(200)
        .optional()
        .describe("Optional brief note explaining why the title was updated."),
    },
    {
      title: "Rename Conversation",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async ({ conversation_id, new_title, reason }) => {
      try {
        const result = renameConversation(conversation_id, new_title, {
          reason,
          paths,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: `重命名对话失败: ${formatError(err)}` }],
        };
      }
    },
  );

  server.tool(
    "list_recent_conversations",
    "List recent non-deleted Antigravity conversations with their IDs, titles, workspace paths, project IDs, and modification times. Optionally filter by workspace path or folder name (e.g. from Active Workspaces in <user_information>).",
    {
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("Maximum number of recent conversations to return (default 10, max 100)."),
      include_subagents: z
        .boolean()
        .optional()
        .describe("Whether to include subagent child conversations (default false)."),
      workspace: z
        .string()
        .min(1)
        .optional()
        .describe("Optional workspace path, file:// URI, or folder name substring to filter conversations (case-insensitive, supports URL-encoded non-ASCII paths)."),
    },
    {
      title: "List Recent Conversations",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async ({ limit, include_subagents, workspace }) => {
      try {
        const items = listConversations(
          {
            limit: limit ?? 10,
            includeSubagents: include_subagents ?? false,
            workspace,
          },
          paths,
        );
        return {
          content: [{ type: "text", text: JSON.stringify({ count: items.length, conversations: items }, null, 2) }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: `列出最近对话失败: ${formatError(err)}` }],
        };
      }
    },
  );

  return server;
}
