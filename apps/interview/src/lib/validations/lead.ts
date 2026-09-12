import { z } from "zod";
export const interviewRounds = [
  "技术一面",
  "技术二面",
  "技术三面",
  "主管面",
  "HR 面",
  "其他",
] as const;
export const candidateStages = ["社招", "校招 / 实习"] as const;
export const technicalDirections = [
  "前端工程",
  "后端 / 服务端",
  "全栈 / AI 应用开发",
  "数据 / 算法",
  "测试 / SRE / 平台",
  "其他技术岗",
] as const;
export const leadSchema = z.object({
  name: z.string().trim().min(2, "姓名需为 2–50 个字符").max(50, "姓名需为 2–50 个字符"),
  contact: z.string().trim().min(3, "请填写有效联系方式").max(100, "联系方式不能超过 100 个字符"),
  company: z.string().trim().min(1, "请填写目标公司").max(100, "公司名称不能超过 100 个字符"),
  role: z.string().trim().min(1, "请填写目标岗位").max(100, "岗位名称不能超过 100 个字符"),
  candidateStage: z.enum(candidateStages, { error: "请选择求职阶段" }),
  technicalDirection: z.enum(technicalDirections, { error: "请选择技术方向" }),
  interviewRound: z.enum(interviewRounds),
  interviewDate: z.string().datetime({ offset: true, message: "请选择面试时间" }),
  jobDescription: z
    .string()
    .trim()
    .min(50, "JD 至少需要 50 个字符")
    .max(10000, "JD 不能超过 10000 个字符"),
  resumeText: z
    .string()
    .trim()
    .min(100, "简历至少需要 100 个字符")
    .max(20000, "简历不能超过 20000 个字符"),
  notes: z.string().trim().max(2000, "补充信息不能超过 2000 个字符").optional().default(""),
  privacyAccepted: z.literal(true, { error: "请确认隐私说明" }),
});
export type LeadInput = z.infer<typeof leadSchema>;
