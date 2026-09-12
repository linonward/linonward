import { getArticle, getWechatDelivery, updateWechatDelivery } from "@/server/articles";
import { isAdministrator } from "@/server/auth";
import { createWechatDraft } from "@/server/wechat";

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  if (!(await isAdministrator())) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await context.params;
  const article = await getArticle(id);
  if (!article) return Response.json({ error: "Not found" }, { status: 404 });
  if (article.status !== "published")
    return Response.json({ error: "请先发布网站文章，再同步微信公众号草稿。" }, { status: 409 });
  const delivery = await getWechatDelivery(id);
  if (delivery?.status === "draft_synced" && delivery.sourceVersion === article.version)
    return Response.json({ status: "draft_synced", mediaId: delivery.remoteMediaId });
  if (delivery?.status === "syncing")
    return Response.json({ error: "文章正在同步，请稍后再试。" }, { status: 409 });
  await updateWechatDelivery(id, { status: "syncing", lastError: null });
  try {
    const result = await createWechatDraft(article);
    await updateWechatDelivery(id, {
      status: "draft_synced",
      sourceVersion: article.version,
      contentHash: result.contentHash,
      remoteMediaId: result.mediaId,
      lastError: null,
      syncedAt: new Date(),
    });
    return Response.json({ status: "draft_synced", mediaId: result.mediaId });
  } catch (error) {
    const message = error instanceof Error ? error.message : "微信公众号同步失败。";
    await updateWechatDelivery(id, { status: "failed", lastError: message });
    return Response.json({ error: message }, { status: 502 });
  }
}
