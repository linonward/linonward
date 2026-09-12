import { describe, expect, it, vi } from "vitest";

import { createGitHubDispatcher } from "./github.js";
import { sessionIdForTopic } from "./session.js";

const githubConfig = {
  apiUrl: "https://api.github.com",
  ref: "main",
  repository: "linonward/linonward",
  timeoutMs: 30_000,
  token: "github-token",
  workflow: "ai-employee.yml",
};

describe("createGitHubDispatcher", () => {
  it("dispatches text and image context to the AI employee workflow", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const dispatch = createGitHubDispatcher(githubConfig, fetcher);

    await dispatch({
      imageKeys: ["img_first"],
      messageId: "om_message",
      senderOpenId: "ou_sender",
      text: "检查并修复登录问题",
      threadKey: "omt_topic",
    });

    expect(fetcher).toHaveBeenCalledWith(
      "https://api.github.com/repos/linonward/linonward/actions/workflows/ai-employee.yml/dispatches",
      expect.objectContaining({
        body: JSON.stringify({
          inputs: {
            feishu_image_keys: '["img_first"]',
            feishu_message_id: "om_message",
            feishu_sender: "ou_sender",
            prompt: "检查并修复登录问题",
            session_uuid: sessionIdForTopic("omt_topic"),
            thread_key: "omt_topic",
          },
          ref: "main",
        }),
        headers: expect.objectContaining({ Authorization: "Bearer github-token" }),
        method: "POST",
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("throws a credential-safe error when GitHub rejects the dispatch", async () => {
    const dispatch = createGitHubDispatcher(
      githubConfig,
      vi.fn().mockResolvedValue(new Response("Bad credentials", { status: 401 })),
    );

    await expect(
      dispatch({
        messageId: "om_message",
        senderOpenId: "ou_sender",
        text: "run task",
        threadKey: "om_task",
      }),
    ).rejects.toThrow("GitHub workflow dispatch failed with 401");
  });
});
