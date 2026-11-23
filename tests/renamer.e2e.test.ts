import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  extractSummaryTitles,
  makeLengthDelimitedField,
  makeVarintField,
  parseProtoFields,
  patchCascadeSummaryTitle,
} from "../src/protoPatcher.js";
import { resolveAntigravityPaths } from "../src/paths.js";
import { readPbtxtTitle } from "../src/pbtxtPatcher.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_INDEX_PATH = path.resolve(__dirname, "../src/index.js");

function createSandboxAntigravityDir(): {
  dataDir: string;
  convId: string;
  idleConvId: string;
  subagentConvId: string;
  cleanup: () => void;
} {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-renamer-e2e-"));
  const convId = "11111111-2222-3333-4444-555555555555";
  const idleConvId = "22222222-2222-3333-4444-555555555555";
  const subagentConvId = "99999999-2222-3333-4444-555555555555";

  const annotationsDir = path.join(dataDir, "annotations");
  fs.mkdirSync(annotationsDir, { recursive: true });
  fs.writeFileSync(
    path.join(annotationsDir, `${convId}.pbtxt`),
    'title:"Initial Off-Topic Title" last_user_view_time:{seconds:1795410613 nanos:39000000}',
    "utf8",
  );
  fs.writeFileSync(
    path.join(annotationsDir, `${idleConvId}.pbtxt`),
    'title:"Idle Remote Host Chat" last_user_view_time:{seconds:1795410000 nanos:0}',
    "utf8",
  );

  const rawSummary = patchCascadeSummaryTitle(
    Buffer.concat([
      makeVarintField(2, 12n),
      makeLengthDelimitedField(77, Buffer.from("extra-payload", "utf8")),
    ]),
    "Initial Off-Topic Title",
  );
  const idleRawSummary = patchCascadeSummaryTitle(Buffer.alloc(0), "Idle Remote Host Chat");
  const subRawSummary = patchCascadeSummaryTitle(Buffer.alloc(0), "Subagent Task");

  const dbPath = path.join(dataDir, "conversation_summaries.db");
  const db = new DatabaseSync(dbPath, { readBigInts: true });
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE conversation_summaries (
      conversation_id text PRIMARY KEY,
      title text NOT NULL DEFAULT "",
      preview text NOT NULL DEFAULT "",
      step_count integer NOT NULL DEFAULT 0,
      last_modified_time datetime NOT NULL,
      workspace_uris text NOT NULL,
      status text NOT NULL DEFAULT "",
      source text NOT NULL DEFAULT "",
      project_id text NOT NULL DEFAULT "",
      agent_name text NOT NULL DEFAULT "",
      parent_conversation_id text NOT NULL DEFAULT "",
      nesting_depth integer NOT NULL DEFAULT 0,
      battle_id text NOT NULL DEFAULT "",
      winning_conversation_id text NOT NULL DEFAULT "",
      not_fully_idle numeric NOT NULL DEFAULT false,
      killed numeric NOT NULL DEFAULT false,
      last_user_input_time datetime NOT NULL,
      last_user_input_step_index integer NOT NULL DEFAULT -1,
      app_data_dir text NOT NULL DEFAULT "",
      raw_summary blob,
      group_id text NOT NULL DEFAULT ""
    );
    CREATE VIRTUAL TABLE conversations_fts USING fts5(
      conversation_id UNINDEXED,
      chunk_index UNINDEXED,
      chunk_first_step UNINDEXED,
      chunk_last_step UNINDEXED,
      last_modified_time UNINDEXED,
      step_count UNINDEXED,
      last_step_created_at UNINDEXED,
      archived UNINDEXED,
      user_step_byte_offsets UNINDEXED,
      agent_step_byte_offsets UNINDEXED,
      title,
      workspace,
      project,
      user_body,
      agent_body
    );
  `);

  db.prepare(
    `INSERT INTO conversation_summaries (
       conversation_id, title, preview, step_count, last_modified_time, workspace_uris,
       status, parent_conversation_id, not_fully_idle, killed,
       last_user_input_time, last_user_input_step_index, app_data_dir, raw_summary
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    convId,
    "Initial Off-Topic Title",
    "Initial Off-Topic Title",
    12,
    "2026-11-23 05:10:00.000000+00:00",
    '["file:///path/to/workspace"]',
    "CASCADE_RUN_STATUS_RUNNING",
    "",
    1,
    0,
    "2026-11-23 05:09:00.000000+00:00",
    10,
    "antigravity",
    rawSummary,
  );

  db.prepare(
    `INSERT INTO conversation_summaries (
       conversation_id, title, preview, step_count, last_modified_time, workspace_uris,
       status, project_id, parent_conversation_id, not_fully_idle, killed,
       last_user_input_time, last_user_input_step_index, app_data_dir, raw_summary
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    idleConvId,
    "Idle Remote Host Chat",
    "Idle Remote Host Chat",
    6,
    "2026-11-23 05:05:00.000000+00:00",
    '["file:///path/to/%E8%BF%9C%E7%A8%8B%E4%B8%BB%E6%9C%BA"]',
    "CASCADE_RUN_STATUS_IDLE",
    "proj-remote-host",
    "",
    0,
    0,
    "2026-11-23 05:04:00.000000+00:00",
    4,
    "antigravity",
    idleRawSummary,
  );

  db.prepare(
    `INSERT INTO conversation_summaries (
       conversation_id, title, preview, step_count, last_modified_time, workspace_uris,
       status, parent_conversation_id, not_fully_idle, killed,
       last_user_input_time, last_user_input_step_index, app_data_dir, raw_summary
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    subagentConvId,
    "Subagent Task",
    "Subagent Task",
    4,
    "2026-11-23 05:11:00.000000+00:00",
    '["file:///path/to/workspace"]',
    "CASCADE_RUN_STATUS_IDLE",
    convId,
    0,
    0,
    "2026-11-23 05:11:00.000000+00:00",
    2,
    "antigravity",
    subRawSummary,
  );

  // 故意插入超出 JS Number.MAX_SAFE_INTEGER 的纳秒时间戳，验证 readBigInts 处理正确
  const hugeNanoTs = 1795410728249838000n;
  db.prepare(
    `INSERT INTO conversations_fts (
       conversation_id, chunk_index, chunk_first_step, chunk_last_step,
       last_modified_time, step_count, last_step_created_at, archived,
       user_step_byte_offsets, agent_step_byte_offsets,
       title, workspace, project, user_body, agent_body
     ) VALUES (?, -1, 0, 0, ?, 12, ?, 0, ?, ?, ?, 'Antigravity', 'Antigravity', '', '')`,
  ).run(convId, hugeNanoTs, hugeNanoTs, Buffer.alloc(0), Buffer.alloc(0), "Initial Off-Topic Title");

  db.prepare(
    `INSERT INTO conversations_fts (
       conversation_id, chunk_index, chunk_first_step, chunk_last_step,
       last_modified_time, step_count, last_step_created_at, archived,
       user_step_byte_offsets, agent_step_byte_offsets,
       title, workspace, project, user_body, agent_body
     ) VALUES (?, 0, 0, 11, 0, 0, 0, 0, ?, ?, '', '', '', 'user body content', 'agent body content')`,
  ).run(convId, Buffer.alloc(0), Buffer.alloc(0));
  db.close();

  const cacheEntry = makeLengthDelimitedField(
    1,
    Buffer.concat([
      makeLengthDelimitedField(1, Buffer.from(convId, "utf8")),
      makeLengthDelimitedField(2, rawSummary),
    ]),
  );
  fs.writeFileSync(path.join(dataDir, "agyhub_summaries_proto.pb"), cacheEntry);

  return {
    dataDir,
    convId,
    idleConvId,
    subagentConvId,
    cleanup: () => fs.rmSync(dataDir, { recursive: true, force: true }),
  };
}

test("Stdio MCP Server 端到端链路测试（list -> get -> rename -> 幂等校验）", async () => {
  const sandbox = createSandboxAntigravityDir();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [DIST_INDEX_PATH],
    env: {
      ...process.env,
      ANTIGRAVITY_DATA_DIR: sandbox.dataDir,
    },
  });
  const client = new Client({ name: "e2e-test-client", version: "1.0.0" });

  try {
    await client.connect(transport);

    const listedTools = await client.listTools();
    const toolNames = listedTools.tools.map((t) => t.name).sort();
    assert.deepEqual(toolNames, [
      "get_conversation_title",
      "list_recent_conversations",
      "rename_conversation",
    ]);

    // 1. list_recent_conversations（默认过滤子代理，返回工作区路径与 projectId）
    const listRes = await client.callTool({
      name: "list_recent_conversations",
      arguments: { limit: 10 },
    });
    const listText = (listRes.content as Array<{ type: string; text: string }>)[0].text;
    const listJson = JSON.parse(listText);
    assert.equal(listJson.count, 2);
    assert.equal(listJson.conversations[0].conversationId, sandbox.convId);
    assert.deepEqual(listJson.conversations[0].workspacePaths, ["/path/to/workspace"]);

    // 1b. list_recent_conversations 按中文工作区名过滤（兼容 URL 编码 URI）
    const filteredRes = await client.callTool({
      name: "list_recent_conversations",
      arguments: { limit: 10, workspace: "远程主机" },
    });
    const filteredJson = JSON.parse(
      (filteredRes.content as Array<{ type: string; text: string }>)[0].text,
    );
    assert.equal(filteredJson.count, 1);
    assert.equal(filteredJson.conversations[0].conversationId, sandbox.idleConvId);
    assert.equal(filteredJson.conversations[0].projectId, "proj-remote-host");
    assert.deepEqual(filteredJson.conversations[0].workspacePaths, ["/path/to/远程主机"]);

    // 2. get_conversation_title
    const getRes = await client.callTool({
      name: "get_conversation_title",
      arguments: { conversation_id: sandbox.convId },
    });
    const getJson = JSON.parse((getRes.content as Array<{ type: string; text: string }>)[0].text);
    assert.equal(getJson.dbTitle, "Initial Off-Topic Title");
    assert.equal(getJson.pbtxtTitle, "Initial Off-Topic Title");
    assert.equal(getJson.inSync, true);

    // 3. rename_conversation（带多余换行和空格测试自动清洗）
    const renameRes = await client.callTool({
      name: "rename_conversation",
      arguments: {
        conversation_id: sandbox.convId,
        new_title: "  重构 SQLite   同步模块\n与缓存测试 ",
        reason: "话题已转向数据库重构",
      },
    });
    assert.equal(renameRes.isError ?? false, false);
    const renameJson = JSON.parse(
      (renameRes.content as Array<{ type: string; text: string }>)[0].text,
    );
    assert.equal(renameJson.changed, true);
    assert.equal(renameJson.uiRefreshHint, "active_live_sync");
    assert.equal(renameJson.oldTitle, "Initial Off-Topic Title");
    assert.equal(renameJson.newTitle, "重构 SQLite 同步模块 与缓存测试");
    assert.deepEqual(renameJson.updatedTargets, {
      pbtxt: true,
      sqliteSummaries: true,
      sqliteFts: true,
      protoCache: true,
    });

    // 4. 验证磁盘全部 4 处落盘状态
    const paths = resolveAntigravityPaths(sandbox.dataDir);
    assert.equal(
      readPbtxtTitle(path.join(paths.annotationsDir, `${sandbox.convId}.pbtxt`)),
      "重构 SQLite 同步模块 与缓存测试",
    );

    const db = new DatabaseSync(paths.summariesDbPath, { readOnly: true, readBigInts: true });
    const row = db
      .prepare("SELECT title, preview, step_count, raw_summary FROM conversation_summaries WHERE conversation_id = ?")
      .get(sandbox.convId) as Record<string, unknown>;
    assert.equal(row.title, "重构 SQLite 同步模块 与缓存测试");
    assert.equal(row.preview, "重构 SQLite 同步模块 与缓存测试");
    assert.equal(row.step_count, 12n); // 未破坏运行时字段
    const rawBuf = Buffer.from(row.raw_summary as Uint8Array);
    assert.deepEqual(extractSummaryTitles(rawBuf), {
      summaryField1: "重构 SQLite 同步模块 与缓存测试",
      annotationField15_1: "重构 SQLite 同步模块 与缓存测试",
    });
    // 未知字段 77 完好保留
    assert.ok(
      parseProtoFields(rawBuf).some(
        (f) => f.fieldNumber === 77 && f.payload?.toString("utf8") === "extra-payload",
      ),
    );

    const ftsHit = db
      .prepare("SELECT conversation_id, title, last_modified_time FROM conversations_fts WHERE conversations_fts MATCH 'SQLite'")
      .get() as Record<string, unknown>;
    assert.equal(ftsHit.conversation_id, sandbox.convId);
    assert.equal(ftsHit.title, "重构 SQLite 同步模块 与缓存测试");
    assert.equal(ftsHit.last_modified_time, 1795410728249838000n); // 64-bit 纳秒时间戳零精度丢失

    const bodyChunk = db
      .prepare("SELECT user_body FROM conversations_fts WHERE conversation_id = ? AND chunk_index = 0")
      .get(sandbox.convId) as Record<string, unknown>;
    assert.equal(bodyChunk.user_body, "user body content");
    db.close();

    // 验证 agyhub_summaries_proto.pb 已更新
    const cacheFields = parseProtoFields(fs.readFileSync(paths.summariesProtoCachePath));
    const cacheSub = parseProtoFields(cacheFields[0].payload!);
    assert.equal(
      extractSummaryTitles(cacheSub[1].payload!).summaryField1,
      "重构 SQLite 同步模块 与缓存测试",
    );

    // 5. 重复改同名 -> 幂等返回 changed: false
    const repeatRes = await client.callTool({
      name: "rename_conversation",
      arguments: {
        conversation_id: sandbox.convId,
        new_title: "重构 SQLite 同步模块 与缓存测试",
      },
    });
    const repeatJson = JSON.parse(
      (repeatRes.content as Array<{ type: string; text: string }>)[0].text,
    );
    assert.equal(repeatJson.changed, false);
    assert.equal(repeatJson.uiRefreshHint, "unchanged");

    // 6. 重命名历史空闲对话 -> 返回 idle_restart_required
    const idleRenameRes = await client.callTool({
      name: "rename_conversation",
      arguments: {
        conversation_id: sandbox.idleConvId,
        new_title: "远程主机整理归档",
      },
    });
    const idleRenameJson = JSON.parse(
      (idleRenameRes.content as Array<{ type: string; text: string }>)[0].text,
    );
    assert.equal(idleRenameJson.changed, true);
    assert.equal(idleRenameJson.uiRefreshHint, "idle_restart_required");
  } finally {
    await client.close();
    sandbox.cleanup();
  }
});
