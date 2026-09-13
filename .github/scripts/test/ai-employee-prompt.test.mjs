import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { URL } from "node:url";

const prompt = await readFile(new URL("../../prompts/ai-employee.md", import.meta.url), "utf8");

test("routes WeChat article deliverables through a GitHub issue", () => {
  assert.match(prompt, /\.claude\/skills\/write-wechat\/SKILL\.md/);
  assert.match(prompt, /gh issue create/);
  assert.match(prompt, /\[公众号\]/);
  assert.match(prompt, /最终回复只能包含 Issue URL/);
  assert.match(prompt, /同一飞书话题.*更新原 Issue/);
  assert.match(prompt, /Issue 创建失败.*不得伪造链接/);
});
