import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getPublishedArticleById: vi.fn(),
}));

vi.mock("@linonward/content", () => ({
  getPublishedArticleById: mocks.getPublishedArticleById,
}));
vi.mock("@/components/site-header", () => ({ SiteHeader: () => null }));

import { generateMetadata } from "./page";

describe("article page metadata", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("loads the published article by its primary key", async () => {
    const articleId = "35287abc-fb09-406f-9149-b99b1e7e8470";
    mocks.getPublishedArticleById.mockResolvedValue({
      title: "Primary key article",
      summary: "Loaded by id",
    });

    const metadata = await generateMetadata({
      params: Promise.resolve({ id: articleId }),
    });

    expect(mocks.getPublishedArticleById).toHaveBeenCalledWith(articleId);
    expect(metadata).toEqual({ title: "Primary key article", description: "Loaded by id" });
  });

  it("does not query the database for a non-UUID route value", async () => {
    const metadata = await generateMetadata({
      params: Promise.resolve({ id: "legacy-article-slug" }),
    });

    expect(mocks.getPublishedArticleById).not.toHaveBeenCalled();
    expect(metadata).toEqual({});
  });
});
