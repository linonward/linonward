import { describe, expect, it } from "vitest";

import { loadServiceConfig } from "./config.js";

const environment = {
  FEISHU_ALLOWED_OPEN_IDS: "ou_first, ou_second",
  FEISHU_APP_ID: "cli_0123456789abcdef",
  FEISHU_APP_SECRET: "app-secret",
  GITHUB_DISPATCH_TOKEN: "github-token",
  GITHUB_REPOSITORY: "linonward/linonward",
};

describe("loadServiceConfig", () => {
  it("loads secure defaults and the sender allowlist", () => {
    expect(loadServiceConfig(environment)).toEqual({
      feishu: {
        appId: "cli_0123456789abcdef",
        appSecret: "app-secret",
      },
      github: {
        apiUrl: "https://api.github.com",
        ref: "main",
        repository: "linonward/linonward",
        timeoutMs: 30_000,
        token: "github-token",
        workflow: "ai-employee.yml",
      },
      relay: {
        allowedOpenIds: new Set(["ou_first", "ou_second"]),
        maxTaskLength: 6_000,
      },
    });
  });

  it("requires a non-empty sender allowlist", () => {
    expect(() => loadServiceConfig({ ...environment, FEISHU_ALLOWED_OPEN_IDS: " " })).toThrow(
      "FEISHU_ALLOWED_OPEN_IDS must name at least one sender",
    );
  });

  it("rejects insecure GitHub API URLs", () => {
    expect(() =>
      loadServiceConfig({ ...environment, GITHUB_API_URL: "http://github.example.test/api/v3" }),
    ).toThrow("GITHUB_API_URL must use https");
  });

  it("validates repository names and task limits", () => {
    expect(() => loadServiceConfig({ ...environment, GITHUB_REPOSITORY: "invalid" })).toThrow(
      "GITHUB_REPOSITORY must have the form owner/repository",
    );
    expect(() => loadServiceConfig({ ...environment, MAX_TASK_LENGTH: "10001" })).toThrow(
      "MAX_TASK_LENGTH must be an integer between 1 and 10000",
    );
  });
});
