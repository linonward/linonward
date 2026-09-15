import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

import type { PlanDraft, PlanEvaluation, Planner } from "../src/planner.js";
import { defineTool } from "../src/tool.js";
import { ToolRegistry } from "../src/tool-registry.js";
import type { AcceptanceCriterion, PlanStep, TaskPlan } from "../src/types.js";

/** 每个测试在独立临时目录里建 fixture，`afterEach` 负责清理。 */
export async function makeTempDir(prefix = "agent-fixture-"): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

export async function removeTempDir(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true });
}

export interface RecordedEvaluation {
  stepId: string;
  observations: string[];
}

export interface RecordedRevision {
  reason: string;
  observations: string[];
}

/** 可脚本化的 Planner：只返回固定候选，不做任何模型调用。 */
export class ScriptedPlanner implements Planner {
  readonly evaluations: RecordedEvaluation[] = [];
  readonly revisions: RecordedRevision[] = [];
  readonly createInputs: Array<{ goal: string; context: string; availableTools: string[] }> = [];

  constructor(
    private readonly draft: PlanDraft,
    private readonly scriptedEvaluations: PlanEvaluation[] = [],
    private readonly revisedDraft?: PlanDraft,
  ) {}

  async create(input: {
    goal: string;
    context: string;
    availableTools: string[];
  }): Promise<PlanDraft> {
    this.createInputs.push(input);
    return this.draft;
  }

  async revise(input: {
    current: TaskPlan;
    reason: string;
    observations: string[];
  }): Promise<PlanDraft> {
    this.revisions.push({ reason: input.reason, observations: input.observations });
    return this.revisedDraft ?? this.draft;
  }

  async evaluate(input: { step: PlanStep; observations: string[] }): Promise<PlanEvaluation> {
    this.evaluations.push({ stepId: input.step.id, observations: input.observations });
    const next = this.scriptedEvaluations.shift();
    if (!next) throw new Error("scripted_planner_has_no_evaluation");
    return next;
  }
}

/** 每次都把本轮全部 observation 当作证据，用于验证 Harness 的归约边界。 */
export class CompletingPlanner implements Planner {
  readonly revisions: RecordedRevision[] = [];

  constructor(
    private readonly draft: PlanDraft,
    private readonly passedCriteria: string[] = [],
  ) {}

  async create(): Promise<PlanDraft> {
    return this.draft;
  }

  async revise(input: {
    current: TaskPlan;
    reason: string;
    observations: string[];
  }): Promise<PlanDraft> {
    this.revisions.push({ reason: input.reason, observations: input.observations });
    return this.draft;
  }

  async evaluate(input: { step: PlanStep; observations: string[] }): Promise<PlanEvaluation> {
    return {
      completed: true,
      evidence: [...input.observations],
      passedCriteria: [...this.passedCriteria],
    };
  }
}

/** 完成当前 step，并用本轮第一条 observation 作为证据。 */
export function completeFromObservations(passedCriteria: string[] = []): PlanEvaluation {
  return {
    completed: true,
    evidence: [],
    passedCriteria,
  };
}

export function completeWith(
  evidence: string[],
  passedCriteria: string[] = [],
  replanReason?: PlanEvaluation["replanReason"],
): PlanEvaluation {
  return replanReason === undefined
    ? { completed: true, evidence, passedCriteria }
    : { completed: true, evidence, passedCriteria, replanReason };
}

export function notCompleted(evidence: string[] = []): PlanEvaluation {
  return { completed: false, evidence, passedCriteria: [] };
}

export function makeDraft(options: {
  criteria?: Array<{ id: string; description: string }>;
  steps?: Array<{
    id: string;
    title: string;
    dependsOn?: string[];
    completionEvidence?: string;
  }>;
}): PlanDraft {
  return {
    acceptanceCriteria: options.criteria ?? [{ id: "criterion-1", description: "任务结果可验证" }],
    steps: (
      options.steps ?? [
        {
          id: "step-1",
          title: "调查并完成工作",
          dependsOn: [],
          completionEvidence: "工具 observation",
        },
      ]
    ).map((step) => ({
      id: step.id,
      title: step.title,
      dependsOn: step.dependsOn ?? [],
      completionEvidence: step.completionEvidence ?? "工具 observation",
    })),
  };
}

export function criterion(
  id: string,
  status: AcceptanceCriterion["status"] = "unverified",
): AcceptanceCriterion {
  return { id, description: `验收条件 ${id}`, status };
}

export function planStep(id: string, overrides: Partial<PlanStep> = {}): PlanStep {
  return {
    id,
    title: `步骤 ${id}`,
    status: "pending",
    dependsOn: [],
    completionEvidence: "可观察证据",
    evidence: [],
    ...overrides,
  };
}

export function makeTaskPlan(overrides: Partial<TaskPlan> = {}): TaskPlan {
  return {
    version: 1,
    goal: "完成示例任务",
    acceptanceCriteria: [criterion("criterion-1")],
    steps: [planStep("step-1")],
    ...overrides,
  };
}

export const echoTool = defineTool({
  name: "echo",
  description: "Echo one string back. Used to observe the executor contract.",
  effect: "read",
  schema: z.object({ value: z.string().min(1) }).strict(),
  async execute(input) {
    return { echoed: input.value };
  },
});

export const failingTool = defineTool({
  name: "boom",
  description: "Always throws so the executor has to fold it into an observation.",
  effect: "read",
  schema: z.object({}).strict(),
  async execute() {
    throw new Error("tool exploded");
  },
});

export const slowTool = defineTool({
  name: "slow",
  description: "Never resolves unless the injected signal aborts.",
  effect: "read",
  schema: z.object({}).strict(),
  async execute(_input, context) {
    return new Promise((_resolve, reject) => {
      context.signal.addEventListener("abort", () => reject(new Error("aborted")), {
        once: true,
      });
    });
  },
});

export const hugeTool = defineTool({
  name: "huge",
  description: "Returns far more than the observation limit so truncation is observable.",
  effect: "read",
  schema: z.object({ size: z.number().int().positive() }).strict(),
  async execute(input) {
    return { blob: "x".repeat(input.size) };
  },
});

export const externalTool = defineTool({
  name: "publish_report",
  description: "Pretends to send data outside the workspace.",
  effect: "external",
  schema: z.object({ target: z.string().min(1) }).strict(),
  async execute(input) {
    return { sent: input.target };
  },
});

export function createRegistry(...tools: Parameters<ToolRegistry["register"]>[0][]): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of tools) registry.register(tool);
  return registry;
}
