import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { type AntigravityPaths, resolveAntigravityPaths } from "./paths.js";
import { readPbtxtTitle } from "./pbtxtPatcher.js";
import {
  extractSummaryTitles,
  patchCascadeSummaryTitle,
  patchSummariesProtoCacheBatch,
} from "./protoPatcher.js";

export interface PendingPbtxtSyncItem {
  conversationId: string;
  dbTitle: string;
  pbtxtTitle: string;
  status: string;
}

export interface SyncPbtxtResult {
  scannedAnnotations: number;
  pendingCount: number;
  syncedCount: number;
  ftsUpdatedCount: number;
  protoCacheUpdatedCount: number;
  dryRun: boolean;
  items: PendingPbtxtSyncItem[];
}

function toBuffer(val: unknown): Buffer {
  if (val == null) return Buffer.alloc(0);
  if (Buffer.isBuffer(val)) return val;
  if (val instanceof Uint8Array) return Buffer.from(val);
  return Buffer.alloc(0);
}

function toStringVal(val: unknown): string {
  return val == null ? "" : String(val);
}

function writeBufferAtomic(targetPath: string, data: Buffer): void {
  const dir = path.dirname(targetPath);
  const tmpPath = path.join(dir, `.${path.basename(targetPath)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tmpPath, data);
    fs.renameSync(tmpPath, targetPath);
  } catch (err) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      // 忽略清理失败
    }
    throw err;
  }
}

/**
 * 扫描 annotations/*.pbtxt，将以 .pbtxt 为准的新标题批量无损同步回
 * conversation_summaries.db（含 raw_summary 与 conversations_fts）及 agyhub_summaries_proto.pb。
 * 适合在 Antigravity 冷状态（未运行）下执行，彻底避免退出保存钩子覆写。
 */
export function syncAllPbtxtToStore(options?: {
  paths?: AntigravityPaths;
  dryRun?: boolean;
  checkpointWal?: boolean;
  nowDate?: Date;
}): SyncPbtxtResult {
  const paths = options?.paths ?? resolveAntigravityPaths();
  const dryRun = options?.dryRun ?? false;
  const checkpointWal = options?.checkpointWal ?? true;
  const nowDate = options?.nowDate ?? new Date();

  if (!fs.existsSync(paths.summariesDbPath)) {
    throw new Error(`未找到 Antigravity 对话摘要数据库: ${paths.summariesDbPath}`);
  }
  if (!fs.existsSync(paths.annotationsDir)) {
    return {
      scannedAnnotations: 0,
      pendingCount: 0,
      syncedCount: 0,
      ftsUpdatedCount: 0,
      protoCacheUpdatedCount: 0,
      dryRun,
      items: [],
    };
  }

  // 1. 读取全部非空的 annotations/*.pbtxt 标题
  const pbtxtTitles = new Map<string, string>();
  const entries = fs.readdirSync(paths.annotationsDir, { withFileTypes: true });
  for (const ent of entries) {
    if (!ent.isFile() || !ent.name.endsWith(".pbtxt")) continue;
    const convId = ent.name.slice(0, -".pbtxt".length);
    if (!convId) continue;
    try {
      const title = readPbtxtTitle(path.join(paths.annotationsDir, ent.name));
      if (title && title.trim().length > 0) {
        pbtxtTitles.set(convId, title);
      }
    } catch {
      // 跳过损坏或非标准标注文件
    }
  }

  const db = new DatabaseSync(paths.summariesDbPath, {
    readOnly: dryRun,
    readBigInts: true,
  });
  db.exec("PRAGMA busy_timeout = 5000;");

  const items: PendingPbtxtSyncItem[] = [];
  const patchedRawByConvId = new Map<string, Buffer>();
  let ftsUpdatedCount = 0;
  let inTransaction = false;

  try {
    const rows = db
      .prepare(
        `SELECT conversation_id, title, preview, status, raw_summary
         FROM conversation_summaries
         WHERE killed = 0`,
      )
      .all() as Record<string, unknown>[];

    const pendingUpdates: Array<{
      conversationId: string;
      dbTitle: string;
      pbtxtTitle: string;
      status: string;
      rawSummary: Buffer;
    }> = [];

    for (const row of rows) {
      const convId = toStringVal(row.conversation_id);
      const pbtxtTitle = pbtxtTitles.get(convId);
      if (!pbtxtTitle) continue;

      const dbTitle = toStringVal(row.title);
      const dbPreview = toStringVal(row.preview);
      const rawSummary = toBuffer(row.raw_summary);
      const protoTitles = extractSummaryTitles(rawSummary);

      const needsSync =
        dbTitle !== pbtxtTitle ||
        dbPreview !== pbtxtTitle ||
        protoTitles.summaryField1 !== pbtxtTitle ||
        protoTitles.annotationField15_1 !== pbtxtTitle;

      if (needsSync) {
        const status = toStringVal(row.status);
        items.push({ conversationId: convId, dbTitle, pbtxtTitle, status });
        pendingUpdates.push({ conversationId: convId, dbTitle, pbtxtTitle, status, rawSummary });
      }
    }

    if (dryRun || pendingUpdates.length === 0) {
      return {
        scannedAnnotations: pbtxtTitles.size,
        pendingCount: items.length,
        syncedCount: 0,
        ftsUpdatedCount: 0,
        protoCacheUpdatedCount: 0,
        dryRun,
        items,
      };
    }

    const ftsTableExists = Boolean(
      db
        .prepare(
          `SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'conversations_fts'`,
        )
        .get(),
    );

    db.exec("BEGIN IMMEDIATE;");
    inTransaction = true;

    const updateSummaryStmt = db.prepare(
      `UPDATE conversation_summaries
       SET title = ?, preview = ?, raw_summary = ?
       WHERE conversation_id = ?`,
    );
    const selectFtsStmt = ftsTableExists
      ? db.prepare(
          `SELECT conversation_id, chunk_index, chunk_first_step, chunk_last_step,
                  last_modified_time, step_count, last_step_created_at, archived,
                  user_step_byte_offsets, agent_step_byte_offsets,
                  workspace, project, user_body, agent_body
           FROM conversations_fts
           WHERE conversation_id = ? AND chunk_index = -1`,
        )
      : null;
    const deleteFtsStmt = ftsTableExists
      ? db.prepare(
          `DELETE FROM conversations_fts WHERE conversation_id = ? AND chunk_index = -1`,
        )
      : null;
    const insertFtsStmt = ftsTableExists
      ? db.prepare(
          `INSERT INTO conversations_fts (
             conversation_id, chunk_index, chunk_first_step, chunk_last_step,
             last_modified_time, step_count, last_step_created_at, archived,
             user_step_byte_offsets, agent_step_byte_offsets,
             title, workspace, project, user_body, agent_body
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
      : null;

    for (const target of pendingUpdates) {
      const patchedRaw = patchCascadeSummaryTitle(target.rawSummary, target.pbtxtTitle, nowDate);
      updateSummaryStmt.run(
        target.pbtxtTitle,
        target.pbtxtTitle,
        patchedRaw,
        target.conversationId,
      );
      patchedRawByConvId.set(target.conversationId, patchedRaw);

      if (selectFtsStmt && deleteFtsStmt && insertFtsStmt) {
        const ftsRow = selectFtsStmt.get(target.conversationId) as Record<string, unknown> | undefined;
        if (ftsRow) {
          deleteFtsStmt.run(target.conversationId);
          insertFtsStmt.run(
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
            target.pbtxtTitle,
            ftsRow.workspace as SQLInputValue,
            ftsRow.project as SQLInputValue,
            ftsRow.user_body as SQLInputValue,
            ftsRow.agent_body as SQLInputValue,
          );
          ftsUpdatedCount++;
        }
      }
    }

    db.exec("COMMIT;");
    inTransaction = false;

    if (checkpointWal) {
      db.exec("PRAGMA wal_checkpoint(FULL);");
    }
  } catch (err) {
    if (inTransaction) {
      try {
        db.exec("ROLLBACK;");
      } catch {
        // 忽略回滚失败
      }
    }
    throw err;
  } finally {
    db.close();
  }

  // 2. 同步刷新 agyhub_summaries_proto.pb 中全部已更新条目
  let protoCacheUpdatedCount = 0;
  if (fs.existsSync(paths.summariesProtoCachePath) && patchedRawByConvId.size > 0) {
    const cacheBuf = fs.readFileSync(paths.summariesProtoCachePath);
    if (cacheBuf.length > 0) {
      const { buffer, updatedCount } = patchSummariesProtoCacheBatch(cacheBuf, patchedRawByConvId);
      if (updatedCount > 0) {
        writeBufferAtomic(paths.summariesProtoCachePath, buffer);
        protoCacheUpdatedCount = updatedCount;
      }
    }
  }

  return {
    scannedAnnotations: pbtxtTitles.size,
    pendingCount: items.length,
    syncedCount: patchedRawByConvId.size,
    ftsUpdatedCount,
    protoCacheUpdatedCount,
    dryRun: false,
    items,
  };
}
