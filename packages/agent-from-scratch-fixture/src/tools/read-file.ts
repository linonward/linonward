import { readFile } from "node:fs/promises";
import { z } from "zod";

import { sha256 } from "../checkpoint.js";
import { defineTool } from "../tool.js";
import { resolveExistingWorkspacePath } from "../workspace.js";

/** 单次读取上限。截断必须显式告知模型，避免它用残缺内容生成补丁。 */
export const READ_FILE_LIMIT = 20_000;

export const readFileTool = defineTool({
  name: "read_file",
  description:
    "Read one UTF-8 text file inside the workspace root and return its content, byte size and SHA-256.",
  effect: "read",
  schema: z.object({ path: z.string().min(1) }).strict(),
  async execute(input, context) {
    const path = await resolveExistingWorkspacePath(context.cwd, input.path);
    const content = await readFile(path, "utf8");
    const truncated = content.length > READ_FILE_LIMIT;

    return {
      path: input.path,
      content: content.slice(0, READ_FILE_LIMIT),
      truncated,
      bytes: Buffer.byteLength(content),
      sha256: sha256(content),
    };
  },
});
