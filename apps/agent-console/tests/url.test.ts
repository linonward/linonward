import { describe, expect, it } from "vitest";

import { readRunId, withRunId } from "../src/lib/url.js";

describe("runId 与 URL 的双向映射", () => {
  it("从 ?run= 读出 runId，缺失或空白视为没有", () => {
    expect(readRunId("?run=abc-123")).toBe("abc-123");
    expect(readRunId("?a=1&run=abc-123&b=2")).toBe("abc-123");
    expect(readRunId("?run=%20abc%20")).toBe("abc");
    expect(readRunId("")).toBeUndefined();
    expect(readRunId("?other=1")).toBeUndefined();
    expect(readRunId("?run=")).toBeUndefined();
    expect(readRunId("?run=%20%20")).toBeUndefined();
  });

  it("写入 runId 时保留其它查询参数，清除时只去掉 run", () => {
    expect(withRunId("", "abc")).toBe("?run=abc");
    expect(withRunId("?theme=dark", "abc")).toBe("?theme=dark&run=abc");
    expect(withRunId("?theme=dark&run=old", "abc")).toBe("?theme=dark&run=abc");
    expect(withRunId("?theme=dark&run=old", undefined)).toBe("?theme=dark");
    expect(withRunId("?run=old", undefined)).toBe("");
  });

  it("round-trip：写进去的 runId 一定读得回来（含需要转义的字符）", () => {
    const runId = "b4a58a2f-f8f7-453b-ba3f-d2f026a9409b";
    expect(readRunId(withRunId("?a=1", runId))).toBe(runId);
  });
});
