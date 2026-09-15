import { describe, expect, it } from "vitest";
import { POST } from "@/app/api/leads/route";

describe("POST /api/leads", () => {
  it("returns normalized validation error for incomplete data", async () => {
    const response = await POST(
      new Request("http://test/api/leads", { method: "POST", body: JSON.stringify({}) }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      success: false,
      error: { code: "VALIDATION_ERROR", message: "提交信息不完整" },
    });
  });
});
