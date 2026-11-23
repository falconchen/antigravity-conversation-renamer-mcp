import os from "node:os";
import path from "node:path";

export interface AntigravityPaths {
  dataDir: string;
  summariesDbPath: string;
  annotationsDir: string;
  summariesProtoCachePath: string;
}

const SAFE_CONVERSATION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;

/**
 * 校验 conversation_id 格式，防止路径穿越或非法字符注入。
 */
export function validateConversationId(conversationId: string): string {
  const trimmed = conversationId.trim();
  if (!SAFE_CONVERSATION_ID_RE.test(trimmed)) {
    throw new Error(`非法的 conversation_id 格式: "${conversationId}"`);
  }
  return trimmed;
}

/**
 * 解析 Antigravity 本地数据目录，支持通过 ANTIGRAVITY_DATA_DIR 环境变量覆盖（便于沙盒测试）。
 */
export function resolveAntigravityPaths(overrideDataDir?: string): AntigravityPaths {
  const dataDir = path.resolve(
    overrideDataDir ??
      process.env.ANTIGRAVITY_DATA_DIR ??
      path.join(os.homedir(), ".gemini", "antigravity"),
  );
  return {
    dataDir,
    summariesDbPath: path.join(dataDir, "conversation_summaries.db"),
    annotationsDir: path.join(dataDir, "annotations"),
    summariesProtoCachePath: path.join(dataDir, "agyhub_summaries_proto.pb"),
  };
}

export function getAnnotationPbtxtPath(paths: AntigravityPaths, conversationId: string): string {
  const safeId = validateConversationId(conversationId);
  return path.join(paths.annotationsDir, `${safeId}.pbtxt`);
}
