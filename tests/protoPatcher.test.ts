import assert from "node:assert/strict";
import test from "node:test";
import {
  encodeVarint,
  extractSummaryTitles,
  makeLengthDelimitedField,
  makeVarintField,
  parseProtoFields,
  patchCascadeSummaryTitle,
  patchSummariesProtoCache,
  validateWireFormat,
} from "../src/protoPatcher.js";

test("patchCascadeSummaryTitle 无损更新字段 1 与字段 15.1 并保留未知字段", () => {
  const tsPayload = Buffer.concat([makeVarintField(1, 1795410613n), makeVarintField(2, 39000000n)]);
  const unknownSubField = makeVarintField(99, 123456n);
  const annPayload = Buffer.concat([
    makeLengthDelimitedField(1, Buffer.from("Initial Title", "utf8")),
    makeLengthDelimitedField(7, tsPayload),
    unknownSubField,
  ]);
  const unknownTopField = makeLengthDelimitedField(77, Buffer.from("keep-me-intact", "utf8"));
  const fixed32TagAndVal = Buffer.concat([
    encodeVarint((88 << 3) | 5),
    Buffer.from([0x01, 0x02, 0x03, 0x04]),
  ]);

  const original = Buffer.concat([
    makeLengthDelimitedField(1, Buffer.from("Initial Title", "utf8")),
    makeVarintField(2, 42n),
    makeLengthDelimitedField(15, annPayload),
    unknownTopField,
    fixed32TagAndVal,
  ]);

  const patched = patchCascadeSummaryTitle(original, "重命名后的新标题 🚀");
  assert.equal(validateWireFormat(patched), true);

  const titles = extractSummaryTitles(patched);
  assert.equal(titles.summaryField1, "重命名后的新标题 🚀");
  assert.equal(titles.annotationField15_1, "重命名后的新标题 🚀");

  const topFields = parseProtoFields(patched);
  assert.ok(topFields.some((f) => f.fieldNumber === 2 && f.wireType === 0));
  assert.ok(
    topFields.some(
      (f) => f.fieldNumber === 77 && f.payload?.toString("utf8") === "keep-me-intact",
    ),
  );
  assert.ok(topFields.some((f) => f.fieldNumber === 88 && f.wireType === 5));

  const field15 = topFields.find((f) => f.fieldNumber === 15);
  assert.ok(field15?.payload);
  const subFields = parseProtoFields(field15.payload);
  assert.ok(subFields.some((sf) => sf.fieldNumber === 7 && sf.payload?.equals(tsPayload)));
  assert.ok(subFields.some((sf) => sf.fieldNumber === 99 && sf.raw.equals(unknownSubField)));
});

test("patchCascadeSummaryTitle 在缺失字段 1 和字段 15 时自动补全", () => {
  const original = Buffer.concat([makeVarintField(2, 10n), makeVarintField(28, 4n)]);
  const patched = patchCascadeSummaryTitle(original, "全新补全标题", new Date("2026-11-23T05:00:00Z"));
  assert.equal(validateWireFormat(patched), true);

  const titles = extractSummaryTitles(patched);
  assert.equal(titles.summaryField1, "全新补全标题");
  assert.equal(titles.annotationField15_1, "全新补全标题");
});

test("patchSummariesProtoCache 仅替换目标会话条目并保留其余条目", () => {
  const convA = "aaaaaaaa-1111-2222-3333-444444444444";
  const convB = "bbbbbbbb-1111-2222-3333-444444444444";
  const summaryA = patchCascadeSummaryTitle(Buffer.alloc(0), "Old A");
  const summaryB = patchCascadeSummaryTitle(Buffer.alloc(0), "Old B");
  const newSummaryA = patchCascadeSummaryTitle(summaryA, "New A");

  const entryA = makeLengthDelimitedField(
    1,
    Buffer.concat([
      makeLengthDelimitedField(1, Buffer.from(convA, "utf8")),
      makeLengthDelimitedField(2, summaryA),
    ]),
  );
  const entryB = makeLengthDelimitedField(
    1,
    Buffer.concat([
      makeLengthDelimitedField(1, Buffer.from(convB, "utf8")),
      makeLengthDelimitedField(2, summaryB),
    ]),
  );
  const tsEntry = makeLengthDelimitedField(
    2,
    Buffer.concat([
      makeLengthDelimitedField(1, Buffer.from(convA, "utf8")),
      makeVarintField(2, 1795410613n),
    ]),
  );

  const cache = Buffer.concat([entryA, entryB, tsEntry]);
  const res = patchSummariesProtoCache(cache, convA, newSummaryA);
  assert.equal(res.updated, true);
  assert.equal(validateWireFormat(res.buffer), true);

  const fields = parseProtoFields(res.buffer);
  assert.equal(fields.length, 3);
  const subA = parseProtoFields(fields[0].payload!);
  const subB = parseProtoFields(fields[1].payload!);
  assert.equal(extractSummaryTitles(subA[1].payload!).summaryField1, "New A");
  assert.equal(extractSummaryTitles(subB[1].payload!).summaryField1, "Old B");
  assert.equal(fields[2].raw.equals(tsEntry), true);
});
