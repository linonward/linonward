import type { ToolDefinition } from "./model.js";
import type { RegisteredTool } from "./tool.js";

/**
 * 注册阶段拒绝重名，运行阶段只按精确名称查找。
 * `definitions()` 是模型能看到的唯一工具清单。
 */
export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();

  register(tool: RegisteredTool): void {
    if (this.tools.has(tool.name)) {
      throw new Error("duplicate tool: " + tool.name);
    }
    this.tools.set(tool.name, tool);
  }

  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  definitions(): ToolDefinition[] {
    return [...this.tools.values()].map((tool) => ({
      type: "function" as const,
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      strict: true as const,
    }));
  }
}
