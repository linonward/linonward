import { describe, expect, it } from "vitest";

import { editorSchema } from "./core/schema";
import { MemoryDraftRepository } from "./draftRepository";

describe("draft repositories", () => {
  it("isolates drafts by document id and lists the saved documents", async () => {
    const repository = new MemoryDraftRepository();
    const document = editorSchema.nodes.doc.createAndFill()!;
    await repository.save("a", { title: "A", themeId: "default", document });
    await repository.save("b", { title: "B", themeId: "minimal", document });

    expect((await repository.load("a"))?.title).toBe("A");
    expect((await repository.load("b"))?.themeId).toBe("minimal");
    expect(await repository.load("missing")).toBeNull();
    expect((await repository.list()).map((item) => item.id).sort()).toEqual(["a", "b"]);
  });
});
