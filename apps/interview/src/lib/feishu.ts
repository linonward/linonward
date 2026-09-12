import type { FeedbackInput } from "@/lib/validations/feedback";
import type { LeadInput } from "@/lib/validations/lead";

const baseUrl = "https://open.feishu.cn/open-apis";
let tokenCache: { value: string; expiresAt: number } | undefined;

async function getTenantAccessToken() {
  if (tokenCache && tokenCache.expiresAt > Date.now()) return tokenCache.value;
  const appId = process.env.FEISHU_APP_ID;
  const appSecret = process.env.FEISHU_APP_SECRET;
  if (!appId || !appSecret) throw new Error("Feishu credentials are not configured");
  const response = await fetch(`${baseUrl}/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  const result = (await response.json()) as {
    code?: number;
    tenant_access_token?: string;
    expire?: number;
  };
  if (!response.ok || result.code !== 0 || !result.tenant_access_token)
    throw new Error("Could not authenticate with Feishu");
  tokenCache = {
    value: result.tenant_access_token,
    expiresAt: Date.now() + Math.max((result.expire ?? 7200) - 120, 60) * 1000,
  };
  return tokenCache.value;
}

export async function createFeishuLead(id: string, lead: LeadInput) {
  const appToken = process.env.FEISHU_BITABLE_APP_TOKEN;
  const tableId = process.env.FEISHU_BITABLE_TABLE_ID;
  if (!appToken || !tableId) throw new Error("Feishu Bitable is not configured");
  const token = await getTenantAccessToken();
  const now = new Date().toISOString();
  const response = await fetch(`${baseUrl}/bitable/v1/apps/${appToken}/tables/${tableId}/records`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      fields: {
        "Lead ID": id,
        姓名: lead.name,
        联系方式: lead.contact,
        目标公司: lead.company,
        目标岗位: lead.role,
        求职阶段: lead.candidateStage,
        技术方向: lead.technicalDirection,
        面试轮次: lead.interviewRound,
        面试时间: lead.interviewDate,
        JD: lead.jobDescription,
        简历: lead.resumeText,
        其他补充: lead.notes,
        状态: "new",
        创建时间: now,
        更新时间: now,
      },
    }),
  });
  const result = (await response.json()) as {
    code?: number;
    data?: { record?: { record_id?: string } };
  };
  const recordId = result.data?.record?.record_id;
  if (!response.ok || result.code !== 0 || !recordId)
    throw new Error("Could not save lead to Feishu");
  return recordId;
}

export async function saveFeishuFeedback(feedback: FeedbackInput) {
  const appToken = process.env.FEISHU_BITABLE_APP_TOKEN;
  const tableId = process.env.FEISHU_BITABLE_TABLE_ID;
  if (!appToken || !tableId) throw new Error("Feishu Bitable is not configured");
  const token = await getTenantAccessToken();
  const filter = encodeURIComponent(`CurrentValue.[Lead ID] = \"${feedback.leadId}\"`);
  const queryResponse = await fetch(
    `${baseUrl}/bitable/v1/apps/${appToken}/tables/${tableId}/records?filter=${filter}&page_size=1`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const queryResult = (await queryResponse.json()) as {
    code?: number;
    data?: { items?: Array<{ record_id?: string }> };
  };
  const recordId = queryResult.data?.items?.[0]?.record_id;
  if (!queryResponse.ok || queryResult.code !== 0 || !recordId)
    throw new Error("Could not find lead in Feishu");

  const now = new Date().toISOString();
  const updateResponse = await fetch(
    `${baseUrl}/bitable/v1/apps/${appToken}/tables/${tableId}/records/${recordId}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        fields: {
          面试状态: feedback.attended,
          实际题目: feedback.actualQuestions,
          题目命中: feedback.matchLevel,
          帮助程度: String(feedback.helpfulness),
          面试卡点: feedback.stuckPoints,
          面试结果: feedback.result,
          案例授权: feedback.caseConsent ? "同意匿名联系" : "不同意",
          回访时间: now,
          更新时间: now,
        },
      }),
    },
  );
  const updateResult = (await updateResponse.json()) as { code?: number };
  if (!updateResponse.ok || updateResult.code !== 0)
    throw new Error("Could not save feedback to Feishu");
}
