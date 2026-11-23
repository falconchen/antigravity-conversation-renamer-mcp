export interface ProtoFieldChunk {
  fieldNumber: number;
  wireType: number;
  raw: Buffer;
  payload?: Buffer;
}

/**
 * 编码无符号 Protobuf varint。
 */
export function encodeVarint(value: number | bigint): Buffer {
  let v = typeof value === "bigint" ? value : BigInt(value);
  if (v < 0n) {
    v = BigInt.asUintN(64, v);
  }
  const bytes: number[] = [];
  while (v >= 0x80n) {
    bytes.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  bytes.push(Number(v));
  return Buffer.from(bytes);
}

/**
 * 从指定偏移量读取 varint。
 */
export function readVarint(buf: Buffer, offset: number): { value: bigint; nextOffset: number } | null {
  let result = 0n;
  let shift = 0n;
  let pos = offset;
  while (pos < buf.length && shift < 64n) {
    const b = buf[pos++];
    result |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) {
      return { value: result, nextOffset: pos };
    }
    shift += 7n;
  }
  return null;
}

/**
 * 将二进制 Protobuf Wire 流解析为保留原始字节的字段片段列表。
 */
export function parseProtoFields(buf: Buffer): ProtoFieldChunk[] {
  const fields: ProtoFieldChunk[] = [];
  let pos = 0;

  while (pos < buf.length) {
    const start = pos;
    const tag = readVarint(buf, pos);
    if (!tag || tag.value === 0n) {
      throw new Error(`Protobuf Wire 解析失败：位置 ${start} 处的 tag 非法`);
    }
    pos = tag.nextOffset;
    const fieldNumber = Number(tag.value >> 3n);
    const wireType = Number(tag.value & 7n);
    if (fieldNumber <= 0) {
      throw new Error(`Protobuf Wire 解析失败：字段编号非法 (${fieldNumber})`);
    }

    switch (wireType) {
      case 0: {
        const val = readVarint(buf, pos);
        if (!val) {
          throw new Error(`Protobuf Wire 解析失败：字段 ${fieldNumber} 的 varint 截断`);
        }
        pos = val.nextOffset;
        fields.push({ fieldNumber, wireType, raw: buf.subarray(start, pos) });
        break;
      }
      case 1: {
        if (pos + 8 > buf.length) {
          throw new Error(`Protobuf Wire 解析失败：字段 ${fieldNumber} 的 64-bit 数据截断`);
        }
        pos += 8;
        fields.push({ fieldNumber, wireType, raw: buf.subarray(start, pos) });
        break;
      }
      case 2: {
        const lenRes = readVarint(buf, pos);
        if (!lenRes) {
          throw new Error(`Protobuf Wire 解析失败：字段 ${fieldNumber} 的长度前缀截断`);
        }
        pos = lenRes.nextOffset;
        const len = Number(lenRes.value);
        if (!Number.isSafeInteger(len) || len < 0 || pos + len > buf.length) {
          throw new Error(`Protobuf Wire 解析失败：字段 ${fieldNumber} 的长度越界 (${len})`);
        }
        const payload = buf.subarray(pos, pos + len);
        pos += len;
        fields.push({ fieldNumber, wireType, payload, raw: buf.subarray(start, pos) });
        break;
      }
      case 5: {
        if (pos + 4 > buf.length) {
          throw new Error(`Protobuf Wire 解析失败：字段 ${fieldNumber} 的 32-bit 数据截断`);
        }
        pos += 4;
        fields.push({ fieldNumber, wireType, raw: buf.subarray(start, pos) });
        break;
      }
      default:
        throw new Error(`Protobuf Wire 解析失败：不支持的 wireType ${wireType}（字段 ${fieldNumber}）`);
    }
  }

  return fields;
}

/**
 * 校验缓冲区是否为合法完整的 Protobuf Wire 编码流。
 */
export function validateWireFormat(buf: Buffer): boolean {
  try {
    parseProtoFields(buf);
    return true;
  } catch {
    return false;
  }
}

export function makeVarintField(fieldNumber: number, value: number | bigint): Buffer {
  const tag = encodeVarint((BigInt(fieldNumber) << 3n) | 0n);
  return Buffer.concat([tag, encodeVarint(value)]);
}

export function makeLengthDelimitedField(fieldNumber: number, payload: Buffer): Buffer {
  const tag = encodeVarint((BigInt(fieldNumber) << 3n) | 2n);
  const len = encodeVarint(payload.length);
  return Buffer.concat([tag, len, payload]);
}

function makeTimestampPayload(date: Date): Buffer {
  const ms = date.getTime();
  const seconds = Math.floor(ms / 1000);
  const nanos = Math.max(0, Math.round((ms - seconds * 1000) * 1_000_000));
  const parts: Buffer[] = [makeVarintField(1, BigInt(seconds))];
  if (nanos > 0) {
    parts.push(makeVarintField(2, BigInt(nanos)));
  }
  return Buffer.concat(parts);
}

/**
 * 提取 CascadeTrajectorySummary 中的顶层字段 1（summary）和字段 15.1（annotations.title）。
 */
export function extractSummaryTitles(rawSummary: Buffer): {
  summaryField1: string | null;
  annotationField15_1: string | null;
} {
  if (rawSummary.length === 0) {
    return { summaryField1: null, annotationField15_1: null };
  }
  const fields = parseProtoFields(rawSummary);
  let summaryField1: string | null = null;
  let annotationField15_1: string | null = null;

  for (const field of fields) {
    if (field.fieldNumber === 1 && field.wireType === 2 && field.payload) {
      summaryField1 = field.payload.toString("utf8");
    } else if (field.fieldNumber === 15 && field.wireType === 2 && field.payload) {
      const subFields = parseProtoFields(field.payload);
      for (const sub of subFields) {
        if (sub.fieldNumber === 1 && sub.wireType === 2 && sub.payload) {
          annotationField15_1 = sub.payload.toString("utf8");
        }
      }
    }
  }

  return { summaryField1, annotationField15_1 };
}

/**
 * 无损修改 CascadeTrajectorySummary（raw_summary）中的标题：
 * - 更新顶层字段 1（summary）
 * - 更新字段 15（annotations）内的子字段 1（title），完整保留 15.7 及所有未知子字段
 * - 完整保留所有其他顶层字段的原始字节
 */
export function patchCascadeSummaryTitle(
  rawSummary: Buffer,
  newTitle: string,
  nowDate: Date = new Date(),
): Buffer {
  const titleBuf = Buffer.from(newTitle, "utf8");
  const fields = rawSummary.length > 0 ? parseProtoFields(rawSummary) : [];

  let replacedField1 = false;
  let replacedField15 = false;
  const outputChunks: Buffer[] = [];

  for (const field of fields) {
    if (field.fieldNumber === 1 && field.wireType === 2) {
      if (!replacedField1) {
        outputChunks.push(makeLengthDelimitedField(1, titleBuf));
        replacedField1 = true;
      }
      continue;
    }

    if (field.fieldNumber === 15 && field.wireType === 2 && field.payload) {
      if (!replacedField15) {
        const subFields = parseProtoFields(field.payload);
        let replacedSub1 = false;
        const subChunks: Buffer[] = [];
        for (const sub of subFields) {
          if (sub.fieldNumber === 1 && sub.wireType === 2) {
            if (!replacedSub1) {
              subChunks.push(makeLengthDelimitedField(1, titleBuf));
              replacedSub1 = true;
            }
          } else {
            subChunks.push(sub.raw);
          }
        }
        if (!replacedSub1) {
          subChunks.unshift(makeLengthDelimitedField(1, titleBuf));
        }
        outputChunks.push(makeLengthDelimitedField(15, Buffer.concat(subChunks)));
        replacedField15 = true;
      }
      continue;
    }

    outputChunks.push(field.raw);
  }

  if (!replacedField1) {
    outputChunks.unshift(makeLengthDelimitedField(1, titleBuf));
  }

  if (!replacedField15) {
    const annPayload = Buffer.concat([
      makeLengthDelimitedField(1, titleBuf),
      makeLengthDelimitedField(7, makeTimestampPayload(nowDate)),
    ]);
    outputChunks.push(makeLengthDelimitedField(15, annPayload));
  }

  const patched = Buffer.concat(outputChunks);
  if (!validateWireFormat(patched)) {
    throw new Error("补丁后的 raw_summary 未通过 Protobuf Wire 格式校验");
  }
  return patched;
}

/**
 * 无损局部更新 agyhub_summaries_proto.pb 中指定 conversationId 对应的 raw_summary 条目。
 */
export function patchSummariesProtoCache(
  cacheBuf: Buffer,
  conversationId: string,
  patchedRawSummary: Buffer,
): { buffer: Buffer; updated: boolean } {
  const res = patchSummariesProtoCacheBatch(
    cacheBuf,
    new Map([[conversationId, patchedRawSummary]]),
  );
  return { buffer: res.buffer, updated: res.updatedCount > 0 };
}

/**
 * 单次扫描无损批量更新 agyhub_summaries_proto.pb 中多个 conversationId 对应的 raw_summary 条目。
 */
export function patchSummariesProtoCacheBatch(
  cacheBuf: Buffer,
  patchedByConvId: ReadonlyMap<string, Buffer>,
): { buffer: Buffer; updatedCount: number } {
  if (patchedByConvId.size === 0) {
    return { buffer: cacheBuf, updatedCount: 0 };
  }
  const fields = parseProtoFields(cacheBuf);
  let updatedCount = 0;
  const outputChunks: Buffer[] = [];

  for (const field of fields) {
    if (field.fieldNumber === 1 && field.wireType === 2 && field.payload) {
      const subFields = parseProtoFields(field.payload);
      const idChunk = subFields.find((s) => s.fieldNumber === 1 && s.wireType === 2 && s.payload);
      const convId = idChunk?.payload?.toString("utf8");
      const replacement = convId ? patchedByConvId.get(convId) : undefined;
      if (replacement) {
        let replacedSummary = false;
        const newSubChunks: Buffer[] = [];
        for (const sub of subFields) {
          if (sub.fieldNumber === 2 && sub.wireType === 2) {
            if (!replacedSummary) {
              newSubChunks.push(makeLengthDelimitedField(2, replacement));
              replacedSummary = true;
            }
          } else {
            newSubChunks.push(sub.raw);
          }
        }
        if (!replacedSummary) {
          newSubChunks.push(makeLengthDelimitedField(2, replacement));
        }
        outputChunks.push(makeLengthDelimitedField(1, Buffer.concat(newSubChunks)));
        updatedCount++;
        continue;
      }
    }
    outputChunks.push(field.raw);
  }

  const result = Buffer.concat(outputChunks);
  if (!validateWireFormat(result)) {
    throw new Error("补丁后的 agyhub_summaries_proto.pb 未通过 Protobuf Wire 格式校验");
  }
  return { buffer: result, updatedCount };
}
