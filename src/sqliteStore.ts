import fs from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { patchCascadeSummaryTitle } from "./protoPatcher.js";

export interface ConversationSummaryRecord {
  conversationId: string;
  title: string;
  preview: string;
  stepCount: number;
  status: string;
  notFullyIdle: boolean;
  killed: boolean;
  parentConversationId: string;
  lastModifiedTime: string;
  rawSummary: Buffer;
}

export interface RecentConversationItem {
  conversationId: string;
  title: string;
  lastModifiedTime: string;
  stepCount: number;
  status: string;
  isSubagent: boolean;
  projectId: string;
  workspacePaths: string[];
}

export interface ListRecentConversationsOptions {
  limit?: number;
  includeSubagents?: boolean;
  workspace?: string;
}

export interface DbRenameResult {
  oldTitle: string;
  patchedRawSummary: Buffer;
  ftsUpdated: boolean;
  wasActive: boolean;
}

function toBuffer(val: unknown): Buffer {
  if (val == null) return Buffer.alloc(0);
  if (Buffer.isBuffer(val)) return val;
  if (val instanceof Uint8Array) return Buffer.from(val);
  return Buffer.alloc(0);
}

function toNumber(val: unknown): number {
  if (typeof val === "bigint") return Number(val);
  if (typeof val === "number") return val;
  return 0;
}

function toStringVal(val: unknown): string {
  if (val == null) return "";
  return String(val);
}

function openDb(dbPath: string, readOnly: boolean): DatabaseSync {
  if (!fs.existsSync(dbPath)) {
    throw new Error(`未找到 Antigravity 对话摘要数据库: ${dbPath}`);
  }
  const db = new DatabaseSync(dbPath, {
    readOnly,
    readBigInts: true,
  });
  db.exec("PRAGMA busy_timeout = 5000;");
  return db;
}

/**
 * 查询指定会话的摘要记录。
 */
export function getConversationSummary(
  dbPath: string,
  conversationId: string,
): ConversationSummaryRecord | null {
  const db = openDb(dbPath, true);
  try {
    const row = db
      .prepare(
        `SELECT conversation_id, title, preview, step_count, status, not_fully_idle, killed,
                parent_conversation_id, last_modified_time, raw_summary
         FROM conversation_summaries
         WHERE conversation_id = ?`,
      )
      .get(conversationId) as Record<string, unknown> | undefined;

    if (!row) return null;

    return {
      conversationId: toStringVal(row.conversation_id),
      title: toStringVal(row.title),
      preview: toStringVal(row.preview),
      stepCount: toNumber(row.step_count),
      status: toStringVal(row.status),
      notFullyIdle: toNumber(row.not_fully_idle) !== 0,
      killed: toNumber(row.killed) !== 0,
      parentConversationId: toStringVal(row.parent_conversation_id),
      lastModifiedTime: toStringVal(row.last_modified_time),
      rawSummary: toBuffer(row.raw_summary),
    };
  } finally {
    db.close();
  }
}

function normalizeWorkspacePath(raw: string): string {
  let value = raw.trim();
  if (value.startsWith("file://")) {
    try {
      value = decodeURIComponent(new URL(value).pathname);
    } catch {
      value = value.replace(/^file:\/\//, "");
      try {
        value = decodeURIComponent(value);
      } catch {
        // 保持原始字符串
      }
    }
  } else {
    try {
      value = decodeURIComponent(value);
    } catch {
      // 保持原始字符串
    }
  }
  return value.length > 1 ? value.replace(/\/+$/, "") : value;
}

function parseWorkspacePaths(rawJson: string): string[] {
  if (!rawJson) return [];
  try {
    const parsed = JSON.parse(rawJson);
    if (Array.isArray(parsed)) {
      return parsed
        .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        .map(normalizeWorkspacePath);
    }
  } catch {
    // 忽略非法 JSON
  }
  return [];
}

function matchesWorkspaceFilter(workspacePaths: string[], rawJson: string, filter: string): boolean {
  const normalizedFilter = normalizeWorkspacePath(filter).toLowerCase();
  if (!normalizedFilter) return true;
  if (workspacePaths.some((p) => p.toLowerCase() === normalizedFilter || p.toLowerCase().includes(normalizedFilter))) {
    return true;
  }
  return rawJson.toLowerCase().includes(normalizedFilter);
}

/**
 * 列出最近的未删除对话，支持按工作区路径/目录名过滤。
 */
export function listRecentConversations(
  dbPath: string,
  options: ListRecentConversationsOptions = {},
): RecentConversationItem[] {
  const safeLimit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 10)));
  const includeSubagents = options.includeSubagents ?? false;
  const workspaceFilter = options.workspace?.trim() ?? "";
  const db = openDb(dbPath, true);
  try {
    const baseWhere = includeSubagents
      ? "WHERE killed = 0"
      : "WHERE killed = 0 AND parent_conversation_id = ''";

    const sql = workspaceFilter
      ? `SELECT conversation_id, title, last_modified_time, step_count, status,
                parent_conversation_id, project_id, workspace_uris
         FROM conversation_summaries
         ${baseWhere}
         ORDER BY last_modified_time DESC`
      : `SELECT conversation_id, title, last_modified_time, step_count, status,
                parent_conversation_id, project_id, workspace_uris
         FROM conversation_summaries
         ${baseWhere}
         ORDER BY last_modified_time DESC
         LIMIT ?`;

    const rows = (
      workspaceFilter ? db.prepare(sql).all() : db.prepare(sql).all(safeLimit)
    ) as Record<string, unknown>[];

    const items: RecentConversationItem[] = [];
    for (const row of rows) {
      const rawWorkspaceUris = toStringVal(row.workspace_uris);
      const workspacePaths = parseWorkspacePaths(rawWorkspaceUris);
      if (workspaceFilter && !matchesWorkspaceFilter(workspacePaths, rawWorkspaceUris, workspaceFilter)) {
        continue;
      }
      items.push({
        conversationId: toStringVal(row.conversation_id),
        title: toStringVal(row.title),
        lastModifiedTime: toStringVal(row.last_modified_time),
        stepCount: toNumber(row.step_count),
        status: toStringVal(row.status),
        isSubagent: toStringVal(row.parent_conversation_id).length > 0,
        projectId: toStringVal(row.project_id),
        workspacePaths,
      });
      if (items.length >= safeLimit) break;
    }

    return items;
  } finally {
    db.close();
  }
}

/**
 * 在单个 IMMEDIATE 事务中无损更新 conversation_summaries（title、preview、raw_summary）及 conversations_fts 标题索引行。
 */
export function updateConversationTitleInDb(
  dbPath: string,
  conversationId: string,
  newTitle: string,
  nowDate: Date = new Date(),
): DbRenameResult {
  const db = openDb(dbPath, false);
  let inTransaction = false;
  try {
    db.exec("BEGIN IMMEDIATE;");
    inTransaction = true;

    const row = db
      .prepare(
        `SELECT title, raw_summary, status, not_fully_idle
         FROM conversation_summaries
         WHERE conversation_id = ?`,
      )
      .get(conversationId) as Record<string, unknown> | undefined;

    if (!row) {
      throw new Error(`在 conversation_summaries.db 中未找到会话: ${conversationId}`);
    }

    const oldTitle = toStringVal(row.title);
    const rawSummary = toBuffer(row.raw_summary);
    const wasActive =
      toNumber(row.not_fully_idle) !== 0 || toStringVal(row.status) === "CASCADE_RUN_STATUS_RUNNING";
    const patchedRawSummary = patchCascadeSummaryTitle(rawSummary, newTitle, nowDate);

    db.prepare(
      `UPDATE conversation_summaries
       SET title = ?, preview = ?, raw_summary = ?
       WHERE conversation_id = ?`,
    ).run(newTitle, newTitle, patchedRawSummary, conversationId);

    let ftsUpdated = false;
    const ftsTableExists = db
      .prepare(
        `SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'conversations_fts'`,
      )
      .get();

    if (ftsTableExists) {
      const ftsRow = db
        .prepare(
          `SELECT conversation_id, chunk_index, chunk_first_step, chunk_last_step,
                  last_modified_time, step_count, last_step_created_at, archived,
                  user_step_byte_offsets, agent_step_byte_offsets,
                  workspace, project, user_body, agent_body
           FROM conversations_fts
           WHERE conversation_id = ? AND chunk_index = -1`,
        )
        .get(conversationId) as Record<string, unknown> | undefined;

      if (ftsRow) {
        db.prepare(
          `DELETE FROM conversations_fts WHERE conversation_id = ? AND chunk_index = -1`,
        ).run(conversationId);

        db.prepare(
          `INSERT INTO conversations_fts (
             conversation_id, chunk_index, chunk_first_step, chunk_last_step,
             last_modified_time, step_count, last_step_created_at, archived,
             user_step_byte_offsets, agent_step_byte_offsets,
             title, workspace, project, user_body, agent_body
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          ftsRow.conversation_id as SQLInputValue,
          ftsRow.chunk_index as SQLInputValue,
          ftsRow.chunk_first_step as SQLInputValue,
          ftsRow.chunk_last_step as SQLInputValue,
          ftsRow.last_modified_time as SQLInputValue,
          ftsRow.step_count as SQLInputValue,
          ftsRow.last_step_created_at as SQLInputValue,
          ftsRow.archived as SQLInputValue,
          ftsRow.user_step_byte_offsets as SQLInputValue,
          ftsRow.agent_step_byte_offsets as SQLInputValue,
          newTitle,
          ftsRow.workspace as SQLInputValue,
          ftsRow.project as SQLInputValue,
          ftsRow.user_body as SQLInputValue,
          ftsRow.agent_body as SQLInputValue,
        );
        ftsUpdated = true;
      }
    }

    db.exec("COMMIT;");
    inTransaction = false;

    return {
      oldTitle,
      patchedRawSummary,
      ftsUpdated,
      wasActive,
    };
  } catch (err) {
    if (inTransaction) {
      try {
        db.exec("ROLLBACK;");
      } catch {
        // 忽略回滚二次异常
      }
    }
    throw err;
  } finally {
    db.close();
  }
}
