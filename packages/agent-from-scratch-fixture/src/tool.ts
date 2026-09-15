import { z, type ZodType } from "zod";

import type { AgentEventInput, SkillState } from "./types.js";

/**
 * 风险等级。`read` 只读取工作区，`write` 修改工作区，
 * `execute` 启动本地进程，`external` 会产生工作区之外的副作用。
 */
export type ToolEffect = "read" | "write" | "execute" | "external";

/** 单写者租约：所有写入工具共用一个临界区，避免并发覆盖。 */
export interface WriteLease {
  runExclusive<Result>(key: string, operation: () => Promise<Result>): Promise<Result>;
}

export class InMemoryWriteLease implements WriteLease {
  private queue: Promise<void> = Promise.resolve();

  runExclusive<Result>(_key: string, operation: () => Promise<Result>): Promise<Result> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

/** Executor 注入的运行时依赖。工具实现不得自行读取全局状态。 */
export interface ToolContext {
  cwd: string;
  signal: AbortSignal;
  writeLease: WriteLease;
  skills: SkillState;
  maxSkillBytes: number;
  emit(event: AgentEventInput): void;
}

/** Schema 校验与真正执行被拆开：策略层必须看到已解析的输入。 */
export interface PreparedToolCall {
  input: unknown;
  execute(context: ToolContext): Promise<unknown>;
}

export interface RegisteredTool {
  name: string;
  description: string;
  effect: ToolEffect;
  parameters: Record<string, unknown>;
  prepare(input: unknown): PreparedToolCall;
}

export interface ToolDefinitionInput<Input> {
  name: string;
  description: string;
  effect: ToolEffect;
  schema: ZodType<Input>;
  execute(input: Input, context: ToolContext): Promise<unknown>;
}

/**
 * 运行时校验与模型可见 JSON Schema 来自同一个定义，避免两份 Schema 漂移。
 * `prepare` 内先 `schema.parse`，因此非法参数永远不会到达策略层或副作用。
 */
export function defineTool<Input>(definition: ToolDefinitionInput<Input>): RegisteredTool {
  const parameters: Record<string, unknown> = { ...z.toJSONSchema(definition.schema) };
  delete parameters["$schema"];

  return {
    name: definition.name,
    description: definition.description,
    effect: definition.effect,
    parameters,
    prepare(input) {
      const parsed = definition.schema.parse(input);
      return {
        input: parsed,
        execute: (context) => definition.execute(parsed, context),
      };
    },
  };
}
