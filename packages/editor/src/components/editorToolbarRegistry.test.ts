import { describe, expect, it } from "vitest";

import { editorCommandIds, editorToolbarGroups } from "./editorToolbarRegistry";

describe("editor toolbar registry", () => {
  it("assigns every registered command to one toolbar group exactly once", () => {
    const groupedIds = Object.values(editorToolbarGroups).flat();

    expect(groupedIds).toEqual(editorCommandIds);
    expect(new Set(groupedIds).size).toBe(groupedIds.length);
  });
});
