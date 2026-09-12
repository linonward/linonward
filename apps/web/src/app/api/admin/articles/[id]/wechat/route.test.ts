import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  claimWechatDelivery: vi.fn(),
  createWechatDraft: vi.fn(),
  getArticle: vi.fn(),
  getPublishedArticleById: vi.fn(),
  getWechatDelivery: vi.fn(),
  isAdministrator: vi.fn(),
  updateWechatDelivery: vi.fn(),
}));

vi.mock("@/server/articles", () => ({
  claimWechatDelivery: mocks.claimWechatDelivery,
  getArticle: mocks.getArticle,
  getPublishedArticleById: mocks.getPublishedArticleById,
  getWechatDelivery: mocks.getWechatDelivery,
  updateWechatDelivery: mocks.updateWechatDelivery,
}));
vi.mock("@/server/auth", () => ({ isAdministrator: mocks.isAdministrator }));
vi.mock("@/server/wechat", () => ({ createWechatDraft: mocks.createWechatDraft }));

import { POST } from "./route";

const context = { params: Promise.resolve({ id: "article-id" }) };
const request = new Request("http://localhost/api/admin/articles/article-id/wechat", {
  method: "POST",
});

describe("WeChat draft synchronization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isAdministrator.mockResolvedValue(true);
  });

  it("requires an explicitly published article version", async () => {
    mocks.getArticle.mockResolvedValue({ status: "draft", publishedVersion: null });

    const response = await POST(request, context);

    expect(response.status).toBe(409);
    expect(mocks.getPublishedArticleById).not.toHaveBeenCalled();
    expect(mocks.createWechatDraft).not.toHaveBeenCalled();
  });

  it("rejects inconsistent publication metadata", async () => {
    mocks.getArticle.mockResolvedValue({ status: "published", publishedVersion: 4 });
    mocks.getPublishedArticleById.mockResolvedValue(null);

    const response = await POST(request, context);

    expect(response.status).toBe(409);
    expect(mocks.createWechatDraft).not.toHaveBeenCalled();
  });

  it("synchronizes the immutable published revision", async () => {
    const publishedArticle = { id: "article-id", version: 4, title: "已发布版本" };
    mocks.getArticle.mockResolvedValue({ status: "published", publishedVersion: 4 });
    mocks.getPublishedArticleById.mockResolvedValue(publishedArticle);
    mocks.getWechatDelivery.mockResolvedValue({ status: "outdated", sourceVersion: 3 });
    mocks.claimWechatDelivery.mockResolvedValue({ status: "syncing" });
    mocks.createWechatDraft.mockResolvedValue({ contentHash: "hash", mediaId: "media-id" });

    const response = await POST(request, context);

    expect(response.status).toBe(200);
    expect(mocks.claimWechatDelivery).toHaveBeenCalledWith("article-id", 4);
    expect(mocks.createWechatDraft).toHaveBeenCalledWith(publishedArticle);
    expect(mocks.updateWechatDelivery).toHaveBeenLastCalledWith(
      "article-id",
      expect.objectContaining({
        status: "draft_synced",
        sourceVersion: 4,
        remoteMediaId: "media-id",
      }),
    );
  });

  it("does not duplicate a concurrent synchronization", async () => {
    mocks.getArticle.mockResolvedValue({ status: "published", publishedVersion: 4 });
    mocks.getPublishedArticleById.mockResolvedValue({ id: "article-id", version: 4 });
    mocks.getWechatDelivery
      .mockResolvedValueOnce({ status: "outdated", sourceVersion: 3 })
      .mockResolvedValueOnce({ status: "syncing", sourceVersion: 3 });
    mocks.claimWechatDelivery.mockResolvedValue(null);

    const response = await POST(request, context);

    expect(response.status).toBe(409);
    expect(mocks.createWechatDraft).not.toHaveBeenCalled();
  });
});
