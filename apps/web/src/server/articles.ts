import type { EditorDraftValue } from "@linonward/editor";
import { and, desc, eq } from "drizzle-orm";

import { getDatabase } from "./db";
import { articleRevisions, articles, channelDeliveries } from "./db/schema";

export const EMPTY_DOCUMENT: EditorDraftValue = {
  version: 3,
  title: "未命名文章",
  themeId: "default",
  document: { type: "doc", content: [{ type: "paragraph" }] },
};

const slugFromTitle = (title: string) => {
  const normalized = title
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-|-$/g, "");
  return `${normalized || "article"}-${Date.now().toString(36)}`;
};

export async function createArticle() {
  const database = getDatabase();
  const [article] = await database
    .insert(articles)
    .values({
      title: EMPTY_DOCUMENT.title,
      slug: slugFromTitle(EMPTY_DOCUMENT.title),
      content: EMPTY_DOCUMENT.document,
      themeId: EMPTY_DOCUMENT.themeId,
    })
    .returning();
  if (!article) throw new Error("Unable to create article.");
  await database.insert(channelDeliveries).values({
    articleId: article.id,
    channel: "wechat",
    sourceVersion: article.version,
  });
  return article;
}

export async function listArticles() {
  return getDatabase().select().from(articles).orderBy(desc(articles.updatedAt));
}

export async function listPublishedArticles() {
  return getDatabase()
    .select()
    .from(articles)
    .where(eq(articles.status, "published"))
    .orderBy(desc(articles.publishedAt));
}

export async function getArticle(id: string) {
  const [article] = await getDatabase().select().from(articles).where(eq(articles.id, id)).limit(1);
  return article ?? null;
}

export async function getPublishedArticle(slug: string) {
  const [article] = await getDatabase()
    .select()
    .from(articles)
    .where(and(eq(articles.slug, slug), eq(articles.status, "published")))
    .limit(1);
  return article ?? null;
}

export async function saveArticle(id: string, draft: EditorDraftValue) {
  const database = getDatabase();
  return database.transaction(async (transaction) => {
    const [current] = await transaction.select().from(articles).where(eq(articles.id, id)).limit(1);
    if (!current) return null;
    const nextVersion = current.version + 1;
    const [updated] = await transaction
      .update(articles)
      .set({
        title: draft.title,
        content: draft.document,
        themeId: draft.themeId,
        version: nextVersion,
      })
      .where(eq(articles.id, id))
      .returning();
    await transaction
      .update(channelDeliveries)
      .set({ status: "outdated", sourceVersion: nextVersion, updatedAt: new Date() })
      .where(and(eq(channelDeliveries.articleId, id), eq(channelDeliveries.channel, "wechat")));
    return updated ?? null;
  });
}

export async function publishArticle(id: string) {
  const database = getDatabase();
  return database.transaction(async (transaction) => {
    const [current] = await transaction.select().from(articles).where(eq(articles.id, id)).limit(1);
    if (!current) return null;
    await transaction
      .insert(articleRevisions)
      .values({
        articleId: id,
        version: current.version,
        title: current.title,
        content: current.content,
        themeId: current.themeId,
      })
      .onConflictDoNothing();
    const [published] = await transaction
      .update(articles)
      .set({ status: "published", publishedAt: current.publishedAt ?? new Date() })
      .where(eq(articles.id, id))
      .returning();
    return published ?? null;
  });
}

export async function getWechatDelivery(articleId: string) {
  const [delivery] = await getDatabase()
    .select()
    .from(channelDeliveries)
    .where(and(eq(channelDeliveries.articleId, articleId), eq(channelDeliveries.channel, "wechat")))
    .limit(1);
  return delivery ?? null;
}

export async function updateWechatDelivery(
  articleId: string,
  values: Partial<typeof channelDeliveries.$inferInsert>,
) {
  const [delivery] = await getDatabase()
    .update(channelDeliveries)
    .set({ ...values, updatedAt: new Date() })
    .where(and(eq(channelDeliveries.articleId, articleId), eq(channelDeliveries.channel, "wechat")))
    .returning();
  return delivery ?? null;
}
