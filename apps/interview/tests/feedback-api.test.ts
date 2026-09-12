import { describe, expect, it } from "vitest";
import { POST } from "@/app/api/feedback/route";

describe("POST /api/feedback", () => {
  it("returns normalized validation error for incomplete data", async () => {
    const response = await POST(
      new Request("http://test/api/feedback", { method: "POST", body: JSON.stringify({}) }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      success: false,
      error: { code: "VALIDATION_ERROR", message: "请检查回访信息后重新提交" },
    });
  });
});
