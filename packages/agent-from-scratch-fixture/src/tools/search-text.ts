import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import { z } from "zod";

import { defineTool } from "../tool.js";

/** 每个文件的上限由 ripgrep 控制，这里是全局条数上限。 */
export const MAX_SEARCH_LINES = 50;

export const SEARCH_EXCLUDED_DIRECTORIES = [
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
] as const;

/**
 * `--` 明确结束选项解析，因此 `-g`、`--help` 之类的查询不会被当成 ripgrep 参数。
 */
export function buildSearchArgs(query: string): string[] {
  const globs = SEARCH_EXCLUDED_DIRECTORIES.flatMap((directory) => ["--glob", `!${directory}/**`]);

  return [
    "-n",
    "--fixed-strings",
    "--max-count",
    String(MAX_SEARCH_LINES),
    ...globs,
    "--",
    query,
    ".",
  ];
}

async function collectLines(
  stream: Readable,
  limit: number,
  onLimit: () => void,
): Promise<{ lines: string[]; truncated: boolean }> {
  const lines: string[] = [];
  let truncated = false;
  const reader = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });

  for await (const line of reader) {
    if (lines.length >= limit) {
      truncated = true;
      onLimit();
      break;
    }
    lines.push(line);
  }

  return { lines, truncated };
}

export const searchTextTool = defineTool({
  name: "search_text",
  description:
    "Search literal text in the workspace with ripgrep. Excludes .git, node_modules, dist, build and .next.",
  effect: "read",
  schema: z.object({ query: z.string().min(1) }).strict(),
  async execute(input, context) {
    const cwd = await realpath(context.cwd);
    const child = spawn("rg", buildSearchArgs(input.query), {
      cwd,
      shell: false,
      signal: context.signal,
    });

    const closed = new Promise<number | null>((resolveClosed) => {
      child.once("close", (code) => resolveClosed(code));
    });
    const started = new Promise<void>((resolveStarted, rejectStarted) => {
      child.once("spawn", () => resolveStarted());
      child.once("error", (error) => rejectStarted(error));
    });

    await started;

    const stdout = child.stdout;
    const { lines, truncated } = stdout
      ? await collectLines(stdout, MAX_SEARCH_LINES, () => child.kill("SIGTERM"))
      : { lines: [], truncated: false };

    const exitCode = await closed;

    return {
      query: input.query,
      matches: lines,
      truncated,
      exitCode,
    };
  },
});
