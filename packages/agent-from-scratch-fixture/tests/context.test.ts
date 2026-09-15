import { describe, expect, it } from "vitest";

import {
  buildModelRequest,
  selectContext,
  summarizeSources,
  type ContextSource,
} from "../src/context.js";

function source(overrides: Partial<ContextSource> & { id: string }): ContextSource {
  return {
    kind: "file_excerpt",
    label: overrides.id,
    content: "content",
    priority: 10,
    ...overrides,
  };
}

describe("selectContext", () => {
  it("优先保留高优先级来源", () => {
    const sources: ContextSource[] = [
      source({ id: "rule", kind: "workspace_rule", content: "keep", priority: 100 }),
      source({ id: "observation", label: "old output", content: "too-large", priority: 10 }),
    ];

    expect(selectContext(sources, 5).map((item) => item.id)).toEqual(["rule"]);
  });

  it("分离系统规则、用户任务和参考资料", () => {
    const request = buildModelRequest({
      task: "检查 package.json",
      cwd: "/workspace",
      toolNames: ["read_file"],
      sources: [
        source({ id: "package", label: "package.json", content: '{"private":true}', priority: 50 }),
      ],
    });

    expect(request.instructions).toContain("You are a repository coding agent.");
    expect(request.instructions).toContain("/workspace");
    expect(request.input[0]).toEqual({ role: "user", content: "检查 package.json" });
    expect(request.input[1]?.content).toContain("<context_sources>");
    expect(request.input[1]?.content).toContain('{"private":true}');
  });

  it("超出预算时不注入任何被裁剪的片段", () => {
    const sources: ContextSource[] = [
      source({ id: "small", content: "a".repeat(4), priority: 50 }),
      source({ id: "big", content: "b".repeat(100), priority: 40 }),
    ];

    const selected = selectContext(sources, 10);

    expect(selected.map((item) => item.id)).toEqual(["small"]);
    expect(selected[0]?.content).toHaveLength(4);
  });

  it("summarizeSources 只暴露种类与标签，不复制内容", () => {
    const summary = summarizeSources([
      source({ id: "a", kind: "task_plan", label: "plan:1", content: "SECRET-BODY", priority: 99 }),
      source({ id: "b", kind: "tool_observation", label: "read_file", content: "SECRET-BODY" }),
    ]);

    expect(summary).toBe("task_plan:plan:1\ntool_observation:read_file");
    expect(summary).not.toContain("SECRET-BODY");
  });
});
