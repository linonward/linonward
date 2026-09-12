import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import { isAdministrator } from "@/server/auth";
import { createImageKey, publicUrlFor, validateImageUpload } from "@/server/uploads";

export const runtime = "nodejs";

const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`缺少 ${name} 环境变量。`);
  return value;
};

export async function POST(request: Request) {
  if (!(await isAdministrator())) return Response.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const body: unknown = await request.json();
    const input = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const contentType = typeof input.contentType === "string" ? input.contentType : "";
    const size = typeof input.size === "number" ? input.size : Number.NaN;
    validateImageUpload(contentType, size);

    const accountId = required("R2_ACCOUNT_ID");
    const bucket = required("R2_BUCKET");
    const key = createImageKey(contentType);
    const client = new S3Client({
      region: "auto",
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: required("R2_ACCESS_KEY_ID"),
        secretAccessKey: required("R2_SECRET_ACCESS_KEY"),
      },
    });
    const uploadUrl = await getSignedUrl(
      client,
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        ContentType: contentType,
        CacheControl: "public, max-age=31536000, immutable",
      }),
      { expiresIn: 60 },
    );
    return Response.json({
      uploadUrl,
      publicUrl: publicUrlFor(key, required("R2_PUBLIC_BASE_URL")),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "无法创建上传链接。";
    const clientError = message.startsWith("仅支持") || message.startsWith("图片大小");
    return Response.json({ error: message }, { status: clientError ? 400 : 500 });
  }
}
