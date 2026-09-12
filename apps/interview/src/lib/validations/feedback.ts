import { z } from "zod";

export const feedbackSchema = z.object({
  leadId: z.uuid("回访链接无效，请联系工作人员获取新链接"),
  attended: z.enum(["已面试", "面试取消 / 改期"], { error: "请选择面试状态" }),
  actualQuestions: z.string().trim().max(6000, "实际题目不能超过 6000 个字符").default(""),
  matchLevel: z.enum(["高：多题被问到或高度相似", "中：部分方向命中", "低：帮助有限", "尚未面试"], {
    error: "请选择题目命中情况",
  }),
  helpfulness: z.coerce.number().int().min(1, "请选择帮助程度").max(5, "请选择帮助程度"),
  stuckPoints: z.string().trim().max(2000, "卡点不能超过 2000 个字符").default(""),
  result: z.enum(["进入下一轮", "收到 offer", "暂未通过", "等待结果", "不便透露"], {
    error: "请选择当前结果",
  }),
  caseConsent: z.boolean().default(false),
});

export type FeedbackInput = z.infer<typeof feedbackSchema>;
