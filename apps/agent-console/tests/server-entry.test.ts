import { describe, expect, it } from "vitest";

import { readHost, readPort, startupRefusal } from "../server/entry-options.js";
import { secretValues } from "../server/redact.js";
import { readStoredToken, startSession, storeToken } from "../src/lib/api.js";

/**
 * 启动守卫与脱敏都属于"不该出错"的一类：前者决定这个能执行命令的接口是否暴露给网络，
 * 后者决定令牌会不会被写进日志或响应。都能离线测。
 */
describe("启动守卫", () => {
  it("回环地址不需要令牌", () => {
    expect(startupRefusal({ host: "127.0.0.1", token: undefined })).toBeUndefined();
    expect(startupRefusal({ host: "localhost", token: "" })).toBeUndefined();
    expect(startupRefusal({ host: "::1", token: undefined })).toBeUndefined();
  });

  it("绑非回环地址且没有令牌时拒绝启动，并说明原因", () => {
    const refusal = startupRefusal({ host: "0.0.0.0", token: undefined });
    expect(refusal).toContain("AGENT_CONSOLE_TOKEN");
    expect(startupRefusal({ host: "10.0.0.5", token: "   " })).toContain("拒绝启动");
  });

  it("有令牌时允许绑定非回环地址", () => {
    expect(startupRefusal({ host: "0.0.0.0", token: "s3cret" })).toBeUndefined();
  });

  it("端口与监听地址都可配置，缺省保持回环", () => {
    expect(readPort({})).toBe(8787);
    expect(readPort({ AGENT_CONSOLE_API_PORT: "9999" })).toBe(9999);
    expect(readPort({ AGENT_CONSOLE_API_PORT: "abc" })).toBe(8787);
    expect(readHost({})).toBe("127.0.0.1");
    expect(readHost({ AGENT_CONSOLE_HOST: "0.0.0.0" })).toBe("0.0.0.0");
  });
});

describe("令牌脱敏", () => {
  it("访问令牌与模型密钥一起进脱敏清单", () => {
    expect(secretValues({ DEEPSEEK_API_KEY: "sk-1", AGENT_CONSOLE_TOKEN: "tok-1" })).toEqual([
      "sk-1",
      "tok-1",
    ]);
    expect(secretValues({})).toEqual([]);
    expect(secretValues({ AGENT_CONSOLE_TOKEN: "" })).toEqual([]);
  });
});

describe("浏览器侧的令牌会话", () => {
  it("会话接口的判定：required 只在服务端真的配了令牌时为 true", async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ ok: true, required: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    const original = globalThis.fetch;
    globalThis.fetch = fakeFetch;
    try {
      await expect(startSession("tok")).resolves.toEqual({ required: true });
    } finally {
      globalThis.fetch = original;
    }
  });

  it("令牌缺失/错误时抛出可读错误，而不是静默失败", async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ error: "缺少或错误的访问令牌" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    const original = globalThis.fetch;
    globalThis.fetch = fakeFetch;
    try {
      await expect(startSession("wrong")).rejects.toThrow("缺少或错误的访问令牌");
    } finally {
      globalThis.fetch = original;
    }
  });

  it("没有 sessionStorage 时读写令牌都不抛错（SSR / 测试环境）", () => {
    expect(readStoredToken()).toBeUndefined();
    expect(() => storeToken("tok")).not.toThrow();
  });
});
