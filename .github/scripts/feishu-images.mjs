export function parseImageKeys(value) {
  let parsed;
  try {
    parsed = JSON.parse(value || "[]");
  } catch {
    throw new Error("FEISHU_IMAGE_KEYS must be a JSON array");
  }
  if (!Array.isArray(parsed)) throw new Error("FEISHU_IMAGE_KEYS must be a JSON array");
  if (parsed.length > 8) throw new Error("FEISHU_IMAGE_KEYS supports at most 8 images");
  if (parsed.some((key) => typeof key !== "string" || !key || key.length > 512)) {
    throw new Error("FEISHU_IMAGE_KEYS contains an invalid image key");
  }
  return parsed;
}

export function extensionForContentType(value) {
  const contentType = value?.split(";", 1)[0]?.trim().toLowerCase();
  return (
    {
      "image/gif": ".gif",
      "image/jpeg": ".jpg",
      "image/png": ".png",
      "image/webp": ".webp",
    }[contentType] ?? ".img"
  );
}
