import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { sha256 } from "../src/checkpoint.js";
import { type AgentRuntime, reconcileInFlightTool } from "../src/recovery.js";
import type { PersistedToolCall } from "../src/run-store.js";
import { InMemoryRunStore, type RunLease } from "../src/run-store.js";
import {
  createApplyPatchVerifier,
  createRealTaskVerifiers,
  readOnlyVerifier,
} from "../src/verifiers.js";

/**
 * 崩溃恢复的自动对账。
 *
 * 在途调用（有 `tool_intent`、没有 `tool_result`）以前一律要求人工对账，因为"它到底执行了
 * 没有"没人知道。可验证的工具应该自己回答这个问题：读操作肯定没副作用，写操作可以用
 * **内容哈希**判定——`update` / `delete` 的输入里本来就带着期望的旧哈希。
 */
async function withWorkspace(
  files: Record<string, string>,
  run: (directory: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "agent-verifiers-"));
  try {
    for (const [name, content] of Object.entries(files)) {
      await writeFile(join(directory, name), content, "utf8");
    }
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("verifiers", () => {
  function call(name: string, argumentsJson: string): PersistedToolCall {
    return { callId: "call-1", name, argumentsJson };
  }

  it("只读工具：确定没有副作用，直接判为未执行（模型重跑一次即可）", async () => {
    await expect(
      readOnlyVerifier.verify({
        call: call("read_file", '{"path":"a.txt"}'),
        state: { cwd: "/workspace" } as never,
      }),
    ).resolves.toEqual({ status: "not_applied" });
  });

  it("create：文件内容与 patch 一致 → 已生效", async () => {
    await withWorkspace({ "a.txt": "hello" }, async (directory) => {
      const verifier = createApplyPatchVerifier({ cwd: directory });
      const result = await verifier.verify({
        call: call(
          "apply_patch",
          JSON.stringify({ operation: "create", path: "a.txt", content: "hello" }),
        ),
        state: { cwd: directory } as never,
      });

      expect(result).toMatchObject({ status: "applied" });
      expect(result.status === "applied" ? result.output : "").toContain('"sha256"');
    });
  });

  it("create：文件不存在 → 未执行", async () => {
    await withWorkspace({}, async (directory) => {
      const verifier = createApplyPatchVerifier({ cwd: directory });
      await expect(
        verifier.verify({
          call: call(
            "apply_patch",
            JSON.stringify({ operation: "create", path: "new.txt", content: "x" }),
          ),
          state: { cwd: directory } as never,
        }),
      ).resolves.toEqual({ status: "not_applied" });
    });
  });

  it("create：文件内容既不是目标内容也不缺 → 无法判定，交人工对账", async () => {
    await withWorkspace({ "a.txt": "something else" }, async (directory) => {
      const verifier = createApplyPatchVerifier({ cwd: directory });
      await expect(
        verifier.verify({
          call: call(
            "apply_patch",
            JSON.stringify({ operation: "create", path: "a.txt", content: "hello" }),
          ),
          state: { cwd: directory } as never,
        }),
      ).resolves.toEqual({ status: "ambiguous", reason: expect.stringContaining("既不是") });
    });
  });

  it("update：文件仍是旧哈希 → 未执行；已经变成编辑后的内容 → 已生效", async () => {
    const before = "line1\nline2\n";
    const after = "line1\nLINE2\n";
    const patch = JSON.stringify({
      operation: "update",
      path: "a.txt",
      expectedSha256: sha256(before),
      edits: [{ search: "line2", replace: "LINE2" }],
    });

    await withWorkspace({ "a.txt": before }, async (directory) => {
      const verifier = createApplyPatchVerifier({ cwd: directory });
      await expect(
        verifier.verify({ call: call("apply_patch", patch), state: { cwd: directory } as never }),
      ).resolves.toEqual({ status: "not_applied" });
    });

    await withWorkspace({ "a.txt": after }, async (directory) => {
      const verifier = createApplyPatchVerifier({ cwd: directory });
      const result = await verifier.verify({
        call: call("apply_patch", patch),
        state: { cwd: directory } as never,
      });
      expect(result).toMatchObject({ status: "applied" });
    });
  });

  it("update：内容被改成第三种样子 → 无法判定", async () => {
    const before = "line1\nline2\n";
    const patch = JSON.stringify({
      operation: "update",
      path: "a.txt",
      expectedSha256: sha256(before),
      edits: [{ search: "line2", replace: "LINE2" }],
    });

    await withWorkspace({ "a.txt": "完全不同的内容\n" }, async (directory) => {
      const verifier = createApplyPatchVerifier({ cwd: directory });
      await expect(
        verifier.verify({ call: call("apply_patch", patch), state: { cwd: directory } as never }),
      ).resolves.toMatchObject({ status: "ambiguous" });
    });
  });

  it("delete：文件已消失 → 已生效；仍是旧内容 → 未执行", async () => {
    const before = "gone\n";
    const patch = JSON.stringify({
      operation: "delete",
      path: "a.txt",
      expectedSha256: sha256(before),
    });

    await withWorkspace({}, async (directory) => {
      const verifier = createApplyPatchVerifier({ cwd: directory });
      await expect(
        verifier.verify({ call: call("apply_patch", patch), state: { cwd: directory } as never }),
      ).resolves.toMatchObject({ status: "applied" });
    });

    await withWorkspace({ "a.txt": before }, async (directory) => {
      const verifier = createApplyPatchVerifier({ cwd: directory });
      await expect(
        verifier.verify({ call: call("apply_patch", patch), state: { cwd: directory } as never }),
      ).resolves.toEqual({ status: "not_applied" });
    });
  });

  it("参数无法解析时交人工对账，而不是猜", async () => {
    await withWorkspace({}, async (directory) => {
      const verifier = createApplyPatchVerifier({ cwd: directory });
      await expect(
        verifier.verify({
          call: call("apply_patch", "not json"),
          state: { cwd: directory } as never,
        }),
      ).resolves.toMatchObject({ status: "ambiguous" });
    });
  });

  it("真实装配：读工具与写工具都有对账器", () => {
    const verifiers = createRealTaskVerifiers();

    expect(Object.keys(verifiers).sort()).toEqual(["apply_patch", "read_file", "search_text"]);
  });
});

/**
 * 对账器真正的用途：`reconcileInFlightTool` 在恢复时调用它。
 *
 * `applied` 只补写 `tool_result`（绝不重复执行副作用）；`ambiguous` 必须变成
 * 人工对账请求，而不是被当成"没执行过"。
 */
describe("在途调用对账", () => {
  /** 对账要往 store 里补写 `tool_result`，因此必须真的持有 lease（fencing 不是装饰）。 */
  async function runtimeFor(
    directory: string,
  ): Promise<{ runtime: AgentRuntime; lease: RunLease }> {
    const store = new InMemoryRunStore();
    const runtime = {
      verifiers: createRealTaskVerifiers(),
      store,
      clock: { now: () => new Date() },
      cwd: directory,
    } as unknown as AgentRuntime;
    const lease = await store.acquireLease("run-1", "owner-1", 60_000);
    return { runtime, lease };
  }

  it("已生效的 patch：补写 tool_result 并继续，不重复执行", async () => {
    await withWorkspace({ "a.txt": "hello" }, async (directory) => {
      const { runtime, lease } = await runtimeFor(directory);
      const call = {
        callId: "call-1",
        name: "apply_patch",
        argumentsJson: JSON.stringify({ operation: "create", path: "a.txt", content: "hello" }),
      };

      const result = await reconcileInFlightTool(
        call,
        { runId: "run-1", cwd: directory, events: [], nextEventSequence: 0 } as never,
        runtime,
        lease,
      );

      expect(result).toMatchObject({ type: "resolved" });
      const events = await runtime.store.readEvents("run-1", 0);
      expect(events).toHaveLength(1);
      expect(events[0]?.event.type).toBe("tool_result");
    });
  });

  it("判定不了的时候交回人工，而不是猜", async () => {
    await withWorkspace({ "a.txt": "第三种状态" }, async (directory) => {
      const { runtime, lease } = await runtimeFor(directory);
      const call = {
        callId: "call-1",
        name: "apply_patch",
        argumentsJson: JSON.stringify({ operation: "create", path: "a.txt", content: "hello" }),
      };

      const result = await reconcileInFlightTool(
        call,
        { runId: "run-1", cwd: directory, events: [], nextEventSequence: 0 } as never,
        runtime,
        lease,
      );

      expect(result).toMatchObject({ type: "manual_reconciliation" });
      await expect(runtime.store.readEvents("run-1", 0)).resolves.toHaveLength(0);
    });
  });
});
