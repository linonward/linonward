import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const articleStatus = pgEnum("article_status", ["draft", "published", "archived"]);
export const deliveryStatus = pgEnum("delivery_status", [
  "not_synced",
  "syncing",
  "draft_synced",
  "outdated",
  "failed",
]);

export const articles = pgTable(
  "articles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    title: text("title").notNull(),
    slug: text("slug").notNull(),
    summary: text("summary").notNull().default(""),
    content: jsonb("content").notNull(),
    themeId: text("theme_id").notNull().default("default"),
    coverAssetId: uuid("cover_asset_id"),
    status: articleStatus("status").notNull().default("draft"),
    version: integer("version").notNull().default(1),
    publishedVersion: integer("published_version"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => sql`now()`),
  },
  (table) => [
    check(
      "articles_published_version_check",
      sql`${table.status} <> 'published' OR ${table.publishedVersion} IS NOT NULL`,
    ),
    uniqueIndex("articles_slug_unique").on(table.slug),
    index("articles_status_idx").on(table.status),
  ],
);

export const articleRevisions = pgTable(
  "article_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    articleId: uuid("article_id")
      .notNull()
      .references(() => articles.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    title: text("title").notNull(),
    content: jsonb("content").notNull(),
    themeId: text("theme_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("article_revisions_version_unique").on(table.articleId, table.version)],
);

export const assets = pgTable("assets", {
  id: uuid("id").primaryKey().defaultRandom(),
  key: text("key").notNull().unique(),
  url: text("url").notNull(),
  contentType: text("content_type").notNull(),
  size: integer("size").notNull(),
  alt: text("alt").notNull().default(""),
  wechatUrl: text("wechat_url"),
  wechatMediaId: text("wechat_media_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const channelDeliveries = pgTable(
  "channel_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    articleId: uuid("article_id")
      .notNull()
      .references(() => articles.id, { onDelete: "cascade" }),
    channel: text("channel").notNull(),
    status: deliveryStatus("status").notNull().default("not_synced"),
    sourceVersion: integer("source_version").notNull(),
    contentHash: text("content_hash"),
    remoteMediaId: text("remote_media_id"),
    lastError: text("last_error"),
    syncedAt: timestamp("synced_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("channel_deliveries_article_channel_unique").on(table.articleId, table.channel),
  ],
);
