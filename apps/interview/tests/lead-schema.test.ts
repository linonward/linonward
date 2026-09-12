import { describe, expect, it } from "vitest";
import { leadSchema } from "@/lib/validations/lead";
const valid = {
  name: "王小明",
  contact: "wechat-hello",
  company: "某公司",
  role: "前端工程师",
  candidateStage: "社招",
  technicalDirection: "前端工程",
  interviewRound: "技术一面",
  interviewDate: "2026-09-08T10:00:00.000Z",
  jobDescription: "a".repeat(50),
  resumeText: "a".repeat(100),
  notes: "",
  privacyAccepted: true,
};
describe("leadSchema", () => {
  it("accepts a complete lead", () => expect(leadSchema.safeParse(valid).success).toBe(true));
  it("requires privacy acceptance", () =>
    expect(leadSchema.safeParse({ ...valid, privacyAccepted: false }).success).toBe(false));
  it("requires a technical direction for cohort analysis", () =>
    expect(leadSchema.safeParse({ ...valid, technicalDirection: "" }).success).toBe(false));
});
