import { describe, expect, it } from "vitest";
import { feedbackSchema } from "@/lib/validations/feedback";

const valid = {
  leadId: "d0f3a5bc-a04f-4c1c-b5d1-90e9b0f819cd",
  attended: "已面试",
  actualQuestions: "项目中如何度量性能优化的收益？",
  matchLevel: "高：多题被问到或高度相似",
  helpfulness: 5,
  stuckPoints: "系统设计部分说得不够完整",
  result: "进入下一轮",
  caseConsent: false,
};

describe("feedbackSchema", () => {
  it("accepts a complete feedback response", () =>
    expect(feedbackSchema.safeParse(valid).success).toBe(true));
  it("rejects a feedback response without a lead id", () =>
    expect(feedbackSchema.safeParse({ ...valid, leadId: "not-an-id" }).success).toBe(false));
});
