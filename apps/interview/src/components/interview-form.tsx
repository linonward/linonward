"use client";
import { ArrowRight } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { DateTimePicker } from "@/components/date-time-picker";
import {
  candidateStages,
  interviewRounds,
  leadSchema,
  technicalDirections,
} from "@/lib/validations/lead";

const initial = {
  name: "",
  contact: "",
  company: "",
  role: "",
  candidateStage: "" as string,
  technicalDirection: "" as string,
  interviewRound: "" as string,
  interviewDate: "",
  jobDescription: "",
  resumeText: "",
  notes: "",
  privacyAccepted: false,
};
type FormData = typeof initial;
export function InterviewForm() {
  const [data, setData] = useState<FormData>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);
  const [serverError, setServerError] = useState("");
  const router = useRouter();
  const update = (key: keyof FormData, value: string | boolean) =>
    setData((current) => ({ ...current, [key]: value }));
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setServerError("");
    const value = {
      ...data,
      interviewDate: data.interviewDate ? new Date(data.interviewDate).toISOString() : "",
    };
    const parsed = leadSchema.safeParse(value);
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
      const response = await fetch("/api/leads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed.data),
      });
      if (!response.ok) throw new Error();
      const result = await response.json();
      router.push(`/success?leadId=${encodeURIComponent(result.leadId)}`);
    } catch {
      setServerError("提交失败，请稍后重试。");
    } finally {
      setPending(false);
    }
  }
  const field = (key: keyof FormData) => ({
    id: key,
    name: key,
    value: typeof data[key] === "string" ? (data[key] as string) : undefined,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
      update(key, e.target.value),
    "aria-invalid": Boolean(errors[key]),
    "aria-describedby": errors[key] ? `${key}-error` : undefined,
  });
  return (
    <section id="submit" className="submit-section">
      <div className="shell form-shell">
        <div className="form-heading">
          <h2>提交资料，开始准备这场面试</h2>
        </div>
        <form onSubmit={submit} noValidate>
          <div className="field-grid">
            <Field fieldId="name" label="姓名 / 称呼" error={errors.name} required>
              <input {...field("name")} placeholder="怎么称呼你" />
            </Field>
            <Field fieldId="contact" label="联系方式" error={errors.contact} required>
              <input {...field("contact")} placeholder="微信、手机号或邮箱" />
            </Field>
            <Field fieldId="company" label="目标公司" error={errors.company} required>
              <input {...field("company")} placeholder="例如：字节跳动" />
            </Field>
            <Field fieldId="role" label="目标岗位" error={errors.role} required>
              <input {...field("role")} placeholder="例如：AI 应用开发工程师、Java 后端工程师" />
            </Field>
            <Field fieldId="candidateStage" label="求职阶段" error={errors.candidateStage} required>
              <select {...field("candidateStage")}>
                <option value="">请选择</option>
                {candidateStages.map((stage) => (
                  <option key={stage}>{stage}</option>
                ))}
              </select>
            </Field>
            <Field
              fieldId="technicalDirection"
              label="技术方向"
              error={errors.technicalDirection}
              required
            >
              <select {...field("technicalDirection")}>
                <option value="">请选择</option>
                {technicalDirections.map((direction) => (
                  <option key={direction}>{direction}</option>
                ))}
              </select>
            </Field>
            <Field fieldId="interviewRound" label="面试轮次" error={errors.interviewRound} required>
              <select {...field("interviewRound")}>
                <option value="">请选择</option>
                {interviewRounds.map((round) => (
                  <option key={round}>{round}</option>
                ))}
              </select>
            </Field>
            <Field fieldId="interviewDate" label="面试时间" error={errors.interviewDate} required>
              <DateTimePicker
                value={data.interviewDate}
                onChange={(value) => update("interviewDate", value)}
                invalid={Boolean(errors.interviewDate)}
              />
            </Field>
          </div>
          <Field fieldId="jobDescription" label="JD" error={errors.jobDescription} required>
            <textarea {...field("jobDescription")} rows={6} placeholder="请粘贴完整职位描述 JD" />
            <em>至少 50 个字符</em>
          </Field>
          <Field fieldId="resumeText" label="简历" error={errors.resumeText} required>
            <textarea {...field("resumeText")} rows={8} placeholder="请直接粘贴你的简历内容" />
            <em>当前测试版暂时只支持粘贴文本，不需要上传 PDF。</em>
          </Field>
          <Field fieldId="notes" label="其他补充（选填）" error={errors.notes}>
            <textarea
              {...field("notes")}
              rows={3}
              placeholder="例如：特别担心系统设计、项目深挖、英语面试等"
            />
          </Field>
          <label className="privacy">
            <input
              id="privacyAccepted"
              name="privacyAccepted"
              type="checkbox"
              checked={data.privacyAccepted}
              onChange={(e) => update("privacyAccepted", e.target.checked)}
            />{" "}
            我确认提交的信息仅用于生成本次面试准备内容。
          </label>
          {errors.privacyAccepted && (
            <p className="error" id="privacyAccepted-error">
              {errors.privacyAccepted}
            </p>
          )}
          {serverError && (
            <p className="error" role="alert">
              {serverError}
            </p>
          )}
          <button className="button submit-button" disabled={pending} type="submit">
            {pending ? "正在提交…" : "提交我的面试资料"} <ArrowRight aria-hidden="true" />
          </button>
        </form>
      </div>
    </section>
  );
}
function Field({
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
