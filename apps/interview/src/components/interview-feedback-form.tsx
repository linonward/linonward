"use client";

import { useState } from "react";
import { feedbackSchema } from "@/lib/validations/feedback";
import { ArrowRight } from "lucide-react";

const matchLevels = [
  "高：多题被问到或高度相似",
  "中：部分方向命中",
  "低：帮助有限",
  "尚未面试",
] as const;
const results = ["进入下一轮", "收到 offer", "暂未通过", "等待结果", "不便透露"] as const;

type FeedbackFormProps = { leadId: string };

export function InterviewFeedbackForm({ leadId }: FeedbackFormProps) {
  const [data, setData] = useState({
    leadId,
    attended: "" as string,
    actualQuestions: "",
    matchLevel: "" as string,
    helpfulness: "",
    stuckPoints: "",
    result: "" as string,
    caseConsent: false,
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [serverError, setServerError] = useState("");

  const update = (key: keyof typeof data, value: string | boolean) =>
    setData((current) => ({ ...current, [key]: value }));

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setServerError("");
    const parsed = feedbackSchema.safeParse({ ...data, helpfulness: Number(data.helpfulness) });
    if (!parsed.success) {
      const next: Record<string, string> = {};
      parsed.error.issues.forEach((issue) => {
        next[String(issue.path[0])] = issue.message;
      });
      setErrors(next);
      return;
    }
    setErrors({});
    setPending(true);
    try {
      const response = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed.data),
      });
      if (!response.ok) throw new Error();
      setSubmitted(true);
    } catch {
      setServerError("提交失败，请稍后重试。若问题持续，请直接联系工作人员。");
    } finally {
      setPending(false);
    }
  }

  if (submitted) {
    return (
      <div className="feedback-complete" role="status">
        <h2>感谢你的回访</h2>
        <p>
          你的反馈会帮助我们校准这类公司与岗位的准备重点；如果后续还有面试，我们也可以继续一起准备。
        </p>
      </div>
    );
  }

  const field = (key: keyof typeof data) => ({
    id: key,
    name: key,
    value: typeof data[key] === "string" ? data[key] : undefined,
    onChange: (
      event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>,
    ) => update(key, event.target.value),
    "aria-invalid": Boolean(errors[key]),
    "aria-describedby": errors[key] ? `${key}-error` : undefined,
  });

  return (
    <form className="feedback-form" onSubmit={submit} noValidate>
      <FeedbackField
        fieldId="attended"
        label="这场面试是否已完成？"
        error={errors.attended}
        required
      >
        <select {...field("attended")}>
          <option value="">请选择</option>
          <option>已面试</option>
          <option>面试取消 / 改期</option>
        </select>
      </FeedbackField>
      <FeedbackField
        fieldId="actualQuestions"
        label="实际被问到哪些题？"
        error={errors.actualQuestions}
      >
        <textarea
          {...field("actualQuestions")}
          rows={7}
          placeholder="尽量写下题目、追问或面试官特别关注的方向。记不全也没关系。"
        />
      </FeedbackField>
      <div className="field-grid feedback-grid">
        <FeedbackField
          fieldId="matchLevel"
          label="作战包的题目命中情况"
          error={errors.matchLevel}
          required
        >
          <select {...field("matchLevel")}>
            <option value="">请选择</option>
            {matchLevels.map((level) => (
              <option key={level}>{level}</option>
            ))}
          </select>
        </FeedbackField>
        <FeedbackField
          fieldId="helpfulness"
          label="这份作战包帮上忙了吗？"
          error={errors.helpfulness}
          required
        >
          <select {...field("helpfulness")}>
            <option value="">请选择</option>
            <option value="5">5 分，非常有帮助</option>
            <option value="4">4 分，比较有帮助</option>
            <option value="3">3 分，一般</option>
            <option value="2">2 分，帮助不大</option>
            <option value="1">1 分，几乎没有帮助</option>
          </select>
        </FeedbackField>
      </div>
      <FeedbackField fieldId="stuckPoints" label="你在哪些地方卡住了？" error={errors.stuckPoints}>
        <textarea
          {...field("stuckPoints")}
          rows={4}
          placeholder="例如：项目数据说不清、系统设计没准备到、被连续追问时组织不好语言。"
        />
      </FeedbackField>
      <FeedbackField fieldId="result" label="目前结果" error={errors.result} required>
        <select {...field("result")}>
          <option value="">请选择</option>
          {results.map((result) => (
            <option key={result}>{result}</option>
          ))}
        </select>
      </FeedbackField>
      <label className="privacy feedback-consent">
        <input
          type="checkbox"
          checked={data.caseConsent}
          onChange={(event) => update("caseConsent", event.target.checked)}
        />{" "}
        我愿意接受后续联系，匿名分享这次准备经历。
      </label>
      {serverError && (
        <p className="error" role="alert">
          {serverError}
        </p>
      )}
      <button className="button submit-button" disabled={pending} type="submit">
        {pending ? "正在提交…" : "提交面试复盘"} <ArrowRight aria-hidden="true" />
      </button>
    </form>
  );
}

function FeedbackField({
  fieldId,
  label,
  error,
  required = false,
  children,
}: {
  fieldId: string;
  label: string;
  error?: string | undefined;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="field">
      {label}
      {required && (
        <span className="required-mark" aria-hidden="true">
          {" "}
          *
        </span>
      )}
      {children}
      {error && (
        <span className="error" id={`${fieldId}-error`}>
          {error}
        </span>
      )}
    </label>
  );
}
