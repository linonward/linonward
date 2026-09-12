import { Buffer } from "node:buffer";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";

import { extensionForContentType, parseImageKeys } from "./feishu-images.mjs";

const appId = process.env.LARKSUITE_CLI_APP_ID;
const appSecret = process.env.LARKSUITE_CLI_APP_SECRET;
const messageId = process.env.MESSAGE_ID;
const imageKeys = parseImageKeys(process.env.FEISHU_IMAGE_KEYS);
const outputDirectory = join(process.cwd(), ".feishu-images");
const maxImageBytes = 20 * 1024 * 1024;

if (imageKeys.length === 0) process.exit(0);
if (!appId || !appSecret || !messageId) {
  throw new Error("Feishu credentials and MESSAGE_ID are required to download images");
}

const token = await getTenantAccessToken();
await mkdir(outputDirectory, { recursive: true });

for (const [index, imageKey] of imageKeys.entries()) {
  const response = await globalThis.fetch(
    `https://open.feishu.cn/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(imageKey)}?type=image`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!response.ok) throw new Error(`Unable to download Feishu image (status ${response.status})`);

  const content = Buffer.from(await response.arrayBuffer());
  if (content.length > maxImageBytes) throw new Error("Feishu image exceeds the 20 MB limit");

  const extension = extensionForContentType(response.headers.get("content-type"));
  await writeFile(join(outputDirectory, `image-${index + 1}${extension}`), content);
}

globalThis.console.log(`Downloaded ${imageKeys.length} Feishu image(s) to .feishu-images`);

async function getTenantAccessToken() {
  const response = await globalThis.fetch(
    "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
    {
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
      headers: { "Content-Type": "application/json; charset=utf-8" },
      method: "POST",
    },
  );
  const payload = await response.json();
  if (!response.ok || payload.code !== 0 || typeof payload.tenant_access_token !== "string") {
    throw new Error(`Unable to obtain Feishu tenant token (status ${response.status})`);
  }
  return payload.tenant_access_token;
}
