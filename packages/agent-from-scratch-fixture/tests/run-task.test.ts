import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ModelRequest } from "../src/context.js";
import type { FunctionCallOutput, ModelDriver, ModelTurn, ToolDefinition } from "../src/model.js";
import type { PlanDraft, PlanEvaluation, Planner } from "../src/planner.js";
import { createRealTaskRegistry, runRealTask } from "../src/run-task.js";
import type { PlanStep, TaskPlan } from "../src/types.js";
import { makeDraft, makeTempDir, removeTempDir } from "./support.js";

type ContinueInput = Parameters<ModelDriver["continue"]>[0];

/** 第一轮请求工具，第二轮直接给最终答案；断言 Loop 与驱动真的串起来了。 */
class ScriptedDriver implements ModelDriver {
  readonly started: ModelRequest[] = [];
  readonly continued: FunctionCallOutput[][] = [];
  private step = 0;

  async start(input: { request: ModelRequest; tools: ToolDefinition[] }): Promise<ModelTurn> {
    this.started.push(input.request);
    this.step += 1;
    return {
      responseId: `resp-${this.step}`,
      finalText: "",
      toolCalls: [
        { callId: "call-1", name: "read_file", argumentsJson: '{"path":"package.json"}' },
      ],
    };
  }

  async continue(input: ContinueInput): Promise<ModelTurn> {
    this.continued.push(input.outputs);
    this.step += 1;
    return { responseId: `resp-${this.step}`, finalText: "包管理器是 pnpm。", toolCalls: [] };
  }
}

/** 工具批次之后把 step 标记完成，并让唯一验收条件通过。 */
class OneShotPlanner implements Planner {
  constructor(private readonly draft: PlanDraft) {}

  async create(): Promise<PlanDraft> {
    return this.draft;
  }

  async revise(input: {
    current: TaskPlan;
    reason: string;
    observations: string[];
  }): Promise<PlanDraft> {
    void input;
    return this.draft;
  }

  async evaluate(input: { step: PlanStep; observations: string[] }): Promise<PlanEvaluation> {
    return {
      completed: true,
      evidence: [...input.observations],
      passedCriteria: ["criterion-1"],
    };
  }
}

/** 故意返回伪造证据：Loop 的 `assertEvidenceComesFromObservations` 必须拦下。 */
class FabricatingPlanner extends OneShotPlanner {
  override async evaluate(): Promise<PlanEvaluation> {
    return { completed: true, evidence: ["编造的证据"], passedCriteria: ["criterion-1"] };
  }
}

describe("runRealTask offline assembly", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const directory of tempDirs.splice(0)) await removeTempDir(directory);
  });

  it("wires tools, persistence, trace and leases around the real loop", async () => {
    const workspace = await makeTempDir("real-task-ws-");
    const storeRoot = await makeTempDir("real-task-store-");
    tempDirs.push(workspace, storeRoot);
    await writeFile(join(workspace, "package.json"), '{"packageManager":"pnpm@12.4.1"}\n');

    const driver = new ScriptedDriver();
    const outcome = await runRealTask({
      cwd: workspace,
      storeRoot,
      model: driver,
      planner: new OneShotPlanner(makeDraft({})),
      skillsDirectory: join(workspace, "missing-skills"),
      maxSteps: 4,
      maxToolCalls: 4,
    });

    expect(outcome.result.stopReason).toBe("final_answer");
    expect(outcome.result.answer).toBe("包管理器是 pnpm。");
    expect(outcome.summary.modelSteps).toBe(2);
    expect(outcome.summary.toolCalls).toBe(1);
    expect(outcome.result.state.changedFiles).toEqual([]);
    expect(driver.continued).toHaveLength(1);
    expect(driver.continued[0]?.[0]?.call_id).toBe("call-1");

    // trace 记录的是事件类型序列，而不是空数组。
    expect(outcome.trace.length).toBeGreaterThan(0);
    expect(outcome.trace.every((event) => event.runId === outcome.summary.runId)).toBe(true);

    // 持久化真的落了盘：事件 JSON 按序号命名，第一条必须是 run_started。
    const runDirectory = join(storeRoot, outcome.summary.runId);
    const events = await readdir(join(runDirectory, "events"));
    expect(events.length).toBeGreaterThanOrEqual(6);
    expect(events[0]).toBe("00000001.json");
    expect(new Set(events).size).toBe(events.length);
    const first = JSON.parse(await readFile(join(runDirectory, "events", "00000001.json"), "utf8"));
    expect((first as { event: { type: string } }).event.type).toBe("run_started");

    // lease 在结束前被释放，不再阻塞后续恢复。
    await expect(readdir(runDirectory)).resolves.not.toContain("lease.json");
  });

  it("stops with invalid_model_output when the planner fabricates evidence", async () => {
    const workspace = await makeTempDir("real-task-ws-");
    const storeRoot = await makeTempDir("real-task-store-");
    tempDirs.push(workspace, storeRoot);
    await writeFile(join(workspace, "package.json"), "{}\n");

    const outcome = await runRealTask({
      cwd: workspace,
      storeRoot,
      model: new ScriptedDriver(),
      planner: new FabricatingPlanner(makeDraft({})),
      skillsDirectory: join(workspace, "missing-skills"),
      maxSteps: 4,
      maxToolCalls: 4,
    });

    expect(outcome.result.stopReason).toBe("invalid_model_output");
  });

  /**
   * 真实提供方（DeepSeek Responses API）要求每个函数的 `parameters` 顶层是
   * `type: "object"`；`z.discriminatedUnion` 之类会生成没有顶层类型的 `anyOf` 并直接 400。
   * 每轮都会把所有工具随请求发送，所以任何一个工具不合规都会让真实运行在第一轮就失败。
   */
  it("ships only top-level object schemas, which real providers require", () => {
    const definitions = createRealTaskRegistry().definitions();

    expect(definitions.map((definition) => definition.name).toSorted()).toEqual([
      "apply_patch",
      "read_file",
      "run_command",
      "search_text",
    ]);

    for (const definition of definitions) {
      expect(definition.parameters["type"], `${definition.name} parameters`).toBe("object");
      expect(definition.parameters["properties"], `${definition.name} properties`).toBeTypeOf(
        "object",
      );
    }
  });
});
