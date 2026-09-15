import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { canonicalJson, sha256 } from "./checkpoint.js";
import type { AgentState, ValidationRecord } from "./types.js";

export const DELETED_FILE_HASH = "deleted";
export const MISSING_FILE_HASH = "missing";

/** 重新计算受控修改文件的当前 hash；文件被删除时用显式标记而不是空字符串。 */
export async function hashChangedFiles(
  cwd: string,
  changedFiles: string[],
): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};

  for (const file of changedFiles) {
    try {
      hashes[file] = sha256(await readFile(join(cwd, file), "utf8"));
    } catch (error) {
      const code = error instanceof Error && "code" in error ? String(error.code) : "";
      hashes[file] = code === "ENOENT" ? DELETED_FILE_HASH : MISSING_FILE_HASH;
    }
  }

  return hashes;
}

export function hashesEqual(left: Record<string, string>, right: Record<string, string>): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

/**
 * 只有绑定“当前 revision + 当前文件 hash + 对应 criterion”的成功命令才算证据。
 * 返回 `undefined` 表示可以完成，否则返回给模型的反馈文本。
 */
export async function checkCompletion(state: AgentState): Promise<string | undefined> {
  if (state.changedFiles.length === 0) return undefined;

  const currentHashes = await hashChangedFiles(state.cwd, state.changedFiles);
  if (!hashesEqual(currentHashes, state.changedFileHashes)) {
    return "工作区在最后一次受控补丁后发生变化，请重新调查并验证。";
  }

  for (const criterionId of state.requiredCriterionIds) {
    const evidence = state.validations.findLast(
      (record: ValidationRecord) =>
        record.status === "passed" &&
        record.validatedRevision === state.mutationRevision &&
        record.criterionIds.includes(criterionId) &&
        hashesEqual(record.changedFileHashes, currentHashes),
    );
    if (!evidence) return `当前修改版本缺少验收证据：${criterionId}`;
  }

  return undefined;
}

/** 模型提前声明完成时，把缺失项写成确定性的反馈文本。 */
export function describeMissingProgress(input: {
  planCompleted: boolean;
  criteriaPassed: boolean;
  completionError: string | undefined;
}): string {
  if (input.completionError) return input.completionError;
  if (!input.planCompleted) return "继续执行：计划中仍有未完成的步骤。";
  if (!input.criteriaPassed) return "继续执行：仍有验收条件未通过。";
  return "继续执行：完成门禁未通过。";
}
