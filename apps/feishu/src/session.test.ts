import { describe, expect, it } from "vitest";

import { sessionIdForTopic } from "./session.js";

describe("sessionIdForTopic", () => {
  it("reuses a valid UUID for one topic and isolates different topics", () => {
    const first = sessionIdForTopic("omt_topic");

    expect(first).toBe(sessionIdForTopic("omt_topic"));
    expect(first).not.toBe(sessionIdForTopic("omt_other"));
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
