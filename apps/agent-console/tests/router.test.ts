import { createServer } from "node:http";

import { describe, expect, it } from "vitest";

import { RunHub } from "../server/bus.js";
import { createRequestHandler, matchRoute, parseRunInput } from "../server/router.js";
import { type ConsoleRunner, RunnerError, type StartRunInput } from "../server/runner.js";

interface FakeRunner {
  runner: ConsoleRunner;
  starts: StartRunInput[];
  answers: Array<{ runId: string; requestId: string; text: string }>;
}

function createFakeRunner(overrides: Partial<ConsoleRunner> = {}): FakeRunner {
  const starts: StartRunInput[] = [];
  const answers: Array<{ runId: string; requestId: string; text: string }> = [];
  const runner: ConsoleRunner = {
    start:
      overrides.start ??
      (async (input) => {
        starts.push(input);
        return { runId: "run-1" };
      }),
    answer:
      overrides.answer ??
      (async (runId, input) => {
        answers.push({ runId, requestId: input.requestId, text: input.text });
      }),
    snapshot:
      overrides.snapshot ??
      (async (runId) => {
        if (runId !== "run-1") return undefined;
        return { runId, status: "completed", stopReason: "final_answer", changedFiles: ["a.txt"] };
      }),
    list:
      overrides.list ??
      (async () => [
        {
          runId: "run-1",
          task: "读取 package.json",
          status: "completed",
          savedAt: "2024-01-01T00:00:05.000Z",
          live: false,
        },
      ]),
  };
  return { runner, starts, answers };
}

/** 起一个临时监听：真实 HTTP 路由 + 注入的假 runner，不碰网络也不碰密钥。 */
async function withServer(
  options: { runner: ConsoleRunner; hub: RunHub; env: NodeJS.ProcessEnv },
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const handle = createRequestHandler({ ...options, defaultCwd: "/tmp/workspace" });
  const server = createServer((request, response) => {
    handle(request, response).catch(() => {
      response.destroy();
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("临时服务器没有端口");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    await run(baseUrl);
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
}

const ENV_WITH_KEY: NodeJS.ProcessEnv = { DEEPSEEK_API_KEY: "sk-test-not-a-real-key" };

describe("matchRoute", () => {
  it("识别五条 API 路由", () => {
    expect(matchRoute("POST", "/api/run")).toEqual({ name: "start" });
    expect(matchRoute("GET", "/api/health")).toEqual({ name: "health" });
    expect(matchRoute("GET", "/api/runs")).toEqual({ name: "runs" });
    expect(matchRoute("GET", "/api/runs/abc/stream")).toEqual({ name: "stream", runId: "abc" });
    expect(matchRoute("GET", "/api/runs/abc")).toEqual({ name: "snapshot", runId: "abc" });
    expect(matchRoute("POST", "/api/runs/abc/answer")).toEqual({ name: "answer", runId: "abc" });
  });

  it("方法与路径不匹配时返回 undefined", () => {
    expect(matchRoute("GET", "/api/run")).toBeUndefined();
    expect(matchRoute("POST", "/api/runs/abc/stream")).toBeUndefined();
    expect(matchRoute("DELETE", "/api/runs/abc")).toBeUndefined();
    expect(matchRoute("GET", "/api")).toBeUndefined();
    expect(matchRoute("POST", "/api/runs")).toBeUndefined();
  });
});

describe("parseRunInput", () => {
  it("缺省值来自服务端：cwd / 预算 / 三个开关", () => {
    const input = parseRunInput({ task: " 做点事 " }, "/tmp/workspace");
    expect(input).toEqual({
      task: "做点事",
      cwd: "/tmp/workspace",
      allowedArgv: [],
      maxSteps: 16,
      maxToolCalls: 32,
      approveAllowed: false,
      requireSandbox: false,
      repeatGuard: true,
    });
  });

  it("非法字段一律 400", () => {
    expect(() => parseRunInput({}, "/tmp")).toThrow(RunnerError);
    expect(() => parseRunInput({ task: "x", maxSteps: 0 }, "/tmp")).toThrow("maxSteps 需要正整数");
    expect(() => parseRunInput({ task: "x", allowedArgv: [["a"], [1]] }, "/tmp")).toThrow(
      "allowedArgv 只接受字符串",
    );
    expect(() => parseRunInput({ task: "x", repeatGuard: "yes" }, "/tmp")).toThrow(
      "repeatGuard 需要布尔值",
    );
  });
});

describe("API 路由（注入假 runner）", () => {
  it("POST /api/run 返回 runId，并把表单字段透传给 runner", async () => {
    const fake = createFakeRunner();
    await withServer(
      { runner: fake.runner, hub: new RunHub(), env: ENV_WITH_KEY },
      async (base) => {
        const response = await fetch(`${base}/api/run`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            task: "读取 package.json",
            allowedArgv: [["node", "--version"]],
            maxSteps: 3,
            maxToolCalls: 5,
            approveAllowed: true,
            plannerModel: "deepseek-planner",
          }),
        });

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ runId: "run-1" });
        expect(fake.starts).toHaveLength(1);
        expect(fake.starts[0]).toMatchObject({
          task: "读取 package.json",
          cwd: "/tmp/workspace",
          allowedArgv: [["node", "--version"]],
          maxSteps: 3,
          maxToolCalls: 5,
          approveAllowed: true,
          plannerModel: "deepseek-planner",
        });
      },
    );
  });

  it("未配置 DEEPSEEK_API_KEY 时返回可读的 4xx，且不会启动运行", async () => {
    const fake = createFakeRunner({
      async start() {
        throw new RunnerError(400, "缺少 DEEPSEEK_API_KEY：请通过环境变量或调用方注入。");
      },
    });
    await withServer({ runner: fake.runner, hub: new RunHub(), env: {} }, async (base) => {
      const response = await fetch(`${base}/api/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ task: "x" }),
      });

      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toContain("DEEPSEEK_API_KEY");
    });
  });

  it("错误信息里的密钥会被脱敏", async () => {
    const fake = createFakeRunner({
      async start() {
        throw new RunnerError(500, `boom ${ENV_WITH_KEY["DEEPSEEK_API_KEY"] ?? ""}`);
      },
    });
    await withServer(
      { runner: fake.runner, hub: new RunHub(), env: ENV_WITH_KEY },
      async (base) => {
        const response = await fetch(`${base}/api/run`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ task: "x" }),
        });

        expect(response.status).toBe(500);
        const body = (await response.json()) as { error: string };
        expect(body.error).toBe("boom ***");
        expect(body.error).not.toContain("sk-test");
      },
    );
  });

  it("GET /api/runs 返回运行列表（用于重开已结束的运行）", async () => {
    const fake = createFakeRunner();
    await withServer(
      { runner: fake.runner, hub: new RunHub(), env: ENV_WITH_KEY },
      async (base) => {
        const response = await fetch(`${base}/api/runs`);
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({
          runs: [
            {
              runId: "run-1",
              task: "读取 package.json",
              status: "completed",
              savedAt: "2024-01-01T00:00:05.000Z",
              live: false,
            },
          ],
        });
      },
    );
  });

  it("运行列表里的密钥同样被脱敏", async () => {
    const fake = createFakeRunner({
      list: async () => [
        { runId: "run-1", task: `任务 ${ENV_WITH_KEY["DEEPSEEK_API_KEY"] ?? ""}`, live: false },
      ],
    });
    await withServer(
      { runner: fake.runner, hub: new RunHub(), env: ENV_WITH_KEY },
      async (base) => {
        const body = await (await fetch(`${base}/api/runs`)).text();
        expect(body).not.toContain("sk-test-not-a-real-key");
        expect(body).toContain("任务 ***");
      },
    );
  });

  it("GET /api/runs/:runId 返回 checkpoint 快照，未知运行 404", async () => {
    const fake = createFakeRunner();
    await withServer(
      { runner: fake.runner, hub: new RunHub(), env: ENV_WITH_KEY },
      async (base) => {
        const found = await fetch(`${base}/api/runs/run-1`);
        expect(found.status).toBe(200);
        await expect(found.json()).resolves.toMatchObject({
          status: "completed",
          changedFiles: ["a.txt"],
        });

        const missing = await fetch(`${base}/api/runs/nope`);
        expect(missing.status).toBe(404);
      },
    );
  });

  it("POST /api/runs/:runId/answer 走 answer 路径", async () => {
    const fake = createFakeRunner();
    await withServer(
      { runner: fake.runner, hub: new RunHub(), env: ENV_WITH_KEY },
      async (base) => {
        const response = await fetch(`${base}/api/runs/run-1/answer`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ requestId: "req-1", text: "同意" }),
        });

        expect(response.status).toBe(200);
        expect(fake.answers).toEqual([{ runId: "run-1", requestId: "req-1", text: "同意" }]);
      },
    );
  });

  it("SSE 先补发历史记录，再在 run_stopped 之后推 done 并关闭", async () => {
    const hub = new RunHub();
    const channel = hub.create("run-1");
    channel.push({ kind: "run_started", at: "2024-01-01T00:00:00.000Z", cwd: "/workspace" });
    channel.push({
      kind: "model_response",
      at: "2024-01-01T00:00:01.000Z",
      step: 1,
      phase: "start",
      responseId: "response-1",
      finalText: "",
      reasoning: ["先看看目录。"],
      toolCalls: [],
      durationMs: 5,
    });
    channel.push({
      kind: "run_stopped",
      at: "2024-01-01T00:00:02.000Z",
      status: "completed",
      stopReason: "final_answer",
    });
    channel.finish();

    await withServer(
      { runner: createFakeRunner().runner, hub, env: ENV_WITH_KEY },
      async (base) => {
        const response = await fetch(`${base}/api/runs/run-1/stream`);
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toContain("text/event-stream");

        const text = await response.text();
        const frames = text.split("\n\n").filter((frame) => frame.length > 0);
        const journalFrames = frames.filter((frame) => frame.includes("event: journal"));

        expect(journalFrames).toHaveLength(3);
        expect(journalFrames[0]).toContain("id: 1");
        expect(journalFrames[1]).toContain('"reasoning":["先看看目录。"]');
        expect(frames.at(-1)).toContain("event: done");
        expect(text).toContain('"stopReason":"final_answer"');
      },
    );
  });

  it("SSE 的 ?after= 只补发没见过的记录", async () => {
    const hub = new RunHub();
    const channel = hub.create("run-1");
    channel.push({ kind: "a" });
    channel.push({ kind: "b" });
    channel.finish();

    await withServer(
      { runner: createFakeRunner().runner, hub, env: ENV_WITH_KEY },
      async (base) => {
        const text = await (await fetch(`${base}/api/runs/run-1/stream?after=1`)).text();
        const journalFrames = text
          .split("\n\n")
          .filter((frame) => frame.includes("event: journal"));

        expect(journalFrames).toHaveLength(1);
        expect(journalFrames[0]).toContain('"kind":"b"');
        expect(text).toContain("event: done");
      },
    );
  });

  it("未知运行的 SSE 与未知路由都返回 404 JSON", async () => {
    await withServer(
      { runner: createFakeRunner().runner, hub: new RunHub(), env: ENV_WITH_KEY },
      async (base) => {
        const stream = await fetch(`${base}/api/runs/nope/stream`);
        expect(stream.status).toBe(404);
        expect(stream.headers.get("content-type")).toContain("application/json");

        const unknown = await fetch(`${base}/api/nothing`);
        expect(unknown.status).toBe(404);
      },
    );
  });
});
