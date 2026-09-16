import { DEFAULT_API_PORT } from "./router.js";

/**
 * 入口的纯逻辑：端口、监听地址与"该不该拒绝启动"。
 *
 * 单独成模块的原因很实际：`server/index.ts` 一被导入就会 `listen`，因此它的守卫无法
 * 在测试里被调用——而"绑到 0.0.0.0 却没有令牌"这类判断恰恰是最需要被测试钉住的。
 */

export function readPort(env: NodeJS.ProcessEnv): number {
  const raw = env["AGENT_CONSOLE_API_PORT"];
  if (raw === undefined || raw.length === 0) return DEFAULT_API_PORT;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_API_PORT;
}

/** 监听地址：默认回环。绑非回环地址时必须配令牌，见 `startupRefusal`。 */
export function readHost(env: NodeJS.ProcessEnv): string {
  const raw = env["AGENT_CONSOLE_HOST"]?.trim();
  return raw === undefined || raw.length === 0 ? "127.0.0.1" : raw;
}

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

/**
 * 启动前的拒绝条件：非回环地址 + 没有令牌 = 把"能执行命令的接口"开放给了整个网络。
 */
export function startupRefusal(input: {
  host: string;
  token: string | undefined;
}): string | undefined {
  if (isLoopback(input.host)) return undefined;
  const token = input.token?.trim() ?? "";
  if (token.length > 0) return undefined;
  return `拒绝启动：绑定 ${input.host} 时必须设置 AGENT_CONSOLE_TOKEN（否则等于开放一个可执行命令的接口）。`;
}
