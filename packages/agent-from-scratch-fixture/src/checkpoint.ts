import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, rename } from "node:fs/promises";
import { dirname, join } from "node:path";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 确定性 JSON：对象键按字典序输出，`undefined` 字段被丢弃。
 * 校验和、actionDigest 与“压缩前后是否一致”的比对都依赖它。
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => sortValue(item));
  if (!isRecord(value)) return value;

  const sorted: Record<string, unknown> = {};
  const keys = Object.keys(value).toSorted((left, right) => left.localeCompare(right));
  for (const key of keys) {
    const item = value[key];
    if (item === undefined) continue;
    sorted[key] = sortValue(item);
  }
  return sorted;
}

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** 写入同目录临时文件 + fsync 文件 + 原子 rename + fsync 目录条目。 */
export async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  const temporary = join(directory, `.atomic-${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);

  try {
    await handle.writeFile(`${canonicalJson(value)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }

  await rename(temporary, path);
  await fsyncDirectory(directory);
}

export async function fsyncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
