import fs from "node:fs";
import path from "node:path";

const TITLE_FIELD_RE = /\btitle\s*:\s*"((?:\\.|[^"\\])*)"/;

/**
 * 将标题转义为 Protobuf Text Format 字符串内容（不含外层双引号）。
 */
export function escapePbtxtString(title: string): string {
  return title
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r/g, "")
    .replace(/\n/g, " ");
}

/**
 * 反转义 Protobuf Text Format 字符串，兼容标准转义与八进制 UTF-8 字节转义。
 */
export function unescapePbtxtString(escaped: string): string {
  const bytes: number[] = [];
  let i = 0;

  while (i < escaped.length) {
    const ch = escaped[i];
    if (ch === "\\" && i + 1 < escaped.length) {
      const next = escaped[i + 1];
      if (/[0-7]/.test(next)) {
        let oct = next;
        let advance = 2;
        while (advance < 4 && i + advance < escaped.length && /[0-7]/.test(escaped[i + advance])) {
          oct += escaped[i + advance];
          advance++;
        }
        bytes.push(parseInt(oct, 8) & 0xff);
        i += advance;
        continue;
      }
      if (next === "x" && i + 3 < escaped.length && /^[0-9a-fA-F]{2}$/.test(escaped.slice(i + 2, i + 4))) {
        bytes.push(parseInt(escaped.slice(i + 2, i + 4), 16));
        i += 4;
        continue;
      }
      const simpleMap: Record<string, string> = {
        "\\": "\\",
        '"': '"',
        "'": "'",
        n: "\n",
        r: "\r",
        t: "\t",
      };
      const mapped = simpleMap[next] ?? next;
      for (const b of Buffer.from(mapped, "utf8")) {
        bytes.push(b);
      }
      i += 2;
      continue;
    }

    for (const b of Buffer.from(ch, "utf8")) {
      bytes.push(b);
    }
    i++;
  }

  return Buffer.from(bytes).toString("utf8");
}

/**
 * 从 .pbtxt 内容中提取 title 字段。
 */
export function parsePbtxtTitle(content: string): string | null {
  const match = TITLE_FIELD_RE.exec(content);
  if (!match) return null;
  return unescapePbtxtString(match[1]);
}

/**
 * 无损改写 .pbtxt 内容中的 title 字段，保留 last_user_view_time 及其他未知字段。
 */
export function patchPbtxtContent(
  existingContent: string | null,
  newTitle: string,
  nowDate: Date = new Date(),
): string {
  const escaped = escapePbtxtString(newTitle);
  const replacement = `title:"${escaped}"`;

  if (existingContent && existingContent.trim().length > 0) {
    if (TITLE_FIELD_RE.test(existingContent)) {
      return existingContent.replace(TITLE_FIELD_RE, replacement);
    }
    return `${replacement} ${existingContent.trimStart()}`;
  }

  const ms = nowDate.getTime();
  const seconds = Math.floor(ms / 1000);
  const nanos = Math.max(0, Math.round((ms - seconds * 1000) * 1_000_000));
  return `${replacement} last_user_view_time:{seconds:${seconds} nanos:${nanos}}`;
}

/**
 * 读取指定 .pbtxt 文件中的标题；文件不存在时返回 null。
 */
export function readPbtxtTitle(filePath: string): string | null {
  if (!fs.existsSync(filePath)) return null;
  const content = fs.readFileSync(filePath, "utf8");
  return parsePbtxtTitle(content);
}

/**
 * 原子写入更新后的 .pbtxt 文件（同目录临时文件 + rename）。
 */
export function writePbtxtTitleAtomic(
  filePath: string,
  newTitle: string,
  nowDate: Date = new Date(),
): { oldTitle: string | null; created: boolean } {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  const exists = fs.existsSync(filePath);
  const existingContent = exists ? fs.readFileSync(filePath, "utf8") : null;
  const oldTitle = existingContent ? parsePbtxtTitle(existingContent) : null;
  const nextContent = patchPbtxtContent(existingContent, newTitle, nowDate);

  const tmpPath = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );
  try {
    fs.writeFileSync(tmpPath, nextContent, "utf8");
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      // 忽略清理临时文件失败
    }
    throw err;
  }

  return { oldTitle, created: !exists };
}
