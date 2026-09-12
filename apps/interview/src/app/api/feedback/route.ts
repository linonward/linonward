import { NextResponse } from "next/server";
import { saveFeishuFeedback } from "@/lib/feishu";
import { feedbackSchema } from "@/lib/validations/feedback";

export const runtime = "nodejs";

const validationError = () =>
  NextResponse.json(
    { success: false, error: { code: "VALIDATION_ERROR", message: "请检查回访信息后重新提交" } },
    { status: 400 },
  );

export async function POST(request: Request) {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return validationError();
  }

  const parsed = feedbackSchema.safeParse(payload);
  if (!parsed.success) return validationError();

  try {
    await saveFeishuFeedback(parsed.data);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Unable to save interview feedback", error);
    return NextResponse.json(
      { success: false, error: { code: "INTERNAL_ERROR", message: "提交失败，请稍后重试" } },
      { status: 500 },
    );
  }
}
