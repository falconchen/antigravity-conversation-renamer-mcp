import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  parsePbtxtTitle,
  patchPbtxtContent,
  readPbtxtTitle,
  unescapePbtxtString,
  writePbtxtTitleAtomic,
} from "../src/pbtxtPatcher.js";

test("patchPbtxtContent 原地替换标题并保留其他字段与转义字符", () => {
  const raw = 'title:"Old \\"Quoted\\" Title" last_user_view_time:{seconds:1795410613 nanos:39000000} pinned:true';
  assert.equal(parsePbtxtTitle(raw), 'Old "Quoted" Title');

  const updated = patchPbtxtContent(raw, '修复 "路径\\转义" 问题');
  assert.ok(updated.includes("last_user_view_time:{seconds:1795410613 nanos:39000000}"));
  assert.ok(updated.includes("pinned:true"));
  assert.equal(parsePbtxtTitle(updated), '修复 "路径\\转义" 问题');
});

test("unescapePbtxtString 兼容八进制 UTF-8 字节转义", () => {
  // "中文" 的 UTF-8 八进制转义
  assert.equal(unescapePbtxtString("\\344\\270\\255\\346\\226\\207"), "中文");
});

test("writePbtxtTitleAtomic 在文件不存在时创建并原子覆盖", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pbtxt-test-"));
  try {
    const filePath = path.join(tmpDir, "annotations", "test-conv.pbtxt");
    const first = writePbtxtTitleAtomic(filePath, "初始标题");
    assert.equal(first.created, true);
    assert.equal(first.oldTitle, null);
    assert.equal(readPbtxtTitle(filePath), "初始标题");

    const second = writePbtxtTitleAtomic(filePath, "更新后的标题");
    assert.equal(second.created, false);
    assert.equal(second.oldTitle, "初始标题");
    assert.equal(readPbtxtTitle(filePath), "更新后的标题");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
