import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RunList } from "../src/components/RunList.js";
import { type JournalRecord, projectRun } from "../src/lib/journal.js";
import type { RunSnapshotView } from "../src/lib/snapshot.js";
import { RunConsole } from "../src/RunConsole.js";

/** 一轮带思维链与工具调用 + 一轮没有推理的离线记录。 */
function records(): JournalRecord[] {
  return [
    {
      kind: "run_started",
      at: "2024-01-01T00:00:00.000Z",
      task: "读取 package.json",
      cwd: "/workspace",
      budgets: { maxSteps: 4, maxToolCalls: 8 },
      allowedArgv: [],
      requireSandbox: false,
      modelId: "deepseek-v4-flash",
    },
    {
      kind: "model_request",
      at: "2024-01-01T00:00:00.100Z",
      step: 1,
      phase: "start",
      instructions: "SYSTEM PROMPT",
      input: [{ role: "user", content: "读取 package.json" }],
      outputs: [],
      toolNames: ["read_file"],
    },
    {
      kind: "model_response",
      at: "2024-01-01T00:00:01.000Z",
      step: 1,
      phase: "start",
      responseId: "response-1",
      finalText: "",
      reasoning: ["先看看 package.json 的 workspaces。"],
      toolCalls: [
        { callId: "call-1", name: "read_file", argumentsJson: '{"path":"package.json"}' },
      ],
      durationMs: 900,
    },
    {
      kind: "tool_call",
      callId: "call-1",
      name: "read_file",
      argumentsJson: '{"path":"package.json"}',
      durationMs: 4,
    },
    {
      kind: "tool_result",
      callId: "call-1",
      name: "read_file",
      durationMs: 4,
      ok: true,
      effect: "read",
      output: '{"ok":true,"data":{"workspaces":["apps/*"]}}',
      policy: { type: "allow" },
    },
    {
      kind: "usage",
      scope: "model",
      step: 1,
      phase: "start",
      model: "deepseek-v4-flash",
      inputTokens: 120,
      outputTokens: 30,
      durationMs: 900,
      costUsd: 0.0001,
    },
    {
      kind: "model_response",
      at: "2024-01-01T00:00:02.000Z",
      step: 2,
      phase: "continue",
      responseId: "response-2",
      finalText: "仓库里有 apps/* 与 packages/*。",
      toolCalls: [],
      durationMs: 500,
    },
    { kind: "plan_revised", at: "2024-01-01T00:00:02.500Z", version: 2, reason: "补充验收条件" },
    {
      kind: "usage",
      scope: "run",
      modelCalls: 2,
      toolCalls: 1,
      inputTokens: 200,
      outputTokens: 60,
      cachedInputTokens: 10,
      wallMs: 2_000,
      costUsd: 0.0002,
      prices: { asOf: "2024-01-01", source: "deepseek" },
      costBasis: "缓存按命中价计",
    },
    {
      kind: "run_stopped",
      at: "2024-01-01T00:00:03.000Z",
      status: "completed",
      stopReason: "final_answer",
    },
  ];
}

const noop = (): void => undefined;

describe("RunConsole 渲染", () => {
  it("时间线渲染出模型思考、工具结果与用量/成本面板", () => {
    const view = projectRun("run-1", records());
    const html = renderToStaticMarkup(
      <RunConsole
        view={view}
        streaming={false}
        paused={false}
        onTogglePause={noop}
        onStop={noop}
        onAnswer={noop}
        onNew={noop}
      />,
    );

    // 思维链：有推理的一轮展示内容，没有推理的一轮明确写出"未返回可见推理"。
    expect(html).toContain("模型思考");
    expect(html).toContain("先看看 package.json 的 workspaces。");
    expect(html).toContain("（模型未返回可见推理）");

    // 模型输出与工具调用 / 结果。
    expect(html).toContain("仓库里有 apps/* 与 packages/*。");
    expect(html).toContain('data-testid="tool-call-1"');
    expect(html).toContain("read_file");
    expect(html).toContain(
      "{&quot;ok&quot;:true,&quot;data&quot;:{&quot;workspaces&quot;:[&quot;apps/*&quot;]}}",
    );

    // 用量与成本面板。
    expect(html).toContain('data-testid="usage-panel"');
    expect(html).toContain("估算成本");
    expect(html).toContain("$0.000200");
    expect(html).toContain("缓存 tokens");
    expect(html).toContain("预算");

    // 结束横幅与计划变化。
    expect(html).toContain("运行结束");
    expect(html).toContain("stopReason=final_answer");
    expect(html).toContain("补充验收条件");
  });

  it("成本算不出时明确显示 cost=unknown", () => {
    const view = projectRun(
      "run-1",
      records().map((record) =>
        record["kind"] === "usage" && record["scope"] === "run"
          ? { ...record, costUsd: undefined }
          : record,
      ),
    );
    const html = renderToStaticMarkup(
      <RunConsole
        view={view}
        streaming={false}
        paused={false}
        onTogglePause={noop}
        onStop={noop}
        onAnswer={noop}
        onNew={noop}
      />,
    );

    expect(html).toContain("cost=unknown");
  });
});

/** `GET /api/runs/:runId` 的解析结果：频道没了之后界面唯一的数据源。 */
function snapshot(overrides: Partial<RunSnapshotView> = {}): RunSnapshotView {
  return {
    runId: "run-1",
    task: "读取 package.json 并总结",
    savedAt: "2024-01-01T00:00:05.000Z",
    status: "waiting",
    stopReason: "approval_required",
    budget: { maxSteps: 6, maxToolCalls: 12, modelSteps: 1, toolCalls: 1 },
    usage: {
      inputTokens: 1_262,
      outputTokens: 64,
      cachedInputTokens: 1_024,
      modelCalls: 1,
      wallMs: 3_000,
      costUsd: 0.000613,
    },
    changedFiles: [],
    pending: {
      requestId: "req-1",
      question: "是否允许执行 run_command？",
      reason: "策略要求人工批准",
    },
    ...overrides,
  };
}

describe("RunConsole 的 checkpoint 快照面板", () => {
  it("实时流不可用时，用快照说清状态、预算与成本", () => {
    const html = renderToStaticMarkup(
      <RunConsole
        view={projectRun("run-1", [])}
        streaming={false}
        paused={false}
        snapshot={snapshot()}
        streamUnavailable
        onTogglePause={noop}
        onStop={noop}
        onAnswer={noop}
        onNew={noop}
      />,
    );

    expect(html).toContain('data-testid="snapshot-panel"');
    expect(html).toContain("运行快照（来自 checkpoint）");
    expect(html).toContain("实时流不可用");
    expect(html).toContain("读取 package.json 并总结");
    expect(html).toContain("waiting");
    expect(html).toContain("approval_required");
    expect(html).toContain("1/6");
    expect(html).toContain("1/12");
    expect(html).toContain("$0.000613");
  });

  it("频道还在时，快照里的待答请求渲染成可提交的输入框", () => {
    const html = renderToStaticMarkup(
      <RunConsole
        view={projectRun("run-1", [])}
        streaming
        paused={false}
        snapshot={snapshot()}
        onTogglePause={noop}
        onStop={noop}
        onAnswer={noop}
        onNew={noop}
      />,
    );

    expect(html).toContain('data-testid="answer-box"');
    expect(html).toContain("需要回答（requestId=req-1）");
    expect(html).toContain("是否允许执行 run_command？");
    expect(html).toContain("策略要求人工批准");
  });

  it("进程重启后（频道没了）不再给输入框，只说明在等什么、为什么答不了", () => {
    const html = renderToStaticMarkup(
      <RunConsole
        view={projectRun("run-1", [])}
        streaming={false}
        paused={false}
        snapshot={snapshot()}
        streamUnavailable
        onTogglePause={noop}
        onStop={noop}
        onAnswer={noop}
        onNew={noop}
      />,
    );

    expect(html).not.toContain('data-testid="answer-box"');
    expect(html).toContain("等待回答");
    expect(html).toContain("requestId=req-1");
    expect(html).toContain("无法继续");
  });

  it("没有快照时不渲染快照面板", () => {
    const html = renderToStaticMarkup(
      <RunConsole
        view={projectRun("run-1", records())}
        streaming={false}
        paused={false}
        onTogglePause={noop}
        onStop={noop}
        onAnswer={noop}
        onNew={noop}
      />,
    );

    expect(html).not.toContain('data-testid="snapshot-panel"');
    expect(html).not.toContain("实时流不可用");
  });
});

describe("RunList 渲染", () => {
  it("列出最近的运行，并标出还在实时接收的那些", () => {
    const html = renderToStaticMarkup(
      <RunList
        runs={[
          {
            runId: "run-live",
            task: "正在跑的任务",
            status: "running",
            savedAt: "2024-01-02T00:00:00.000Z",
            live: true,
          },
          { runId: "run-done", status: "completed", stopReason: "final_answer", live: false },
        ]}
        onOpen={noop}
      />,
    );

    expect(html).toContain('data-testid="run-list"');
    expect(html).toContain("run-live");
    expect(html).toContain("正在跑的任务");
    expect(html).toContain("实时");
    expect(html).toContain("run-done");
    expect(html).toContain("final_answer");
    // 每一项都是可点的打开按钮。
    expect(html).toContain("打开");
  });

  it("没有历史运行时整块不渲染", () => {
    const html = renderToStaticMarkup(<RunList runs={[]} onOpen={noop} />);

    expect(html).toBe("");
  });
});
