import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { AgentLoopEvent } from "../src/agent-loop.js";
import type { ModelDriver } from "../src/model.js";
import type { PlanDraft, PlanEvaluation, Planner } from "../src/planner.js";
import { createResponsesHttpClient, resolveDeepSeekConfig } from "../src/responses-http.js";
import { createStatelessResponsesDriver } from "../src/responses-stateless-driver.js";
import { createDeepSeekTaskModels, type RunRealTaskOptions, runRealTask } from "../src/run-task.js";
import { InMemoryTraceSink } from "../src/trace.js";
import type { ValidationSpec } from "../src/types.js";
import { CompletingPlanner, makeDraft, makeTempDir, removeTempDir } from "./support.js";

const E2E_TIMEOUT_MS = 300_000;

/**
 * task 2 的确定性规划器：只有当观测里出现**成功的补丁结果**时才完成步骤，
 * 并同时把验收条件标成 passed。真正卡住"提前宣布完成"的是 `checkCompletion`：
 * 它要求存在绑定当前 `mutationRevision` 与 criterion 的 ValidationRecord。
 */
function patchAwarePlanner(draft: PlanDraft, criterionId: string): Planner {
  return {
    create: async () => draft,
    revise: async () => draft,
    evaluate: async ({ observations }): Promise<PlanEvaluation> => {
      const patched = observations.some(
        (item) => item.includes('"operation":"update"') || item.includes('"operation": "update"'),
      );
      return patched
        ? { completed: true, evidence: [...observations], passedCriteria: [criterionId] }
        : { completed: false, evidence: [], passedCriteria: [] };
    },
  };
}

/** 在临时目录里造一个小仓库：package.json + src/cli.ts + tests/cli.test.ts + README.md。 */
async function writeFixture(cwd: string): Promise<void> {
  await mkdir(join(cwd, "src"), { recursive: true });
  await mkdir(join(cwd, "tests"), { recursive: true });

  await writeFile(
    join(cwd, "package.json"),
    `${JSON.stringify(
      {
        name: "e2e-fixture-repo",
        private: true,
        packageManager: "pnpm@12.4.1",
        scripts: {
          test: "vitest run",
          build: "tsc --build",
          lint: "eslint .",
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    join(cwd, "src", "cli.ts"),
    [
      "export function main(argv: string[]): number {",
      '  if (argv.includes("--help")) {',
      '    console.log("usage: cli [--help]");',
      "    return 0;",
      "  }",
      "  return 0;",
      "}",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(cwd, "tests", "cli.test.ts"),
    [
      'import { expect, it } from "vitest";',
      'import { main } from "../src/cli.js";',
      "",
      'it("prints help", () => {',
      '  expect(main(["--help"])).toBe(0);',
      "});",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(cwd, "README.md"),
    "# E2E Fixture Repo\n\n这是一个用于真实模型端到端测试的临时仓库。\n",
  );
}

interface RealRunInput {
  cwd: string;
  storeRoot: string;
  task: string;
  model: ModelDriver;
  planner: Planner;
  allowedArgv: string[][];
  validationSpecs?: ValidationSpec[] | undefined;
  onEvent?: ((event: AgentLoopEvent) => void) | undefined;
}

/**
 * 装配真实运行：策略白名单来自 `allowedArgv`，批准由 `runRealTask` 的
 * `autoApproveAllowedCommands` 处理（白名单仍是硬边界）。
 */
async function run(input: RealRunInput): Promise<Awaited<ReturnType<typeof runRealTask>>> {
  const options: RunRealTaskOptions = {
    cwd: input.cwd,
    model: input.model,
    planner: input.planner,
    storeRoot: input.storeRoot,
    trace: new InMemoryTraceSink(),
    allowedArgv: input.allowedArgv,
    autoApproveAllowedCommands: true,
    maxSteps: 24,
    maxToolCalls: 48,
  };
  if (input.validationSpecs !== undefined) options.validationSpecs = input.validationSpecs;
  if (input.onEvent !== undefined) options.onEvent = input.onEvent;
  return runRealTask(options);
}

const enabled = Boolean(process.env["DEEPSEEK_API_KEY"]);

describe.skipIf(!enabled)("DeepSeek Responses API end-to-end", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const directory of tempDirs.splice(0)) await removeTempDir(directory);
  });

  it(
    "task 1 (read only): reports the package manager and scripts from package.json",
    async () => {
      const config = resolveDeepSeekConfig();
      const workspace = await makeTempDir("deepseek-e2e-repo-");
      const storeRoot = await makeTempDir("deepseek-e2e-store-");
      tempDirs.push(workspace, storeRoot);
      await writeFixture(workspace);

      const client = createResponsesHttpClient({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        timeoutMs: 120_000,
      });
      const model = createStatelessResponsesDriver({ client, modelId: config.model });
      // 规划器是 Harness 组件：真实 e2e 固定它，才能把"模型是否愿意按 JSON 契约规划"
      // 这个变量排除掉（该契约由 tests/planner-model.test.ts 离线覆盖）。
      // 模型、工具、文件、命令、完成门禁全部是真实路径。
      const planner = new CompletingPlanner(
        makeDraft({
          criteria: [
            { id: "criterion-read", description: "报告 package.json 的包管理器与 scripts" },
          ],
          steps: [{ id: "inspect", title: "读取 package.json 并报告包管理器与 scripts" }],
        }),
        ["criterion-read"],
      );

      const events: string[] = [];
      const outcome = await run({
        cwd: workspace,
        storeRoot,
        task:
          "读取 package.json，告诉我这个项目用哪个包管理器，并列出 scripts 里的命令。" +
          "这是一个只读任务：不要修改任何文件。",
        model,
        planner,
        allowedArgv: [],
        onEvent: (event) => events.push(event.type),
      });

      console.log("[e2e task 1] summary", JSON.stringify(outcome.summary));
      console.log("[e2e task 1] events", JSON.stringify(events));
      console.log("[e2e task 1] answer", outcome.result.answer);

      expect(outcome.result.stopReason).toBe("final_answer");
      expect(outcome.result.answer).toContain("pnpm");

      const observed = outcome.result.state.contextSources.filter(
        (source) => source.kind === "tool_observation",
      );
      expect(observed.length).toBeGreaterThan(0);
      expect(observed.map((source) => source.label).join(" ")).toMatch(/read_file|search_text/);
      expect(observed.some((source) => source.content.includes("pnpm"))).toBe(true);
      expect(events).toContain("run_started");
      expect(events).toContain("run_stopped");
    },
    E2E_TIMEOUT_MS,
  );

  it(
    "task 2 (write + verify): edits README.md and runs a whitelisted command",
    async () => {
      const config = resolveDeepSeekConfig();
      const workspace = await makeTempDir("deepseek-e2e-repo-");
      const storeRoot = await makeTempDir("deepseek-e2e-store-");
      tempDirs.push(workspace, storeRoot);
      await writeFixture(workspace);

      const client = createResponsesHttpClient({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        timeoutMs: 120_000,
      });
      const model = createStatelessResponsesDriver({ client, modelId: config.model });
      const criterionId = "criterion-e2e";
      const planner = patchAwarePlanner(
        makeDraft({
          criteria: [{ id: criterionId, description: "README 第一行已修改且有当前版本的验证证据" }],
          steps: [{ id: "edit-readme", title: "修改 README.md 并运行 node --version" }],
        }),
        criterionId,
      );
      const validationSpecs: ValidationSpec[] = [
        { command: "node", args: ["--version"], criterionIds: [criterionId] },
      ];

      const events: string[] = [];
      const outcome = await run({
        cwd: workspace,
        storeRoot,
        task:
          "任务：把 README.md 的**第一行整行**精确替换为 `# Hello Agent`（不要保留原文、不要加任何后缀）。" +
          "先 read_file 拿到 sha256，再用 apply_patch 的 update 操作完成这次替换，" +
          "然后必须用 run_command 运行 `node --version` 作为验收证据。",
        model,
        planner,
        allowedArgv: [["node", "--version"]],
        validationSpecs,
        onEvent: (event) => events.push(event.type),
      });

      console.log("[e2e task 2] summary", JSON.stringify(outcome.summary));
      console.log("[e2e task 2] events", JSON.stringify(events));
      console.log("[e2e task 2] answer", outcome.result.answer);

      const readme = await readFile(join(workspace, "README.md"), "utf8");
      console.log("[e2e task 2] README.md", JSON.stringify(readme));

      // 硬断言的是 Harness 保证的"受控写入真的发生"：第一行被改写、
      // 变更文件被记录、mutationRevision 前进。措辞与是否顺手跑了验收命令
      // 取决于模型的指令遵循程度（实测 deepseek-flash 两者都不稳定），所以只记录。
      expect(readme.split("\n")[0]).not.toBe("# E2E Fixture Repo");
      expect(outcome.result.state.changedFiles).toContain("README.md");
      expect(outcome.result.state.mutationRevision).toBeGreaterThan(0);

      const validatedOnCurrentRevision = outcome.result.state.validations.some(
        (validation) =>
          validation.validatedRevision === outcome.result.state.mutationRevision &&
          validation.status === "passed" &&
          validation.criterionIds.includes(criterionId),
      );
      console.log(
        "[e2e task 2] patch applied",
        JSON.stringify({
          stopReason: outcome.result.stopReason,
          mutationRevision: outcome.result.state.mutationRevision,
          validations: outcome.result.state.validations.length,
          validatedOnCurrentRevision,
        }),
      );
    },
    E2E_TIMEOUT_MS,
  );

  /**
   * 与前两条的对照点：这里**没有确定性规划器**，`create` / `evaluate`（必要时还有 `revise`）
   * 全部由真实模型完成。它验证的是"模型版规划器能否在一个简单只读任务上收敛到
   * `final_answer`"，而不是 Harness 的完成门禁。
   *
   * 循环模型与规划模型来自同一份 `DeepSeekConfig`：循环用 `DEEPSEEK_MODEL`，
   * 规划用 `DEEPSEEK_PLANNER_MODEL`（缺省回落到循环模型）。
   */
  it(
    "task 3 (read only, model planner): converges with the real planner model",
    async () => {
      const config = resolveDeepSeekConfig();
      const workspace = await makeTempDir("deepseek-e2e-repo-");
      const storeRoot = await makeTempDir("deepseek-e2e-store-");
      tempDirs.push(workspace, storeRoot);
      await writeFixture(workspace);

      const client = createResponsesHttpClient({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        timeoutMs: 120_000,
      });
      const { model, planner } = createDeepSeekTaskModels({ client, config });

      const events: string[] = [];
      const outcome = await run({
        cwd: workspace,
        storeRoot,
        task:
          "读取 package.json，告诉我这个项目用哪个包管理器，并列出 scripts 里的命令。" +
          "这是一个只读任务：不要修改任何文件。",
        model,
        planner,
        allowedArgv: [],
        onEvent: (event) => events.push(event.type),
      });

      console.log(
        "[e2e task 3] models",
        JSON.stringify({ loop: config.model, planner: config.plannerModel }),
      );
      console.log("[e2e task 3] summary", JSON.stringify(outcome.summary));
      console.log("[e2e task 3] events", JSON.stringify(events));
      console.log("[e2e task 3] answer", outcome.result.answer);

      expect(outcome.result.stopReason).toBe("final_answer");
      expect(outcome.result.answer).toContain("pnpm");

      const observed = outcome.result.state.contextSources.filter(
        (source) => source.kind === "tool_observation",
      );
      expect(observed.length).toBeGreaterThan(0);
      expect(observed.map((source) => source.label).join(" ")).toMatch(/read_file|search_text/);
      expect(observed.some((source) => source.content.includes("pnpm"))).toBe(true);
      expect(events).toContain("run_started");
      expect(events).toContain("run_stopped");
    },
    E2E_TIMEOUT_MS,
  );
});
