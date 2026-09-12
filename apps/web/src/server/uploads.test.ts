import { describe, expect, it } from "vitest";

import { createImageKey, MAX_IMAGE_SIZE, publicUrlFor, validateImageUpload } from "./uploads";

describe("image uploads", () => {
  it("validates supported images and size", () => {
    expect(() => validateImageUpload("image/png", MAX_IMAGE_SIZE)).not.toThrow();
    expect(() => validateImageUpload("image/svg+xml", 100)).toThrow("仅支持");
    expect(() => validateImageUpload("image/png", MAX_IMAGE_SIZE + 1)).toThrow("10 MB");
  });

  it("creates dated, public object URLs", () => {
    const key = createImageKey("image/jpeg");
    expect(key).toMatch(/^images\/\d{4}-\d{2}-\d{2}\/[\da-f-]+\.jpg$/);
    expect(publicUrlFor("images/a b.jpg", "https://storage.linonward.com/")).toBe(
      "https://storage.linonward.com/images/a%20b.jpg",
    );
  });
});
