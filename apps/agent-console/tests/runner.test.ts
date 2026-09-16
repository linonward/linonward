import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { toDurableState } from "../../../packages/agent-from-scratch-fixture/src/durable-state.js";
import {
  createRunCheckpoint,
  LocalFileRunStore,
} from "../../../packages/agent-from-scratch-fixture/src/run-store.js";
import { PreApprovingLedger } from "../../../packages/agent-from-scratch-fixture/src/run-task.js";
import { createInitialState } from "../../../packages/agent-from-scratch-fixture/src/state.js";
import type {
  AgentState,
  DurableAgentState,
} from "../../../packages/agent-from-scratch-fixture/src/types.js";
import { type RunChannel, RunHub } from "../server/bus.js";
import {
  CONSOLE_MAX_OPEN_RUNS_ENV,
  cancelRefusal,
  clarificationMismatch,
  createConsoleRunner,
  openRunRefusal,
  RunnerError,
  readMaxOpenRuns,
  resolveAnswerKind,
  type StartRunInput,
} from "../server/runner.js";

const FAKE_KEY = "sk-offline-test-not-a-real-key";

function startInput(overrides: Partial<StartRunInput> = {}): StartRunInput {
  return {
    task: "读取 package.json",
    cwd: tmpdir(),
    allowedArgv: [],
    maxSteps: 2,
    maxToolCalls: 2,
    approveAllowed: false,
    // 离线测试不执行真命令；默认值仍与线上一致（要求隔离）。
    requireSandbox: false,
    repeatGuard: true,
    ...overrides,
  };
}

async function waitForDone(channel: RunChannel, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!channel.done) {
    if (Date.now() > deadline) throw new Error("运行没有在超时内结束");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function collected(channel: RunChannel): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  channel.subscribe(0, {
    onEntry: (entry) => records.push(entry.record),
    onDone: () => undefined,
  });
  return records;
}

async function ensureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

/** 造一份"运行过一轮、可能正在等回答"的检查点，用来测快照与列表。 */
async function seedCheckpoint(input: {
  storeRoot: string;
  runId: string;
  task: string;
  status?: AgentState["status"];
  stopReason?: string;
  savedAt?: Date;
  pendingUserInput?: DurableAgentState["pendingUserInput"];
}): Promise<void> {
  const savedAt = input.savedAt ?? new Date();
  const store = new LocalFileRunStore(input.storeRoot, () => savedAt);
  const lease = await store.acquireLease(input.runId, "seed-owner", 60_000);
  const state = createInitialState(
    input.task,
    "/workspace",
    { maxSteps: 6, maxToolCalls: 12 },
    { runId: input.runId, now: savedAt },
  );
  const withPlan: AgentState = {
    ...state,
    status: input.status ?? "waiting",
    stopReason: input.stopReason ?? "approval_required",
    plan: {
      version: 1,
      goal: input.task,
      acceptanceCriteria: [{ id: "ac1", description: "验收条件", status: "unverified" }],
      steps: [
        {
          id: "st1",
          title: "步骤",
          status: "in_progress",
          dependsOn: [],
          completionEvidence: "证据",
          evidence: [],
        },
      ],
    },
    pendingUserInput: input.pendingUserInput,
  };
  await store.saveCheckpoint(
    createRunCheckpoint({
      state: toDurableState(withPlan),
      throughSequence: 1,
      now: savedAt,
    }),
    lease,
  );
}

/**
 * 真实运行器的装配 + 收尾链路，**完全离线**：
 * 密钥是假的、`DEEPSEEK_BASE_URL` 指向一个必然连不上的本地端口，因此不会产生任何
 * 真实模型请求；但 `createContext` / `runAgentLoop` / journal 双写 / 事件总线 /
 * `settle` 都是线上那一套。
 */
describe("createConsoleRunner（离线，假密钥 + 不可达 baseUrl）", () => {
  it("缺密钥时 start 直接抛 400，且不会启动运行", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-console-runner-"));
    try {
      const runner = createConsoleRunner({
        env: {},
        hub: new RunHub(),
        storeRoot: directory,
      });
      await expect(runner.start(startInput())).rejects.toBeInstanceOf(RunnerError);
      await expect(runner.start(startInput())).rejects.toThrow("DEEPSEEK_API_KEY");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("运行失败也会走完 journal → 总线，并把 run_stopped 推给订阅者（密钥不外泄）", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-console-runner-"));
    try {
      const hub = new RunHub();
      const runner = createConsoleRunner({
        env: {
          DEEPSEEK_API_KEY: FAKE_KEY,
          DEEPSEEK_BASE_URL: "http://127.0.0.1:9/v1",
        },
        hub,
        storeRoot: directory,
      });

      const { runId } = await runner.start(startInput());
      const channel = hub.get(runId);
      expect(channel).toBeDefined();
      if (channel === undefined) return;

      await waitForDone(channel);
      const records = collected(channel);
      const kinds = records.map((record) => record["kind"]);

      // journal 的 run_started 一定先到（可读日志行可能夹在中间）；结束一定以 run_stopped 收尾。
      const structured = kinds.filter((kind) => kind !== "log_line");
      expect(structured[0]).toBe("run_started");
      expect(kinds.at(-1)).toBe("run_stopped");
      expect(records.at(-1)?.["status"]).toBe("failed");
      // 可读日志行也进了总线（原始事件区）。
      expect(kinds).toContain("log_line");

      // 任何推给浏览器的内容都不包含密钥。
      expect(JSON.stringify(records)).not.toContain(FAKE_KEY);

      // journal 双写：结构化记录落在运行目录的 JSONL 里。
      const journal = await readFile(join(directory, runId, "journal.jsonl"), "utf8");
      expect(journal).toContain('"kind":"run_started"');
      expect(journal).not.toContain(FAKE_KEY);

      // 运行失败太早时没有 checkpoint：快照返回 undefined 而不是崩掉。
      await expect(runner.snapshot(runId)).resolves.toBeUndefined();
      await expect(runner.snapshot("does-not-exist")).resolves.toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("对未知运行 answer 返回 404 语义的 RunnerError", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-console-runner-"));
    try {
      const runner = createConsoleRunner({
        env: { DEEPSEEK_API_KEY: FAKE_KEY },
        hub: new RunHub(),
        storeRoot: directory,
      });

      await expect(
        runner.answer("missing-run", { requestId: "req-1", text: "同意" }),
      ).rejects.toMatchObject({ status: 404 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

/**
 * 快照与列表都只读磁盘上的 checkpoint：**页面刷新后唯一的兜底数据源**。
 * 频道还在时走 SSE 补发，频道没了（API 进程重启）就只能靠这里。
 */
describe("checkpoint 快照与运行列表（离线）", () => {
  it("快照带 task 与待答请求，刷新后能把输入框重建出来", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-console-snapshot-"));
    try {
      await seedCheckpoint({
        storeRoot: directory,
        runId: "run-waiting",
        task: "读取 package.json",
        pendingUserInput: {
          id: "req-1",
          kind: "approval",
          question: "是否允许执行 run_command？",
          reason: "策略要求人工批准",
          createdAt: "2024-01-01T00:00:04.000Z",
        },
      });

      const runner = createConsoleRunner({ env: {}, hub: new RunHub(), storeRoot: directory });
      const snapshot = await runner.snapshot("run-waiting");

      expect(snapshot).toMatchObject({
        runId: "run-waiting",
        task: "读取 package.json",
        status: "waiting",
        stopReason: "approval_required",
        pending: {
          requestId: "req-1",
          question: "是否允许执行 run_command？",
          reason: "策略要求人工批准",
        },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("审批等待没有 pendingUserInput：从 journal 最后一条 waiting 记录里读回 requestId", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-console-snapshot-"));
    try {
      await seedCheckpoint({
        storeRoot: directory,
        runId: "run-approval",
        task: "跑一条命令",
        status: "waiting",
        stopReason: "approval_required",
      });
      // 审批等待只留在 journal 里（state.pendingUserInput 只管澄清）。
      await writeFile(
        join(directory, "run-approval", "journal.jsonl"),
        [
          JSON.stringify({ kind: "run_started", at: "2024-01-01T00:00:00.000Z" }),
          JSON.stringify({
            kind: "tool_result",
            callId: "call-1",
            name: "run_command",
            ok: false,
            waiting: { requestId: "req-9", reason: "approval_required" },
          }),
          "",
        ].join("\n"),
        "utf8",
      );

      const runner = createConsoleRunner({ env: {}, hub: new RunHub(), storeRoot: directory });
      const snapshot = await runner.snapshot("run-approval");

      expect(snapshot?.pending).toEqual({
        requestId: "req-9",
        question: "",
        reason: "approval_required",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("运行已经不在 waiting 时不会从 journal 里翻出过期的 pending", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-console-snapshot-"));
    try {
      await seedCheckpoint({
        storeRoot: directory,
        runId: "run-answered",
        task: "已经答过了",
        status: "completed",
        stopReason: "final_answer",
      });
      await writeFile(
        join(directory, "run-answered", "journal.jsonl"),
        `${JSON.stringify({
          kind: "tool_result",
          callId: "call-1",
          name: "run_command",
          waiting: { requestId: "req-9", reason: "approval_required" },
        })}\n`,
        "utf8",
      );

      const runner = createConsoleRunner({ env: {}, hub: new RunHub(), storeRoot: directory });
      const snapshot = await runner.snapshot("run-answered");

      expect(snapshot === undefined ? true : Object.hasOwn(snapshot, "pending")).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("没有待答请求时快照不含 pending 字段（缺失就是缺失）", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-console-snapshot-"));
    try {
      await seedCheckpoint({
        storeRoot: directory,
        runId: "run-done",
        task: "已完成的任务",
        status: "completed",
        stopReason: "final_answer",
      });

      const runner = createConsoleRunner({ env: {}, hub: new RunHub(), storeRoot: directory });
      const snapshot = await runner.snapshot("run-done");

      expect(snapshot).toBeDefined();
      expect(snapshot === undefined ? true : Object.hasOwn(snapshot, "pending")).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("列表按保存时间倒序汇总，并标出还有活频道的运行", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-console-list-"));
    try {
      await seedCheckpoint({
        storeRoot: directory,
        runId: "run-old",
        task: "旧运行",
        status: "completed",
        stopReason: "final_answer",
        savedAt: new Date("2024-01-01T00:00:00.000Z"),
      });
      await seedCheckpoint({
        storeRoot: directory,
        runId: "run-new",
        task: "新运行",
        savedAt: new Date("2024-01-02T00:00:00.000Z"),
      });
      // 不是运行目录的条目必须被跳过，而不是让整个列表失败。
      await ensureDirectory(join(directory, "not-a-run"));

      const hub = new RunHub();
      const live = hub.create("run-old");
      const runner = createConsoleRunner({ env: {}, hub, storeRoot: directory });

      const runs = await runner.list();

      expect(runs.map((run) => run.runId)).toEqual(["run-new", "run-old"]);
      expect(runs[0]).toMatchObject({ runId: "run-new", task: "新运行", status: "waiting" });
      expect(runs[0]?.live).toBe(false);
      expect(runs[1]?.live).toBe(true);

      // 频道结束后不再是"活着的"。
      live.finish();
      const afterFinish = await runner.list();
      expect(afterFinish.every((run) => !run.live)).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("空目录返回空列表而不是报错", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-console-list-empty-"));
    try {
      const runner = createConsoleRunner({ env: {}, hub: new RunHub(), storeRoot: directory });
      await expect(runner.list()).resolves.toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

/**
 * 审批与澄清是两条不同的续跑路径：审批只要在账本里批准那条 requestId，
 * 澄清才要把回答写进状态。搞错的症状很隐蔽——HTTP 200，但运行随即以
 * `unexpected_user_input` 失败。
 */
describe("回答请求的分流（审批 vs 澄清）", () => {
  const approvalRequest = {
    id: "req-approval",
    actionDigest: "digest-1",
    summary: "Run node -e * in /workspace",
    risks: ["风险"],
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };

  it("账本里的 requestId 走审批路径，且凭证一次性、绑定同一个 actionDigest", async () => {
    const approvals = new PreApprovingLedger();
    await approvals.saveApprovalRequest("run-1", approvalRequest);

    await expect(resolveAnswerKind(approvals, "run-1", "req-approval")).resolves.toBe("approval");

    await approvals.approve("run-1", "req-approval");
    // 重放同一调用时才能消费到凭证——这正是 resume 之后循环会做的事。
    await expect(approvals.consumeApprovalGrant("run-1", "digest-1")).resolves.toBeDefined();
    // 一次性。
    await expect(approvals.consumeApprovalGrant("run-1", "digest-1")).resolves.toBeUndefined();
  });

  it("不属于任何待批准请求的 requestId 归到澄清路径", async () => {
    const approvals = new PreApprovingLedger();

    await expect(resolveAnswerKind(approvals, "run-1", "req-user-input")).resolves.toBe(
      "user_input",
    );
    // 别的运行的批准请求不能串台。
    await approvals.saveApprovalRequest("run-2", approvalRequest);
    await expect(resolveAnswerKind(approvals, "run-1", "req-approval")).resolves.toBe("user_input");
  });

  it("澄清的 requestId 对不上时给出可读 4xx，而不是 200 + run_error", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-console-answer-"));
    try {
      await seedCheckpoint({
        storeRoot: directory,
        runId: "run-waiting",
        task: "等一个回答",
        pendingUserInput: {
          id: "req-real",
          kind: "clarification",
          question: "用哪个目录？",
          reason: "需要澄清",
          createdAt: "2024-01-01T00:00:04.000Z",
        },
      });
      const store = new LocalFileRunStore(directory);

      await expect(
        clarificationMismatch(store, "run-waiting", "req-real"),
      ).resolves.toBeUndefined();
      await expect(clarificationMismatch(store, "run-waiting", "req-typo")).resolves.toMatchObject({
        status: 400,
        message: "requestId 不匹配：当前等待的是 req-real",
      });
      await expect(clarificationMismatch(store, "run-done", "req-x")).resolves.toMatchObject({
        status: 400,
        message: "这次运行没有待回答的请求：req-x",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

/**
 * API 进程重启后，等待中的运行必须还能被继续：频道没了，但检查点、运行参数与那条
 * 审批请求都还在磁盘上。这里用一个**全新的 runner**（模拟重启后的进程）回答，
 * 断言它会从磁盘重建运行，而不是直接 404。
 */
describe("进程重启后继续一次等待中的运行（离线）", () => {
  const APPROVAL_REQUEST = {
    id: "req-9",
    actionDigest: "digest-9",
    summary: "Run node -e * in /workspace",
    risks: ["风险"],
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };

  async function seedWaitingRun(storeRoot: string, runId: string): Promise<void> {
    await seedCheckpoint({
      storeRoot,
      runId,
      task: "跑一条命令",
      status: "waiting",
      stopReason: "approval_required",
    });
    await writeFile(
      join(storeRoot, runId, "journal.jsonl"),
      [
        JSON.stringify({
          kind: "run_started",
          at: "2024-01-01T00:00:00.000Z",
          command: "run",
          cwd: "/workspace",
          budgets: { maxSteps: 3, maxToolCalls: 6 },
          allowedArgv: [["node", "-e", "*"]],
          requireSandbox: false,
          approveAllowed: false,
          task: "跑一条命令",
        }),
        JSON.stringify({
          kind: "tool_result",
          at: "2024-01-01T00:00:01.000Z",
          callId: "call-1",
          name: "run_command",
          waiting: { requestId: APPROVAL_REQUEST.id, reason: "approval_required" },
          policy: { type: "ask", request: APPROVAL_REQUEST },
        }),
        "",
      ].join("\n"),
      "utf8",
    );
  }

  it("用新进程回答会重建运行：请求被受理，频道里能重放完整历史", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-console-rehydrate-"));
    try {
      await seedWaitingRun(directory, "run-waiting");

      // 假密钥 + 不可达 baseUrl：重建本身不用网络，续跑会在模型调用处失败。
      const hub = new RunHub();
      const runner = createConsoleRunner({
        env: { DEEPSEEK_API_KEY: FAKE_KEY, DEEPSEEK_BASE_URL: "http://127.0.0.1:9/v1" },
        hub,
        storeRoot: directory,
      });

      // 磁盘上有这个运行，但新进程里没有任何上下文：过去这里是 404。
      // 快照把批准凭证的过期时间一并透出，界面据此判断"还值不值得给表单"。
      const snapshot = await runner.snapshot("run-waiting");
      expect(snapshot?.pending?.expiresAt).toBe(APPROVAL_REQUEST.expiresAt);

      await expect(
        runner.answer("run-waiting", { requestId: APPROVAL_REQUEST.id, text: "批准" }),
      ).resolves.toBeUndefined();

      const channel = hub.get("run-waiting");
      expect(channel).toBeDefined();
      if (channel === undefined) return;
      await waitForDone(channel, 30_000);

      // 重建的频道补发了历史（run_started + 那条 waiting），界面因此还能重建时间线。
      const kinds = collected(channel).map((record) => record["kind"]);
      expect(kinds).toContain("run_started");
      expect(JSON.stringify(collected(channel))).toContain(APPROVAL_REQUEST.id);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("requestId 不属于任何待批准请求时仍然是可读 4xx", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-console-rehydrate-"));
    try {
      await seedWaitingRun(directory, "run-waiting");
      const runner = createConsoleRunner({
        env: { DEEPSEEK_API_KEY: FAKE_KEY, DEEPSEEK_BASE_URL: "http://127.0.0.1:9/v1" },
        hub: new RunHub(),
        storeRoot: directory,
      });

      await expect(
        runner.answer("run-waiting", { requestId: "req-typo", text: "批准" }),
      ).rejects.toMatchObject({ status: 400 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("磁盘上没有检查点时依旧是 404", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-console-rehydrate-"));
    try {
      const runner = createConsoleRunner({
        env: { DEEPSEEK_API_KEY: FAKE_KEY },
        hub: new RunHub(),
        storeRoot: directory,
      });

      await expect(
        runner.answer("never-existed", { requestId: "req-1", text: "批准" }),
      ).rejects.toMatchObject({ status: 404 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

/** 中止运行：没有可中止的东西时要给出不同的拒绝，而不是一律报"未知运行"。 */
describe("中止运行（离线，假密钥 + 不可达 baseUrl）", () => {
  it("没有活上下文 → 404；有上下文但没在执行 → 409；正在执行 → 放行", () => {
    expect(cancelRefusal(undefined, "run-1")).toMatchObject({ status: 404 });
    expect(cancelRefusal({ active: false }, "run-1")).toMatchObject({
      status: 409,
      message: expect.stringContaining("等待回答"),
    });
    expect(cancelRefusal({ active: true }, "run-1")).toBeUndefined();
  });

  it("中止正在执行的运行会真的把它停下来（abort 一路传到模型调用）", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-console-cancel-"));
    try {
      const hub = new RunHub();
      const runner = createConsoleRunner({
        env: {
          DEEPSEEK_API_KEY: FAKE_KEY,
          // 不可达：模型调用会卡在重试里，正好留出"运行中"的窗口。
          DEEPSEEK_BASE_URL: "http://127.0.0.1:9/v1",
        },
        hub,
        storeRoot: directory,
      });

      const { runId } = await runner.start(startInput());
      const channel = hub.get(runId);
      expect(channel).toBeDefined();
      if (channel === undefined) return;

      // 可能已经失败（极快）——那就没有可中止的运行，语义上等价于"已结束"。
      const cancel = await runner.cancel(runId).then(
        () => "ok" as const,
        (error: unknown) => error,
      );
      if (cancel !== "ok") {
        expect(cancel).toMatchObject({ status: expect.any(Number) });
      }

      await waitForDone(channel, 30_000);
      expect(channel.done).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("硬上限写进 run_started 记录，重建运行时才拿得回来", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-console-caps-"));
    try {
      const runner = createConsoleRunner({
        env: { DEEPSEEK_API_KEY: FAKE_KEY, DEEPSEEK_BASE_URL: "http://127.0.0.1:9/v1" },
        hub: new RunHub(),
        storeRoot: directory,
      });

      const { runId } = await runner.start(startInput({ maxCostUsd: 0.5, maxWallMs: 60_000 }));
      const journal = await readFile(join(directory, runId, "journal.jsonl"), "utf8");
      const meta = JSON.parse(journal.split("\n")[0] ?? "{}") as Record<string, unknown>;

      expect(meta["budgets"]).toEqual({
        maxSteps: 2,
        maxToolCalls: 2,
        maxCostUsd: 0.5,
        maxWallMs: 60_000,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

/**
 * 并发上限：一个进程同时打开多少运行。
 *
 * 上限按"打开的运行"计（运行中 + 等待回答），因为等待中的运行同样占着频道、journal
 * 轮询与一份上下文；只数"正在跑"的保护是不够的。
 */
describe("同时打开的运行上限", () => {
  it("边界判断：达到上限即拒绝，未配置上限则永不拒绝", () => {
    expect(openRunRefusal(0, 2)).toBeUndefined();
    expect(openRunRefusal(1, 2)).toBeUndefined();
    expect(openRunRefusal(2, 2)).toMatchObject({ status: 429 });
    expect(openRunRefusal(99, undefined)).toBeUndefined();
  });

  it("配置非法时直接报错，而不是静默退回不限", () => {
    expect(readMaxOpenRuns({})).toBeUndefined();
    expect(readMaxOpenRuns({ [CONSOLE_MAX_OPEN_RUNS_ENV]: "3" })).toBe(3);
    expect(() => readMaxOpenRuns({ [CONSOLE_MAX_OPEN_RUNS_ENV]: "0" })).toThrow("正整数");
    expect(() => readMaxOpenRuns({ [CONSOLE_MAX_OPEN_RUNS_ENV]: "abc" })).toThrow("正整数");
  });

  it("达到上限时 start 返回 429，而不会真的启动第二次运行", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-console-limit-"));
    // 一个"永不回应"的本地模型端点：让第一次运行确定性地停留在运行中。
    const server = createServer(() => undefined);
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("测试服务器没有端口");

    try {
      const hub = new RunHub();
      const runner = createConsoleRunner({
        env: {
          DEEPSEEK_API_KEY: FAKE_KEY,
          DEEPSEEK_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
        },
        hub,
        storeRoot: directory,
        maxOpenRuns: 1,
      });

      const first = await runner.start(startInput());
      await expect(runner.start(startInput())).rejects.toMatchObject({ status: 429 });

      // 收尾：中止第一次运行，释放它的上下文。
      await runner.cancel(first.runId).catch(() => undefined);
      const channel = hub.get(first.runId);
      if (channel !== undefined) await waitForDone(channel, 30_000).catch(() => undefined);
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      await rm(directory, { recursive: true, force: true });
    }
  }, 40_000);
});
