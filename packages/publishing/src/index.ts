import { createHash } from "node:crypto";
import type { getPublishedArticleById } from "@linonward/content";
import {
  getTheme,
  parseDraft,
  renderWechatHtml,
  sanitizeWechatHtml,
} from "@linonward/editor/publishing";

type Article = NonNullable<Awaited<ReturnType<typeof getPublishedArticleById>>>;
type WechatErrorResponse = { errcode?: number; errmsg?: string };

let tokenCache: { value: string; expiresAt: number } | undefined;

const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`缺少 ${name} 环境变量。`);
  return value;
};

const ensureWechatSuccess = <T extends WechatErrorResponse>(payload: T): T => {
  if (payload.errcode && payload.errcode !== 0)
    throw new Error(`微信接口错误 ${payload.errcode}: ${payload.errmsg || "未知错误"}`);
  return payload;
};

async function getAccessToken() {
  if (tokenCache && tokenCache.expiresAt > Date.now() + 5 * 60 * 1000) return tokenCache.value;
  const response = await fetch("https://api.weixin.qq.com/cgi-bin/stable_token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "client_credential",
      appid: required("WECHAT_APP_ID"),
      secret: required("WECHAT_APP_SECRET"),
    }),
  });
  const payload = ensureWechatSuccess(
    (await response.json()) as WechatErrorResponse & { access_token?: string; expires_in?: number },
  );
  if (!response.ok || !payload.access_token) throw new Error("无法获取微信公众号 access_token。");
  tokenCache = {
    value: payload.access_token,
    expiresAt: Date.now() + Math.max(300, payload.expires_in ?? 7200) * 1000,
  };
  return payload.access_token;
}

async function downloadImage(url: string) {
  const source = new URL(url);
  const storage = new URL(required("R2_PUBLIC_BASE_URL"));
  if (source.protocol !== "https:" || source.host !== storage.host)
    throw new Error("公众号同步仅支持本站对象存储中的 HTTPS 图片。");
  const response = await fetch(url);
  if (!response.ok) throw new Error(`无法读取正文图片：${url}`);
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > 10 * 1024 * 1024)
    throw new Error("正文图片不能超过 10 MB。");
  const contentType = response.headers.get("content-type")?.split(";")[0] || "image/jpeg";
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > 10 * 1024 * 1024) throw new Error("正文图片不能超过 10 MB。");
  return { bytes, contentType };
}

async function uploadImageForArticle(url: string, token: string) {
  const image = await downloadImage(url);
  const form = new FormData();
  form.set("media", new Blob([image.bytes], { type: image.contentType }), "article-image");
  const response = await fetch(
    `https://api.weixin.qq.com/cgi-bin/media/uploadimg?access_token=${encodeURIComponent(token)}`,
    { method: "POST", body: form },
  );
  const payload = ensureWechatSuccess(
    (await response.json()) as WechatErrorResponse & { url?: string },
  );
  if (!response.ok || !payload.url) throw new Error("微信正文图片上传失败。");
  return payload.url;
}

async function uploadCover(url: string, token: string) {
  const image = await downloadImage(url);
  const form = new FormData();
  form.set("media", new Blob([image.bytes], { type: image.contentType }), "article-cover");
  const response = await fetch(
    `https://api.weixin.qq.com/cgi-bin/material/add_material?access_token=${encodeURIComponent(token)}&type=image`,
    { method: "POST", body: form },
  );
  const payload = ensureWechatSuccess(
    (await response.json()) as WechatErrorResponse & { media_id?: string },
  );
  if (!response.ok || !payload.media_id) throw new Error("微信封面素材上传失败。");
  return payload.media_id;
}

const collectImageUrls = (node: unknown, result = new Set<string>()) => {
  if (!node || typeof node !== "object") return result;
  const value = node as Record<string, unknown>;
  if (value.type === "image" && value.attrs && typeof value.attrs === "object") {
    const source = (value.attrs as Record<string, unknown>).src;
    if (typeof source === "string") result.add(source);
  }
  if (Array.isArray(value.content))
    value.content.forEach((child) => collectImageUrls(child, result));
  return result;
};

const replaceImageUrls = (node: unknown, replacements: ReadonlyMap<string, string>): unknown => {
  if (!node || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map((child) => replaceImageUrls(child, replacements));
  const value = node as Record<string, unknown>;
  const attrs =
    value.attrs && typeof value.attrs === "object"
      ? (value.attrs as Record<string, unknown>)
      : null;
  const source =
    value.type === "image" && attrs && typeof attrs.src === "string" ? attrs.src : null;
  return {
    ...value,
    ...(source ? { attrs: { ...attrs, src: replacements.get(source) ?? source } } : {}),
    ...(Array.isArray(value.content)
      ? { content: value.content.map((child) => replaceImageUrls(child, replacements)) }
      : {}),
  };
};

export async function createWechatDraft(article: Article) {
  if (Array.from(article.title).length > 32) throw new Error("微信公众号标题不能超过 32 个字。");
  const imageUrls = [...collectImageUrls(article.content)];
  const coverUrl = imageUrls[0];
  if (!coverUrl) throw new Error("同步公众号草稿前，请在正文中添加至少一张封面图片。");
  const token = await getAccessToken();
  const replacements = new Map<string, string>();
  for (const imageUrl of imageUrls) {
    replacements.set(imageUrl, await uploadImageForArticle(imageUrl, token));
  }
  const document = replaceImageUrls(article.content, replacements) as Record<string, unknown>;
  const draft = parseDraft({
    version: 3,
    title: article.title,
    themeId: article.themeId,
    document,
  });
  if (!draft) throw new Error("文章内容格式无效。");
  const content = sanitizeWechatHtml(renderWechatHtml(draft.document, getTheme(article.themeId)));
  const thumbMediaId = await uploadCover(coverUrl, token);
  const response = await fetch(
    `https://api.weixin.qq.com/cgi-bin/draft/add?access_token=${encodeURIComponent(token)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        articles: [
          {
            article_type: "news",
            title: article.title,
            digest: article.summary || undefined,
            content,
            content_source_url: `https://notes.linonward.com/articles/${encodeURIComponent(article.slug)}`,
            thumb_media_id: thumbMediaId,
            need_open_comment: 0,
            only_fans_can_comment: 0,
          },
        ],
      }),
    },
  );
  const payload = ensureWechatSuccess(
    (await response.json()) as WechatErrorResponse & { media_id?: string },
  );
  if (!response.ok || !payload.media_id) throw new Error("微信公众号草稿创建失败。");
  return {
    mediaId: payload.media_id,
    contentHash: createHash("sha256").update(content).digest("hex"),
  };
}
