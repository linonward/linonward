import { randomUUID } from "node:crypto";
import { open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";

import { fsyncDirectory, sha256 } from "../checkpoint.js";
import { defineTool } from "../tool.js";
import { resolvePatchTarget } from "../workspace.js";

const editSchema = z.object({ search: z.string().min(1), replace: z.string() }).strict();

export const patchInputSchema = z.discriminatedUnion("operation", [
  z
    .object({ operation: z.literal("create"), path: z.string().min(1), content: z.string() })
    .strict(),
  z
    .object({
      operation: z.literal("update"),
      path: z.string().min(1),
      expectedSha256: z.string().regex(/^[a-f0-9]{64}$/),
      edits: z.array(editSchema).min(1),
    })
    .strict(),
  z
    .object({
      operation: z.literal("delete"),
      path: z.string().min(1),
      expectedSha256: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict(),
]);

export type PatchInput = z.infer<typeof patchInputSchema>;

export interface PatchResult {
  operation: "create" | "update" | "delete";
  path: string;
  sha256?: string | undefined;
}

/**
 * 每个 `search` 必须在当前文本中恰好出现一次。
 * 出现 0 次说明旧内容已被改动，出现多次说明补丁有歧义，两者都必须失败。
 */
export function applyUniqueTextEdits(
  current: string,
  edits: Array<{ search: string; replace: string }>,
): string {
  let next = current;

  for (const edit of edits) {
    const first = next.indexOf(edit.search);
    if (first === -1) throw new Error("edit_not_found");
    if (next.indexOf(edit.search, first + edit.search.length) !== -1) {
      throw new Error("edit_not_unique");
    }
    next = next.slice(0, first) + edit.replace + next.slice(first + edit.search.length);
  }

  return next;
}

/** 同目录临时文件 + fsync + 再次核对 hash + 原子 rename。 */
export async function atomicReplace(
  path: string,
  content: string,
  expectedSha256: string,
): Promise<void> {
  const temporary = join(dirname(path), `.agent-patch-${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);

  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }

  if (sha256(await readFile(path, "utf8")) !== expectedSha256) {
    await unlink(temporary);
    throw new Error("file_changed");
  }

  await rename(temporary, path);
  await fsyncDirectory(dirname(path));
}

export const applyPatchTool = defineTool({
  name: "apply_patch",
  description:
    "Create, patch, or delete one workspace file under a SHA-256 precondition. Never replaces a whole file.",
  effect: "write",
  schema: patchInputSchema,
  async execute(input, context) {
    return context.writeLease.runExclusive(input.path, async () => {
      const path = await resolvePatchTarget(context.cwd, input.path, input.operation);

      if (input.operation === "create") {
        await writeFile(path, input.content, { encoding: "utf8", flag: "wx", mode: 0o600 });
        return { operation: "create", path: input.path, sha256: sha256(input.content) };
      }

      const current = await readFile(path, "utf8");
      if (sha256(current) !== input.expectedSha256) throw new Error("file_changed");

      if (input.operation === "delete") {
        await unlink(path);
        return { operation: "delete", path: input.path };
      }

      const next = applyUniqueTextEdits(current, input.edits);
      await atomicReplace(path, next, input.expectedSha256);
      return { operation: "update", path: input.path, sha256: sha256(next) };
    });
  },
});
