import { NextResponse } from "next/server";
import { leadSchema } from "@/lib/validations/lead";
import { createFeishuLead } from "@/lib/feishu";
export const runtime = "nodejs";

const validationError = () =>
  NextResponse.json(
    { success: false, error: { code: "VALIDATION_ERROR", message: "提交信息不完整" } },
    { status: 400 },
  );

export async function POST(request: Request) {
  let payload: unknown;

  try {
    payload = await request.json();
  } catch {
    return validationError();
  }

  const parsed = leadSchema.safeParse(payload);
  if (!parsed.success) return validationError();

  try {
    const id = crypto.randomUUID();
    await createFeishuLead(id, parsed.data);
    return NextResponse.json({ success: true, leadId: id }, { status: 201 });
  } catch (error) {
    console.error("Unable to save interview lead", error);
    return NextResponse.json(
      { success: false, error: { code: "INTERNAL_ERROR", message: "提交失败，请稍后重试" } },
      { status: 500 },
    );
  }
}
