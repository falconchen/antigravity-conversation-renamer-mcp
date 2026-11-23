import fs from "node:fs";
import path from "node:path";
import {
  type AntigravityPaths,
  getAnnotationPbtxtPath,
  resolveAntigravityPaths,
  validateConversationId,
} from "./paths.js";
import { readPbtxtTitle, writePbtxtTitleAtomic } from "./pbtxtPatcher.js";
import { extractSummaryTitles, patchSummariesProtoCache } from "./protoPatcher.js";
import {
  getConversationSummary,
  listRecentConversations,
  type ListRecentConversationsOptions,
  type RecentConversationItem,
  updateConversationTitleInDb,
} from "./sqliteStore.js";

export const MAX_TITLE_LENGTH = 100;

export interface ConversationTitleInfo {
  conversationId: string;
  dbTitle: string;
  dbPreview: string;
  pbtxtTitle: string | null;
  protoSummaryTitle: string | null;
  protoAnnotationTitle: string | null;
  inSync: boolean;
  stepCount: number;
  status: string;
  lastModifiedTime: string;
}

export interface RenameConversationResult {
  conversationId: string;
  changed: boolean;
  oldTitle: string;
  newTitle: string;
  reason?: string;
  uiRefreshHint: "active_live_sync" | "idle_restart_required" | "unchanged";
  coldSyncHint?: string;
  updatedTargets: {
    pbtxt: boolean;
    sqliteSummaries: boolean;
    sqliteFts: boolean;
    protoCache: boolean;
  };
}

/**
 * 清洗并校验新标题：折叠换行与多余空白，禁止空标题与超长标题。
 */
export function normalizeTitle(rawTitle: string): string {
  const cleaned = rawTitle
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  if (cleaned.length === 0) {
    throw new Error("新标题不能为空");
  }
  if (cleaned.length > MAX_TITLE_LENGTH) {
    throw new Error(`新标题过长（${cleaned.length} 字符），请控制在 ${MAX_TITLE_LENGTH} 字符以内`);
  }
  return cleaned;
}

/**
 * 查询对话当前在磁盘各存储位点的标题状态。
 */
export function getConversationTitleInfo(
  conversationId: string,
  paths: AntigravityPaths = resolveAntigravityPaths(),
): ConversationTitleInfo {
  const safeId = validateConversationId(conversationId);
  const summary = getConversationSummary(paths.summariesDbPath, safeId);
  if (!summary) {
    throw new Error(`未找到对话 ${safeId}`);
  }

  const pbtxtPath = getAnnotationPbtxtPath(paths, safeId);
  const pbtxtTitle = readPbtxtTitle(pbtxtPath);
  const protoTitles = extractSummaryTitles(summary.rawSummary);

  const inSync =
    summary.title === summary.preview &&
    (pbtxtTitle === null || pbtxtTitle === summary.title) &&
    (protoTitles.summaryField1 === null || protoTitles.summaryField1 === summary.title) &&
    (protoTitles.annotationField15_1 === null || protoTitles.annotationField15_1 === summary.title);

  return {
    conversationId: safeId,
    dbTitle: summary.title,
    dbPreview: summary.preview,
    pbtxtTitle,
    protoSummaryTitle: protoTitles.summaryField1,
    protoAnnotationTitle: protoTitles.annotationField15_1,
    inSync,
    stepCount: summary.stepCount,
    status: summary.status,
    lastModifiedTime: summary.lastModifiedTime,
  };
}

/**
 * 列出最近的对话列表，支持按工作区路径或目录名筛选。
 */
export function listConversations(
  options: ListRecentConversationsOptions = {},
  paths: AntigravityPaths = resolveAntigravityPaths(),
): RecentConversationItem[] {
  return listRecentConversations(paths.summariesDbPath, options);
}

/**
 * 原子更新 agyhub_summaries_proto.pb 缓存快照中的单个会话条目。
 */
function updateProtoCacheFileAtomic(
  cachePath: string,
  conversationId: string,
  patchedRawSummary: Buffer,
): boolean {
  if (!fs.existsSync(cachePath)) return false;

  const original = fs.readFileSync(cachePath);
  if (original.length === 0) return false;

  const { buffer, updated } = patchSummariesProtoCache(original, conversationId, patchedRawSummary);
  if (!updated) return false;

  const dir = path.dirname(cachePath);
  const tmpPath = path.join(
    dir,
    `.${path.basename(cachePath)}.${process.pid}.${Date.now()}.tmp`,
  );
  try {
    fs.writeFileSync(tmpPath, buffer);
    fs.renameSync(tmpPath, cachePath);
  } catch (err) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      // 忽略临时文件清理失败
    }
    throw err;
  }
  return true;
}

/**
 * 重命名 Antigravity 对话标题：
 * 1. 先原子更新 annotations/<id>.pbtxt（运行时 language_server 事实源，避免被内存旧标题覆盖）；
 * 2. 单事务更新 conversation_summaries.db（title、preview、无损 Patch raw_summary 及 FTS5 标题行）；
 * 3. 若存在 agyhub_summaries_proto.pb，无损局部替换对应条目。
 */
export function renameConversation(
  conversationId: string,
  rawNewTitle: string,
  options?: {
    reason?: string;
    paths?: AntigravityPaths;
    nowDate?: Date;
  },
): RenameConversationResult {
  const safeId = validateConversationId(conversationId);
  const newTitle = normalizeTitle(rawNewTitle);
  const paths = options?.paths ?? resolveAntigravityPaths();
  const nowDate = options?.nowDate ?? new Date();

  const current = getConversationTitleInfo(safeId, paths);
  if (current.dbTitle === newTitle && current.pbtxtTitle === newTitle && current.inSync) {
    return {
      conversationId: safeId,
      changed: false,
      oldTitle: current.dbTitle,
      newTitle,
      reason: options?.reason,
      uiRefreshHint: "unchanged",
      updatedTargets: {
        pbtxt: false,
        sqliteSummaries: false,
        sqliteFts: false,
        protoCache: false,
      },
    };
  }

  // 步骤 1：优先原子写入 annotations/<id>.pbtxt
  const pbtxtPath = getAnnotationPbtxtPath(paths, safeId);
  writePbtxtTitleAtomic(pbtxtPath, newTitle, nowDate);

  // 步骤 2：事务更新 conversation_summaries + conversations_fts
  const dbRes = updateConversationTitleInDb(paths.summariesDbPath, safeId, newTitle, nowDate);

  // 步骤 3：可选局部更新 agyhub_summaries_proto.pb 缓存快照
  let protoCacheUpdated = false;
  try {
    protoCacheUpdated = updateProtoCacheFileAtomic(
      paths.summariesProtoCachePath,
      safeId,
      dbRes.patchedRawSummary,
    );
  } catch (err) {
    // 缓存文件非权威主数据，局部更新异常时记录到 stderr，不阻塞主流程
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[conversation-renamer-mcp] 更新 agyhub_summaries_proto.pb 跳过: ${msg}\n`);
  }

  return {
    conversationId: safeId,
    changed: true,
    oldTitle: dbRes.oldTitle || current.pbtxtTitle || "",
    newTitle,
    reason: options?.reason,
    uiRefreshHint: dbRes.wasActive ? "active_live_sync" : "idle_restart_required",
    ...(dbRes.wasActive
      ? {}
      : {
          coldSyncHint:
            "历史空闲对话在普通退出重启时可能被运行中进程的内存旧缓存覆写 SQLite（.pbtxt 已安全保留）。请运行 `npm run sync-relaunch` 执行冷同步并安全重启 Antigravity 使其立即生效。",
        }),
    updatedTargets: {
      pbtxt: true,
      sqliteSummaries: true,
      sqliteFts: dbRes.ftsUpdated,
      protoCache: protoCacheUpdated,
    },
  };
}
