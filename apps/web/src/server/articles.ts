import type { EditorDraftValue } from "@linonward/editor";
import { and, desc, eq, ne, or, sql } from "drizzle-orm";

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

const publishedArticleSelection = {
  id: articles.id,
  slug: articles.slug,
  summary: articles.summary,
  status: articles.status,
  version: articleRevisions.version,
  publishedAt: articles.publishedAt,
  title: articleRevisions.title,
  content: articleRevisions.content,
  themeId: articleRevisions.themeId,
};

export async function createArticle() {
  const database = getDatabase();
  return database.transaction(async (transaction) => {
    const [article] = await transaction
      .insert(articles)
      .values({
        title: EMPTY_DOCUMENT.title,
        slug: slugFromTitle(EMPTY_DOCUMENT.title),
        content: EMPTY_DOCUMENT.document,
        themeId: EMPTY_DOCUMENT.themeId,
      })
      .returning();
    if (!article) throw new Error("Unable to create article.");
    await transaction.insert(channelDeliveries).values({
      articleId: article.id,
      channel: "wechat",
      sourceVersion: article.version,
    });
    return article;
  });
}

export async function listArticles() {
  return getDatabase().select().from(articles).orderBy(desc(articles.updatedAt));
}

export async function listPublishedArticles() {
  return getDatabase()
    .select(publishedArticleSelection)
    .from(articles)
    .innerJoin(
      articleRevisions,
      and(
        eq(articleRevisions.articleId, articles.id),
        eq(articleRevisions.version, articles.publishedVersion),
      ),
    )
    .where(eq(articles.status, "published"))
    .orderBy(desc(articles.publishedAt));
}

export async function getArticle(id: string) {
  const [article] = await getDatabase().select().from(articles).where(eq(articles.id, id)).limit(1);
  return article ?? null;
}

export async function getPublishedArticle(slug: string) {
  const [article] = await getDatabase()
    .select(publishedArticleSelection)
    .from(articles)
    .innerJoin(
      articleRevisions,
      and(
        eq(articleRevisions.articleId, articles.id),
        eq(articleRevisions.version, articles.publishedVersion),
      ),
    )
    .where(and(eq(articles.slug, slug), eq(articles.status, "published")))
    .limit(1);
  return article ?? null;
}

export async function getPublishedArticleById(id: string) {
  const [article] = await getDatabase()
    .select(publishedArticleSelection)
    .from(articles)
    .innerJoin(
      articleRevisions,
      and(
        eq(articleRevisions.articleId, articles.id),
        eq(articleRevisions.version, articles.publishedVersion),
      ),
    )
    .where(and(eq(articles.id, id), eq(articles.status, "published")))
    .limit(1);
  return article ?? null;
}

export type SaveArticleResult =
  | { status: "saved"; article: typeof articles.$inferSelect }
  | { status: "not_found" }
  | { status: "conflict" };

export async function saveArticle(
  id: string,
  draft: EditorDraftValue,
  expectedVersion: number,
): Promise<SaveArticleResult> {
  const database = getDatabase();
  return database.transaction(async (transaction) => {
    const [updated] = await transaction
      .update(articles)
      .set({
        title: draft.title,
        content: draft.document,
        themeId: draft.themeId,
        version: sql`${articles.version} + 1`,
      })
      .where(and(eq(articles.id, id), eq(articles.version, expectedVersion)))
      .returning();
    if (updated) return { status: "saved", article: updated };

    const [existing] = await transaction
      .select({ id: articles.id })
      .from(articles)
      .where(eq(articles.id, id))
      .limit(1);
    return { status: existing ? "conflict" : "not_found" };
  });
}

export async function publishArticle(id: string) {
  const database = getDatabase();
  return database.transaction(async (transaction) => {
    const [current] = await transaction
      .select()
      .from(articles)
      .where(eq(articles.id, id))
      .limit(1)
      .for("update");
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
      .set({
        status: "published",
        publishedVersion: current.version,
        publishedAt: current.publishedAt ?? new Date(),
      })
      .where(eq(articles.id, id))
      .returning();
    await transaction
      .update(channelDeliveries)
      .set({ status: "outdated", updatedAt: new Date() })
      .where(and(eq(channelDeliveries.articleId, id), eq(channelDeliveries.channel, "wechat")));
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

export async function claimWechatDelivery(articleId: string, sourceVersion: number) {
  const [delivery] = await getDatabase()
    .update(channelDeliveries)
    .set({ status: "syncing", lastError: null, updatedAt: new Date() })
    .where(
      and(
        eq(channelDeliveries.articleId, articleId),
        eq(channelDeliveries.channel, "wechat"),
        ne(channelDeliveries.status, "syncing"),
        or(
          ne(channelDeliveries.status, "draft_synced"),
          ne(channelDeliveries.sourceVersion, sourceVersion),
        ),
      ),
    )
    .returning();
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
