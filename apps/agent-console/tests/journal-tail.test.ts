import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { readLastWaitingRequest, readRunMeta } from "../server/journal-tail.js";

/**
 * 两个读取器都服务于同一件事：API 进程重启后，**只靠磁盘上的 journal** 重建一次运行。
 * 重建需要运行参数（cwd / 白名单 / 预算）与那条等待中的审批请求（含 actionDigest）。
 */

async function withJournal(lines: unknown[], run: (path: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "agent-console-journal-"));
  const path = join(directory, "journal.jsonl");
  try {
    await writeFile(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");
    await run(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const RUN_STARTED = {
  kind: "run_started",
  at: "2024-01-01T00:00:00.000Z",
  command: "run",
  cwd: "/workspace",
  budgets: { maxSteps: 5, maxToolCalls: 8 },
  allowedArgv: [["node", "-e", "*"]],
  requireSandbox: true,
  approveAllowed: false,
  task: "查看 node 版本",
  modelId: "deepseek-v4-pro",
};

const APPROVAL_REQUEST = {
  id: "req-1",
  actionDigest: "digest-1",
  summary: "Run node -e * in /workspace",
  risks: ["风险"],
  expiresAt: "2024-01-01T00:15:00.000Z",
};

describe("readRunMeta", () => {
  it("读回重建运行需要的参数（含 approveAllowed）", async () => {
    await withJournal([RUN_STARTED, { kind: "log_line", text: "..." }], async (path) => {
      expect(readRunMeta(path)).toEqual({
        command: "run",
        task: "查看 node 版本",
        cwd: "/workspace",
        budgets: { maxSteps: 5, maxToolCalls: 8 },
        allowedArgv: [["node", "-e", "*"]],
        requireSandbox: true,
        approveAllowed: false,
        modelId: "deepseek-v4-pro",
      });
    });
  });

  it("字段缺失时保持缺失：不猜 approveAllowed，也不伪造预算", async () => {
    await withJournal([{ kind: "run_started", at: "x", cwd: "/w" }], async (path) => {
      const meta = readRunMeta(path);
      expect(meta?.cwd).toBe("/w");
      expect(meta?.approveAllowed).toBeUndefined();
      expect(meta?.budgets).toBeUndefined();
      expect(meta?.allowedArgv).toBeUndefined();
    });
  });

  it("文件不存在或没有 run_started 时返回 undefined", async () => {
    expect(readRunMeta("/definitely/missing/journal.jsonl")).toBeUndefined();
    await withJournal([{ kind: "log_line", text: "只有日志" }], async (path) => {
      expect(readRunMeta(path)).toBeUndefined();
    });
  });
});

describe("readLastWaitingRequest", () => {
  it("连完整审批请求一起读回（actionDigest 是批准时必须的）", async () => {
    await withJournal(
      [
        RUN_STARTED,
        {
          kind: "tool_result",
          callId: "call-1",
          name: "run_command",
          waiting: { requestId: "req-1", reason: "approval_required" },
          policy: { type: "ask", request: APPROVAL_REQUEST },
        },
      ],
      async (path) => {
        expect(readLastWaitingRequest(path)).toEqual({
          requestId: "req-1",
          reason: "approval_required",
          request: APPROVAL_REQUEST,
        });
      },
    );
  });

  it("取最后一条 waiting：之前答过的请求不能盖住当前等待的那条", async () => {
    await withJournal(
      [
        {
          kind: "tool_result",
          waiting: { requestId: "req-old", reason: "approval_required" },
          policy: { type: "ask", request: { ...APPROVAL_REQUEST, id: "req-old" } },
        },
        { kind: "tool_result", ok: true, output: "{}" },
        {
          kind: "tool_result",
          waiting: { requestId: "req-new", reason: "approval_required" },
          policy: { type: "ask", request: { ...APPROVAL_REQUEST, id: "req-new" } },
        },
      ],
      async (path) => {
        expect(readLastWaitingRequest(path)?.requestId).toBe("req-new");
      },
    );
  });

  it("澄清请求没有 policy.request：request 缺失但 requestId 仍可用", async () => {
    await withJournal(
      [
        {
          kind: "tool_result",
          waiting: { requestId: "req-clarify", reason: "user_input_required" },
        },
      ],
      async (path) => {
        const waiting = readLastWaitingRequest(path);
        expect(waiting?.requestId).toBe("req-clarify");
        expect(waiting?.request).toBeUndefined();
      },
    );
  });

  it("policy.request 形状不完整时拒绝它，而不是把坏数据塞进账本", async () => {
    await withJournal(
      [
        {
          kind: "tool_result",
          waiting: { requestId: "req-1", reason: "approval_required" },
          policy: { type: "ask", request: { id: "req-1" } },
        },
      ],
      async (path) => {
        expect(readLastWaitingRequest(path)?.request).toBeUndefined();
      },
    );
  });
});
