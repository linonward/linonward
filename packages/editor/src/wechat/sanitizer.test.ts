import { describe, expect, it } from "vitest";

import { sanitizeWechatHtml } from "./sanitizer";

describe("WeChat HTML sanitizer", () => {
  it("removes unsupported elements, event handlers, classes, and risky styles", () => {
    const html = sanitizeWechatHtml(
      '<p class="note" onclick="alert(1)" style="color:#333;position:fixed;transition:all .2s">正文</p><script>alert(1)</script>',
    );

    expect(html).toBe('<p style="color:#333;">正文</p>alert(1)');
  });
});
