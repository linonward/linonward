import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import { sha256 } from "./checkpoint.js";
import type { PersistedToolCall } from "./run-store.js";
import {
  applyUniqueTextEdits,
  narrowPatchInput,
  type PatchInput,
  patchInputSchema,
} from "./tools/apply-patch.js";

/**
 * 崩溃恢复的自动对账器。
 *
 * 在途调用（有 `tool_intent`、没有 `tool_result`）的含义是"**可能**已经产生了副作用"。
 * 之前一律要求人工对账——安全，但一次进程重启就要人回答一个问题。可判定的工具应该
 * 自己回答它：
 *
 * - **读操作**（`read_file` / `search_text`）：没有副作用，"未执行"是事实，模型重跑即可；
 * - **`apply_patch`**：`update` / `delete` 的输入里本来就带着期望的旧哈希，`create` 带着
 *   目标内容，因此可以拿磁盘上的现状与"执行前 / 执行后"两个确定状态对照。
 *
 * 对照不上（第三种状态）时**绝不猜**：返回 `ambiguous`，交回人工对账。
 */

export type VerifyOutcome =
  | { status: "applied"; output: string }
  | { status: "not_applied" }
  | { status: "ambiguous"; reason: string };

/**
 * 工具声明的恢复策略比 `ToolStateVerifier` 多一个 `ambiguous`——"不确定"必须是显式的，
 * 不能挤进 `not_applied`（那会让循环以为副作用没发生，可能重复执行）。
 */
export interface RecoveringVerifier {
  verify(input: { call: PersistedToolCall; state: unknown }): Promise<VerifyOutcome>;
}

/** 只读工具：确定没有副作用。 */
export const readOnlyVerifier: RecoveringVerifier = {
  async verify() {
    return { status: "not_applied" };
  },
};

/** 解析成已收窄的 patch 输入；解析不出来就返回 `undefined`（交人工对账）。 */
function readPatchInput(call: PersistedToolCall): PatchInput | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(call.argumentsJson);
  } catch {
    return undefined;
  }
  const parsed = patchInputSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  try {
    return narrowPatchInput(parsed.data);
  } catch {
    return undefined;
  }
}

async function readOptionalFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

function patchObservation(operation: string, path: string, contentSha?: string): string {
  return JSON.stringify({
    ok: true,
    data: { operation, path, ...(contentSha === undefined ? {} : { sha256: contentSha }) },
  });
}

export interface ApplyPatchVerifierOptions {
  cwd?: string | undefined;
  /** 注入"读当前内容"的实现；测试用内存，生产用真实文件系统。 */
  readFile?: ((path: string) => Promise<string | undefined>) | undefined;
}

/**
 * `apply_patch` 的对账器：把磁盘现状与两个确定状态对照。
 *
 * | 操作 | 已生效的判据 | 未执行的判据 |
 * | --- | --- | --- |
 * | `create` | 存在且内容等于 patch 的 `content` | 不存在 |
 * | `update` | 反向应用编辑能还原出 `expectedSha256` | 当前哈希仍等于 `expectedSha256` |
 * | `delete` | 不存在 | 存在且哈希仍等于 `expectedSha256` |
 *
 * 其余情况（内容被改成第三种样子、反向编辑有歧义）一律 `ambiguous`。
 */
export function createApplyPatchVerifier(
  options: ApplyPatchVerifierOptions = {},
): RecoveringVerifier {
  const read = options.readFile ?? readOptionalFile;

  return {
    async verify({ call, state }) {
      const input = readPatchInput(call);
      if (input === undefined) {
        return { status: "ambiguous", reason: "apply_patch 的参数无法解析" };
      }
      const cwd = options.cwd ?? (state as { cwd?: string } | undefined)?.cwd ?? process.cwd();
      const path = isAbsolute(input.path) ? input.path : resolve(cwd, input.path);
      const current = await read(path);

      if (input.operation === "create") {
        if (current === undefined) return { status: "not_applied" };
        if (sha256(current) === sha256(input.content)) {
          return {
            status: "applied",
            output: patchObservation("create", input.path, sha256(input.content)),
          };
        }
        return { status: "ambiguous", reason: "目标文件既不是 patch 的内容，也不是缺失状态" };
      }

      if (input.operation === "delete") {
        if (current === undefined) {
          return { status: "applied", output: patchObservation("delete", input.path) };
        }
        if (sha256(current) === input.expectedSha256) return { status: "not_applied" };
        return { status: "ambiguous", reason: "目标文件存在，但内容与执行前不一致" };
      }

      // update：当前仍是旧内容 → 没执行；能反向还原出旧内容 → 已经执行。
      if (current === undefined) {
        return { status: "ambiguous", reason: "update 的目标文件不存在" };
      }
      if (sha256(current) === input.expectedSha256) return { status: "not_applied" };

      const reversed = reverseEdits(current, input.edits);
      if (reversed !== undefined && sha256(reversed) === input.expectedSha256) {
        return {
          status: "applied",
          output: patchObservation("update", input.path, sha256(current)),
        };
      }
      return { status: "ambiguous", reason: "目标文件内容与编辑前后的状态都对不上" };
    },
  };
}

/**
 * 反向应用编辑：把每个 `replace` 换回 `search`。
 *
 * 只接受**唯一命中**的替换：`replace` 出现 0 次或多次都说明无法确定这次编辑就是我们的，
 * 返回 `undefined` 交人工对账。按编辑的逆序还原，与 `applyUniqueTextEdits` 的顺序对应。
 */
function reverseEdits(
  current: string,
  edits: readonly { search: string; replace: string }[],
): string | undefined {
  let text = current;
  for (const edit of [...edits].reverse()) {
    const first = text.indexOf(edit.replace);
    if (first < 0) return undefined;
    if (text.indexOf(edit.replace, first + edit.replace.length) >= 0) return undefined;
    text = text.slice(0, first) + edit.search + text.slice(first + edit.replace.length);
  }
  // 还原结果必须是"应用编辑后"的样子，否则说明替换过程有别的解释。
  try {
    return applyUniqueTextEdits(text, [...edits]) === current ? text : undefined;
  } catch {
    return undefined;
  }
}

/** 真实装配用的对账器表：工具名 → 对账器。 */
export function createRealTaskVerifiers(): Record<string, RecoveringVerifier> {
  return {
    read_file: readOnlyVerifier,
    search_text: readOnlyVerifier,
    apply_patch: createApplyPatchVerifier(),
  };
}
