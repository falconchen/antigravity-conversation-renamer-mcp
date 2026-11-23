import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { resolveAntigravityPaths } from "../src/paths.js";
import {
  extractSummaryTitles,
  makeLengthDelimitedField,
  makeVarintField,
  parseProtoFields,
  patchCascadeSummaryTitle,
} from "../src/protoPatcher.js";
import { syncAllPbtxtToStore } from "../src/syncPbtxt.js";

test("syncAllPbtxtToStore 将被退出钩子覆写回旧标题的历史对话按 .pbtxt 批量无损恢复", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-sync-pbtxt-"));
  const conv1 = "aaaaaaaa-1111-2222-3333-444444444444";
  const conv2 = "bbbbbbbb-1111-2222-3333-444444444444";

  try {
    const paths = resolveAntigravityPaths(dataDir);
    fs.mkdirSync(paths.annotationsDir, { recursive: true });

    // 模拟 .pbtxt 保留着新标题，但 SQLite 与 Proto 缓存被旧进程退出覆写回旧标题
    fs.writeFileSync(
      path.join(paths.annotationsDir, `${conv1}.pbtxt`),
      'title:"ivm1 限速加固与 ACL 拦截前移" last_user_view_time:{seconds:1795404793 nanos:0}',
      "utf8",
    );
    fs.writeFileSync(
      path.join(paths.annotationsDir, `${conv2}.pbtxt`),
      'title:"已一致的标题" last_user_view_time:{seconds:1795400000 nanos:0}',
      "utf8",
    );

    const oldRaw1 = patchCascadeSummaryTitle(
      Buffer.concat([
        makeVarintField(2, 127n),
        makeLengthDelimitedField(77, Buffer.from("preserve-unknown", "utf8")),
      ]),
      "复查ivm1限速",
    );
    const sameRaw2 = Buffer.concat([
      makeLengthDelimitedField(1, Buffer.from("首条提问预览内容", "utf8")),
      makeVarintField(2, 10n),
      makeLengthDelimitedField(15, makeLengthDelimitedField(1, Buffer.from("已一致的标题", "utf8"))),
    ]);

    const db = new DatabaseSync(paths.summariesDbPath, { readBigInts: true });
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
        parent_conversation_id text NOT NULL DEFAULT "",
        not_fully_idle numeric NOT NULL DEFAULT false,
        killed numeric NOT NULL DEFAULT false,
        last_user_input_time datetime NOT NULL,
        last_user_input_step_index integer NOT NULL DEFAULT -1,
        raw_summary blob
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

    const ins = db.prepare(
      `INSERT INTO conversation_summaries (
         conversation_id, title, preview, step_count, last_modified_time, workspace_uris,
         status, parent_conversation_id, not_fully_idle, killed,
         last_user_input_time, last_user_input_step_index, raw_summary
       ) VALUES (?, ?, ?, ?, ?, ?, ?, '', 0, 0, ?, 1, ?)`,
    );
    ins.run(conv1, "复查ivm1限速", "复查ivm1限速", 127, "2026-11-23 02:54:53+00:00", "[]", "CASCADE_RUN_STATUS_IDLE", "2026-11-23 02:50:00+00:00", oldRaw1);
    ins.run(conv2, "已一致的标题", "首条提问预览内容", 10, "2026-11-23 01:00:00+00:00", "[]", "CASCADE_RUN_STATUS_IDLE", "2026-11-23 01:00:00+00:00", sameRaw2);

    db.prepare(
      `INSERT INTO conversations_fts (
         conversation_id, chunk_index, chunk_first_step, chunk_last_step,
         last_modified_time, step_count, last_step_created_at, archived,
         user_step_byte_offsets, agent_step_byte_offsets,
         title, workspace, project, user_body, agent_body
       ) VALUES (?, -1, 0, 0, ?, 127, ?, 0, ?, ?, ?, '远程主机', '远程主机', '', '')`,
    ).run(conv1, 1795404793000000000n, 1795404793000000000n, Buffer.alloc(0), Buffer.alloc(0), "复查ivm1限速");
    db.close();

    const cacheBuf = Buffer.concat([
      makeLengthDelimitedField(
        1,
        Buffer.concat([
          makeLengthDelimitedField(1, Buffer.from(conv1, "utf8")),
          makeLengthDelimitedField(2, oldRaw1),
        ]),
      ),
      makeLengthDelimitedField(
        1,
        Buffer.concat([
          makeLengthDelimitedField(1, Buffer.from(conv2, "utf8")),
          makeLengthDelimitedField(2, sameRaw2),
        ]),
      ),
    ]);
    fs.writeFileSync(paths.summariesProtoCachePath, cacheBuf);

    // 1. dryRun 仅报告差异，不修改磁盘
    const dryRes = syncAllPbtxtToStore({ paths, dryRun: true });
    assert.equal(dryRes.pendingCount, 1);
    assert.equal(dryRes.syncedCount, 0);
    assert.equal(dryRes.items[0].conversationId, conv1);
    assert.equal(dryRes.items[0].pbtxtTitle, "ivm1 限速加固与 ACL 拦截前移");

    // 2. 正式冷同步
    const syncRes = syncAllPbtxtToStore({ paths, dryRun: false, checkpointWal: true });
    assert.equal(syncRes.syncedCount, 1);
    assert.equal(syncRes.ftsUpdatedCount, 1);
    assert.equal(syncRes.protoCacheUpdatedCount, 1);

    // 3. 验证 SQLite、未知 Protobuf 字段、FTS5 与 Proto 缓存全部恢复
    const verifyDb = new DatabaseSync(paths.summariesDbPath, { readOnly: true, readBigInts: true });
    const row1 = verifyDb
      .prepare("SELECT title, preview, raw_summary FROM conversation_summaries WHERE conversation_id = ?")
      .get(conv1) as Record<string, unknown>;
    assert.equal(row1.title, "ivm1 限速加固与 ACL 拦截前移");
    assert.equal(row1.preview, "ivm1 限速加固与 ACL 拦截前移");
    const raw1 = Buffer.from(row1.raw_summary as Uint8Array);
    assert.deepEqual(extractSummaryTitles(raw1), {
      summaryField1: "ivm1 限速加固与 ACL 拦截前移",
      annotationField15_1: "ivm1 限速加固与 ACL 拦截前移",
    });
    assert.ok(
      parseProtoFields(raw1).some(
        (f) => f.fieldNumber === 77 && f.payload?.toString("utf8") === "preserve-unknown",
      ),
    );
    const ftsHit = verifyDb
      .prepare("SELECT conversation_id, title FROM conversations_fts WHERE conversations_fts MATCH 'ACL'")
      .get() as Record<string, unknown>;
    assert.equal(ftsHit.conversation_id, conv1);
    verifyDb.close();

    const updatedCacheFields = parseProtoFields(fs.readFileSync(paths.summariesProtoCachePath));
    const sub1 = parseProtoFields(updatedCacheFields[0].payload!);
    assert.equal(
      extractSummaryTitles(sub1[1].payload!).summaryField1,
      "ivm1 限速加固与 ACL 拦截前移",
    );

    // 4. 再次 dryRun 应为 0 待同步（幂等）
    const afterRes = syncAllPbtxtToStore({ paths, dryRun: true });
    assert.equal(afterRes.pendingCount, 0);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
