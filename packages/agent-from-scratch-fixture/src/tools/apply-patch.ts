import { randomUUID } from "node:crypto";
import { open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";

import { fsyncDirectory, sha256 } from "../checkpoint.js";
import { defineTool } from "../tool.js";
import { resolvePatchTarget } from "../workspace.js";

const editSchema = z.object({ search: z.string().min(1), replace: z.string() }).strict();

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

/**
 * 顶层必须是 `type: "object"`。
 *
 * `z.discriminatedUnion` 生成的是没有顶层类型的 `anyOf`，OpenAI 接受，但 DeepSeek 的
 * Responses API 会直接 400（`schema must be a JSON Schema of 'type: "object"', got 'type: null'`）。
 * 每轮所有工具都会随请求发送，所以一个不合规的 schema 会让整个运行在第一轮就失败。
 * 逐操作的前置条件因此改由 `superRefine` 在运行时强制，校验强度不变。
 */
export const patchInputSchema = z
  .object({
    operation: z.enum(["create", "update", "delete"]),
    path: z.string().min(1),
    content: z.string().optional(),
    expectedSha256: sha256Schema.optional(),
    edits: z.array(editSchema).min(1).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const reject = (field: "content" | "expectedSha256" | "edits", message: string): void => {
      ctx.addIssue({ code: "custom", path: [field], message });
    };

    if (value.operation === "create") {
      if (value.content === undefined) reject("content", "create 需要 content");
      if (value.expectedSha256 !== undefined)
        reject("expectedSha256", "create 不接受 expectedSha256");
      if (value.edits !== undefined) reject("edits", "create 不接受 edits");
      return;
    }

    if (value.expectedSha256 === undefined) {
      reject("expectedSha256", `${value.operation} 需要 expectedSha256`);
    }
    if (value.content !== undefined) reject("content", `${value.operation} 不接受 content`);

    if (value.operation === "update") {
      if (value.edits === undefined) reject("edits", "update 需要 edits");
    } else if (value.edits !== undefined) {
      reject("edits", "delete 不接受 edits");
    }
  });

/** 运行时判定后的严格形状，供 `execute` 做可辨识收窄。 */
export type PatchInput =
  | { operation: "create"; path: string; content: string }
  | {
      operation: "update";
      path: string;
      expectedSha256: string;
      edits: Array<{ search: string; replace: string }>;
    }
  | { operation: "delete"; path: string; expectedSha256: string };

type PatchDraft = z.infer<typeof patchInputSchema>;

/**
 * `superRefine` 已经保证了这些前置条件；这里做显式收窄，让类型系统与运行期校验一致，
 * 而不是用断言把 `undefined` 塞进去。
 */
export function narrowPatchInput(draft: PatchDraft): PatchInput {
  if (draft.operation === "create") {
    if (draft.content === undefined) throw new Error("invalid_patch_input");
    return { operation: "create", path: draft.path, content: draft.content };
  }

  if (draft.expectedSha256 === undefined) throw new Error("invalid_patch_input");

  if (draft.operation === "delete") {
    return { operation: "delete", path: draft.path, expectedSha256: draft.expectedSha256 };
  }

  if (draft.edits === undefined) throw new Error("invalid_patch_input");
  return {
    operation: "update",
    path: draft.path,
    expectedSha256: draft.expectedSha256,
    edits: draft.edits,
  };
}

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
  async execute(draft, context) {
    const input = narrowPatchInput(draft);
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
