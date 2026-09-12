import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getArticle: vi.fn(),
  isAdministrator: vi.fn(),
  saveArticle: vi.fn(),
}));

vi.mock("@/server/articles", () => ({
  getArticle: mocks.getArticle,
  saveArticle: mocks.saveArticle,
}));
vi.mock("@/server/auth", () => ({ isAdministrator: mocks.isAdministrator }));

import { GET, PUT } from "./route";

const context = { params: Promise.resolve({ id: "article-id" }) };
const draft = {
  version: 3,
  title: "测试文章",
  themeId: "default",
  document: { type: "doc", content: [{ type: "paragraph" }] },
};

const putRequest = (version?: string) =>
  new Request("http://localhost/api/admin/articles/article-id", {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      ...(version === undefined ? {} : { "if-match": version }),
    },
    body: JSON.stringify(draft),
  });

describe("article route version preconditions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isAdministrator.mockResolvedValue(true);
  });

  it("returns the current version when loading a draft", async () => {
    mocks.getArticle.mockResolvedValue({ ...draft, content: draft.document, version: 7 });

    const response = await GET(new Request("http://localhost"), context);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ version: 7, draft });
  });

  it("requires an expected version when saving", async () => {
    const response = await PUT(putRequest(), context);

    expect(response.status).toBe(428);
    expect(mocks.saveArticle).not.toHaveBeenCalled();
  });

  it("rejects malformed versions", async () => {
    const response = await PUT(putRequest("not-a-version"), context);

    expect(response.status).toBe(400);
    expect(mocks.saveArticle).not.toHaveBeenCalled();
  });

  it("reports concurrent edits without overwriting them", async () => {
    mocks.saveArticle.mockResolvedValue({ status: "conflict" });

    const response = await PUT(putRequest("7"), context);

    expect(response.status).toBe(409);
    expect(mocks.saveArticle).toHaveBeenCalledWith("article-id", expect.any(Object), 7);
  });

  it("returns the incremented version after saving", async () => {
    mocks.saveArticle.mockResolvedValue({
      status: "saved",
      article: { version: 8, updatedAt: new Date("2026-09-12T09:00:00Z") },
    });

    const response = await PUT(putRequest("7"), context);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ version: 8 });
  });
});
