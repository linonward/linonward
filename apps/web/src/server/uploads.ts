import { randomUUID } from "node:crypto";

export const MAX_IMAGE_SIZE = 10 * 1024 * 1024;

const extensionsByMimeType: Record<string, string> = {
  "image/avif": "avif",
  "image/gif": "gif",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

export function validateImageUpload(contentType: string, size: number) {
  if (!(contentType in extensionsByMimeType))
    throw new Error("仅支持 AVIF、GIF、JPEG、PNG 或 WebP 图片。");
  if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_IMAGE_SIZE)
    throw new Error("图片大小必须在 1 B 到 10 MB 之间。");
}

export function createImageKey(contentType: string) {
  const extension = extensionsByMimeType[contentType];
  if (!extension) throw new Error("不支持的图片类型。");
  return `images/${new Date().toISOString().slice(0, 10)}/${randomUUID()}.${extension}`;
}

export function publicUrlFor(key: string, publicBaseUrl: string) {
  return `${publicBaseUrl.replace(/\/$/, "")}/${key.split("/").map(encodeURIComponent).join("/")}`;
}
