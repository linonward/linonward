import { createServer } from "node:http";

import { detectSandbox } from "../../../packages/agent-from-scratch-fixture/src/sandbox.js";
import { RunHub } from "./bus.js";
import { readHost, readPort, startupRefusal } from "./entry-options.js";
import { createRequestHandler } from "./router.js";
import { createConsoleRunner } from "./runner.js";

const host = readHost(process.env);
const port = readPort(process.env);
const refusal = startupRefusal({ host, token: process.env["AGENT_CONSOLE_TOKEN"] });
if (refusal !== undefined) {
  process.stderr.write(`${refusal}\n`);
  process.exit(1);
}
const hub = new RunHub();
const runner = createConsoleRunner({ env: process.env, hub });
const handle = createRequestHandler({ runner, hub, env: process.env });

const server = createServer((request, response) => {
  handle(request, response).catch((error: unknown) => {
    // 兜底：处理器内部的错误已经映射成 JSON 响应，这里只保证连接不会挂住。
    if (!response.headersSent) {
      response.writeHead(500, { "content-type": "application/json; charset=utf-8" });
      response.end(
        JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
      );
      return;
    }
    response.end();
  });
});

server.listen(port, host, () => {
  const keyState = process.env["DEEPSEEK_API_KEY"] ? "已配置" : "未配置（/api/run 会返回 4xx）";
  // 默认要求隔离：先把"这台机器上能用什么沙箱"说清楚，避免第一条 run_command 才让人发现。
  const sandbox = detectSandbox(process.platform, process.env);
  void sandbox.isAvailable().then((available) => {
    process.stdout.write(
      `沙箱：${sandbox.id}（${available ? "可用" : "不可用 —— requireSandbox 默认开启，命令会被拒绝执行"}）\n`,
    );
  });
  process.stdout.write(
    [
      `agent-console API 监听 http://${host}:${port}`,
      `DEEPSEEK_API_KEY：${keyState}`,
      `GET  /api/health`,
      `POST /api/run`,
      `GET  /api/runs`,
      `GET  /api/runs/:runId/stream`,
      `GET  /api/runs/:runId`,
      `POST /api/runs/:runId/cancel`,
      `访问令牌：${(process.env["AGENT_CONSOLE_TOKEN"] ?? "").trim().length === 0 ? "未设置（仅本机可信环境）" : "已设置"}`,
      `POST /api/runs/:runId/answer`,
      "",
    ].join("\n"),
  );
});

const shutdown = (): void => {
  server.close(() => {
    process.exit(0);
  });
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
